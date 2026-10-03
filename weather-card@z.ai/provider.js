/* provider.js — Weather Card weather provider.
 *
 * A thin, replaceable transport for Open-Meteo. All HTTP goes through
 * libsoup 3 with hard timeouts; responses are returned as parsed JSON
 * and validated separately in weather.js, so UI code never sees
 * provider-specific shapes or codes.
 *
 * Coordinates are rounded to two decimals (~1 km) before leaving the
 * machine — city-level weather does not need more precision.
 *
 * SPDX-License-Identifier: MIT
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup';

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const SEARCH_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const USER_AGENT = 'weather-card-gnome-extension/1.0';
const IO_TIMEOUT_S = 20;      // libsoup per-request I/O timeout
const HARD_TIMEOUT_MS = 30_000; // guaranteed ceiling, whatever soup does
const SEARCH_COUNT = 8;

/** Error kinds: 'network' | 'http' | 'malformed' | 'cancelled' */
export class ProviderError extends Error {
    constructor(kind, message) {
        super(message);
        this.name = 'ProviderError';
        this.kind = kind;
    }
}

/** Round a coordinate to the precision actually needed (2 decimals). */
export function roundCoord(value) {
    return Math.round(value * 100) / 100;
}

export class OpenMeteoProvider {
    constructor() {
        this._session = new Soup.Session({timeout: IO_TIMEOUT_S});
        this._cancellables = new Set();
        this._timers = new Set();
        this._disposed = false;
    }

    /** Cancel every in-flight request. Safe to call repeatedly. */
    abort() {
        for (const cancellable of [...this._cancellables])
            cancellable.cancel();
        for (const timer of [...this._timers]) {
            GLib.source_remove(timer);
            this._timers.delete(timer);
        }
    }

    /** Full teardown — call from disable(). */
    dispose() {
        this.abort();
        this._session = null;
        this._disposed = true;
    }

    /**
     * Fetch a forecast for a location.
     *
     * @param {object} place - {latitude, longitude} (2-decimal precision)
     * @returns {Promise<object>} parsed JSON payload (unvalidated)
     */
    fetchForecast(place) {
        // Only the fields the widget actually displays are requested.
        const url =
            `${FORECAST_URL}?latitude=${encodeURIComponent(place.latitude)}` +
            `&longitude=${encodeURIComponent(place.longitude)}` +
            '&current=temperature_2m,apparent_temperature,is_day,precipitation,weather_code' +
            '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max' +
            '&hourly=weather_code,temperature_2m,precipitation_probability,is_day' +
            '&timezone=auto&forecast_days=2&temperature_unit=celsius';
        return this._getJson(url);
    }

    /**
     * Search for places by name (manual location fallback).
     *
     * @returns {Promise<Array<{id:number,name:string,region:string,country:string,
     *                           latitude:number,longitude:number}>>}
     */
    searchPlaces(query, language = 'en') {
        const url =
            `${SEARCH_URL}?name=${encodeURIComponent(query)}` +
            `&count=${SEARCH_COUNT}&language=${encodeURIComponent(language)}&format=json`;
        return this._getJson(url).then(json => this._parseSearch(json));
    }

    _parseSearch(json) {
        if (json === null || typeof json !== 'object' || Array.isArray(json))
            throw new ProviderError('malformed', 'Unexpected search response');
        const results = json.results;
        if (results === undefined || results === null)
            return [];
        if (!Array.isArray(results))
            throw new ProviderError('malformed', 'Unexpected search results');
        const places = [];
        for (const r of results) {
            if (typeof r?.name !== 'string' || r.name.length === 0)
                continue;
            const latitude = Number(r.latitude);
            const longitude = Number(r.longitude);
            if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90)
                continue;
            if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180)
                continue;
            places.push({
                id: Number.isFinite(r.id) ? r.id : 0,
                name: r.name,
                region: typeof r.admin1 === 'string' ? r.admin1 : '',
                country: typeof r.country === 'string' ? r.country : '',
                latitude: roundCoord(latitude),
                longitude: roundCoord(longitude),
            });
        }
        return places;
    }

    _getJson(url) {
        if (this._disposed)
            return Promise.reject(new ProviderError('cancelled', 'Provider disposed'));

        return new Promise((resolve, reject) => {
            const session = this._session;
            if (!session) {
                reject(new ProviderError('cancelled', 'Provider disposed'));
                return;
            }

            const cancellable = new GLib.Cancellable();
            this._cancellables.add(cancellable);

            // Guaranteed ceiling even if the session timeout property is
            // unsupported for some reason.
            const timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HARD_TIMEOUT_MS, () => {
                this._timers.delete(timer);
                cancellable.cancel();
                return GLib.SOURCE_REMOVE;
            });
            this._timers.add(timer);

            let settled = false;
            const finish = fn => arg => {
                if (settled)
                    return;
                settled = true;
                this._cancellables.delete(cancellable);
                if (this._timers.has(timer)) {
                    GLib.source_remove(timer);
                    this._timers.delete(timer);
                }
                fn(arg);
            };
            const ok = finish(resolve);
            const fail = finish(reject);

            try {
                const message = Soup.Message.new('GET', url);
                message.get_request_headers().append('User-Agent', USER_AGENT);
                session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable,
                    (sess, res) => {
                        try {
                            const bytes = sess.send_and_read_finish(res);
                            const status = message.get_status();
                            if (status !== 200) {
                                if (status === 429)
                                    throw new ProviderError('http', 'Weather service is busy (HTTP 429)');
                                throw new ProviderError('http', `Weather service responded with HTTP ${status}`);
                            }
                            if (bytes === null)
                                throw new ProviderError('malformed', 'Empty response body');
                            const text = new TextDecoder().decode(bytes.get_data());
                            let json;
                            try {
                                json = JSON.parse(text);
                            } catch (e) {
                                throw new ProviderError('malformed', 'Response was not valid JSON');
                            }
                            ok(json);
                        } catch (e) {
                            fail(this._normalizeError(e));
                        }
                    });
            } catch (e) {
                fail(this._normalizeError(e));
            }
        });
    }

    _normalizeError(e) {
        if (e instanceof ProviderError)
            return e;
        try {
            if (e instanceof GLib.Error &&
                e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return new ProviderError('cancelled', 'Request cancelled');
        } catch (err) {
            // Fall through: classify as network below.
        }
        return new ProviderError('network', e?.message ?? 'Network request failed');
    }
}
