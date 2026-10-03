/* weather.js — Weather Card domain model.
 *
 * Pure logic, no GNOME Shell imports: this module can also be exercised
 * by tooling outside the shell. It maps a validated provider payload
 * into a small, provider-agnostic snapshot the UI renders, so the
 * weather backend can be replaced without touching UI code.
 *
 * SPDX-License-Identifier: MIT
 */

/** Error thrown when a provider payload fails validation. */
export class MalformedError extends Error {
    constructor(message) {
        super(message);
        this.name = 'MalformedError';
    }
}

/* WMO 4677 weather codes (as used by Open-Meteo) mapped onto this
 * widget's own condition domain. Never leak these codes into the UI. */
const WMO_CODES = {
    0: ['clear', 'Clear'],
    1: ['clear', 'Mostly clear'],
    2: ['partly-cloudy', 'Partly cloudy'],
    3: ['overcast', 'Overcast'],
    45: ['fog', 'Foggy'],
    48: ['fog', 'Foggy'],
    51: ['drizzle', 'Light drizzle'],
    53: ['drizzle', 'Drizzle'],
    55: ['drizzle', 'Heavy drizzle'],
    56: ['sleet', 'Freezing drizzle'],
    57: ['sleet', 'Freezing drizzle'],
    61: ['rain', 'Light rain'],
    63: ['rain', 'Rain'],
    65: ['rain', 'Heavy rain'],
    66: ['sleet', 'Freezing rain'],
    67: ['sleet', 'Freezing rain'],
    71: ['snow', 'Light snow'],
    73: ['snow', 'Snow'],
    75: ['snow', 'Heavy snow'],
    77: ['snow', 'Snow grains'],
    80: ['rain', 'Light showers'],
    81: ['rain', 'Showers'],
    82: ['rain', 'Heavy showers'],
    85: ['snow', 'Snow showers'],
    86: ['snow', 'Heavy snow showers'],
    95: ['thunderstorm', 'Thunderstorms'],
    96: ['thunderstorm', 'Thunderstorms'],
    99: ['thunderstorm', 'Thunderstorms'],
};

/* icon family keys — resolved further by icons.js */
const ICON_FOR_CONDITION = {
    'clear': isDay => isDay ? 'clear-day' : 'clear-night',
    'partly-cloudy': isDay => isDay ? 'partly-day' : 'partly-night',
    'overcast': () => 'overcast',
    'cloudy': () => 'cloudy',
    'fog': () => 'fog',
    'drizzle': () => 'drizzle',
    'rain': () => 'rain',
    'sleet': () => 'sleet',
    'snow': () => 'snow',
    'thunderstorm': () => 'thunderstorm',
};

function codeToDomain(code, isDay) {
    const entry = WMO_CODES[code];
    if (!entry)
        throw new MalformedError(`Unknown weather code ${code}`);
    const [condition, label] = entry;
    const iconKey = (ICON_FOR_CONDITION[condition] ?? ICON_FOR_CONDITION['cloudy'])(isDay);
    return {condition, label, iconKey};
}

/* ------------------------------------------------------------ validation */

function num(value, {min, max, field}) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        throw new MalformedError(`${field} is not a number`);
    if (value < min || value > max)
        throw new MalformedError(`${field} out of range (${value})`);
    return value;
}

function optionalNum(value, {min, max, field}) {
    if (value === null || value === undefined)
        return null;
    return num(value, {min, max, field});
}

const ISO_LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isoTime(value, field) {
    if (typeof value !== 'string' || !ISO_LOCAL.test(value))
        throw new MalformedError(`${field} is not a local ISO time (${value})`);
    return value;
}

function isoDate(value, field) {
    if (typeof value !== 'string' || !ISO_DATE.test(value))
        throw new MalformedError(`${field} is not an ISO date (${value})`);
    return value;
}

function bool01(value, field) {
    if (value !== 0 && value !== 1)
        throw new MalformedError(`${field} is not 0/1`);
    return value === 1;
}

function requireObject(value, field) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        throw new MalformedError(`${field} missing`);
    return value;
}

/**
 * Parse and validate a provider payload into a domain snapshot.
 *
 * @param {object} raw - parsed JSON from the provider
 * @param {object} meta - location metadata: {name, latitude, longitude}
 * @returns {object} snapshot — see README "Domain model"
 */
export function parseSnapshot(raw, meta) {
    requireObject(raw, 'payload');

    const current = requireObject(raw.current, 'current');
    const daily = requireObject(raw.daily, 'daily');
    const hourly = requireObject(raw.hourly, 'hourly');

    const curTime = isoTime(current.time, 'current.time');
    const curCode = num(current.weather_code, {min: 0, max: 99, field: 'current.weather_code'});
    // Note: code 0..99 validated; unknown-but-plausible codes are rejected above.
    const isDay = bool01(current.is_day, 'current.is_day');
    const cur = codeToDomain(Math.trunc(curCode), isDay);

    const tempC = num(current.temperature_2m, {min: -90, max: 70, field: 'current.temperature_2m'});
    const feelsC = num(current.apparent_temperature, {min: -110, max: 80, field: 'current.apparent_temperature'});
    const precipMm = optionalNum(current.precipitation, {min: 0, max: 300, field: 'current.precipitation'}) ?? 0;

    const times = daily.time;
    const dailyMax = daily.temperature_2m_max;
    const dailyMin = daily.temperature_2m_min;
    const dailyProb = daily.precipitation_probability_max;
    if (!Array.isArray(times) || times.length < 1 ||
        !Array.isArray(dailyMax) || dailyMax.length < 1 ||
        !Array.isArray(dailyMin) || dailyMin.length < 1)
        throw new MalformedError('daily arrays missing');
    const todayIso = times[0];
    isoDate(todayIso, 'daily.time[0]');
    if (todayIso.slice(0, 10) !== curTime.slice(0, 10))
        throw new MalformedError('daily block does not cover today');

    const hourTimes = hourly.time;
    const hourCodes = hourly.weather_code;
    const hourTemps = hourly.temperature_2m;
    const hourProbs = hourly.precipitation_probability;
    const hourDay = hourly.is_day;
    if (!Array.isArray(hourTimes) || hourTimes.length < 12 ||
        !Array.isArray(hourCodes) || hourCodes.length !== hourTimes.length ||
        !Array.isArray(hourTemps) || hourTemps.length !== hourTimes.length ||
        !Array.isArray(hourDay) || hourDay.length !== hourTimes.length)
        throw new MalformedError('hourly arrays missing or misaligned');
    const probsOk = !hourProbs || (Array.isArray(hourProbs) && hourProbs.length === hourTimes.length);

    // Window: entries at or after the current hour; provider orders them.
    let idx = hourTimes.findIndex(t => t >= curTime);
    if (idx < 0)
        idx = hourTimes.length - 1;
    const hours = [];
    for (let i = idx; i < hourTimes.length && hours.length < 7; i++) {
        const hTime = isoTime(hourTimes[i], `hourly.time[${i}]`);
        const hCode = num(hourCodes[i], {min: 0, max: 99, field: `hourly.weather_code[${i}]`});
        const hDay = bool01(hourDay[i], `hourly.is_day[${i}]`);
        const hTemp = num(hourTemps[i], {min: -90, max: 70, field: `hourly.temperature_2m[${i}]`});
        const hProb = probsOk
            ? optionalNum(hourProbs?.[i], {min: 0, max: 100, field: `hourly.precipitation_probability[${i}]`})
            : null;
        const dom = codeToDomain(Math.trunc(hCode), hDay);
        hours.push({
            iso: hTime,
            tempC: hTemp,
            precipProb: hProb,
            isDay: hDay,
            iconKey: dom.iconKey,
        });
    }
    if (hours.length < 4)
        throw new MalformedError('not enough hourly data after "now"');

    const utcOffsetSeconds = num(raw.utc_offset_seconds, {min: -43200, max: 43200, field: 'utc_offset_seconds'});
    const timezone = typeof raw.timezone === 'string' && raw.timezone.length > 0
        ? raw.timezone : 'UTC';

    return {
        fetchedAt: Date.now(),
        location: {
            name: meta.name ?? null,
            latitude: meta.latitude,
            longitude: meta.longitude,
            timezone,
        },
        current: {
            tempC,
            feelsC,
            isDay,
            code: Math.trunc(curCode),
            condition: cur.condition,
            label: cur.label,
            iconKey: cur.iconKey,
            precipMm,
        },
        today: {
            maxC: num(dailyMax[0], {min: -90, max: 70, field: 'daily.temperature_2m_max[0]'}),
            minC: num(dailyMin[0], {min: -90, max: 70, field: 'daily.temperature_2m_min[0]'}),
            precipProb: optionalNum(Array.isArray(dailyProb) ? dailyProb[0] : null,
                {min: 0, max: 100, field: 'daily.precipitation_probability_max[0]'}),
        },
        hourly: hours,
        utcOffsetSeconds,
    };
}

/**
 * Re-validate a snapshot that came back from the cache. Returns the
 * snapshot or null — cached data is never trusted blindly.
 */
export function auditSnapshot(snap) {
    if (snap === null || typeof snap !== 'object')
        return null;
    try {
        if (typeof snap.fetchedAt !== 'number' || !Number.isFinite(snap.fetchedAt))
            return null;
        const loc = requireObject(snap.location, 'location');
        num(loc.latitude, {min: -90, max: 90, field: 'location.latitude'});
        num(loc.longitude, {min: -180, max: 180, field: 'location.longitude'});
        const cur = requireObject(snap.current, 'current');
        num(cur.tempC, {min: -90, max: 70, field: 'current.tempC'});
        requireObject(snap.today, 'today');
        if (!Array.isArray(snap.hourly) || snap.hourly.length < 4)
            return null;
        for (const h of snap.hourly) {
            requireObject(h, 'hourly entry');
            num(h.tempC, {min: -90, max: 70, field: 'hourly.tempC'});
        }
        return snap;
    } catch (e) {
        return null;
    }
}

/* -------------------------------------------------------------- units */

const FAHRENHEIT_REGIONS = new Set([
    'US', 'BS', 'KY', 'LR', 'PW', 'FM', 'MH',
    'PR', 'VI', 'GU', 'MP', 'AS',
]);

let _autoUnit = null;

/**
 * Resolve the "auto" unit setting from the current locale. Fahrenheit
 * only where it is customary; Celsius elsewhere.
 *
 * @returns {'celsius'|'fahrenheit'}
 */
export function autoUnit() {
    if (_autoUnit)
        return _autoUnit;
    let region = '';
    try {
        const {locale} = new Intl.DateTimeFormat().resolvedOptions();
        const parts = String(locale ?? '').split('-');
        region = (parts[1] ?? '').toUpperCase();
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

/** Convert a Celsius temperature for display in the given unit. */
export function displayTemp(tempC, unit) {
    const value = unit === 'fahrenheit' ? tempC * 9 / 5 + 32 : tempC;
    return `${Math.round(value)}°`;
}

/* ---------------------------------------------------------- formatting */

const HOUR_FMT = new Intl.DateTimeFormat(undefined, {hour: 'numeric', timeZone: 'UTC'});
const TIME_FMT = new Intl.DateTimeFormat(undefined, {hour: 'numeric', minute: '2-digit'});

/** Parse "YYYY-MM-DDTHH:MM" (location-local) into an epoch in ms. */
function localIsoToEpoch(iso) {
    const [date, time] = iso.split('T');
    const [y, m, d] = date.split('-').map(Number);
    const [hh, mm] = time.split(':').map(Number);
    return Date.UTC(y, m - 1, d, hh, mm);
}

/** "2 PM" / "14:00" — location-local hour, user's hour-cycle. */
export function formatHour(iso) {
    try {
        return HOUR_FMT.format(new Date(localIsoToEpoch(iso)));
    } catch (e) {
        return iso.slice(11, 16);
    }
}

/** "2:14 PM" — wall-clock time of *this* machine (for "Updated …"). */
export function formatWallClock(epochMs) {
    try {
        return TIME_FMT.format(new Date(epochMs));
    } catch (e) {
        return '';
    }
}
