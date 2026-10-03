/* geoclue.js — Weather Card location service.
 *
 * One-shot location acquisition through GeoClue2 over D-Bus — the same
 * mechanism the XDG Desktop Portal uses under the hood. The permission
 * dialog itself is presented by GNOME Shell's GeoClue agent, so consent
 * is always a system-level decision, never ours.
 *
 * City-level accuracy is requested (GCLUE_ACCURACY_LEVEL_CITY). The
 * client is stopped and dropped as soon as a fix arrives; this module
 * never becomes a background service.
 *
 * Kinds of LocationError:
 *   'denied'      — consent not given / agent declined (client never active)
 *   'unavailable' — GeoClue missing, or no fix within the window
 *   'cancelled'   — caller aborted
 *
 * SPDX-License-Identifier: MIT
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const BUS_NAME = 'org.freedesktop.GeoClue2';
const MANAGER_PATH = '/org/freedesktop/GeoClue2/Manager';
const IFACE_MANAGER = 'org.freedesktop.GeoClue2.Manager';
const IFACE_CLIENT = 'org.freedesktop.GeoClue2.Client';
const IFACE_LOCATION = 'org.freedesktop.GeoClue2.Location';
const DBUS_PROPS = 'org.freedesktop.DBus.Properties';

/** GClueAccuracyLevel.CITY — everything this widget needs. */
export const ACCURACY_CITY = 2;

/** Seconds we wait for the user to answer the permission dialog. */
const DECISION_WINDOW_S = 120;
/** Extra seconds to obtain a fix after the client becomes active. */
const FIX_WINDOW_S = 45;

export class LocationError extends Error {
    constructor(kind, message) {
        super(message);
        this.name = 'LocationError';
        this.kind = kind; // 'denied' | 'unavailable' | 'cancelled'
    }
}

export class GeoClueLocator {
    constructor() {
        this._cancellable = new GLib.Cancellable();
        this._cancelId = 0;
        this._timeoutId = 0;
        this._signalIds = [];
        this._proxies = [];
        this._settled = false;
    }

    /** Abort an in-flight locate() — it will reject with 'cancelled'. */
    cancel() {
        if (this._settled) {
            this._teardown();
            return;
        }
        this._cancellable.cancel();
    }

    /**
     * Resolve an approximate location once.
     *
     * @param {object} [options]
     * @param {string} [options.desktopId] - app id shown in the permission
     *        dialog (matches weather-card.desktop)
     * @returns {Promise<{latitude: number, longitude: number}>}
     */
    locate({desktopId = 'weather-card'} = {}) {
        return new Promise((resolve, reject) => {
            this._resolve = resolve;
            this._reject = reject;
            this._desktopId = desktopId;

            this._cancelId = this._cancellable.connect(() => {
                if (this._settled) {
                    this._teardown();
                    return;
                }
                this._settle(new LocationError('cancelled', 'Cancelled'));
            });

            try {
                this._manager = Gio.DBusProxy.new_sync(
                    Gio.DBus.session, Gio.DBusProxyFlags.NONE, null,
                    BUS_NAME, MANAGER_PATH, IFACE_MANAGER, null);
                this._track(this._manager);
            } catch (e) {
                this._settle(new LocationError('unavailable',
                    'GeoClue is not available on this system.'));
                return;
            }

            this._callManagerGetClient().then(client => {
                this._client = client;
                this._awaitLocation();
                return this._configureClient(client);
            }).then(() => {
                this._callStart(this._client);
            }).catch(e => {
                this._settle(e);
            });
        });
    }

    /* ------------------------------------------------------------- steps */

    _callManagerGetClient() {
        return new Promise((resolve, reject) => {
            try {
                const result = this._manager.call_sync('GetClient', null,
                    Gio.DBusCallFlags.NONE, -1, null);
                const [clientPath] = result.deep_unpack();
                if (typeof clientPath !== 'string' || clientPath.length === 0)
                    throw new LocationError('unavailable', 'GeoClue returned no client.');
                const client = Gio.DBusProxy.new_sync(
                    Gio.DBus.session, Gio.DBusProxyFlags.NONE, null,
                    BUS_NAME, clientPath, IFACE_CLIENT, null);
                this._track(client);
                resolve(client);
            } catch (e) {
                reject(new LocationError('unavailable',
                    `Could not create GeoClue client: ${e.message}`));
            }
        });
    }

    _configureClient(client) {
        const set = (name, value) => client.call_sync(DBUS_PROPS,
            new GLib.Variant('(ssv)', [IFACE_CLIENT, name, value]),
            Gio.DBusCallFlags.NONE, -1, null);
        return new Promise((resolve, reject) => {
            try {
                set('DesktopId', new GLib.Variant('s', this._desktopId));
                set('RequestedAccuracyLevel', new GLib.Variant('u', ACCURACY_CITY));
                resolve();
            } catch (e) {
                reject(new LocationError('unavailable',
                    `Could not configure GeoClue client: ${e.message}`));
            }
        });
    }

    _callStart(client) {
        try {
            client.call_sync('Start', null, Gio.DBusCallFlags.NONE, -1, null);
            this._armTimeout(DECISION_WINDOW_S + FIX_WINDOW_S);
        } catch (e) {
            this._settle(new LocationError('unavailable',
                `GeoClue could not start: ${e.message}`));
        }
    }

    _awaitLocation() {
        const client = this._client;
        const id = client.connect('g-signal', (proxy, sender, name, params) => {
            if (name !== 'LocationUpdated')
                return;
            const [oldPath, newPath] = params.deep_unpack();
            this._onLocationUpdated(newPath);
        });
        this._signalIds.push([client, id]);
    }

    _onLocationUpdated(locationPath) {
        if (this._settled)
            return;
        try {
            const loc = Gio.DBusProxy.new_sync(
                Gio.DBus.session, Gio.DBusProxyFlags.NONE, null,
                BUS_NAME, locationPath, IFACE_LOCATION, null);
            this._track(loc);
            const lat = loc.get_cached_property('Latitude')?.unpack();
            const lon = loc.get_cached_property('Longitude')?.unpack();
            if (typeof lat !== 'number' || typeof lon !== 'number' ||
                !Number.isFinite(lat) || !Number.isFinite(lon))
                throw new Error('incomplete location properties');
            this._settle({latitude: lat, longitude: lon});
        } catch (e) {
            this._settle(new LocationError('unavailable',
                `Location arrived but could not be read: ${e.message}`));
        }
    }

    _armTimeout(seconds) {
        this._clearTimeout();
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._timeoutId = 0;
            if (this._settled)
                return GLib.SOURCE_REMOVE;
            // Distinguish "never authorized" from "authorized but no fix".
            const active = this._client?.get_cached_property('Active')?.unpack();
            if (active === false)
                this._settle(new LocationError('denied',
                    'Location access was not granted.'));
            else
                this._settle(new LocationError('unavailable',
                    'A location could not be determined in time.'));
            return GLib.SOURCE_REMOVE;
        });
    }

    /* ------------------------------------------------------------ cleanup */

    _track(proxy) {
        this._proxies.push(proxy);
    }

    _settle(result) {
        if (this._settled)
            return;
        this._settled = true;

        // Best-effort Stop() — never keep a GeoClue client running.
        try {
            this._client?.call_sync('Stop', null, Gio.DBusCallFlags.NONE, 200, null);
        } catch (e) {
            // Client may already be gone; that is fine.
        }

        this._teardown();

        if (result instanceof Error)
            this._reject?.(result);
        else
            this._resolve?.(result);
    }

    _teardown() {
        this._clearTimeout();
        if (this._cancelId && this._cancellable) {
            this._cancellable.disconnect(this._cancelId);
            this._cancelId = 0;
        }
        for (const [obj, id] of this._signalIds)
            obj.disconnect(id);
        this._signalIds = [];
        this._proxies = [];
        this._client = null;
        this._manager = null;
    }

    _clearTimeout() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
    }

    /** Final cleanup for callers that gave up without settle. */
    dispose() {
        this.cancel();
    }
}
