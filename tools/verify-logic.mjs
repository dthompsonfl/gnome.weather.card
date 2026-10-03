#!/usr/bin/env node
/**
 * verify-logic.mjs — development verification for Weather Card's pure
 * domain logic (weather.js).
 *
 * Runs entirely outside GNOME: weather.js deliberately imports nothing
 * from GObject/GNOME, so we can exercise the provider-payload
 * validation, domain mapping, units, and formatting like unit tests.
 *
 * Usage:
 *   node tools/verify-logic.mjs            # synthetic payload suite
 *   node tools/verify-logic.mjs --live     # also fetch a live payload
 *                                          # from Open-Meteo and parse it
 *
 * SPDX-License-Identifier: MIT
 */

import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import process from 'node:process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const weather = await import(
    path.join(HERE, '..', 'weather-card@z.ai', 'weather.js'));

let passed = 0;
function ok(name, fn) {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
}

/* ------------------------------------------------------- sample payload */

function samplePayload(overrides = {}) {
    const hours = [];
    // 2026-09-13 local, 48 entries starting at 00:00
    for (let i = 0; i < 48; i++) {
        const hh = String(Math.floor(i / 2)).padStart(2, '0');
        const mm = i % 2 === 0 ? '00' : '30';
        hours.push({
            time: `2026-09-13T${hh}:${mm}`,
            weather_code: [3, 61, 80, 0, 2, 95][i % 6],
            temperature_2m: 12 + (i % 10),
            precipitation_probability: [null, 10, 40, 90][i % 4],
            is_day: (i >= 12 && i < 36) ? 1 : 0,
        });
    }
    const payload = {
        latitude: 52.52,
        longitude: 13.41,
        timezone: 'Europe/Berlin',
        utc_offset_seconds: 7200,
        current: {
            time: '2026-09-13T14:00',
            temperature_2m: 21.3,
            apparent_temperature: 20.1,
            is_day: 1,
            precipitation: 0.0,
            weather_code: 3,
            interval: 900,
        },
        daily: {
            time: ['2026-09-13', '2026-09-14'],
            temperature_2m_max: [23.4, 21.2],
            temperature_2m_min: [12.1, 11.8],
            precipitation_probability_max: [30, 10],
            weather_code: [3, 61],
        },
        hourly: {
            time: hours.map(h => h.time),
            weather_code: hours.map(h => h.weather_code),
            temperature_2m: hours.map(h => h.temperature_2m),
            precipitation_probability: hours.map(h => h.precipitation_probability),
            is_day: hours.map(h => h.is_day),
        },
    };
    return {...payload, ...overrides};
}

const meta = {name: 'Berlin', latitude: 52.52, longitude: 13.41};

/* ---------------------------------------------------------------- tests */

console.log('parseSnapshot — happy path');
ok('parses a well-formed payload', () => {
    const snap = weather.parseSnapshot(samplePayload(), meta);
    assert.equal(snap.current.tempC, 21.3);
    assert.equal(snap.current.feelsC, 20.1);
    assert.equal(snap.current.isDay, true);
    assert.equal(snap.current.label, 'Overcast');
    assert.equal(snap.current.iconKey, 'overcast');
    assert.equal(snap.today.maxC, 23.4);
    assert.equal(snap.today.minC, 12.1);
    assert.equal(snap.today.precipProb, 30);
    assert.equal(snap.location.timezone, 'Europe/Berlin');
    assert.equal(snap.utcOffsetSeconds, 7200);
});
ok('hourly window starts at the current hour', () => {
    const snap = weather.parseSnapshot(samplePayload(), meta);
    assert.equal(snap.hourly[0].iso, '2026-09-13T14:00');
    assert.equal(snap.hourly.length, 7);
});
ok('night hours map to night icons', () => {
    const nightNow = samplePayload({
        current: {...samplePayload().current, time: '2026-09-13T21:00', is_day: 0, weather_code: 0},
    });
    const snap = weather.parseSnapshot(nightNow, meta);
    assert.equal(snap.hourly[0].iso, '2026-09-13T21:00');
    assert.equal(snap.hourly[0].isDay, false);
    assert.equal(snap.current.iconKey, 'clear-night');
});
ok('auto (null) name is preserved', () => {
    const snap = weather.parseSnapshot(samplePayload(), {name: null, latitude: 1, longitude: 2});
    assert.equal(snap.location.name, null);
});

console.log('WMO code mapping — every code in the table resolves');
ok('all documented WMO codes map to a domain + icon', () => {
    const codes = [0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67,
        71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99];
    const iconKeys = new Set(['clear-day', 'clear-night', 'partly-day',
        'partly-night', 'cloudy', 'overcast', 'fog', 'drizzle', 'rain',
        'sleet', 'snow', 'thunderstorm']);
    for (const code of codes) {
        for (const isDay of [0, 1]) {
            const snap = weather.parseSnapshot(
                samplePayload({
                    current: {...samplePayload().current, weather_code: code, is_day: isDay},
                }), meta);
            assert.ok(iconKeys.has(snap.current.iconKey),
                `code ${code} day ${isDay} -> ${snap.current.iconKey}`);
            assert.ok(snap.current.label.length > 0);
        }
    }
});

console.log('parseSnapshot — rejects malformed payloads');
const malformed = [
    ['missing current', p => ({...p, current: undefined})],
    ['temperature NaN', p => samplePayloadWithCurrent(p, {temperature_2m: NaN})],
    ['temperature out of range', p => samplePayloadWithCurrent(p, {temperature_2m: 999})],
    ['unknown weather code', p => samplePayloadWithCurrent(p, {weather_code: 17})],
    ['is_day not 0/1', p => samplePayloadWithCurrent(p, {is_day: 2})],
    ['bad current time', p => samplePayloadWithCurrent(p, {time: '14:00'})],
    ['misaligned hourly arrays', p => ({
        ...p,
        hourly: {...p.hourly, temperature_2m: p.hourly.temperature_2m.slice(0, 40)},
    })],
    ['too few hours', p => ({
        ...p,
        hourly: {
            time: p.hourly.time.slice(0, 30),
            weather_code: p.hourly.weather_code.slice(0, 30),
            temperature_2m: p.hourly.temperature_2m.slice(0, 30),
            is_day: p.hourly.is_day.slice(0, 30),
        },
    })],
    ['bad hour time format', p => ({
        ...p,
        hourly: {...p.hourly, time: p.hourly.time.map((t, i) => i === 30 ? 'nope' : t)},
    })],
    ['daily not covering today', p => ({
        ...p,
        daily: {...p.daily, time: ['2026-09-12', '2026-09-13']},
    })],
    ['daily max missing', p => ({...p, daily: {time: p.daily.time}})],
    ['bad utc offset', p => ({...p, utc_offset_seconds: 100000})],
];
function samplePayloadWithCurrent(p, patch) {
    return {...p, current: {...p.current, ...patch}};
}
for (const [name, mutate] of malformed) {
    ok(`rejects: ${name}`, () => {
        const payload = mutate(samplePayload());
        assert.throws(() => weather.parseSnapshot(payload, meta),
            weather.MalformedError);
    });
}

console.log('auditSnapshot — cache re-validation');
ok('accepts a valid snapshot', () => {
    const snap = weather.parseSnapshot(samplePayload(), meta);
    const copy = JSON.parse(JSON.stringify(snap));
    assert.deepEqual(weather.auditSnapshot(copy), snap);
});
ok('rejects corrupted cache entries', () => {
    const snap = weather.parseSnapshot(samplePayload(), meta);
    const broken = JSON.parse(JSON.stringify(snap));
    broken.current.tempC = 'warm';
    assert.equal(weather.auditSnapshot(broken), null);
    assert.equal(weather.auditSnapshot(null), null);
    assert.equal(weather.auditSnapshot({}), null);
    assert.equal(weather.auditSnapshot({fetchedAt: 'x'}), null);
});

console.log('units');
ok('resolveUnit honors explicit choices', () => {
    assert.equal(weather.resolveUnit('fahrenheit'), 'fahrenheit');
    assert.equal(weather.resolveUnit('celsius'), 'celsius');
});
ok('resolveUnit auto falls back to a valid unit', () => {
    const unit = weather.resolveUnit('auto');
    assert.ok(unit === 'celsius' || unit === 'fahrenheit');
});
ok('displayTemp converts correctly', () => {
    assert.equal(weather.displayTemp(0, 'celsius'), '0°');
    assert.equal(weather.displayTemp(21.3, 'celsius'), '21°');
    assert.equal(weather.displayTemp(0, 'fahrenheit'), '32°');
    assert.equal(weather.displayTemp(100, 'fahrenheit'), '212°');
    assert.equal(weather.displayTemp(-40, 'fahrenheit'), '-40°');
});

console.log('formatting');
ok('formatHour renders the location-local hour', () => {
    const out = weather.formatHour('2026-09-13T14:00');
    assert.match(out, /14|2\s?PM/i, `got ${out}`);
});
ok('formatWallClock renders a wall time', () => {
    const out = weather.formatWallClock(Date.UTC(2026, 8, 13, 12, 14));
    assert.match(out, /\d{1,2}:\d{2}/, `got ${out}`);
});
ok('formatHour tolerates unparseable input', () => {
    // Must never throw; falls back to a (possibly empty) string.
    assert.equal(typeof weather.formatHour('garbage'), 'string');
});

console.log(`\n${passed} checks passed.`);

/* ------------------------------------------------------------ live mode */

if (process.argv.includes('--live')) {
    const url = 'https://api.open-meteo.com/v1/forecast?latitude=52.52&longitude=13.41' +
        '&current=temperature_2m,apparent_temperature,is_day,precipitation,weather_code' +
        '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max' +
        '&hourly=weather_code,temperature_2m,precipitation_probability,is_day' +
        '&timezone=auto&forecast_days=2&temperature_unit=celsius';
    console.log('\nLive fetch:', url);
    try {
        const res = await fetch(url, {headers: {'User-Agent': 'weather-card-dev/1.0'}});
        console.log('HTTP', res.status);
        const json = await res.json();
        const snap = weather.parseSnapshot(json, meta);
        console.log('Live parse OK:', snap.current.label, snap.current.tempC,
            snap.location.timezone, `${snap.hourly.length} hourly entries`);
    } catch (e) {
        console.log('Live fetch/parse FAILED:', e.message);
        process.exitCode = 1;
    }
} else {
    console.log('\n(use --live to also fetch + parse a real payload)');
}
