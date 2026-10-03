/* weather.js — Weather Card domain model.
 *
 * Pure logic with no GNOME Shell imports, so the same module runs inside
 * the shell process and under `node tools/verify-logic.mjs`.
 *
 * Responsibilities:
 *   - map provider payloads onto a small, provider-neutral snapshot
 *   - validate every field before the UI is allowed to see it
 *   - own units, condition vocabulary and presentation hints
 *
 * Nothing here knows about Open-Meteo. That mapping lives in provider.js;
 * swapping the backend means reimplementing that one function, not this file.
 *
 * SPDX-License-Identifier: MIT
 */

/** Raised when a provider payload cannot be safely interpreted. */
export class MalformedError extends Error {
    constructor(message) {
        super(message);
        this.name = 'MalformedError';
    }
}

/* ------------------------------------------------------- condition domain */

/* WMO 4677 codes as published by Open-Meteo, mapped onto this widget's
 * own condition vocabulary. Codes never reach the UI.
 *
 * Each condition carries:
 *   label    – short human string for the card
 *   motion   – which ambient motion the scene layer should perform
 *   precip   – precipitation family, used to pick artwork accents
 */
const CONDITIONS = {
    'clear': {
        label: 'Clear',
        motion: 'celestial',
        precip: 'none',
    },
    'mostly-clear': {
        label: 'Mostly clear',
        motion: 'celestial',
        precip: 'none',
    },
    'partly-cloudy': {
        label: 'Partly cloudy',
        motion: 'clouds',
        precip: 'none',
    },
    'overcast': {
        label: 'Overcast',
        motion: 'clouds',
        precip: 'none',
    },
    'cloudy': {
        label: 'Cloudy',
        motion: 'clouds',
        precip: 'none',
    },
    'fog': {
        label: 'Fog',
        motion: 'fog',
        precip: 'none',
    },
    'drizzle': {
        label: 'Drizzle',
        motion: 'rain',
        precip: 'drizzle',
    },
    'rain': {
        label: 'Rain',
        motion: 'rain',
        precip: 'rain',
    },
    'sleet': {
        label: 'Sleet',
        motion: 'mixed',
        precip: 'mixed',
    },
    'snow': {
        label: 'Snow',
        motion: 'snow',
        precip: 'snow',
    },
    'thunderstorm': {
        label: 'Thunderstorm',
        motion: 'storm',
        precip: 'rain',
    },
};

const WMO_CODES = {
    0: 'clear',
    1: 'mostly-clear',
    2: 'partly-cloudy',
    3: 'overcast',
    45: 'fog',
    48: 'fog',
    51: 'drizzle',
    53: 'drizzle',
    55: 'drizzle',
    56: 'sleet',
    57: 'sleet',
    61: 'rain',
    63: 'rain',
    65: 'rain',
    66: 'sleet',
    67: 'sleet',
    71: 'snow',
    73: 'snow',
    75: 'snow',
    77: 'snow',
    80: 'rain',
    81: 'rain',
    82: 'rain',
    85: 'snow',
    86: 'snow',
    95: 'thunderstorm',
    96: 'thunderstorm',
    99: 'thunderstorm',
};

/** Icon family keys, resolved to a file by icons.js. */
const ICON_FOR_CONDITION = {
    'clear': isDay => (isDay ? 'clear-day' : 'clear-night'),
    'mostly-clear': isDay => (isDay ? 'partly-day' : 'partly-night'),
    'partly-cloudy': isDay => (isDay ? 'partly-day' : 'partly-night'),
    'overcast': () => 'overcast',
    'cloudy': () => 'cloudy',
    'fog': () => 'fog',
    'drizzle': () => 'drizzle',
    'rain': () => 'rain',
    'sleet': () => 'sleet',
    'snow': () => 'snow',
    'thunderstorm': () => 'thunderstorm',
};

/**
 * Map one observed code/day-night pair onto the domain model.
 *
 * An unknown code is not fatal: a provider adding a code must not blank the
 * card. Unrecognised codes degrade to the neutral overcast artwork, and the
 * caller is told via `recognised: false` so tests can catch drift.
 */
function classify(code, isDay) {
    const key = WMO_CODES[code];
    const condition = CONDITIONS[key] ? key : 'overcast';
    const spec = CONDITIONS[condition];
    const iconKey = ICON_FOR_CONDITION[condition](isDay);
    return {
        condition,
        label: spec.label,
        motion: spec.motion,
        precip: spec.precip,
        iconKey,
        recognised: CONDITIONS[key] !== undefined,
    };
}

/* ------------------------------------------------------------- validation */

const TEMP_C_MIN = -90;
const TEMP_C_MAX = 70;

function num(value, {min, max, field}) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        throw new MalformedError(`${field} is not a finite number`);
    if (value < min || value > max)
        throw new MalformedError(`${field} out of range (${value})`);
    return value;
}

function optionalNum(value, {min, max, field}) {
    if (value === null || value === undefined)
        return null;
    return num(value, {min, max, field});
}

const ISO_LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isoTime(value, field) {
    if (typeof value !== 'string')
        throw new MalformedError(`${field} is not a string (${value})`);
    const m = ISO_LOCAL.exec(value);
    if (!m)
        throw new MalformedError(`${field} is not a local ISO time (${value})`);
    const [, y, mo, d, h, mi] = m.map(Number);
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59)
        throw new MalformedError(`${field} is not a real date/time (${value})`);
    return {date: `${y}-${mo}-${d}`, hour: h, minute: mi, iso: value};
}

function isoDate(value, field) {
    if (typeof value !== 'string' || !ISO_DATE.test(value))
        throw new MalformedError(`${field} is not an ISO date (${value})`);
    return value;
}

function dayFlag(value, field) {
    if (value !== 0 && value !== 1)
        throw new MalformedError(`${field} is not 0/1 (${value})`);
    return value === 1;
}

function requireObject(value, field) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        throw new MalformedError(`${field} missing or not an object`);
    return value;
}

/** Coerce a provider code to a usable integer, rejecting junk outright. */
function weatherCode(value, field) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        throw new MalformedError(`${field} is not a number`);
    if (value < 0 || value > 99)
        throw new MalformedError(`${field} out of range (${value})`);
    return Math.trunc(value);
}

/* ----------------------------------------------------------- parse helpers */

/**
 * Pick the daily summary that actually describes "today" at the location.
 *
 * Providers label daily blocks in local time, so the block whose date
 * equals the current local date is the right one. A neighbouring date is
 * accepted as a fallback (timezone/edge-of-day races) but anything further
 * away means the payload does not describe the requested day.
 */
function pickTodayBlock(daily, currentDate, field) {
    const times = daily.time;
    if (!Array.isArray(times) || times.length === 0)
        throw new MalformedError(`${field}.time missing`);

    const dates = times.map((t, i) => isoDate(t, `${field}.time[${i}]`));
    let idx = dates.indexOf(currentDate);
    if (idx < 0) {
        idx = dates.findIndex(d => Math.abs(dayNumber(d) - dayNumber(currentDate)) === 1);
        if (idx < 0)
            throw new MalformedError(`${field} does not cover today`);
    }
    return idx;
}

const DAY_MS = 86400000;

function dayNumber(isoDateStr) {
    const [y, m, d] = isoDateStr.split('-').map(Number);
    return Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);
}

/** Aligned-array guard: returns null when a field is unusable. */
function alignedArray(hourly, key, length, field) {
    const arr = hourly[key];
    if (arr === undefined || arr === null)
        return null;
    if (!Array.isArray(arr) || arr.length !== length)
        throw new MalformedError(`${field} is missing or misaligned`);
    return arr;
}

/* ------------------------------------------------------------- entry point */

/**
 * Parse and validate a provider payload into a snapshot.
 *
 * @param {object} raw - parsed JSON from the provider
 * @param {object} meta - {name, latitude, longitude}
 * @returns {object} snapshot
 */
export function parseSnapshot(raw, meta = {}) {
    requireObject(raw, 'payload');
    const current = requireObject(raw.current, 'current');
    const daily = requireObject(raw.daily, 'daily');
    const hourly = requireObject(raw.hourly, 'hourly');

    const curTime = isoTime(current.time, 'current.time');
    const curCode = weatherCode(current.weather_code, 'current.weather_code');
    const isDay = dayFlag(current.is_day, 'current.is_day');
    const cur = classify(curCode, isDay);

    const tempC = num(current.temperature_2m,
        {min: TEMP_C_MIN, max: TEMP_C_MAX, field: 'current.temperature_2m'});
    const feelsC = num(current.apparent_temperature,
        {min: -110, max: 80, field: 'current.apparent_temperature'});
    const precipMm = optionalNum(current.precipitation,
        {min: 0, max: 300, field: 'current.precipitation'}) ?? 0;

    /* --- today ------------------------------------------------------- */

    const dailyTimes = daily.time;
    if (!Array.isArray(dailyTimes) || dailyTimes.length === 0)
        throw new MalformedError('daily.time missing');
    const dayIdx = pickTodayBlock(daily, curTime.date, 'daily');

    const dailyMax = daily.temperature_2m_max;
    const dailyMin = daily.temperature_2m_min;
    if (!Array.isArray(dailyMax) || dailyMax.length !== dailyTimes.length)
        throw new MalformedError('daily.temperature_2m_max missing or misaligned');
    if (!Array.isArray(dailyMin) || dailyMin.length !== dailyTimes.length)
        throw new MalformedError('daily.temperature_2m_min missing or misaligned');
    const dailyProb = alignedArray(daily, 'precipitation_probability_max',
        dailyTimes.length, 'daily.precipitation_probability_max');

    /* --- hourly window ----------------------------------------------- */

    const hourTimes = hourly.time;
    if (!Array.isArray(hourTimes) || hourTimes.length === 0)
        throw new MalformedError('hourly.time missing');
    const n = hourTimes.length;
    const hourCodes = alignedArray(hourly, 'weather_code', n, 'hourly.weather_code');
    const hourTemps = alignedArray(hourly, 'temperature_2m', n, 'hourly.temperature_2m');
    const hourDay = alignedArray(hourly, 'is_day', n, 'hourly.is_day');
    const hourProbs = alignedArray(hourly, 'precipitation_probability', n,
        'hourly.precipitation_probability');
    if (!hourCodes || !hourTemps || !hourDay)
        throw new MalformedError('hourly arrays missing or misaligned');

    // Provider arrays are ascending; find the first hour at or after now.
    let start = hourTimes.findIndex(t => typeof t === 'string' && t >= curTime.iso);
    if (start < 0)
        start = n - 1;

    const hours = [];
    for (let i = start; i < n && hours.length < 8; i++) {
        const t = isoTime(hourTimes[i], `hourly.time[${i}]`);
        const dom = classify(
            weatherCode(hourCodes[i], `hourly.weather_code[${i}]`),
            dayFlag(hourDay[i], `hourly.is_day[${i}]`));
        hours.push({
            iso: t.iso,
            tempC: num(hourTemps[i],
                {min: TEMP_C_MIN, max: TEMP_C_MAX, field: `hourly.temperature_2m[${i}]`}),
            precipProb: hourProbs
                ? optionalNum(hourProbs[i],
                    {min: 0, max: 100, field: `hourly.precipitation_probability[${i}]`})
                : null,
            isDay: dayFlag(hourDay[i], `hourly.is_day[${i}]`),
            condition: dom.condition,
            iconKey: dom.iconKey,
        });
    }
    if (hours.length < 4)
        throw new MalformedError('not enough hourly data at or after the current hour');

    const utcOffsetSeconds = num(raw.utc_offset_seconds,
        {min: -43200, max: 43200, field: 'utc_offset_seconds'});
    const timezone = typeof raw.timezone === 'string' && raw.timezone.length > 0
        ? raw.timezone : 'UTC';

    return {
        fetchedAt: Date.now(),
        location: {
            name: typeof meta.name === 'string' && meta.name !== '' ? meta.name : null,
            latitude: Number.isFinite(meta.latitude) ? meta.latitude : null,
            longitude: Number.isFinite(meta.longitude) ? meta.longitude : null,
            timezone,
        },
        current: {
            tempC,
            feelsC,
            isDay,
            code: curCode,
            condition: cur.condition,
            label: cur.label,
            motion: cur.motion,
            precip: cur.precip,
            iconKey: cur.iconKey,
            recognised: cur.recognised,
            precipMm,
        },
        today: {
            maxC: num(dailyMax[dayIdx],
                {min: TEMP_C_MIN, max: TEMP_C_MAX, field: 'daily.temperature_2m_max'}),
            minC: num(dailyMin[dayIdx],
                {min: TEMP_C_MIN, max: TEMP_C_MAX, field: 'daily.temperature_2m_min'}),
            precipProb: dailyProb
                ? optionalNum(dailyProb[dayIdx],
                    {min: 0, max: 100, field: 'daily.precipitation_probability_max'})
                : null,
        },
        hourly: hours,
        utcOffsetSeconds,
    };
}

/* ------------------------------------------------------------ cache audit */

/**
 * Re-validate a snapshot that came back from disk. Returns the snapshot or
 * null. Cached data is never trusted just because it parsed.
 */
export function auditSnapshot(snap) {
    if (snap === null || typeof snap !== 'object' || Array.isArray(snap))
        return null;
    try {
        if (typeof snap.fetchedAt !== 'number' || !Number.isFinite(snap.fetchedAt) ||
            snap.fetchedAt <= 0)
            return null;

        const loc = requireObject(snap.location, 'location');
        num(loc.latitude, {min: -90, max: 90, field: 'location.latitude'});
        num(loc.longitude, {min: -180, max: 180, field: 'location.longitude'});
        if (typeof loc.timezone !== 'string')
            return null;

        const cur = requireObject(snap.current, 'current');
        num(cur.tempC, {min: TEMP_C_MIN, max: TEMP_C_MAX, field: 'current.tempC'});
        num(cur.feelsC, {min: -110, max: 80, field: 'current.feelsC'});
        if (typeof cur.iconKey !== 'string' || cur.iconKey.length === 0)
            return null;
        if (typeof cur.label !== 'string' || cur.label.length === 0)
            return null;

        requireObject(snap.today, 'today');
        num(snap.today.maxC, {min: TEMP_C_MIN, max: TEMP_C_MAX, field: 'today.maxC'});
        num(snap.today.minC, {min: TEMP_C_MIN, max: TEMP_C_MAX, field: 'today.minC'});

        if (!Array.isArray(snap.hourly) || snap.hourly.length < 4)
            return null;
        for (const h of snap.hourly) {
            requireObject(h, 'hourly entry');
            isoTime(h.iso, 'hourly.iso');
            num(h.tempC, {min: TEMP_C_MIN, max: TEMP_C_MAX, field: 'hourly.tempC'});
            if (typeof h.iconKey !== 'string' || h.iconKey.length === 0)
                return null;
        }
        return snap;
    } catch (e) {
        return null;
    }
}

/* ------------------------------------------------------------------ units */

const FAHRENHEIT_REGIONS = new Set([
    'US', 'BS', 'KY', 'LR', 'PW', 'FM', 'MH',
    'PR', 'VI', 'GU', 'MP', 'AS',
]);

let _autoUnit = null;

/** Fahrenheit only where customary; Celsius everywhere else. */
export function autoUnit() {
    if (_autoUnit)
        return _autoUnit;
    let region = '';
    try {
        const {locale} = new Intl.DateTimeFormat().resolvedOptions();
        region = (String(locale ?? '').split('-')[1] ?? '').toUpperCase();
    } catch (e) {
        region = '';
    }
    _autoUnit = FAHRENHEIT_REGIONS.has(region) ? 'fahrenheit' : 'celsius';
    return _autoUnit;
}

/**
 * @param {('auto'|'celsius'|'fahrenheit')} setting
 * @returns {'celsius'|'fahrenheit'}
 */
export function resolveUnit(setting) {
    if (setting === 'fahrenheit' || setting === 'celsius')
        return setting;
    return autoUnit();
}

/** Convert Celsius for display, e.g. `21°` or `70°`. */
export function displayTemp(tempC, unit) {
    const value = unit === 'fahrenheit' ? tempC * 9 / 5 + 32 : tempC;
    return `${Math.round(value)}°`;
}

/** Same as displayTemp but returns the bare number (for tabular columns). */
export function tempValue(tempC, unit) {
    return Math.round(unit === 'fahrenheit' ? tempC * 9 / 5 + 32 : tempC);
}

/* ------------------------------------------------------------- formatting */

const HOUR_FMT = new Intl.DateTimeFormat(undefined,
    {hour: 'numeric', timeZone: 'UTC'});
const TIME_FMT = new Intl.DateTimeFormat(undefined,
    {hour: 'numeric', minute: '2-digit'});

/** "2026-09-13T14:00" read as a location-local wall time. */
function localIsoToEpoch(iso) {
    const [date, time] = iso.split('T');
    const [y, m, d] = date.split('-').map(Number);
    const [hh, mm] = time.split(':').map(Number);
    return Date.UTC(y, m - 1, d, hh, mm);
}

/** "2 PM" / "14:00" in the user's hour cycle. */
export function formatHour(iso) {
    try {
        return HOUR_FMT.format(new Date(localIsoToEpoch(iso)));
    } catch (e) {
        return iso.slice(11, 16);
    }
}

/** Wall-clock time on *this* machine, used for quiet "updated" notes. */
export function formatWallClock(epochMs) {
    try {
        return TIME_FMT.format(new Date(epochMs));
    } catch (e) {
        return '';
    }
}

/* ------------------------------------------------- presentation decisions */

/**
 * Should "feels like" earn a line of its own? Only when the gap is
 * something a person would actually notice.
 */
export function feelsLikeMatters(tempC, feelsC, unit) {
    const scale = unit === 'fahrenheit' ? 1.8 : 1;
    return Math.abs(tempC - feelsC) * scale >= 3;
}

/**
 * Should precipitation probability be surfaced? Below ~20% it is noise
 * rather than information.
 */
export function precipChanceMatters(prob) {
    return prob !== null && prob !== undefined && prob >= 20;
}

/**
 * One concise semantic sentence for assistive technology. Decorative
 * artwork is hidden from the accessibility tree; this string carries the
 * meaning instead.
 *
 * @param {object} snapshot
 * @param {'celsius'|'fahrenheit'} unit
 * @returns {string}
 */
export function describe(snapshot, unit) {
    if (!snapshot)
        return 'Weather unavailable';
    const {current, today, location} = snapshot;
    const place = location?.name ?? 'your location';
    const parts = [
        `${displayTemp(current.tempC, unit)}, ${current.label.toLowerCase()} in ${place}.`,
        `High ${displayTemp(today.maxC, unit)}, low ${displayTemp(today.minC, unit)}.`,
    ];
    if (feelsLikeMatters(current.tempC, current.feelsC, unit))
        parts.push(`Feels like ${displayTemp(current.feelsC, unit)}.`);
    if (precipChanceMatters(today.precipProb))
        parts.push(`${Math.round(today.precipProb)} percent chance of precipitation.`);
    return parts.join(' ');
}