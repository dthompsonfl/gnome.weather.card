/* geoclue.js — Weather Card location service.
 *
 * One-shot, city-level location via GeoClue2, the same service the desktop
 * portals use. Consent is GNOME's decision, never ours: the permission
 * dialog comes from the system's location agent.
 *
 * Everything non-obvious here was verified against the GeoClue2 running on
 * the target system, and the details are load-bearing:
 *
 *   * GeoClue2 is a SYSTEM bus service
 *     (/usr/share/dbus-1/system-services/org.freedesktop.GeoClue2.service).
 *     A session-bus call never yields a client.
 *
 *   * RequestedAccuracyLevel is the GClueAccuracyLevel enum and CITY is 4,
 *     not 2: NONE=0, COUNTRY=1, CITY=4, NEIGHBORHOOD=5, STREET=6, EXACT=8.
 *     City is all a city-level forecast needs, so nothing finer is asked
 *     for. (Verified: the live service reports AvailableAccuracyLevel=4.)
 *
 *   * LocationUpdated must be subscribed *before* Start(), per the
 *     interface contract, or the first fix is missed.
 *
 *   * The Location object exists only while the client runs: Stop()
 *     destroys it, and the signal's `old` path is "/" until the first fix.
 *     Coordinates are therefore read inside the signal, before teardown.
 *
 *   * Gio.DBusProxy.new() has a GJS-overridden signature that is awkward to
 *     call positionally, so this module uses the plain connection API
 *     (call/call_finish, signal_subscribe). That API is stable across Shell
 *     versions and keeps no proxy objects alive to manage.
 *
 * Nothing here may block the shell: a synchronous D-Bus call inside GNOME
 * Shell is a UI freeze however brief. Every step is asynchronous, and
 * cancellation is deterministic — cancel() settles the promise exactly once
 * and releases the GeoClue client.
 *
 * LocationError kinds:
 *   'denied'      — consent refused, or the agent declined
 *   'unavailable' — GeoClue missing, inactive, or no fix in time
 *   'cancelled'   — the caller aborted (extension disable, location change)
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

/** GClueAccuracyLevel.CITY — verified against the installed typelib. */
export const ACCURACY_CITY = 4;

/* Bounded so a permission dialog that is never answered cannot leave the
 * card spinning forever. */
const DECISION_WINDOW_S = 100;
const FIX_WINDOW_S = 45;

/* How long to wait for GeoClue to answer a trivial property read before
 * declaring the service unavailable. */
const AVAILABILITY_PROBE_MS = 5000;

/** Total seconds a locate() may take before it gives up. */
export const MAX_LOCATE_SECONDS = DECISION_WINDOW_S + FIX_WINDOW_S;

const REPLY_OBJECT = new GLib.VariantType('(o)');
const REPLY_VOID = new GLib.VariantType('()');
const REPLY_MAP = new GLib.VariantType('(a{sv})');
const REPLY_VARIANT = new GLib.VariantType('(v)');

export class LocationError extends Error {
    constructor(kind, message) {
        super(message);
        this.name = 'LocationError';
        this.kind = kind;
    }
}

/**
 * One asynchronous D-Bus method call.
 *
 * `replyType` must match the method's out-signature; a mismatch surfaces as
 * a generic reply error, indistinguishable from a service fault.
 */
function dbusCall(connection, cancellable, {
    busName, path, iface, method,
    params = null,
    replyType = REPLY_OBJECT,
    timeoutMs = 0,
}) {
    return new Promise((resolve, reject) => {
        if (!connection) {
            reject(new Error('no D-Bus connection'));
            return;
        }

        // One Cancellable spans the whole locate() run, so each call owns a
        // single handler and disconnects it when the call completes.
        let call = null;
        let handlerId = 0;
        const onCancel = () => {
            try {
                call?.cancel();
            } catch (e) {
                // Already completed.
            }
        };

        if (cancellable) {
            if (cancellable.is_cancelled()) {
                reject(new Error('cancelled'));
                return;
            }
            handlerId = cancellable.connect(onCancel);
        }

        const finish = (fn, value) => {
            if (cancellable && handlerId)
                cancellable.disconnect(handlerId);
            fn(value);
        };

        try {
            call = connection.call(busName, path, iface, method, params,
                replyType, Gio.DBusCallFlags.NONE, timeoutMs, cancellable,
                (conn, res) => {
                    let reply;
                    try {
                        reply = conn.call_finish(res);
                    } catch (e) {
                        finish(reject, e);
                        return;
                    }
                    finish(resolve, reply.deep_unpack()[0]);
                });
        } catch (e) {
            finish(reject, e);
        }
    });
}

/**
 * Is there an installed .desktop identity GNOME's permission agent will find?
 *
 * The agent resolves the id through Shell.AppSystem, which only searches
 * $XDG_DATA_DIRS/applications. A .desktop shipped *inside* the extension
 * directory is never seen, so extensions.gnome.org installs cannot rely on
 * one. `NoDisplay=true` is fine: the lookup matches on the app id and does
 * not filter on should_show().
 */
function hasDesktopIdentity(desktopId) {
    try {
        const wanted = `${desktopId}.desktop`;
        return Gio.AppInfo.get_all().some(info => info.get_id() === wanted);
    } catch (e) {
        return false;
    }
}

export class GeoClueLocator {
    constructor() {
        this._cancellable = new Gio.Cancellable();
        this._timeoutIds = new Set();
        this._subscription = 0;
        this._connection = null;
        this._clientPath = null;
        this._settled = false;
        this._disposed = false;
        this._promise = null;
    }

    /**
     * Abort an in-flight locate(). Unless a result already arrived, the
     * promise rejects with kind 'cancelled' and the client is released.
     */
    cancel() {
        if (this._settled || this._disposed)
            return;
        this._settle(new LocationError('cancelled', 'Cancelled'));
    }

    /** Release everything. Safe repeatedly, before or after locate(). */
    dispose() {
        this._disposed = true;
        this.cancel();
        this._teardown();
    }

    /**
     * Resolve an approximate location once.
     *
     * @param {object} [options]
     * @param {string} [options.desktopId] - app id shown by the permission
     *        dialog; must match an installed .desktop basename
     * @returns {Promise<{latitude: number, longitude: number}>}
     */
    locate({desktopId = 'weather-card'} = {}) {
        if (this._promise)
            return this._promise;

        this._promise = new Promise((resolve, reject) => {
            this._resolve = resolve;
            this._reject = reject;
        });

        this._run(desktopId).catch(e => {
            if (this._settled)
                return;
            this._settle(e instanceof LocationError
                ? e
                : new LocationError('unavailable', e?.message ?? 'Location failed'));
        });

        return this._promise;
    }

    /* -------------------------------------------------------------- flow */

    async _run(desktopId) {
        if (this._disposed)
            throw new LocationError('cancelled', 'Disposed');

        // Preflight: the permission agent identifies this application by the
        // basename of an installed .desktop file. GNOME's AppAuthorizer does
        // `if (app == null) return completeAuth()` with an accuracy of NONE
        // (js/ui/status/location.js), so a missing identity file produces a
        // SILENT denial — no dialog, no fix, no explanation. Fail loudly here
        // instead, and tell the user what to install.
        if (!hasDesktopIdentity(desktopId))
            throw new LocationError('no-identity',
                `No installed application identity named “${desktopId}.desktop”, ` +
                'so GNOME would silently refuse the location request. ' +
                'Run install.sh, or choose a location manually.');

        // GeoclueBusType.AUTO lets libgeoclue route to a per-session instance
        // when one exists (what desktop portals use); the system bus is the
        // default and is what ships on this platform.
        const connection = Gio.DBus.system;
        this._connection = connection;

        // 1. Confirm the service answers before promising anything to the
        //    user, so "location services unavailable" reads as such.
        //    GeoClue can be busy inside a long blocking fix attempt, so this
        //    probe gets a short deadline instead of the 25s D-Bus default.
        try {
            await dbusCall(connection, this._cancellable, {
                busName: BUS_NAME,
                path: MANAGER_PATH,
                iface: DBUS_PROPS,
                method: 'Get',
                params: new GLib.Variant('(ss)', [IFACE_MANAGER, 'InUse']),
                replyType: REPLY_VARIANT,
                timeoutMs: AVAILABILITY_PROBE_MS,
            });
        } catch (e) {
            throw new LocationError('unavailable',
                `GeoClue is not available on this system (${e.message}).`);
        }
        if (this._settled)
            return;

        // 2. Obtain this application's own client object.
        const clientPath = await dbusCall(connection, this._cancellable, {
            busName: BUS_NAME,
            path: MANAGER_PATH,
            iface: IFACE_MANAGER,
            method: 'GetClient',
            timeoutMs: AVAILABILITY_PROBE_MS,
        });
        if (this._settled)
            return;
        if (typeof clientPath !== 'string' || clientPath.length === 0)
            throw new LocationError('unavailable', 'GeoClue returned no client.');
        this._clientPath = clientPath;

        // 3. Subscribe before Start(), or the first fix is missed.
        this._subscription = connection.signal_subscribe(
            BUS_NAME, IFACE_CLIENT, 'LocationUpdated', clientPath,
            null, Gio.DBusSignalFlags.NONE,
            (_conn, _sender, _path, _iface, _signal, params) => {
                const [, newPath] = params.deep_unpack();
                this._onLocationUpdated(newPath);
            });

        // 4. Identify ourselves and request city accuracy.
        await this._setProperty(clientPath, 'DesktopId',
            new GLib.Variant('s', desktopId));
        if (this._settled)
            return;
        await this._setProperty(clientPath, 'RequestedAccuracyLevel',
            new GLib.Variant('u', ACCURACY_CITY));
        if (this._settled)
            return;

        // 5. Ask for a fix, bounded by an explicit deadline.
        this._armTimeout(MAX_LOCATE_SECONDS);
        await dbusCall(connection, this._cancellable, {
            busName: BUS_NAME,
            path: clientPath,
            iface: IFACE_CLIENT,
            method: 'Start',
            replyType: REPLY_VOID,
        });
    }

    _setProperty(path, name, variant) {
        return dbusCall(this._connection, this._cancellable, {
            busName: BUS_NAME,
            path,
            iface: DBUS_PROPS,
            method: 'Set',
            params: new GLib.Variant('(ssv)', [IFACE_CLIENT, name, variant]),
            replyType: REPLY_VOID,
        });
    }

    async _onLocationUpdated(locationPath) {
        // "/" is the documented "no fix yet" value.
        if (this._settled || typeof locationPath !== 'string' ||
            locationPath === '' || locationPath === '/')
            return;

        // The Location object dies with the client, so read it now.
        try {
            const props = await dbusCall(this._connection, this._cancellable, {
                busName: BUS_NAME,
                path: locationPath,
                iface: DBUS_PROPS,
                method: 'GetAll',
                params: new GLib.Variant('(s)', [IFACE_LOCATION]),
                replyType: REPLY_MAP,
            });
            if (this._settled)
                return;

            const {Latitude: lat, Longitude: lon} = props;
            if (typeof lat !== 'number' || typeof lon !== 'number' ||
                !Number.isFinite(lat) || !Number.isFinite(lon) ||
                lat < -90 || lat > 90 || lon < -180 || lon > 180)
                throw new Error('incomplete location properties');

            this._settle({latitude: lat, longitude: lon});
        } catch (e) {
            if (this._settled)
                return;
            this._settle(new LocationError('unavailable',
                `Location arrived but could not be read: ${e.message}`));
        }
    }

    _armTimeout(seconds) {
        this._clearTimeouts();
        const id = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._timeoutIds.delete(id);
            if (this._settled)
                return GLib.SOURCE_REMOVE;
            this._settle(new LocationError('unavailable',
                'A location could not be determined in time.'));
            return GLib.SOURCE_REMOVE;
        });
        this._timeoutIds.add(id);
    }

    /* ----------------------------------------------------------- cleanup */

    _settle(result) {
        if (this._settled)
            return;
        this._settled = true;

        // Capture the settlement callbacks before teardown clears them:
        // the caller's promise must always settle exactly once, including on
        // cancellation, or the card would wait on a promise that never does.
        const resolve = this._resolve;
        const reject = this._reject;

        this._clearTimeouts();

        // Best-effort asynchronous Stop(): never leave a client running, and
        // never block the shell while releasing it.
        if (this._connection && this._clientPath) {
            try {
                dbusCall(this._connection, null, {
                    busName: BUS_NAME,
                    path: this._clientPath,
                    iface: IFACE_CLIENT,
                    method: 'Stop',
                    replyType: REPLY_VOID,
                    timeoutMs: 250,
                }).catch(() => {});
            } catch (e) {
                // Client already gone.
            }
        }

        // Cancel outstanding calls before dropping their handlers.
        if (!this._cancellable.is_cancelled()) {
            try {
                this._cancellable.cancel();
            } catch (e) {
                // Nothing to cancel.
            }
        }

        this._teardown();

        if (result instanceof Error)
            reject?.(result);
        else
            resolve?.(result);
    }

    _teardown() {
        this._clearTimeouts();
        if (this._subscription) {
            try {
                this._connection?.signal_unsubscribe(this._subscription);
            } catch (e) {
                // Connection already gone.
            }
            this._subscription = 0;
        }
        this._clientPath = null;
        this._connection = null;
        this._resolve = null;
        this._reject = null;
    }

    _clearTimeouts() {
        for (const id of this._timeoutIds) {
            try {
                GLib.source_remove(id);
            } catch (e) {
                // Already removed.
            }
        }
        this._timeoutIds.clear();
    }
}