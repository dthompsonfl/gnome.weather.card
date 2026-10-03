/* store.js — Weather Card settings & cache.
 *
 * GSettings holds only small, non-sensitive preferences plus the saved
 * card position. The last successful weather snapshot lives in a cache
 * file under ~/.cache/weather-card@z.ai/ so startup can render
 * immediately without any network traffic.
 *
 * SPDX-License-Identifier: MIT
 */

import GLib from 'gi://GLib';

const CACHE_VERSION = 1;
const CACHE_DIR = GLib.build_filenamev([GLib.get_user_cache_dir(), 'weather-card@z.ai']);
const CACHE_FILE = GLib.build_filenamev([CACHE_DIR, 'weather.json']);

export class Store {
    /**
     * @param {Gio.Settings} settings - org.gnome.shell.extensions.weather-card
     */
    constructor(settings) {
        this._settings = settings;
    }

    /* ------------------------------------------------------------ units */

    get unit() {
        return this._settings.get_string('unit');
    }

    set unit(value) {
        this._settings.set_string('unit', value);
    }

    /* --------------------------------------------------------- location */

    get locationMode() {
        return this._settings.get_string('location-mode');
    }

    set locationMode(value) {
        this._settings.set_string('location-mode', value);
    }

    get manualPlace() {
        const name = this._settings.get_string('manual-name');
        if (name === '')
            return null;
        return {
            name,
            latitude: this._settings.get_double('manual-latitude'),
            longitude: this._settings.get_double('manual-longitude'),
        };
    }

    setManualPlace({name, latitude, longitude}) {
        this._settings.set_string('manual-name', name);
        this._settings.set_double('manual-latitude', latitude);
        this._settings.set_double('manual-longitude', longitude);
    }

    get autoPlace() {
        const latitude = this._settings.get_double('auto-latitude');
        const longitude = this._settings.get_double('auto-longitude');
        if (latitude === 0 && longitude === 0)
            return null;
        return {name: null, latitude, longitude};
    }

    setAutoPlace({latitude, longitude}) {
        this._settings.set_double('auto-latitude', latitude);
        this._settings.set_double('auto-longitude', longitude);
    }

    /* --------------------------------------------------------- schedule */

    get refreshIntervalMinutes() {
        return Math.max(10, this._settings.get_uint('refresh-interval'));
    }

    /* --------------------------------------------------------- position */

    get cardPosition() {
        const x = this._settings.get_int('card-x');
        const y = this._settings.get_int('card-y');
        if (x < 0 || y < 0)
            return null;
        return {x, y};
    }

    setCardPosition(x, y) {
        this._settings.set_int('card-x', Math.trunc(x));
        this._settings.set_int('card-y', Math.trunc(y));
    }

    resetCardPosition() {
        this._settings.set_int('card-x', -1);
        this._settings.set_int('card-y', -1);
    }

    /* ------------------------------------------------------- observers */

    /**
     * @param {string} key - settings key to watch
     * @param {() => void} callback
     * @returns {number} signal id (pass to unwatch)
     */
    watch(key, callback) {
        return this._settings.connect(`changed::${key}`, callback);
    }

    unwatch(id) {
        this._settings.disconnect(id);
    }

    /* ------------------------------------------------------------ cache */

    /**
     * @returns {object|null} the last validated snapshot, or null
     */
    readSnapshot() {
        try {
            const [ok, contents] = GLib.file_get_contents(CACHE_FILE);
            if (!ok || !contents)
                return null;
            const text = new TextDecoder().decode(contents);
            const parsed = JSON.parse(text);
            if (parsed?.version !== CACHE_VERSION)
                return null;
            return parsed.snapshot ?? null;
        } catch (e) {
            return null;
        }
    }

    /** Persist a snapshot (small, atomic, best-effort). */
    writeSnapshot(snapshot) {
        try {
            GLib.mkdir_with_parents(CACHE_DIR, 0o700);
            const payload = JSON.stringify({version: CACHE_VERSION, snapshot});
            return GLib.file_set_contents(CACHE_FILE, payload);
        } catch (e) {
            return false;
        }
    }

    clearSnapshot() {
        try {
            GLib.unlink(CACHE_FILE);
        } catch (e) {
            // Missing file is fine.
        }
    }
}
