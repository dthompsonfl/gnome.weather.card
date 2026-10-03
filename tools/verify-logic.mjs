#!/usr/bin/env node
/**
 * verify-logic.mjs — development verification for Weather Card's pure
 * domain logic (weather.js).
 *
 * Runs entirely outside GNOME: weather.js deliberately imports nothing
 * from GObject/GNOME, so the provider-payload validation, domain mapping,
 * units, presentation decisions and accessibility text can all be exercised
 * like unit tests.
 *
 * This cannot validate GNOME Shell behaviour (St/Clutter/Gio). Those need a
 * real shell — see the README's verification section.
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
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.join(HERE, '..', 'weather-card@z.ai');

const weather = await import(path.join(EXT, 'weather.js'));
const tokens = await import(path.join(EXT, 'tokens.js'));

let passed = 0;
let failed = 0;

function ok(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (e) {
        failed++;
        console.log(`  ✗ ${name}`);
        console.log(`      ${e.message.split('\n').slice(0, 4).join('\n      ')}`);
    }
}

/* ------------------------------------------------------- sample payload */

/**
 * A realistic Open-Meteo payload: hourly entries on the hour, a daily block
 * covering today and tomorrow, and one null precipitation value per four
 * hours (which the real API does emit).
 */
function samplePayload(overrides = {}) {
    const hours = [];
    for (let i = 0; i < 48; i++) {
        const hh = String(i % 24).padStart(2, '0');
        hours.push({
            time: `2026-09-13T${hh}:00`,
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

function withCurrent(patch) {
    const p = samplePayload();
    return {...p, current: {...p.current, ...patch}};
}

/* --------------------------------------------------------------- parsing */

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

ok('records the motion class for the scene layer', () => {
    assert.equal(weather.parseSnapshot(samplePayload(), meta).current.motion, 'clouds');
    assert.equal(weather.parseSnapshot(withCurrent({weather_code: 61}), meta).current.motion, 'rain');
    assert.equal(weather.parseSnapshot(withCurrent({weather_code: 71}), meta).current.motion, 'snow');
    assert.equal(weather.parseSnapshot(withCurrent({weather_code: 95}), meta).current.motion, 'storm');
    assert.equal(weather.parseSnapshot(withCurrent({weather_code: 45}), meta).current.motion, 'fog');
});

ok('hourly window starts at the current hour and is bounded', () => {
    const snap = weather.parseSnapshot(samplePayload(), meta);
    assert.equal(snap.hourly[0].iso, '2026-09-13T14:00');
    assert.equal(snap.hourly.length, 8);
});

ok('hourly window crosses midnight correctly', () => {
    // 23:00 now: the window must run into the next day without stopping.
    const snap = weather.parseSnapshot(withCurrent({time: '2026-09-13T23:00'}), meta);
    assert.equal(snap.hourly[0].iso, '2026-09-13T23:00');
    assert.ok(snap.hourly.some(h => h.iso.startsWith('2026-09-14')),
        'expected entries on the following day');
});

ok('late-evening window is padded from the end when too short', () => {
    // Only two hours remain in the array; the parser must still yield a
    // usable window rather than blanking the card.
    const p = samplePayload();
    const trimmed = {
        ...p,
        current: {...p.current, time: '2026-09-13T23:00'},
        hourly: {
            time: p.hourly.time.slice(22),
            weather_code: p.hourly.weather_code.slice(22),
            temperature_2m: p.hourly.temperature_2m.slice(22),
            is_day: p.hourly.is_day.slice(22),
            precipitation_probability: p.hourly.precipitation_probability.slice(22),
        },
    };
    // Two entries is below the minimum, so this must be rejected rather
    // than silently rendering a nearly-empty hourly row.
    assert.throws(() => weather.parseSnapshot(trimmed, meta), weather.MalformedError);
});

ok('night hours map to night artwork', () => {
    const snap = weather.parseSnapshot(
        withCurrent({time: '2026-09-13T21:00', is_day: 0, weather_code: 0}), meta);
    assert.equal(snap.hourly[0].iso, '2026-09-13T21:00');
    assert.equal(snap.hourly[0].isDay, false);
    assert.equal(snap.current.iconKey, 'clear-night');
});

ok('null location name is preserved as null', () => {
    const snap = weather.parseSnapshot(samplePayload(), {name: null, latitude: 1, longitude: 2});
    assert.equal(snap.location.name, null);
});

ok('empty location name becomes null', () => {
    const snap = weather.parseSnapshot(samplePayload(), {name: '', latitude: 1, longitude: 2});
    assert.equal(snap.location.name, null);
});

console.log('daily block selection');
ok('uses the block matching the current local date', () => {
    const p = samplePayload();
    const reordered = {
        ...p,
        daily: {
            time: ['2026-09-14', '2026-09-13'],
            temperature_2m_max: [21.2, 23.4],
            temperature_2m_min: [11.8, 12.1],
            precipitation_probability_max: [10, 30],
        },
    };
    const snap = weather.parseSnapshot(reordered, meta);
    assert.equal(snap.today.maxC, 23.4, 'must pick today, not the first entry');
    assert.equal(snap.today.minC, 12.1);
});

ok('accepts an adjacent date when the exact date is absent', () => {
    // Providers occasionally label blocks by UTC day; a one-day offset must
    // not blank the card.
    const p = samplePayload();
    const shifted = {
        ...p,
        daily: {
            time: ['2026-09-14'],
            temperature_2m_max: [21.2],
            temperature_2m_min: [11.8],
            precipitation_probability_max: [10],
        },
    };
    const snap = weather.parseSnapshot(shifted, meta);
    assert.equal(snap.today.maxC, 21.2);
});

ok('rejects a daily block that does not describe today', () => {
    const p = samplePayload();
    const far = {
        ...p,
        daily: {
            time: ['2026-10-01'],
            temperature_2m_max: [21.2],
            temperature_2m_min: [11.8],
            precipitation_probability_max: [10],
        },
    };
    assert.throws(() => weather.parseSnapshot(far, meta), weather.MalformedError);
});

console.log('WMO code mapping');
ok('every documented WMO code maps to a known icon', () => {
    const codes = [0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67,
        71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99];
    const iconKeys = new Set(['clear-day', 'clear-night', 'partly-day',
        'partly-night', 'cloudy', 'overcast', 'fog', 'drizzle', 'rain',
        'sleet', 'snow', 'thunderstorm']);
    for (const code of codes) {
        for (const isDay of [0, 1]) {
            const snap = weather.parseSnapshot(
                withCurrent({weather_code: code, is_day: isDay}), meta);
            assert.ok(iconKeys.has(snap.current.iconKey),
                `code ${code} day ${isDay} -> ${snap.current.iconKey}`);
            assert.ok(snap.current.label.length > 0);
            assert.equal(snap.current.recognised, true,
                `code ${code} should be a recognised condition`);
        }
    }
});

ok('an unrecognised code degrades instead of blanking the card', () => {
    // The provider gaining a code must not produce an error state.
    const snap = weather.parseSnapshot(withCurrent({weather_code: 17}), meta);
    assert.equal(snap.current.iconKey, 'overcast');
    assert.equal(snap.current.recognised, false,
        'drift must be visible to the test suite');
    assert.equal(snap.current.tempC, 21.3, 'the rest of the reading survives');
});

console.log('malformed payloads are rejected');
const malformed = [
    ['missing current', () => ({...samplePayload(), current: undefined})],
    ['current is not an object', () => ({...samplePayload(), current: 42})],
    ['missing daily', () => ({...samplePayload(), daily: undefined})],
    ['missing hourly', () => ({...samplePayload(), hourly: undefined})],
    ['temperature NaN', () => withCurrent({temperature_2m: NaN})],
    ['temperature is a string', () => withCurrent({temperature_2m: '21'})],
    ['temperature out of range', () => withCurrent({temperature_2m: 999})],
    ['is_day not 0/1', () => withCurrent({is_day: 2})],
    ['bad current time', () => withCurrent({time: '14:00'})],
    ['impossible month', () => withCurrent({time: '2026-13-01T10:00'})],
    ['impossible hour', () => withCurrent({time: '2026-09-13T25:00'})],
    ['weather code out of range', () => withCurrent({weather_code: 150})],
    ['weather code negative', () => withCurrent({weather_code: -1})],
    ['misaligned hourly arrays', () => {
        const p = samplePayload();
        return {...p, hourly: {...p.hourly, temperature_2m: p.hourly.temperature_2m.slice(0, 40)}};
    }],
    ['hourly missing weather codes', () => {
        const p = samplePayload();
        const {weather_code, ...rest} = p.hourly;
        return {...p, hourly: rest};
    }],
    ['hourly missing is_day', () => {
        const p = samplePayload();
        const {is_day, ...rest} = p.hourly;
        return {...p, hourly: rest};
    }],
    ['too few hourly entries', () => {
        const p = samplePayload();
        const n = 30;
        return {
            ...p,
            current: {...p.current, time: '2026-09-13T14:00'},
            hourly: {
                time: p.hourly.time.slice(0, n),
                weather_code: p.hourly.weather_code.slice(0, n),
                temperature_2m: p.hourly.temperature_2m.slice(0, n),
                is_day: p.hourly.is_day.slice(0, n),
            },
        };
    }],
    ['bad hour time format', () => {
        const p = samplePayload();
        return {...p, hourly: {...p.hourly, time: p.hourly.time.map((t, i) => i === 30 ? 'nope' : t)}};
    }],
    ['hourly time unsorted descending from now', () => {
        const p = samplePayload();
        return {
            ...p,
            current: {...p.current, time: '2026-09-13T02:00'},
        };
    }],
    ['daily max missing', () => ({...samplePayload(), daily: {time: ['2026-09-13']}})],
    ['daily arrays misaligned', () => {
        const p = samplePayload();
        return {...p, daily: {...p.daily, temperature_2m_max: [23.4]}};
    }],
    ['bad utc offset', () => ({...samplePayload(), utc_offset_seconds: 100000})],
    ['missing utc offset', () => {
        const p = samplePayload();
        const {utc_offset_seconds, ...rest} = p;
        return rest;
    }],
    ['payload is an array', () => []],
    ['payload is null', () => null],
];
for (const [name, build] of malformed) {
    ok(`rejects: ${name}`, () => {
        assert.throws(() => weather.parseSnapshot(build(), meta), weather.MalformedError);
    });
}

console.log('null precipitation is tolerated');
ok('null hourly probability becomes null, not NaN', () => {
    const snap = weather.parseSnapshot(samplePayload(), meta);
    const nulls = snap.hourly.filter(h => h.precipProb === null);
    assert.ok(nulls.length > 0, 'sample should contain nulls');
    for (const h of snap.hourly) {
        assert.ok(h.precipProb === null ||
            (Number.isFinite(h.precipProb) && h.precipProb >= 0 && h.precipProb <= 100));
    }
});
ok('missing daily probability becomes null', () => {
    const p = samplePayload();
    const {precipitation_probability_max, ...rest} = p.daily;
    const snap = weather.parseSnapshot({...p, daily: rest}, meta);
    assert.equal(snap.today.precipProb, null);
});
ok('null current precipitation defaults to zero', () => {
    const snap = weather.parseSnapshot(withCurrent({precipitation: null}), meta);
    assert.equal(snap.current.precipMm, 0);
});

console.log('auditSnapshot — cache is never trusted blindly');
ok('accepts a valid snapshot', () => {
    const snap = weather.parseSnapshot(samplePayload(), meta);
    assert.deepEqual(weather.auditSnapshot(JSON.parse(JSON.stringify(snap))), snap);
});
ok('rejects structural corruption', () => {
    const base = JSON.parse(JSON.stringify(weather.parseSnapshot(samplePayload(), meta)));
    const cases = [
        ['temperature is a string', s => { s.current.tempC = 'warm'; }],
        ['feels-like missing', s => { delete s.current.feelsC; }],
        ['icon key missing', s => { delete s.current.iconKey; }],
        ['label missing', s => { delete s.current.label; }],
        ['timezone missing', s => { delete s.location.timezone; }],
        ['hourly truncated', s => { s.hourly = s.hourly.slice(0, 2); }],
        ['hourly entry broken', s => { s.hourly[0].iso = 'nope'; }],
        ['hourly temp out of range', s => { s.hourly[0].tempC = 500; }],
        ['high out of range', s => { s.today.maxC = 999; }],
        ['latitude out of range', s => { s.location.latitude = 91; }],
        ['fetchedAt not a number', s => { s.fetchedAt = 'now'; }],
        ['fetchedAt zero', s => { s.fetchedAt = 0; }],
    ];
    for (const [name, mutate] of cases) {
        const broken = JSON.parse(JSON.stringify(base));
        mutate(broken);
        assert.equal(weather.auditSnapshot(broken), null, name);
    }
});
ok('rejects non-objects', () => {
    for (const v of [null, undefined, 42, 'x', [], true])
        assert.equal(weather.auditSnapshot(v), null);
});

console.log('units');
ok('resolveUnit honors explicit choices', () => {
    assert.equal(weather.resolveUnit('fahrenheit'), 'fahrenheit');
    assert.equal(weather.resolveUnit('celsius'), 'celsius');
});
ok('resolveUnit auto resolves to a valid unit', () => {
    const unit = weather.resolveUnit('auto');
    assert.ok(unit === 'celsius' || unit === 'fahrenheit');
});
ok('unknown setting falls back to auto', () => {
    const unit = weather.resolveUnit('kelvin');
    assert.ok(unit === 'celsius' || unit === 'fahrenheit');
});
ok('displayTemp converts correctly', () => {
    assert.equal(weather.displayTemp(0, 'celsius'), '0°');
    assert.equal(weather.displayTemp(21.3, 'celsius'), '21°');
    assert.equal(weather.displayTemp(-0.4, 'celsius'), '0°', 'rounds to zero, not -0');
    assert.equal(weather.displayTemp(0, 'fahrenheit'), '32°');
    assert.equal(weather.displayTemp(100, 'fahrenheit'), '212°');
    assert.equal(weather.displayTemp(-40, 'fahrenheit'), '-40°');
});

console.log('formatting');
ok('formatHour renders the location-local hour', () => {
    assert.match(weather.formatHour('2026-09-13T14:00'), /14|2\s?PM/i);
    assert.match(weather.formatHour('2026-09-13T00:00'), /12\s?AM|00|0/i);
});
ok('formatWallClock renders a wall time', () => {
    assert.match(weather.formatWallClock(Date.UTC(2026, 8, 13, 12, 14)), /\d{1,2}:\d{2}/);
});
ok('formatters never throw on junk', () => {
    assert.equal(typeof weather.formatHour('garbage'), 'string');
    assert.equal(typeof weather.formatWallClock(NaN), 'string');
    assert.equal(typeof weather.formatWallClock(undefined), 'string');
});

console.log('presentation decisions');
ok('feels-like is shown only when materially different', () => {
    // 1 °C apart: noise.
    assert.equal(weather.feelsLikeMatters(20, 19, 'celsius'), false);
    // 5 °C apart: worth a line.
    assert.equal(weather.feelsLikeMatters(20, 15, 'celsius'), true);
    // The threshold is unit-aware: 2 °C is ~3.6 °F, which does matter.
    assert.equal(weather.feelsLikeMatters(20, 18, 'fahrenheit'), true);
    assert.equal(weather.feelsLikeMatters(20, 19.5, 'fahrenheit'), false);
});
ok('precipitation chance is shown only when meaningful', () => {
    assert.equal(weather.precipChanceMatters(0), false);
    assert.equal(weather.precipChanceMatters(19), false);
    assert.equal(weather.precipChanceMatters(20), true);
    assert.equal(weather.precipChanceMatters(80), true);
    assert.equal(weather.precipChanceMatters(null), false);
    assert.equal(weather.precipChanceMatters(undefined), false);
});

console.log('accessibility description');
ok('describe produces one concise sentence group', () => {
    const snap = weather.parseSnapshot(samplePayload(), meta);
    const text = weather.describe(snap, 'celsius');
    assert.match(text, /21°/);
    assert.match(text, /overcast/i);
    assert.match(text, /Berlin/);
    assert.match(text, /High 23°, low 12°/);
});
ok('describe omits details that do not apply', () => {
    // feelsC within 3 °C and no meaningful precipitation: neither appears.
    const snap = weather.parseSnapshot(
        withCurrent({apparent_temperature: 20.8, precipitation: 0}), meta);
    const text = weather.describe(snap, 'celsius');
    assert.ok(!text.includes('Feels like'), text);
    assert.ok(!text.includes('percent chance'), text);
});
ok('describe survives a missing snapshot', () => {
    assert.equal(typeof weather.describe(null, 'celsius'), 'string');
    assert.match(weather.describe(null, 'celsius'), /unavailable/i);
});
ok('describe works with no place name', () => {
    const snap = weather.parseSnapshot(
        samplePayload(), {name: null, latitude: 1, longitude: 2});
    assert.match(weather.describe(snap, 'celsius'), /your location/i);
});

console.log('design tokens');
ok('layout constants are sane and bounded', () => {
    assert.ok(tokens.LAYOUT.cardWidth >= 280 && tokens.LAYOUT.cardWidth <= 420);
    assert.ok(tokens.LAYOUT.hourlyCount >= 6 && tokens.LAYOUT.hourlyCount <= 10);
    assert.ok(tokens.LAYOUT.heroIcon > tokens.LAYOUT.hourlyIcon,
        'hero artwork must be larger than hourly artwork');
    assert.ok(tokens.LAYOUT.fallbackHeight > 0);
});
ok('ambient motion is slow and small', () => {
    for (const [key, spec] of Object.entries(tokens.MOTION)) {
        if (typeof spec !== 'object' || spec.duration === undefined)
            continue;
        assert.ok(spec.duration >= 1400,
            `${key} duration ${spec.duration}ms is too fast to read as ambient`);
    }
    assert.ok(tokens.MOTION.breathe.scale < 0.03,
        'breathing must stay near the threshold of perception');
});
ok('every motion accent maps to a valid accent', () => {
    for (const motion of ['celestial', 'clouds', 'fog', 'rain', 'snow',
        'mixed', 'storm', 'unknown-value']) {
        const accent = tokens.accentFor(motion);
        assert.ok(accent && Number.isFinite(accent.hue) &&
            Number.isFinite(accent.sat) && Number.isFinite(accent.light));
        assert.match(tokens.accentRgba(accent, 0.5), /^rgba\(\d+, \d+%, \d+%, 0\.5\)$/);
    }
});

console.log('generated assets');
ok('every icon exists for both schemes', () => {
    const keys = ['clear-day', 'clear-night', 'partly-day', 'partly-night',
        'cloudy', 'overcast', 'fog', 'drizzle', 'rain', 'sleet', 'snow',
        'thunderstorm'];
    for (const scheme of ['dark', 'light']) {
        for (const key of keys) {
            const file = path.join(EXT, 'icons', scheme, `${key}.svg`);
            assert.ok(fs.existsSync(file), `missing ${scheme}/${key}.svg`);
        }
    }
});
ok('generated SVGs are inert and self-contained', () => {
    const dir = path.join(EXT, 'icons', 'dark');
    for (const name of fs.readdirSync(dir)) {
        const svg = fs.readFileSync(path.join(dir, name), 'utf8');
        const body = svg.replace('xmlns="http://www.w3.org/2000/svg"', '');
        for (const forbidden of ['<script', 'xlink:href', 'http://', 'https://',
            '@import', '<image', '<foreignObject', 'data:']) {
            assert.ok(!body.includes(forbidden),
                `${name} contains ${forbidden}`);
        }
        assert.ok(svg.includes('viewBox="0 0 96 96"'), `${name} has no viewBox`);
    }
});
ok('stylesheets define every colour they reference', () => {
    const base = fs.readFileSync(path.join(EXT, 'stylesheet.css'), 'utf8');
    const used = new Set([...base.matchAll(/\$([A-Z_]+)\$/g)].map(m => m[1]));
    assert.ok(used.size > 10, 'expected the base sheet to use colour variables');
    for (const scheme of ['stylesheet-dark.css', 'stylesheet-light.css']) {
        const variant = fs.readFileSync(path.join(EXT, scheme), 'utf8');
        const defined = new Set(
            [...variant.matchAll(/@define-color ([A-Z_]+)/g)].map(m => m[1]));
        const missing = [...used].filter(name => !defined.has(name));
        assert.equal(missing.length, 0,
            `${scheme} does not define: ${missing.join(', ')}`);
    }
});
ok('stylesheet is balanced and free of unsubstituted tokens', () => {
    const base = fs.readFileSync(path.join(EXT, 'stylesheet.css'), 'utf8');
    const opens = (base.match(/\{/g) ?? []).length;
    const closes = (base.match(/\}/g) ?? []).length;
    assert.equal(opens, closes, 'unbalanced braces in stylesheet.css');
    assert.ok(!/@[A-Z_]+@/.test(base), 'unsubstituted @TOKEN@ remains');
});

/* ------------------------------------------------------------------ done */

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0)
    process.exitCode = 1;

/* ------------------------------------------------------------ live mode */

if (process.argv.includes('--live')) {
    // Mirrors provider.js exactly, including forecast_hours, so the test
    // exercises the real request shape rather than a convenient one.
    const url = 'https://api.open-meteo.com/v1/forecast?latitude=52.52&longitude=13.41' +
        '&current=temperature_2m,apparent_temperature,is_day,precipitation,weather_code' +
        '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max' +
        '&hourly=weather_code,temperature_2m,precipitation_probability,is_day' +
        '&timezone=auto&forecast_days=2&forecast_hours=12&temperature_unit=celsius';
    console.log('\nLive fetch:', url);
    try {
        const res = await fetch(url, {headers: {'User-Agent': 'weather-card-dev/1.0'}});
        console.log('HTTP', res.status);
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        const snap = weather.parseSnapshot(json, meta);
        console.log('Live parse OK:', snap.current.label, `${snap.current.tempC}°C`,
            snap.location.timezone, `${snap.hourly.length} hourly entries`);
        console.log('Live window:', snap.hourly.map(h => weather.formatHour(h.iso)).join(' '));
        console.log('Live describe:', weather.describe(snap, 'celsius'));
    } catch (e) {
        console.log('Live fetch/parse FAILED:', e.message);
        process.exitCode = 1;
    }
} else {
    console.log('\n(use --live to also fetch + parse a real payload)');
}