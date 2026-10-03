/* extension.js — Weather Card lifecycle & controller.
 *
 * Owns the state machine, scheduling, and every external interaction:
 *   - location flow (GeoClue with consent, manual fallback)
 *   - weather refresh (~every 15 minutes, never per-minute polling)
 *   - refresh on wake/resume and on connectivity regain, when stale
 *   - exponential backoff after failures; no requests while offline
 *   - complete resource release on disable()
 *
 * UI decisions live in widget.js; provider specifics in provider.js;
 * location in geoclue.js; persistence in store.js; parsing/validation
 * in weather.js; icon rendering in icons.js.
 *
 * SPDX-License-Identifier: MIT
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {GeoClueLocator} from './geoclue.js';
import * as icons from './icons.js';
import {OpenMeteoProvider, roundCoord} from './provider.js';
import {Store} from './store.js';
import * as weather from './weather.js';
import {WeatherCard} from './widget.js';

const DEFAULT_EDGE_MARGIN = 48;
const DEFAULT_TOP_OFFSET = 72;
const WAKE_SETTLE_S = 3;
const NET_REGAIN_DEBOUNCE_S = 2;
const MAX_BACKOFF_MULTIPLE = 4;

export default class WeatherCardExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._store = new Store(this._settings);
        this._provider = new OpenMeteoProvider();
        this._locator = null;

        this._connections = [];
        this._timers = new Set();
        this._fetching = false;
        this._failures = 0;
        this._login1 = null;
        this._login1Sub = 0;
        this._schemeId = 0;
        this._locationDebounce = 0;
        this._netDebounce = 0;

        const cached = this._store.readSnapshot();
        this._snapshot = weather.auditSnapshot(cached);

        this._card = new WeatherCard({
            settings: this._settings,
            basePath: this.path,
            callbacks: {
                refresh: () => this.manualRefresh(),
                useCurrentLocation: () => this.beginAutoLocation(),
                chooseLocation: () => this.openSearchPrefs(),
                unitToggle: () => this.toggleUnit(),
                resetPosition: () => this.resetPosition(),
                positionSaved: (x, y) => this._store.setCardPosition(x, y),
            },
        });

        const backgroundGroup = Main.layoutManager._backgroundGroup;
        if (backgroundGroup)
            backgroundGroup.add_child(this.actor);

        this._watchEnvironment();
        this._positionCard();
        this._updateScale();

        // Paint the cache immediately, then decide what to fetch.
        if (this._snapshot) {
            this._card.showWeather(this._snapshot, {refreshing: this._isStale()});
        }

        // Let the shell settle before first network/location work.
        this._addTimeout(1, () => this._startupFlow());
    }

    disable() {
        // Order matters: stop external work, then timers, then UI.
        this._locator?.cancel();
        this._locator = null;
        this._provider?.dispose();
        this._provider = null;

        for (const id of [...this._timers])
            this._removeTimeout(id);
        this._timers.clear();

        for (const [obj, id] of this._connections)
            obj.disconnect(id);
        this._connections = [];

        if (this._login1 && this._login1Sub) {
            try {
                this._login1.signal_unsubscribe(this._login1Sub);
            } catch (e) {
                // Subscription may already be gone.
            }
            this._login1Sub = 0;
            this._login1 = null;
        }

        if (this._schemeId) {
            try {
                St.Settings.get().disconnect(this._schemeId);
            } catch (e) {
                // Settings object may be gone.
            }
            this._schemeId = 0;
        }

        if (this._card) {
            this._card.destroy();
            this._card = null;
        }

        this._snapshot = null;
        this._store = null;
        this._settings = null;
    }

    /* ------------------------------------------------------- the actor */

    get actor() {
        return this._card?.actor ?? null;
    }

    _positionCard() {
        if (!this._card)
            return;
        const saved = this._store.cardPosition;
        if (saved) {
            this._card.setPosition(saved.x, saved.y);
            return;
        }
        try {
            const idx = global.display.get_primary_monitor();
            const mon = global.display.get_monitor_geometry(idx);
            const width = this._card.actor.width || 340;
            this._card.setPosition(
                mon.x + mon.width - width - DEFAULT_EDGE_MARGIN,
                mon.y + DEFAULT_TOP_OFFSET);
        } catch (e) {
            this._card.setPosition(48, 72);
        }
    }

    _updateScale() {
        if (!this._card)
            return;
        let scale = 1;
        try {
            const idx = global.display.get_primary_monitor();
            scale = Math.ceil(global.display.get_monitor_scale(idx) || 1);
        } catch (e) {
            scale = 1;
        }
        this._card.setScale(scale);
    }

    /* --------------------------------------------------- environment */

    _connect(obj, signal, handler) {
        const id = obj.connect(signal, handler);
        this._connections.push([obj, id]);
        return id;
    }

    _watchEnvironment() {
        this._connect(this._settings, 'changed::unit',
            () => this._card?.updateUnit());
        this._connect(this._settings, 'changed::refresh-interval',
            () => this._reschedule());
        this._connect(this._settings, 'changed::location-mode',
            () => this._locationChanged());
        this._connect(this._settings, 'changed::manual-name',
            () => this._locationChanged());
        this._connect(this._settings, 'changed::manual-latitude',
            () => this._locationChanged());
        this._connect(this._settings, 'changed::manual-longitude',
            () => this._locationChanged());

        this._schemeId = icons.watchScheme(() =>
            this._card?.setScheme(icons.currentScheme()));
        this._connect(Main.layoutManager, 'monitors-changed', () => {
            this._positionCard();
            this._updateScale();
        });

        this._connect(Main.overview, 'showing', () =>
            this._card?.setOverviewHidden(true));
        this._connect(Main.overview, 'hiding', () =>
            this._card?.setOverviewHidden(false));

        const netmon = Gio.NetworkMonitor.get_default();
        this._connect(netmon, 'notify::network-available', () =>
            this._networkChanged());
        this._connect(netmon, 'notify::connectivity', () =>
            this._networkChanged());

        try {
            this._login1 = Gio.bus_get_sync(Gio.BusType.SYSTEM, null);
            this._login1Sub = this._login1.signal_subscribe(
                null, 'org.freedesktop.login1', 'PrepareForSleep',
                '/org/freedesktop/login1', null, Gio.DBusSignalFlags.NONE,
                (conn, sender, path, iface, signal, params) => {
                    const [goingToSleep] = params.deep_unpack();
                    if (!goingToSleep)
                        this._addTimeout(WAKE_SETTLE_S, () => this._onWake());
                });
        } catch (e) {
            // logind unavailable (rare); the interval timer still works.
        }
    }

    /* -------------------------------------------------------- helpers */

    _addTimeout(seconds, fn) {
        const id = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._timers.delete(id);
            fn();
            return GLib.SOURCE_REMOVE;
        });
        this._timers.add(id);
        return id;
    }

    _removeTimeout(id) {
        if (this._timers.has(id)) {
            GLib.source_remove(id);
            this._timers.delete(id);
        }
    }

    _clearTimers() {
        for (const id of [...this._timers])
            this._removeTimeout(id);
    }

    _isOffline() {
        try {
            const netmon = Gio.NetworkMonitor.get_default();
            return !netmon.network_available ||
                netmon.connectivity === Gio.NetworkConnectivity.LIMITED;
        } catch (e) {
            return false;
        }
    }

    _intervalMinutes() {
        return this._store.refreshIntervalMinutes;
    }

    _isStale() {
        if (!this._snapshot)
            return true;
        const ageMs = Date.now() - this._snapshot.fetchedAt;
        return ageMs > this._intervalMinutes() * 60 * 1000;
    }

    _currentPlace() {
        if (this._store.locationMode === 'manual')
            return this._store.manualPlace;
        return this._store.autoPlace;
    }

    /* ---------------------------------------------------- state flow */

    _startupFlow() {
        if (!this._card)
            return;

        if (this._store.locationMode === 'manual') {
            if (this._store.manualPlace) {
                if (this._isStale())
                    this.refresh();
                else
                    this._scheduleNext(this._remainingSeconds());
            } else {
                // Manual mode with nothing chosen: user is (or will be)
                // picking a place in the preferences window.
                this._card.showChoosePending();
            }
            return;
        }

        // Automatic mode.
        if (this._store.autoPlace) {
            if (this._isStale())
                this.refresh();
            else
                this._scheduleNext(this._remainingSeconds());
        } else if (!this._snapshot) {
            this._card.showOnboarding();
        } else {
            // Have cached weather but no stored coordinates: keep the
            // cache visible and gently start the location flow.
            this._card.showWeather(this._snapshot, {refreshing: true});
            this.beginAutoLocation();
        }
    }

    /** Manual refresh from the menu/error retry: resets backoff. */
    manualRefresh() {
        this._failures = 0;
        this._clearTimers();
        this.refresh();
    }

    refresh() {
        if (this._fetching || !this._card || !this._provider)
            return;

        const place = this._currentPlace();
        if (!place) {
            this._startupFlow();
            return;
        }

        if (this._isOffline()) {
            // Never hammer the network while offline; the network monitor
            // will trigger a refresh as soon as we're back.
            if (this._snapshot)
                this._card.showWeather(this._snapshot, {offline: true});
            else
                this._card.showError('network');
            this._scheduleNext(this._intervalMinutes() * 60);
            return;
        }

        this._fetching = true;
        if (!this._snapshot)
            this._card.showLoading();

        this._provider.fetchForecast({
            latitude: roundCoord(place.latitude),
            longitude: roundCoord(place.longitude),
        }).then(raw => {
            const snapshot = weather.parseSnapshot(raw, {
                name: place.name ?? null,
                latitude: place.latitude,
                longitude: place.longitude,
            });
            this._snapshot = snapshot;
            this._failures = 0;
            this._store.writeSnapshot(snapshot);
            this._card?.showWeather(snapshot);
            this._fetching = false;
            this._scheduleNext(this._intervalMinutes() * 60);
        }).catch(e => {
            this._fetching = false;
            if (e?.kind === 'cancelled' || !this._card)
                return;
            this._onFetchError(e);
        });
    }

    _onFetchError(e) {
        this._failures++;

        const offline = this._isOffline() || e.kind === 'network';
        if (offline) {
            if (this._snapshot)
                this._card.showWeather(this._snapshot, {offline: true});
            else
                this._card.showError('network');
            // No timer: we rely on the network monitor to try again.
            return;
        }

        const kind = e.kind === 'malformed' ? 'malformed' : 'provider';
        if (this._snapshot)
            this._card.showWeather(this._snapshot, {note: 'Couldn’t update just now — retrying soon'});
        else
            this._card.showError(kind);

        // Backoff: interval, 2×, 4× … capped.
        const mult = Math.min(MAX_BACKOFF_MULTIPLE, 2 ** (this._failures - 1));
        this._scheduleNext(this._intervalMinutes() * 60 * mult);
    }

    _remainingSeconds() {
        const ageMs = Date.now() - (this._snapshot?.fetchedAt ?? 0);
        return Math.max(60, Math.ceil((this._intervalMinutes() * 60 * 1000 - ageMs) / 1000));
    }

    _scheduleNext(seconds) {
        this._clearTimers();
        this._addTimeout(Math.max(10, seconds), () => this.refresh());
    }

    _reschedule() {
        if (this._snapshot && !this._isStale())
            this._scheduleNext(this._remainingSeconds());
        else
            this.refresh();
    }

    /* -------------------------------------------------------- location */

    beginAutoLocation() {
        if (!this._card || this._locator)
            return;

        this._clearTimers();
        this._card.showLocating();

        this._locator = new GeoClueLocator();
        this._locator.locate({desktopId: 'weather-card'}).then(result => {
            this._locator = null;
            this._store.setAutoPlace({
                latitude: roundCoord(result.latitude),
                longitude: roundCoord(result.longitude),
            });
            this._failures = 0;
            this.refresh();
        }).catch(e => {
            this._locator = null;
            if (e?.kind === 'cancelled' || !this._card)
                return;
            const kind = e.kind === 'denied' ? 'permission' : 'location';
            if (this._snapshot) {
                this._card.showWeather(this._snapshot, {offline: false});
                // Keep the cached view; a quiet retry later costs nothing.
                this._scheduleNext(this._intervalMinutes() * 60);
            } else {
                this._card.showError(kind);
            }
        });
    }

    _locationChanged() {
        if (!this._card)
            return;
        // Manual place updates arrive as three key writes (name, lat,
        // lon) — debounce into one reaction.
        if (this._locationDebounce)
            this._removeTimeout(this._locationDebounce);
        this._locationDebounce = this._addTimeout(1, () => {
            this._locationDebounce = 0;
            this._applyLocationChange();
        });
    }

    _applyLocationChange() {
        if (!this._card)
            return;
        this._locator?.cancel();
        this._locator = null;
        this._failures = 0;
        this._clearTimers();
        this._snapshot = null;
        this._store.clearSnapshot();

        if (this._store.locationMode === 'auto') {
            if (this._store.autoPlace) {
                // Coordinates already known: no need to ask GeoClue again.
                this.refresh();
            } else {
                this.beginAutoLocation();
            }
        } else if (this._store.manualPlace) {
            this.refresh();
        } else {
            this._card.showChoosePending();
        }
    }

    openSearchPrefs() {
        // If nothing is configured anywhere, jumping straight into the
        // search dialog is the smoothest first-run path. Users who
        // already have a working setup land in the regular preferences.
        if (!this._store.autoPlace && !this._store.manualPlace)
            this._store.locationMode = 'manual';
        try {
            this.openPreferences();
        } catch (e) {
            logError(e, 'weather-card: could not open preferences');
        }
    }

    /* ---------------------------------------------------------- misc */

    toggleUnit() {
        const current = weather.resolveUnit(this._store.unit);
        this._store.unit = current === 'fahrenheit' ? 'celsius' : 'fahrenheit';
        // changed::unit triggers card.updateUnit()
    }

    resetPosition() {
        this._store.resetCardPosition();
        this._positionCard();
    }

    _onWake() {
        if (this._isStale())
            this.refresh();
    }

    _networkChanged() {
        if (this._isOffline())
            return;
        // Reconnected: refresh soon if we're stale or in an error state.
        // network-available and connectivity can both fire — debounce to
        // a single attempt.
        if (this._isStale() || (this._failures > 0 && !this._snapshot)) {
            if (this._netDebounce)
                this._removeTimeout(this._netDebounce);
            this._netDebounce = this._addTimeout(NET_REGAIN_DEBOUNCE_S, () => {
                this._netDebounce = 0;
                this.refresh();
            });
        }
    }
}
