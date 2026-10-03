/* scene.js — Weather Card scene and ambient motion.
 *
 * Renders the hero weather illustration as a small stack of layers and gives
 * each condition restrained, compositor-native motion.
 *
 * Performance contract (this is the important part):
 *
 *   * No JavaScript animation loop. No setInterval, no frame callbacks, no
 *     per-frame JS. Every motion is a Clutter transition on an existing
 *     actor, so the compositor runs it off the main thread.
 *   * Only opacity, translation and scale animate. No layout properties are
 *     ever animated, so nothing triggers a re-layout.
 *   * Actors are created once per scene and reused across condition
 *     changes; transitions cross-fade between two scenes rather than
 *     rebuilding.
 *   * Actor count is bounded and small (see LAYERS below).
 *   * All motion stops when the scene is hidden, when the card is in the
 *     overview, when the extension is disabled, and when the system asks for
 *     reduced motion.
 *
 * Artwork comes from the repository's own generated SVGs via icons.js, so
 * there is no per-frame parsing and no remote asset.
 *
 * SPDX-License-Identifier: MIT
 */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {MaterialTheme} from './material.js';
import * as tokens from './tokens.js';

const EASE = Clutter.AnimationMode.EASE_OUT_QUAD;
const EASE_SOFT = Clutter.AnimationMode.EASE_OUT_CUBIC;

/**
 * Per-condition layer plan.
 *
 * `art` is the generated SVG for the condition; `layers` describes what
 * moves and how far. Keeping this as data (rather than branching inside an
 * animation function) means a new condition is one table entry.
 */
const SCENES = {
    'clear-day': {art: 'clear-day', depth: 'sun'},
    'clear-night': {art: 'clear-night', depth: 'moon'},
    'partly-day': {art: 'partly-day', depth: 'sun-cloud'},
    'partly-night': {art: 'partly-night', depth: 'moon-cloud'},
    'cloudy': {art: 'cloudy', depth: 'cloud'},
    'overcast': {art: 'overcast', depth: 'cloud'},
    'fog': {art: 'fog', depth: 'fog'},
    'drizzle': {art: 'drizzle', depth: 'rain-light'},
    'rain': {art: 'rain', depth: 'rain'},
    'sleet': {art: 'sleet', depth: 'mixed'},
    'snow': {art: 'snow', depth: 'snow'},
    'thunderstorm': {art: 'thunderstorm', depth: 'storm'},
};

/** How many precipitation streaks/flakes a scene may create, at most. */
const MAX_PARTICLES = 6;

/** Delay before the single lightning flash, in milliseconds. */
const LIGHTNING_DELAY_MS = 11000;

/**
 * One condition's artwork plus its moving parts.
 *
 * A scene is a plain actor tree; `start()`/`stop()` own only the
 * transitions, never the actors themselves, so switching conditions can
 * cross-fade rather than tear down.
 */
class WeatherScene {
    /**
     * @param {object} options
     * @param {string} options.iconKey - domain icon key
     * @param {number} options.size - logical size
     * @param {() => St.Bin} options.makeIcon - bound icon factory
     * @param {boolean} options.motion - whether motion is permitted
     */
    constructor({iconKey, size, makeIcon, motion}) {
        this.iconKey = iconKey;
        this.size = size;
        this._makeIcon = makeIcon;
        this._motionAllowed = motion;
        this._animations = [];
        this._flashTimers = [];
        this._destroyed = false;
        this._flashed = false;

        const plan = SCENES[iconKey] ?? SCENES['cloudy'];

        this.actor = new St.Widget({
            style_class: 'wc-scene',
            width: size,
            height: size,
        });

        // Atmospheric glow behind the artwork. It carries the condition's
        // colour so weather reads as atmosphere rather than decoration.
        this.glow = new St.Widget({
            style_class: 'wc-scene-glow',
            width: size,
            height: size,
        });
        this.actor.add_child(this.glow);

        // The artwork itself.
        this.art = this._makeIcon(iconKey, size);
        this.actor.add_child(this.art);

        // Precipitation / mist accents, created per depth plan and reused.
        this._parts = [];
        this._buildAccents(plan.depth);
    }

    _buildAccents(depth) {
        const {size} = this;
        const spec = ACCENTS[depth];
        if (!spec)
            return;

        const count = Math.min(spec.count, MAX_PARTICLES);
        for (let i = 0; i < count; i++) {
            const actor = new St.Widget({
                style_class: spec.className,
                width: spec.width,
                height: spec.height,
            });
            // Deterministic placement: no Math.random(), so a redraw looks
            // identical to the last one and nothing re-randomises per frame.
            const t = count === 1 ? 0.5 : i / (count - 1);
            actor.set_position(
                Math.round(spec.x0 + (spec.x1 - spec.x0) * t),
                Math.round(spec.y0 + (spec.y1 - spec.y0) * t));
            // Stagger phase so the parts do not move in lockstep.
            actor.__phase = spec.phase * t;
            this._parts.push(actor);
            this.actor.add_child(actor);
        }
    }

    /**
     * Begin ambient motion. Safe to call repeatedly; each call replaces the
     * previous set of transitions.
     *
     * @param {boolean} visible - only animate while actually on screen
     */
    start(visible = true) {
        this.stop();
        if (this._destroyed || !visible || !this._motionAllowed)
            return;

        const plan = SCENES[this.iconKey] ?? SCENES['cloudy'];

        this._animateBreath();
        this._animateAccents(plan.depth);
    }

    /** Cancel every transition this scene owns. */
    stop() {
        for (const [actor, prop] of this._animations) {
            try {
                actor.remove_transition(prop);
            } catch (e) {
                // Actor already destroyed.
            }
        }
        this._animations = [];
    }

    /**
     * Very slow "breathing" on the artwork. A ~1.4% scale change over 7 s is
     * at the edge of perception: it reads as the light changing, not as an
     * animation.
     */
    _animateBreath() {
        const spec = tokens.MOTION.breathe;
        this._loop(this.art, 'scale-x', {
            from: 1 - spec.scale, to: 1 + spec.scale,
            duration: spec.duration, mode: EASE_SOFT,
        });
        this._loop(this.art, 'scale-y', {
            from: 1 - spec.scale, to: 1 + spec.scale,
            duration: spec.duration, mode: EASE_SOFT,
        });
        // The glow pulses a little out of phase, which reads as depth.
        this._loop(this.glow, 'opacity', {
            from: 120, to: 210,
            duration: tokens.MOTION.shimmer.duration, mode: EASE_SOFT,
        });
    }

    _animateAccents(depth) {
        const spec = ACCENTS[depth];
        if (!spec)
            return;

        for (const actor of this._parts) {
            const duration = spec.duration;
            const delay = Math.round(actor.__phase * duration);

            if (spec.kind === 'fall') {
                // Rain: a controlled vertical loop, staggered by phase so it
                // reads as continuous rain from a handful of streaks rather
                // than a particle emitter.
                this._loop(actor, 'translation-y', {
                    from: -spec.shift, to: spec.shift,
                    duration, delay, mode: EASE,
                });
            } else if (spec.kind === 'sway') {
                // Snow: slow diagonal drift, each flake at its own pace.
                this._loop(actor, 'translation-x', {
                    from: -spec.shift * 0.5, to: spec.shift * 0.5,
                    duration: duration * 1.4, delay, mode: EASE_SOFT,
                });
                this._loop(actor, 'translation-y', {
                    from: -spec.shift * 0.5, to: spec.shift * 0.5,
                    duration, delay, mode: EASE_SOFT,
                });
            } else if (spec.kind === 'mist') {
                // Fog: lateral drift only, at two different rates so the
                // bands shear against each other.
                this._loop(actor, 'translation-x', {
                    from: -spec.shift, to: spec.shift,
                    duration: duration + actor.__phase, delay, mode: EASE_SOFT,
                });
            }
        }

        // Lightning: a rare, short illumination. One brief double-flash at
        // most per scene, never a strobe — photosensitivity is a real
        // constraint, and the flash is suppressed under reduced motion like
        // every other effect here.
        if (spec.kind === 'flash' && !this._flashed) {
            this._flashed = true;
            this._scheduleFlash();
        }
    }

    /**
     * Illuminate the scene once, well after it settled.
     *
     * Uses two short pulses rather than one long fade so it reads as
     * lightning rather than a brightness change, then returns to rest.
     */
    _scheduleFlash() {
        const {duration, hold} = tokens.MOTION.flash;
        const id = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, LIGHTNING_DELAY_MS, () => {
                if (this._destroyed)
                    return GLib.SOURCE_REMOVE;

                this.glow.remove_all_transitions();
                this.glow.opacity = 40;
                this.glow.ease({
                    opacity: 255,
                    duration,
                    mode: EASE,
                    onComplete: () => {
                        if (this._destroyed)
                            return;
                        this.glow.ease({
                            opacity: 40,
                            duration: duration * 2,
                            delay: hold,
                            mode: EASE,
                        });
                    },
                });
                return GLib.SOURCE_REMOVE;
            });
        this._flashTimers.push(id);
    }

    _loop(actor, prop, {from, to, duration, delay = 0, mode = EASE}) {
        if (this._destroyed)
            return;
        try {
            actor.save_easing_state();
            actor[prop] = from;
            actor.restore_easing_state();
            actor.ease({
                [prop]: to,
                duration,
                delay,
                mode,
                repeatCount: -1,
                autoReverse: true,
            });
            this._animations.push([actor, prop]);
        } catch (e) {
            // A missing transition just means no ambient motion, which is
            // an acceptable degradation.
        }
    }

    setMotionAllowed(allowed) {
        if (this._motionAllowed === allowed)
            return;
        this._motionAllowed = allowed;
        if (!allowed)
            this.stop();
    }

    destroy() {
        this._destroyed = true;
        this.stop();
        for (const id of this._flashTimers) {
            try {
                GLib.source_remove(id);
            } catch (e) {
                // Already fired.
            }
        }
        this._flashTimers = [];
        this.actor.destroy();
    }
}

/**
 * Accent geometry per depth plan.
 *
 * Counts are intentionally tiny: the brief is atmosphere, not a particle
 * system. A handful of well-placed marks reads better than dozens of
 * anonymous ones and costs a fraction of the GPU work.
 */
const ACCENTS = {
    'sun': null,
    'moon': null,
    'sun-cloud': null,
    'moon-cloud': null,
    'cloud': null,
    'fog': {
        kind: 'mist',
        className: 'wc-scene-mist',
        count: 3,
        width: 26, height: 2,
        x0: 4, x1: 28, y0: 44, y1: 52,
        shift: tokens.MOTION.mist.shift,
        duration: tokens.MOTION.mist.duration,
        phase: 0.18,
    },
    'rain-light': {
        kind: 'fall',
        className: 'wc-scene-drop',
        count: 3,
        width: 2, height: 7,
        x0: 12, x1: 42, y0: 48, y1: 52,
        shift: tokens.MOTION.fall.shift * 0.55,
        duration: 2600,
        phase: 0.25,
    },
    'rain': {
        kind: 'fall',
        className: 'wc-scene-drop',
        count: 5,
        width: 2, height: 9,
        x0: 8, x1: 46, y0: 46, y1: 52,
        shift: tokens.MOTION.fall.shift,
        duration: tokens.MOTION.fall.duration,
        phase: 0.3,
    },
    'mixed': {
        kind: 'fall',
        className: 'wc-scene-drop',
        count: 3,
        width: 2, height: 8,
        x0: 12, x1: 44, y0: 47, y1: 52,
        shift: tokens.MOTION.fall.shift * 0.8,
        duration: 2000,
        phase: 0.22,
    },
    'snow': {
        kind: 'sway',
        className: 'wc-scene-flake',
        count: 4,
        width: 4, height: 4,
        x0: 10, x1: 44, y0: 48, y1: 54,
        shift: tokens.MOTION.snowfall.shift,
        duration: tokens.MOTION.snowfall.duration,
        phase: 0.2,
    },
    'storm': {
        kind: 'flash',
        className: 'wc-scene-flash',
        count: 1,
        width: 62, height: 62,
        x0: 0, x1: 0, y0: 0, y1: 0,
        shift: 0,
        duration: 1,
        phase: 0,
    },
};

/**
 * The hero weather visualisation, owning at most two scenes so a condition
 * change can cross-fade rather than cut.
 */
export class WeatherSceneView {
    /**
     * @param {object} options
     * @param {(key: string, size: number) => St.Bin} options.makeIcon
     * @param {number} [options.size]
     */
    constructor({makeIcon, size = tokens.LAYOUT.heroIcon}) {
        this._makeIcon = makeIcon;
        this._size = size;
        this._motion = MaterialTheme.motionEnabled();

        this.actor = new St.Widget({
            style_class: 'wc-scene-host',
            width: size,
            height: size,
        });

        this._current = null;
        this._outgoing = null;
    }

    /**
     * Show a condition. When the icon key is unchanged this is a no-op, so
     * repeated refreshes of the same weather never rebuild the scene.
     *
     * @param {string} iconKey
     */
    setCondition(iconKey) {
        if (this._current?.iconKey === iconKey)
            return;

        const motion = MaterialTheme.motionEnabled();
        this._motion = motion;

        const next = new WeatherScene({
            iconKey,
            size: this._size,
            makeIcon: this._makeIcon,
            motion,
        });

        // Cross-fade: the outgoing scene stays mounted but stops moving, so
        // there is no visual pop and no second animation running.
        if (this._current) {
            const old = this._current;
            old.stop();
            this._outgoing?.destroy();
            this._outgoing = old;
            this.actor.add_child(old.actor);
            this._fade(old.actor, 255, 0, tokens.MOTION.sceneFade, () => {
                old.destroy();
                if (this._outgoing === old)
                    this._outgoing = null;
            });
        }

        this.actor.add_child(next.actor);
        this._fade(next.actor, 0, 255, tokens.MOTION.sceneFade);
        this._current = next;
    }

    _fade(actor, from, to, duration, onComplete = null) {
        try {
            actor.opacity = from;
            actor.ease({
                opacity: to,
                duration,
                mode: EASE,
                onComplete: onComplete ?? undefined,
            });
        } catch (e) {
            actor.opacity = to;
            onComplete?.();
        }
    }

    /** Start/stop ambient motion as a unit (visibility, overview, settings). */
    setActive(active) {
        if (!this._current)
            return;
        this._current.setMotionAllowed(this._motion);
        this._current.start(active);
    }

    /** Re-evaluate motion after a reduced-motion or animation setting change. */
    refreshMotionPolicy() {
        this._motion = MaterialTheme.motionEnabled();
        this._current?.setMotionAllowed(this._motion);
    }

    destroy() {
        this._current?.destroy();
        this._current = null;
        this._outgoing?.destroy();
        this._outgoing = null;
        this.actor.destroy();
    }
}