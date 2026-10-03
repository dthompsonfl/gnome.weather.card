/* icons.js — Weather Card icon rendering.
 *
 * Bridges the domain model's icon keys to the original SVG family in
 * icons/<scheme>/ and loads them through St.TextureCache, which
 * rasterizes at the requested paint scale (HiDPI-crisp), watches the
 * files, and caches textures by file+scale.
 *
 * The light/dark scheme mirrors Main.getStyleVariant() for user
 * sessions: GNOME's user session prefers dark unless the system color
 * scheme says "prefer light".
 *
 * SPDX-License-Identifier: MIT
 */

import Gio from 'gi://Gio';
import St from 'gi://St';

export const ICON_KEYS = [
    'clear-day', 'clear-night', 'partly-day', 'partly-night', 'cloudy',
    'overcast', 'fog', 'drizzle', 'rain', 'sleet', 'snow', 'thunderstorm',
];

/**
 * Current card color scheme ('dark' | 'light').
 *
 * @returns {'dark'|'light'}
 */
export function currentScheme() {
    try {
        const st = St.Settings.get();
        if (st.colorScheme === St.SystemColorScheme.PREFER_LIGHT)
            return 'light';
    } catch (e) {
        // StSettings without color-scheme: fall back to dark.
    }
    return 'dark';
}

/**
 * Watch the system color scheme.
 *
 * @param {() => void} callback
 * @returns {number} signal id for St.Settings
 */
export function watchScheme(callback) {
    return St.Settings.get().connect('notify::color-scheme', callback);
}

/**
 * Whether animations are allowed right now. Honors GNOME's reduced
 * motion on every shell version we target (StSettings:reduced-motion
 * on GNOME 51+, enable-animations earlier).
 *
 * @returns {boolean}
 */
export function animationsEnabled() {
    const st = St.Settings.get();
    try {
        if (st.reducedMotion !== undefined && St.ReducedMotion)
            return st.reducedMotion !== St.ReducedMotion.REDUCE;
    } catch (e) {
        // Fall back to enable-animations below.
    }
    return st.enable_animations;
}

/**
 * Build an icon actor for a domain icon key.
 *
 * @param {string} iconKey - e.g. 'partly-day'
 * @param {number} size - logical size in points
 * @param {object} options - {basePath, scheme, paintScale}
 * @returns {St.Bin} fixed-size container holding the texture
 */
export function iconActor(iconKey, size, {basePath, scheme, paintScale = 1}) {
    const path = `${basePath}/icons/${scheme}/${iconKey}.svg`;
    const file = Gio.File.new_for_path(path);
    const texture = St.TextureCache.get_default().load_file_async(
        file, size, size, Math.max(1, paintScale), 1);
    texture.set_size(size, size);

    const bin = new St.Bin({width: size, height: size});
    bin.set_child(texture);
    return bin;
}
