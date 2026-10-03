/* tokens.js — Weather Card design tokens.
 *
 * The single source of truth for the card's visual language: surfaces,
 * foreground hierarchy, atmospheric accents, geometry, type, depth and
 * motion. CSS cannot read these values, so the few that need to reach the
 * actor tree (accent colours for state-specific atmosphere, layout
 * constants) are exposed here too.
 *
 * The stylesheet owns paint; this file owns decisions. Both are generated
 * from the same conceptual palette by tools/generate-assets.py, which is
 * why the CSS and these tokens cannot drift apart silently.
 *
 * SPDX-License-Identifier: MIT
 */

/** Corner radii, in logical pixels. */
export const RADIUS = {
    card: 26,
    menu: 18,
    control: 12,
    pill: 999,
    hairline: 1,
};

/** Spacing scale, in logical pixels. */
export const SPACE = {
    xs: 2,
    sm: 4,
    md: 8,
    lg: 14,
    xl: 20,
    cardPadX: 24,
    cardPadTop: 22,
    cardPadBottom: 18,
};

/** Fixed layout constants the stylesheet cannot express. */
export const LAYOUT = {
    cardWidth: 336,
    heroIcon: 62,
    hourlyIcon: 26,
    hourlyCount: 8,
    /** Distance kept from a monitor edge when clamping. */
    edgeMargin: 48,
    /** Distance from the top of the monitor for the default position. */
    topOffset: 76,
    /** Minimum size used for clamping before the card has been laid out. */
    fallbackHeight: 300,
};

/**
 * Type roles. St resolves font-family from the shell theme, so nothing here
 * names a typeface — hierarchy comes from weight, scale and tracking.
 */
export const TYPE = {
    heroSize: 66,
    heroWeight: 300,
    heroTracking: -2.5,
    locationSize: 15,
    locationWeight: 600,
    conditionSize: 16,
    conditionWeight: 500,
    metaSize: 13,
    hourTimeSize: 11,
    hourTempSize: 13,
    statusSize: 12,
    titleSize: 20,
    bodySize: 14,
};

/**
 * Motion vocabulary.
 *
 * Every duration is deliberately long and every amplitude tiny. Ambient
 * weather motion should be noticeable only if you look for it: the card is
 * furniture, not a screensaver. Nothing loops faster than 6 s, and nothing
 * moves further than a few logical pixels.
 */
export const MOTION = {
    /** Material and state transitions. */
    quick: 140,
    standard: 220,
    gentle: 320,
    /** Weather scene cross-fade when conditions change. */
    sceneFade: 260,

    /* Ambient loops (duration, travel in logical pixels). */
    breathe: {duration: 7200, scale: 0.014},
    shimmer: {duration: 5200, shift: 3.0},
    drift: {duration: 24000, shift: 7.0},
    driftSlow: {duration: 38000, shift: 5.0},
    mist: {duration: 17000, shift: 9.0},
    fall: {duration: 1500, shift: 26.0},
    snowfall: {duration: 4200, shift: 14.0},
    flash: {duration: 240, hold: 90},
};

/**
 * Atmospheric accents per condition family.
 *
 * These tint the scene's glow layer only — never the glass itself. A
 * rainbow-tinted card would read as decoration rather than weather, so the
 * material stays neutral and the artwork carries the colour.
 */
export const ACCENT = {
    clearDay: {hue: 38, sat: 0.82, light: 0.62},
    clearNight: {hue: 222, sat: 0.45, light: 0.58},
    clouds: {hue: 214, sat: 0.22, light: 0.66},
    overcast: {hue: 216, sat: 0.14, light: 0.58},
    fog: {hue: 208, sat: 0.10, light: 0.72},
    rain: {hue: 205, sat: 0.38, light: 0.58},
    snow: {hue: 200, sat: 0.28, light: 0.78},
    sleet: {hue: 202, sat: 0.24, light: 0.70},
    storm: {hue: 268, sat: 0.34, light: 0.60},
};

/** Map a domain motion class onto its accent. */
export function accentFor(motion) {
    switch (motion) {
    case 'celestial':
        return ACCENT.clearDay;
    case 'clouds':
        return ACCENT.clouds;
    case 'fog':
        return ACCENT.fog;
    case 'rain':
        return ACCENT.rain;
    case 'snow':
        return ACCENT.snow;
    case 'mixed':
        return ACCENT.sleet;
    case 'storm':
        return ACCENT.storm;
    default:
        return ACCENT.overcast;
    }
}

/** Render an accent as an rgba() string for the scene's glow layer. */
export function accentRgba(accent, alpha) {
    return `rgba(${Math.round(accent.hue)}, ${Math.round(accent.light * 100)}, ` +
        `${Math.round(accent.sat * 100)}%, ${alpha})`;
}

/**
 * Foreground luminance decides whether artwork and glows read correctly on
 * a dark or light card. Returned as a rough 0..1 "how light is the text".
 */
export function isLightScheme(scheme) {
    return scheme === 'light';
}