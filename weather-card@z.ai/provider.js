/* provider.js — Weather Card weather provider.
 *
 * A thin, replaceable transport for Open-Meteo. All HTTP goes through
 * libsoup 3 with an explicit deadline; responses are returned as parsed JSON
 * and validated separately in weather.js, so UI code never sees
 * provider-specific shapes or codes.
 *
 * Coordinates are rounded to two decimals (~1 km) before leaving the
 * machine — city-level weather needs no finer precision.
 *
 * Error kinds are deliberately distinct, because the card reacts to each
 * differently and a deadline must never be mistaken for a shutdown:
 *
 *   'cancelled' — deliberate lifecycle cancellation (extension disabled)
 *   'timeout'   — the request exceeded its deadline
 *   'network'   — connectivity or transport failure
 *   'http'      — the provider answered with an error status
 *   'malformed' — the payload could not be safely interpreted
 *
 * SPDX-License-Identifier: MIT
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const SEARCH_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const USER_AGENT = 'weather-card-gnome-extension/1.0 (+https://github.com/dthompsonfl/gnome.weather.card)';

/* libsoup's own idle timeout and a guaranteed ceiling on top of it. */
const IO_TIMEOUT_S = 15;
const HARD_TIMEOUT_MS = 25_000;

const SEARCH_COUNT = 8;

/* Only the hours the card can actually show. Open-Meteo returns the hourly
 * block starting at the current hour when forecast_hours is used, which is
 * exactly the window rendered — 8 cells plus the current observation. */
const HOURLY_HOURS = 12;

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
        this._session = new Soup.Session({
            timeout: IO_TIMEOUT_S,
            user_agent: USER_AGENT,
        });
        this._inflight = new Map();
        this._timers = new Set();
        this._disposed = false;
    }

    /*
     * Cancellation note (measured on this platform, libsoup 3.6 +
     * GJS 1.88): cancelling a Gio.Cancellable while a soup transfer is
     * still in flight blocks GJS's promise microtask checkpoint until
     * libsoup drains the cancelled message, which can defer a rejection
     * by many seconds. The promise is therefore settled immediately on
     * cancellation and the transfer is left to finish on its own; the
     * response is discarded by the `settled` guard. Nothing is left
     * behind: the session is owned by the provider and dropped in
     * dispose().
     */
    abort() {
        for (const entry of [...this._inflight.values()]) {
            // Settle first so the caller hears back immediately…
            entry.fail(new ProviderError('cancelled', 'Request cancelled'));
            // …then ask libsoup to stop working on it.
            try {
                entry.cancellable.cancel();
            } catch (e) {
                // Already cancelled.
            }
        }
        this._inflight.clear();
    }

    /** Full teardown — call from disable(). */
    dispose() {
        this.abort();
        for (const timer of this._timers) {
            try {
                GLib.source_remove(timer);
            } catch (e) {
                // Already removed.
            }
        }
        this._timers.clear();
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
        // forecast_days stays at 2 so tomorrow's block is available when the
        // local clock is close to midnight, while forecast_hours keeps the
        // hourly payload to the hours that are actually rendered.
        const url =
            `${FORECAST_URL}?latitude=${encodeURIComponent(place.latitude)}` +
            `&longitude=${encodeURIComponent(place.longitude)}` +
            '&current=temperature_2m,apparent_temperature,is_day,precipitation,weather_code' +
            '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max' +
            '&hourly=weather_code,temperature_2m,precipitation_probability,is_day' +
            `&timezone=auto&forecast_days=2&forecast_hours=${HOURLY_HOURS}` +
            '&temperature_unit=celsius';
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

            // Gio.Cancellable, not GLib.Cancellable — the latter does not
            // exist in GJS and throws on construction.
            const cancellable = new Gio.Cancellable();

            let timedOut = false;
            let settled = false;
            let timer = 0;

            // Declared before cleanup() can reference it: a closure over a
            // `const` declared later throws a TDZ error at call time, which
            // would abort fail() before it ever rejects.
            const entry = {cancellable, fail: null};

            const cleanup = () => {
                this._inflight.delete(cancellable);
                if (timer && this._timers.has(timer)) {
                    GLib.source_remove(timer);
                    this._timers.delete(timer);
                    timer = 0;
                }
            };

            const ok = value => {
                if (settled)
                    return;
                settled = true;
                cleanup();
                resolve(value);
            };
            const fail = error => {
                if (settled)
                    return;
                settled = true;
                cleanup();
                reject(error);
            };

            // Registered before the request is issued so abort() can settle
            // this promise even if soup never calls back.
            entry.fail = fail;
            this._inflight.set(cancellable, entry);

            // A guaranteed ceiling even if the session timeout misbehaves.
            // Tracked separately from cancellation so a deadline is never
            // reported as a lifecycle cancellation.
            timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HARD_TIMEOUT_MS, () => {
                this._timers.delete(timer);
                timer = 0;
                timedOut = true;
                try {
                    cancellable.cancel();
                } catch (e) {
                    // Already cancelled.
                }
                // A hard deadline must settle the promise itself: soup may
                // not call back for a cancelled transfer.
                fail(new ProviderError('timeout',
                    'The weather service took too long to answer.'));
                return GLib.SOURCE_REMOVE;
            });
            this._timers.add(timer);

            try {
                const message = Soup.Message.new('GET', url);
                session.send_and_read_async(message, GLib.PRIORITY_DEFAULT,
                    cancellable, (sess, res) => {
                        try {
                            const bytes = sess.send_and_read_finish(res);
                            const status = message.get_status();

                            if (status < 200 || status >= 300) {
                                if (status === 429 || status === 503)
                                    throw new ProviderError('http',
                                        'The weather service is busy. Try again shortly.');
                                throw new ProviderError('http',
                                    `Weather service responded with HTTP ${status}`);
                            }
                            if (bytes === null)
                                throw new ProviderError('malformed', 'Empty response body');

                            const text = new TextDecoder().decode(bytes.get_data());
                            let json;
                            try {
                                json = JSON.parse(text);
                            } catch (e) {
                                throw new ProviderError('malformed',
                                    'Response was not valid JSON');
                            }
                            // Open-Meteo reports bad parameters as HTTP 400
                            // with a JSON body, so the reason is surfaced
                            // as a provider fault rather than "malformed".
                            if (json && json.error === true)
                                throw new ProviderError('http',
                                    'Weather service rejected the request');
                            ok(json);
                        } catch (e) {
                            fail(this._normalizeError(e, timedOut));
                        }
                    });
            } catch (e) {
                fail(this._normalizeError(e, timedOut));
            }
        });
    }

    _normalizeError(e, timedOut) {
        if (e instanceof ProviderError)
            return e;

        // A deadline that fired is a timeout, never a cancellation: the two
        // lead to different scheduling decisions.
        if (timedOut)
            return new ProviderError('timeout', 'The weather service took too long to answer.');

        try {
            if (e instanceof GLib.Error &&
                e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                return new ProviderError('cancelled', 'Request cancelled');
            }
        } catch (err) {
            // Fall through and classify as a network problem.
        }
        return new ProviderError('network', e?.message ?? 'Network request failed');
    }
}