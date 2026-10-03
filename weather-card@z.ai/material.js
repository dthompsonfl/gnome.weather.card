/* material.js — Weather Card material system.
 *
 * GNOME has no supported backdrop-blur for shell actors on the versions we
 * target, so "glass" here is built the way optical glass actually reads:
 * a translucent base, a directional light gradient across the top edge, a
 * hairline keyline that separates the card from any wallpaper, and a
 * deliberate ambient tint. The result is dimensional rather than merely
 * transparent, and it costs nothing per frame because none of it animates
 * continuously.
 *
 * St supports the CSS properties used here (verified against the installed
 * theme engine): background-gradient-{start,end,direction} and box-shadow,
 * including `inset`.
 *
 * Runtime re-theming: GNOME Shell loads exactly ONE stylesheet variant per
 * extension, chosen from [`<session>-<variant>.css`, `stylesheet-<variant>.css`,
 * `<session>.css`, `stylesheet.css`] at activation time only. It never
 * re-selects on a light/dark change. So the card ships a single
 * `stylesheet.css` holding scheme-independent rules and swaps only the
 * colour-carrying variant here, through the public St.Theme API.
 *
 * SPDX-License-Identifier: MIT
 */

import Gio from 'gi://Gio';
import St from 'gi://St';

import * as tokens from './tokens.js';

const VARIANT_FILES = ['stylesheet-dark.css', 'stylesheet-light.css'];

/** @param {string} message */
function log(message) {
    // eslint-disable-next-line no-console
    console.debug(`[weather-card] ${message}`);
}

/**
 * Is the system in a high-contrast accessibility mode?
 *
 * St exposes this as a boolean on StSettings; treating it as a first-class
 * mode is what lets the card drop translucency and strengthen its keyline
 * rather than merely tinting text.
 */
export function isHighContrast() {
    try {
        return St.Settings.get().high_contrast === true;
    } catch (e) {
        return false;
    }
}

/**
 * Owns the card's stylesheet variants and switches between them when the
 * system colour scheme changes.
 *
 * A single instance lives on the extension and is shared by the card and
 * its menu, so at most one pair of stylesheets is ever loaded.
 */
export class MaterialTheme {
    /**
     * @param {string} basePath - extension directory
     * @param {string} scheme - initial scheme: 'dark' | 'light'
     */
    constructor(basePath, scheme) {
        this._basePath = basePath;
        this._theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
        this._loaded = new Map();
        this._current = null;
        this._signalId = 0;
        this._destroyed = false;

        for (const file of VARIANT_FILES) {
            const path = `${basePath}/${file}`;
            try {
                this._loaded.set(file, Gio.File.new_for_path(path));
            } catch (e) {
                // A missing variant is not fatal: the base stylesheet alone
                // still yields a legible card.
                log(`material: missing variant ${file}`);
            }
        }

        this._scheme = scheme;
        this._apply();
    }

    /** Current scheme: 'dark' | 'light'. */
    get scheme() {
        return this._scheme;
    }

    /** True when motion is permitted right now (reduced-motion aware). */
    static motionEnabled() {
        const st = St.Settings.get();
        // GNOME 51 added St.ReducedMotion; absent on 50, where the older
        // enable-animations setting is the equivalent signal.
        try {
            if (st.reducedMotion !== undefined && St.ReducedMotion)
                return st.reducedMotion !== St.ReducedMotion.REDUCE;
        } catch (e) {
            // Fall through to enable-animations.
        }
        return st.enable_animations !== false;
    }

    /**
     * Switch scheme. Only acts when the variant actually changes, and
     * tolerates being called while the extension is being torn down.
     *
     * @param {string} scheme
     * @returns {boolean} whether anything changed
     */
    setScheme(scheme) {
        if (this._destroyed || scheme === this._scheme)
            return false;
        this._scheme = scheme;
        this._apply();
        return true;
    }

    /**
     * Watch the system colour scheme.
     *
     * @param {() => void} callback
     * @returns {number} signal id, for disconnecting
     */
    watchScheme(callback) {
        this._signalId = St.Settings.get().connect(
            'notify::color-scheme', callback);
        return this._signalId;
    }

    _apply() {
        if (this._destroyed)
            return;
        const want = this._scheme === 'light'
            ? 'stylesheet-light.css'
            : 'stylesheet-dark.css';

        // Unload the outgoing variant first so the two cannot both apply and
        // fight over the same selectors.
        if (this._current && this._current !== want) {
            const file = this._loaded.get(this._current);
            if (file) {
                try {
                    this._theme.unload_stylesheet(file);
                } catch (e) {
                    // Already unloaded.
                }
            }
            this._current = null;
        }

        if (this._current === want)
            return;

        const file = this._loaded.get(want);
        if (!file)
            return;
        try {
            this._theme.load_stylesheet(file);
            this._current = want;
        } catch (e) {
            logError(e, 'material: could not load stylesheet variant');
        }
    }

    /** Release the stylesheet. Called from disable(). */
    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;

        if (this._signalId) {
            try {
                St.Settings.get().disconnect(this._signalId);
            } catch (e) {
                // Settings object already gone.
            }
            this._signalId = 0;
        }

        if (this._current) {
            const file = this._loaded.get(this._current);
            if (file) {
                try {
                    this._theme.unload_stylesheet(file);
                } catch (e) {
                    // Already unloaded.
                }
            }
        }
        this._current = null;
        this._loaded.clear();
    }
}

/**
 * Build the card's material as a stack of layers.
 *
 * Layering (bottom to top) is what produces the sense of thickness:
 *   1. base      — translucent fill, the "glass" itself
 *   2. light     — top-edge highlight, as if lit from above
 *   3. keyline   — 1px inner border, separating card from wallpaper
 *   4. depth     — soft outer shadow lifting it off the desktop
 *
 * Each layer is a plain St.Widget with a style class; CSS does the painting.
 * Animations are applied to these actors individually (hover lift, press),
 * which is compositor-cheap because only opacity and transform change.
 *
 * @param {object} [options]
 * @returns {St.Widget} the material container, with named children
 */
export function buildMaterial({highContrast = false} = {}) {
    const root = new St.Widget({
        style_class: highContrast
            ? 'wc-material wc-material-hc'
            : 'wc-material',
    });

    const base = new St.Widget({style_class: 'wc-mat-base'});
    const light = new St.Widget({style_class: 'wc-mat-light'});
    const keyline = new St.Widget({style_class: 'wc-mat-keyline'});
    const depth = new St.Widget({style_class: 'wc-mat-depth'});

    root.add_child(base);
    root.add_child(light);
    root.add_child(keyline);
    root.add_child(depth);

    root.materialLayers = {base, light, keyline, depth};
    return root;
}

/**
 * Apply a press/hover depth change to a material container.
 *
 * Kept here rather than in the widget so the card and its menu share one
 * definition of "pressed".
 */
export function setMaterialPressed(material, pressed) {
    const layer = material?.materialLayers?.depth;
    if (!layer)
        return;
    if (pressed) {
        layer.add_style_class_name('wc-mat-depth-pressed');
        layer.remove_style_class_name('wc-mat-depth-rest');
    } else {
        layer.add_style_class_name('wc-mat-depth-rest');
        layer.remove_style_class_name('wc-mat-depth-pressed');
    }
}

/** Corner radius token, re-exported for callers building custom chrome. */
export {tokens as designTokens};