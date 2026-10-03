/* widget.js — Weather Card presentation.
 *
 * Builds and renders the desktop card. This module owns:
 *   - the card actor and its layered material (St/Clutter only, no webviews)
 *   - every designed state: weather, onboarding, locating, loading, errors
 *     and offline, so the card is never blank
 *   - the hero weather scene and its ambient motion (see scene.js)
 *   - drag-to-reposition with a stage grab, click or keyboard to open the menu
 *   - accessibility semantics, so assistive technology hears one concise
 *     sentence instead of a stream of decorative actors
 *
 * The controller (extension.js) decides *which* state to show; this module
 * decides how it looks. Provider specifics live in provider.js, location in
 * geoclue.js, persistence in store.js, parsing/validation in weather.js.
 *
 * GNOME 50 note: St.BoxLayout has no `spacing` property — constructing one
 * throws "No property spacing on StBoxLayout" — so spacing is expressed the
 * way the shell itself does it, through a Clutter.BoxLayout layout manager.
 *
 * SPDX-License-Identifier: MIT
 */

import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import * as icons from './icons.js';
import {buildMaterial, MaterialTheme, setMaterialPressed} from './material.js';
import {WeatherSceneView} from './scene.js';
import * as tokens from './tokens.js';
import * as weather from './weather.js';

const V = Clutter.Orientation.VERTICAL;
const H = Clutter.Orientation.HORIZONTAL;
const EASE = Clutter.AnimationMode.EASE_OUT_QUAD;

const {LAYOUT, MOTION, SPACE} = tokens;

/* ------------------------------------------------------------ helpers */

/**
 * A vertical or horizontal box.
 *
 * Spacing goes through a Clutter.BoxLayout because St.BoxLayout itself has
 * no `spacing` property on the Shell versions we target.
 */
function box(orientation, spacing = 0, extra = {}) {
    const b = new St.BoxLayout({orientation, ...extra});
    b.set_layout_manager(new Clutter.BoxLayout({spacing}));
    return b;
}

function vbox(spacing = 0, extra) {
    return box(V, spacing, extra);
}

function hbox(spacing = 0, extra) {
    return box(H, spacing, extra);
}

function label(text, styleClass, {ellipsize = false, wrap = false} = {}) {
    const l = new St.Label({text, style_class: styleClass});
    const ct = l.clutter_text;
    if (ellipsize)
        ct.ellipsize = Pango.EllipsizeMode.END;
    if (wrap) {
        ct.line_wrap = true;
        ct.line_wrap_mode = Pango.WrapMode.WORD;
    }
    return l;
}

function button(text, styleClass, onActivate, {accessibleName = null} = {}) {
    const b = new St.Button({
        label: text,
        style_class: styleClass,
        can_focus: true,
        reactive: true,
    });
    if (accessibleName)
        b.accessible_name = accessibleName;
    b.connect('clicked', onActivate);
    return b;
}

function hairline() {
    return new St.Widget({style_class: 'wc-hairline'});
}

/**
 * A status line, shown only when there is something worth saying.
 *
 * Freshness is deliberately quiet: when data is healthy and recent the card
 * says nothing, because a permanent "Updated 9:42 PM" would compete with the
 * temperature for the eye.
 */
function statusLine(text, {critical = false} = {}) {
    if (!text)
        return null;
    const row = hbox(SPACE.md);
    const dot = new St.Widget({
        style_class: critical ? 'wc-status-dot wc-status-dot-critical' : 'wc-status-dot',
        width: 6,
        height: 6,
    });
    dot.y_align = Clutter.ActorAlign.CENTER;
    row.add_child(dot);
    const l = label(text, 'wc-status');
    l.y_align = Clutter.ActorAlign.CENTER;
    row.add_child(l);
    return row;
}

/* ---------------------------------------------------------------- card */

export class WeatherCard {
    /**
     * @param {object} options
     * @param {Gio.Settings} options.settings
     * @param {string} options.basePath - extension directory
     * @param {MaterialTheme} options.material - shared stylesheet owner
     * @param {object} options.callbacks - {refresh, useCurrentLocation,
     *        chooseLocation, unitToggle, resetPosition, positionSaved}
     */
    constructor({settings, basePath, material, callbacks}) {
        this._settings = settings;
        this._basePath = basePath;
        this._callbacks = callbacks;
        this._material = material;
        this._unit = weather.resolveUnit(settings.get_string('unit'));
        this._content = null;
        this._scene = null;
        this._menu = null;
        this._destroyed = false;
        this._overviewHidden = false;
        this._press = null;
        this._paintScale = 1;
        this._render = null;
        this._snapshot = null;

        this.actor = new St.Bin({
            style_class: 'wc-card',
            width: LAYOUT.cardWidth,
            reactive: true,
            can_focus: true,
            track_hover: true,
        });

        // The material lives behind the content so press/hover feedback can
        // animate without touching the content's layout.
        this._materialActor = buildMaterial({
            highContrast: MaterialTheme.isHighContrast(),
        });
        this.actor.set_child(this._materialActor);

        this._contentBin = new St.Bin({x_expand: true, y_expand: true});
        this._materialActor.add_child(this._contentBin);

        this._connectInput();
    }

    /* ------------------------------------------------------------ input */

    _connectInput() {
        this._ids = [
            this.actor.connect('button-press-event',
                (a, e) => this._onPress(e)),
            this.actor.connect('button-release-event',
                (a, e) => this._onRelease(e)),
            this.actor.connect('motion-event',
                (a, e) => this._onMotion(e)),
            this.actor.connect('key-press-event',
                (a, e) => this._onKey(e)),
            this.actor.connect('notify::hover',
                () => this._setHovered(this.actor.hover)),
        ];
    }

    _setHovered(hovered) {
        const layer = this._materialActor.materialLayers?.depth;
        if (!layer)
            return;
        if (hovered)
            layer.add_style_class_name('wc-mat-depth-hover');
        else
            layer.remove_style_class_name('wc-mat-depth-hover');
    }

    _sourceIsInteractive(event) {
        let node = event.get_source();
        while (node && node !== this.actor) {
            if (node instanceof St.Button)
                return true;
            node = node.get_parent();
        }
        return false;
    }

    _onPress(event) {
        if (this._sourceIsInteractive(event))
            return Clutter.EVENT_PROPAGATE;

        const button = event.get_button();
        if (button !== 1 && button !== 3)
            return Clutter.EVENT_PROPAGATE;

        this.actor.grab_key_focus();
        setMaterialPressed(this._materialActor, true);

        const [sx, sy] = event.get_coords();
        const [ax, ay] = this.actor.get_position();
        this._press = {sx, sy, ax, ay, moved: false, grab: null};

        if (button === 3) {
            this._openMenu();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_STOP;
    }

    _onMotion(event) {
        const press = this._press;
        if (!press)
            return Clutter.EVENT_PROPAGATE;

        const state = event.get_state();
        if (!(state & Clutter.ModifierType.BUTTON1_MASK)) {
            this._press = null;
            setMaterialPressed(this._materialActor, false);
            return Clutter.EVENT_PROPAGATE;
        }

        const [sx, sy] = event.get_coords();
        const dx = sx - press.sx;
        const dy = sy - press.sy;

        if (!press.moved) {
            let threshold = 8;
            try {
                threshold = St.Settings.get().drag_threshold ?? 8;
            } catch (e) {
                // The default threshold is fine.
            }
            if (Math.hypot(dx, dy) < threshold)
                return Clutter.EVENT_PROPAGATE;
            press.moved = true;
            try {
                press.grab = global.stage.grab(this.actor);
            } catch (e) {
                press.grab = null;
            }
            this._menu?.close();
        }

        let nx = press.ax + dx;
        let ny = press.ay + dy;
        [nx, ny] = this.clampToVisible(nx, ny);
        this.actor.set_position(Math.round(nx), Math.round(ny));
        return Clutter.EVENT_STOP;
    }

    _onRelease(event) {
        const press = this._press;
        if (!press)
            return Clutter.EVENT_PROPAGATE;
        this._press = null;
        setMaterialPressed(this._materialActor, false);

        if (press.grab) {
            try {
                press.grab.dismiss();
            } catch (e) {
                // Grab already dismissed.
            }
        }

        if (press.moved) {
            const [x, y] = this.actor.get_position();
            this._callbacks.positionSaved?.(x, y);
        } else {
            this._openMenu();
        }
        return Clutter.EVENT_STOP;
    }

    _onKey(event) {
        const key = event.get_key_symbol();
        if (key === Clutter.KEY_Return || key === Clutter.KEY_KP_Enter ||
            key === Clutter.KEY_space || key === Clutter.KEY_Menu) {
            this._openMenu();
            return Clutter.EVENT_STOP;
        }
        if (key === Clutter.KEY_Escape && this._menu?.isOpen) {
            this._menu.close();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    /**
     * Keep the card fully on screen.
     *
     * Uses whichever monitor currently holds the card, so a card dragged to a
     * second display stays clamped to *that* display rather than to the
     * primary one. On a monitor too small to hold the card, the top-left is
     * preferred rather than producing an inverted range.
     *
     * @returns {[number, number]} clamped stage coordinates
     */
    clampToVisible(x, y) {
        let geom;
        try {
            geom = global.display.get_monitor_geometry(this.monitorIndexFor(x, y));
        } catch (e) {
            return [x, y];
        }

        const w = this.actor.width || LAYOUT.cardWidth;
        const h = this.actor.height || LAYOUT.fallbackHeight;
        const m = SPACE.md;

        const minX = geom.x + m;
        const minY = geom.y + m;
        const maxX = geom.x + geom.width - w - m;
        const maxY = geom.y + geom.height - h - m;

        const cx = maxX < minX ? minX : Math.min(Math.max(x, minX), maxX);
        const cy = maxY < minY ? minY : Math.min(Math.max(y, minY), maxY);
        return [cx, cy];
    }

    /**
     * Index of the monitor holding a card at the given stage position.
     *
     * @returns {number} monitor index, or the primary index as a fallback
     */
    monitorIndexFor(x, y) {
        let primary = 0;
        try {
            primary = global.display.get_primary_monitor();
            const n = global.display.get_n_monitors();
            const w = this.actor.width || LAYOUT.cardWidth;
            const h = this.actor.height || LAYOUT.fallbackHeight;
            // Probe the card's own rectangle rather than a single point: a
            // card spanning a monitor edge should resolve to whichever
            // monitor holds its centre.
            const cx = x + w / 2;
            const cy = y + h / 2;
            for (let i = 0; i < n; i++) {
                const g = global.display.get_monitor_geometry(i);
                if (cx >= g.x && cx < g.x + g.width &&
                    cy >= g.y && cy < g.y + g.height)
                    return i;
            }
        } catch (e) {
            // Fall through to the primary monitor.
        }
        return primary;
    }

    setPosition(x, y) {
        const [cx, cy] = this.clampToVisible(x, y);
        this.actor.set_position(Math.round(cx), Math.round(cy));
    }

    /* ------------------------------------------------------------- menu */

    _openMenu() {
        if (this._destroyed || this._menu?.isOpen)
            return;
        // A menu closed by an outside click should not immediately reopen
        // from the same click's release event.
        if (Date.now() - (this._menuClosedAt ?? 0) < 350)
            return;

        this._menu = new CardMenu({
            items: this._menuItems(),
            onClose: () => {
                this._menu = null;
                this._menuClosedAt = Date.now();
                try {
                    this.actor.grab_key_focus();
                } catch (e) {
                    // Card may already be gone.
                }
            },
        });
        this._menu.open(this.actor);
    }

    _menuItems() {
        const other = this._unit === 'fahrenheit'
            ? 'Celsius (°C)' : 'Fahrenheit (°F)';
        return [
            {
                label: 'Refresh',
                iconName: 'view-refresh-symbolic',
                activate: () => this._callbacks.refresh?.(),
            },
            {
                label: `Switch to ${other}`,
                activate: () => this._callbacks.unitToggle?.(),
            },
            {
                label: 'Change Location…',
                iconName: 'system-search-symbolic',
                activate: () => this._callbacks.chooseLocation?.(),
            },
            {
                label: 'Reset Position',
                iconName: 'zoom-fit-best-symbolic',
                activate: () => this._callbacks.resetPosition?.(),
            },
        ];
    }

    closeMenu() {
        this._menu?.close();
    }

    /* ------------------------------------------------------ state entry */

    /** Normal weather display (also used for cached data). */
    showWeather(snapshot, {offline = false, refreshing = false, note = null} = {}) {
        this._snapshot = snapshot;
        this._render = () =>
            this._setContent(this._buildWeather(snapshot, {
                offline, refreshing, note,
            }));
        this._render();
        this._updateAccessibility();
    }

    showOnboarding() {
        this._render = () => this._setContent(this._buildOnboarding());
        this._render();
    }

    showLocating() {
        this._render = () => this._setContent(this._buildLocating());
        this._render();
    }

    showLoading() {
        this._render = () => this._setContent(this._buildLoading());
        this._render();
    }

    showChoosePending() {
        this._render = () => this._setContent(this._buildChoosePending());
        this._render();
    }

    /**
     * Error states.
     *
     * @param {string} kind - 'network' | 'provider' | 'malformed' |
     *        'permission' | 'location' | 'no-identity'
     */
    showError(kind) {
        this._render = () => this._setContent(this._buildError(kind));
        this._render();
    }

    /* Re-render in the current unit / scheme / scale (called by controller). */
    updateUnit() {
        this._unit = weather.resolveUnit(this._settings.get_string('unit'));
        this._render?.();
        this._updateAccessibility();
    }

    setScale(paintScale) {
        const next = Math.max(1, paintScale);
        if (next === this._paintScale)
            return;
        this._paintScale = next;
        this._render?.();
    }

    /** Adopt a new colour scheme; the material owns the stylesheet swap. */
    setScheme(scheme) {
        this._material.setScheme(scheme);
        this._render?.();
    }

    /** React to a change in reduced-motion or animation settings. */
    refreshMotionPolicy() {
        this._scene?.refreshMotionPolicy();
        this._applySceneMotion();
    }

    setOverviewHidden(hidden) {
        this._overviewHidden = hidden;
        if (hidden) {
            this._scene?.setActive(false);
            if (MaterialTheme.motionEnabled()) {
                this.actor.ease({
                    opacity: 0,
                    duration: MOTION.quick,
                    mode: EASE,
                    onComplete: () => {
                        if (this._overviewHidden && !this._destroyed)
                            this.actor.hide();
                    },
                });
            } else {
                this.actor.hide();
            }
        } else {
            this.actor.show();
            if (MaterialTheme.motionEnabled())
                this.actor.ease({opacity: 255, duration: MOTION.quick, mode: EASE});
            this._applySceneMotion();
        }
    }

    /* ---------------------------------------------------- content build */

    _makeIcon(iconKey, size) {
        return icons.iconActor(iconKey, size, {
            basePath: this._basePath,
            scheme: this._material.scheme,
            paintScale: this._paintScale,
        });
    }

    /**
     * Ensure the hero scene exists for the current condition.
     *
     * The scene is created once and reused for identical conditions, so an
     * ordinary refresh never rebuilds (or re-animates) the artwork.
     */
    _ensureScene(iconKey) {
        if (!this._scene) {
            this._scene = new WeatherSceneView({
                makeIcon: (k, s) => this._makeIcon(k, s),
                size: LAYOUT.heroIcon,
            });
        }
        this._scene.setCondition(iconKey);
        this._applySceneMotion();
        return this._scene.actor;
    }

    _applySceneMotion() {
        if (!this._scene)
            return;
        this._scene.refreshMotionPolicy();
        this._scene.setActive(!this._overviewHidden && !this._destroyed);
    }

    /**
     * Which secondary facts deserve space right now.
     *
     * Only information that changes a decision earns a line: a "feels like"
     * that materially disagrees with the reading, or a precipitation chance
     * high enough to alter plans.
     */
    _secondaryFacts(snapshot) {
        const facts = [];
        if (weather.feelsLikeMatters(
            snapshot.current.tempC, snapshot.current.feelsC, this._unit)) {
            facts.push(`Feels like ${weather.displayTemp(
                snapshot.current.feelsC, this._unit)}`);
        }
        if (weather.precipChanceMatters(snapshot.today.precipProb))
            facts.push(`${Math.round(snapshot.today.precipProb)}% chance`);
        else if (snapshot.current.precipMm >= 0.1)
            facts.push('Precipitating');
        return facts;
    }

    _statusFor(snapshot, {offline, note}) {
        if (note)
            return {text: note, critical: false};
        if (offline) {
            return {
                text: `Offline — showing ${weather.formatWallClock(snapshot.fetchedAt)}`,
                critical: true,
            };
        }
        // Refreshing is deliberately silent: a card that says "Refreshing…"
        // every fifteen minutes is a card nobody reads.
        return null;
    }

    _buildWeather(snapshot, {offline, refreshing, note}) {
        const root = vbox();

        /* --- location ------------------------------------------------- */
        const header = hbox();
        const location = label(
            snapshot.location.name ?? 'Current Location', 'wc-location',
            {ellipsize: true});
        location.x_expand = true;
        location.y_align = Clutter.ActorAlign.CENTER;
        header.add_child(location);

        // Open-Meteo's licence requires a link next to displayed data.
        const attribution = label('Open-Meteo', 'wc-attribution');
        attribution.y_align = Clutter.ActorAlign.CENTER;
        header.add_child(attribution);
        root.add_child(header);

        /* --- hero: temperature and condition art ---------------------- */
        const hero = hbox(SPACE.md);
        hero.margin_top = SPACE.md;

        const tempLabel = label(
            weather.displayTemp(snapshot.current.tempC, this._unit), 'wc-temp');
        tempLabel.y_align = Clutter.ActorAlign.CENTER;

        const sceneActor = this._ensureScene(snapshot.current.iconKey);
        sceneActor.y_align = Clutter.ActorAlign.CENTER;
        sceneActor.x_expand = true;

        hero.add_child(tempLabel);
        hero.add_child(sceneActor);
        root.add_child(hero);

        /* --- condition ------------------------------------------------ */
        const condition = label(snapshot.current.label, 'wc-condition');
        condition.margin_top = SPACE.xs;
        root.add_child(condition);

        /* --- high / low, plus only what matters ----------------------- */
        const meta = hbox(SPACE.md);
        meta.margin_top = SPACE.sm;
        const hl = label(
            `H ${weather.displayTemp(snapshot.today.maxC, this._unit)}` +
            `   L ${weather.displayTemp(snapshot.today.minC, this._unit)}`,
            'wc-meta');
        hl.y_align = Clutter.ActorAlign.CENTER;
        meta.add_child(hl);

        const facts = this._secondaryFacts(snapshot);
        if (facts.length > 0) {
            const sep = label('·', 'wc-meta-sep');
            sep.y_align = Clutter.ActorAlign.CENTER;
            meta.add_child(sep);
            const f = label(facts.join('   ·   '), 'wc-meta');
            f.y_align = Clutter.ActorAlign.CENTER;
            meta.add_child(f);
        }
        root.add_child(meta);

        /* --- hourly ---------------------------------------------------- */
        const rule = hairline();
        rule.margin_top = SPACE.lg;
        rule.margin_bottom = SPACE.md;
        root.add_child(rule);

        root.add_child(this._buildHourly(snapshot));

        /* --- status: only when it says something ----------------------- */
        const status = this._statusFor(snapshot, {offline, note});
        if (status) {
            const row = statusLine(status.text, {critical: status.critical});
            if (row) {
                row.margin_top = SPACE.md;
                if (offline) {
                    const retry = button('Try Again', 'wc-btn-quiet',
                        () => this._callbacks.refresh?.());
                    retry.y_align = Clutter.ActorAlign.CENTER;
                    row.add_child(retry);
                }
                root.add_child(row);
            }
        }

        return root;
    }

    _buildHourly(snapshot) {
        const row = hbox();
        row.x_expand = true;
        const hours = snapshot.hourly.slice(0, LAYOUT.hourlyCount);
        for (const hour of hours) {
            const cell = vbox(SPACE.sm);
            cell.x_expand = true;

            const time = label(weather.formatHour(hour.iso), 'wc-hour-time');
            time.x_align = Clutter.ActorAlign.CENTER;

            const icon = this._makeIcon(hour.iconKey, LAYOUT.hourlyIcon);
            icon.x_align = Clutter.ActorAlign.CENTER;

            const temp = label(
                weather.displayTemp(hour.tempC, this._unit), 'wc-hour-temp');
            temp.x_align = Clutter.ActorAlign.CENTER;

            cell.add_child(time);
            cell.add_child(icon);
            cell.add_child(temp);
            row.add_child(cell);
        }
        return row;
    }

    _stateMark(iconKey) {
        const holder = vbox();
        holder.margin_top = SPACE.xs;
        const mark = this._makeIcon(iconKey, 52);
        mark.x_align = Clutter.ActorAlign.CENTER;
        holder.add_child(mark);
        return holder;
    }

    _buildOnboarding() {
        const root = vbox();
        root.add_child(this._stateMark('partly-day'));

        const title = label('Weather where you are', 'wc-title');
        title.x_align = Clutter.ActorAlign.CENTER;
        title.margin_top = SPACE.lg;
        root.add_child(title);

        const body = label(
            'Allow Weather to use your approximate location to show local conditions.',
            'wc-body', {wrap: true});
        body.x_align = Clutter.ActorAlign.CENTER;
        body.margin_top = SPACE.sm;
        root.add_child(body);

        const actions = vbox(SPACE.sm);
        actions.margin_top = SPACE.xl;
        actions.add_child(button('Use Current Location', 'wc-btn-primary',
            () => this._callbacks.useCurrentLocation?.(),
            {accessibleName: 'Use current location'}));
        actions.add_child(button('Choose Location', 'wc-btn-secondary',
            () => this._callbacks.chooseLocation?.(),
            {accessibleName: 'Choose a location manually'}));
        root.add_child(actions);

        return root;
    }

    _buildLocating() {
        const root = vbox();
        root.add_child(this._stateMark('partly-night'));

        const title = label('Finding your location…', 'wc-title');
        title.x_align = Clutter.ActorAlign.CENTER;
        title.margin_top = SPACE.lg;
        root.add_child(title);

        const body = label(
            'GNOME will ask for your permission. This only takes a moment.',
            'wc-body', {wrap: true});
        body.x_align = Clutter.ActorAlign.CENTER;
        body.margin_top = SPACE.sm;
        root.add_child(body);
        return root;
    }

    _buildLoading() {
        const root = vbox();

        const header = hbox();
        header.add_child(this._skel(118, 13));
        const right = this._skel(58, 10);
        right.x_align = Clutter.ActorAlign.END;
        header.add_child(right);
        root.add_child(header);

        const hero = hbox();
        hero.margin_top = SPACE.md;
        hero.add_child(this._skel(112, Math.round(LAYOUT.heroIcon * 0.8)));
        const mark = this._skelRound(LAYOUT.heroIcon);
        mark.x_align = Clutter.ActorAlign.END;
        hero.add_child(mark);
        root.add_child(hero);

        const condition = this._skel(150, 13);
        condition.margin_top = SPACE.sm;
        root.add_child(condition);

        const meta = this._skel(196, 11);
        meta.margin_top = SPACE.md;
        root.add_child(meta);

        const rule = hairline();
        rule.margin_top = SPACE.lg;
        rule.margin_bottom = SPACE.md;
        root.add_child(rule);

        const hours = hbox();
        hours.x_expand = true;
        for (let i = 0; i < LAYOUT.hourlyCount; i++) {
            const cell = vbox(SPACE.sm);
            cell.x_expand = true;
            const t = this._skel(26, 9);
            t.x_align = Clutter.ActorAlign.CENTER;
            const icon = this._skelRound(LAYOUT.hourlyIcon);
            icon.x_align = Clutter.ActorAlign.CENTER;
            const v = this._skel(24, 10);
            v.x_align = Clutter.ActorAlign.CENTER;
            cell.add_child(t);
            cell.add_child(icon);
            cell.add_child(v);
            hours.add_child(cell);
        }
        root.add_child(hours);
        return root;
    }

    _skel(w, h) {
        return new St.Widget({style_class: 'wc-skel', width: w, height: h});
    }

    _skelRound(size) {
        return new St.Widget({
            style_class: 'wc-skel wc-skel-round',
            width: size,
            height: size,
        });
    }

    _buildChoosePending() {
        const root = vbox();
        root.add_child(this._stateMark('fog'));

        const title = label('Choose a location', 'wc-title');
        title.x_align = Clutter.ActorAlign.CENTER;
        title.margin_top = SPACE.lg;
        root.add_child(title);

        const body = label(
            'Pick a place in the window that just opened.',
            'wc-body', {wrap: true});
        body.x_align = Clutter.ActorAlign.CENTER;
        body.margin_top = SPACE.sm;
        root.add_child(body);
        return root;
    }

    _buildError(kind) {
        const specs = {
            'network': {
                mark: 'fog',
                title: 'No connection',
                body: 'You appear to be offline. Weather will update automatically once you’re connected again.',
                primary: 'Try Again',
                onPrimary: () => this._callbacks.refresh?.(),
            },
            'provider': {
                mark: 'cloudy',
                title: 'Weather service hiccup',
                body: 'The weather service couldn’t answer just now. This is usually brief.',
                primary: 'Try Again',
                onPrimary: () => this._callbacks.refresh?.(),
            },
            'malformed': {
                mark: 'cloudy',
                title: 'Couldn’t read the update',
                body: 'The weather service sent something unexpected. Trying again usually fixes it.',
                primary: 'Try Again',
                onPrimary: () => this._callbacks.refresh?.(),
            },
            'permission': {
                mark: 'fog',
                title: 'Location access declined',
                body: 'You can allow access from Settings → Privacy → Location, or simply choose a place to use instead.',
                primary: 'Choose Location…',
                onPrimary: () => this._callbacks.chooseLocation?.(),
                secondary: 'Try Again',
                onSecondary: () => this._callbacks.useCurrentLocation?.(),
            },
            'location': {
                mark: 'fog',
                title: 'Couldn’t determine location',
                body: 'Location services may be switched off or unavailable. You can pick a place manually instead.',
                primary: 'Choose Location…',
                onPrimary: () => this._callbacks.chooseLocation?.(),
                secondary: 'Try Again',
                onSecondary: () => this._callbacks.useCurrentLocation?.(),
            },
            'no-identity': {
                mark: 'fog',
                title: 'Location identity missing',
                body: 'GNOME needs an installed application identity before it can share your location. Run the installer, or choose a place to use instead.',
                primary: 'Choose Location…',
                onPrimary: () => this._callbacks.chooseLocation?.(),
            },
        };
        const spec = specs[kind] ?? specs.provider;

        const root = vbox();
        root.add_child(this._stateMark(spec.mark));

        const title = label(spec.title, 'wc-title');
        title.x_align = Clutter.ActorAlign.CENTER;
        title.margin_top = SPACE.lg;
        root.add_child(title);

        const body = label(spec.body, 'wc-body', {wrap: true});
        body.x_align = Clutter.ActorAlign.CENTER;
        body.margin_top = SPACE.sm;
        root.add_child(body);

        const actions = vbox(SPACE.sm);
        actions.margin_top = SPACE.xl;
        actions.add_child(button(spec.primary, 'wc-btn-primary', spec.onPrimary));
        if (spec.secondary) {
            actions.add_child(button(spec.secondary, 'wc-btn-secondary',
                spec.onSecondary));
        }
        root.add_child(actions);

        return root;
    }

    /* ------------------------------------------------------ transitions */

    _setContent(content) {
        const old = this._content;
        this._content = content;
        this._contentBin.set_child(content);
        if (old)
            old.destroy();

        if (content && MaterialTheme.motionEnabled()) {
            content.set_opacity(0);
            content.ease({
                opacity: 255,
                duration: MOTION.standard,
                mode: EASE,
            });
        }
    }

    /**
     * The card is one interactive object, so assistive technology should hear
     * a single summary rather than every decorative child. The artwork
     * carries no accessible role at all.
     */
    _updateAccessibility() {
        if (!this._snapshot)
            return;
        try {
            this.actor.accessible_role = Atk.Role.PANEL;
            this.actor.accessible_name = weather.describe(this._snapshot, this._unit);
        } catch (e) {
            // Accessibility is best-effort; never let it break rendering.
        }
    }

    /* ---------------------------------------------------------- teardown */

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;

        this._press = null;
        this._menu?.close();
        this._menu = null;
        this._scene?.destroy();
        this._scene = null;

        for (const id of this._ids ?? []) {
            try {
                this.actor.disconnect(id);
            } catch (e) {
                // Actor already gone.
            }
        }
        this._ids = [];

        this.actor.destroy();
        this._content = null;
        this._snapshot = null;
    }
}

/* ------------------------------------------------------------- menu ---- */

/**
 * A deliberately small menu.
 *
 * GNOME's PopupMenu is built around window-anchored popups with struts and
 * grabs, which is the wrong shape for desktop furniture, so the menu is
 * hand-rolled — but it keeps the parts that matter for accessibility: real
 * focusable rows, arrow-key navigation, Escape to dismiss, and an accessible
 * role.
 */
class CardMenu {
    constructor({items, onClose}) {
        this._onClose = onClose;
        this.isOpen = false;

        this.actor = vbox(2, {
            style_class: 'wc-menu',
            reactive: true,
            visible: false,
        });
        try {
            this.actor.accessible_role = Atk.Role.MENU;
        } catch (e) {
            // Best-effort.
        }

        this._rows = [];
        this._stagePressId = 0;

        for (const item of items) {
            const row = new St.Button({
                style_class: 'wc-menu-item',
                can_focus: true,
            });
            row.accessible_name = item.label;

            const content = hbox(SPACE.md);
            if (item.iconName) {
                content.add_child(new St.Icon({
                    icon_name: item.iconName,
                    icon_size: 16,
                    y_align: Clutter.ActorAlign.CENTER,
                }));
            }
            const text = label(item.label, 'wc-menu-item-label');
            text.y_align = Clutter.ActorAlign.CENTER;
            content.add_child(text);
            row.set_child(content);

            row.connect('clicked', () => {
                this.close();
                item.activate?.();
            });
            row.connect('key-press-event', (a, event) =>
                this._onRowKey(row, event));
            this._rows.push(row);
            this.actor.add_child(row);
        }

        this.actor.connect('key-press-event', (a, event) => {
            if (event.get_key_symbol() === Clutter.KEY_Escape) {
                this.close();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    open(anchor) {
        if (this.isOpen)
            return;
        this.isOpen = true;

        Main.layoutManager.addChrome(this.actor, {affectsStruts: false});
        this.actor.show();

        // Measure now that the actor is staged, then anchor it to the card's
        // top-right corner, clamped inside the monitor holding the card.
        const [, natW] = this.actor.get_preferred_width(-1);
        const [, natH] = this.actor.get_preferred_height(-1);
        const [ax, ay] = anchor.get_position();
        let x = ax + anchor.width - natW - SPACE.md;
        let y = ay + SPACE.md;

        try {
            const mon = global.display.get_monitor_geometry(
                this._monitorIndexFor(anchor));
            const m = SPACE.md;
            x = Math.min(Math.max(mon.x + m, x), mon.x + mon.width - natW - m);
            y = Math.min(Math.max(mon.y + m, y), mon.y + mon.height - natH - m);
        } catch (e) {
            // Best effort.
        }
        this.actor.set_position(Math.round(x), Math.round(y));

        this._stagePressId = global.stage.connect('button-press-event',
            (stage, event) => {
                if (!this._contains(event.get_source()))
                    this.close();
                return Clutter.EVENT_PROPAGATE;
            });

        this._rows[0]?.grab_key_focus();

        if (MaterialTheme.motionEnabled()) {
            this.actor.set_opacity(0);
            this.actor.ease({
                opacity: 255,
                duration: MOTION.quick,
                mode: EASE,
            });
        }
    }

    _monitorIndexFor(anchor) {
        try {
            const [ax, ay] = anchor.get_position();
            const cx = ax + anchor.width / 2;
            const cy = ay + anchor.height / 2;
            const n = global.display.get_n_monitors();
            for (let i = 0; i < n; i++) {
                const g = global.display.get_monitor_geometry(i);
                if (cx >= g.x && cx < g.x + g.width &&
                    cy >= g.y && cy < g.y + g.height)
                    return i;
            }
            return global.display.get_primary_monitor();
        } catch (e) {
            return 0;
        }
    }

    _contains(node) {
        while (node) {
            if (node === this.actor)
                return true;
            node = node.get_parent();
        }
        return false;
    }

    _onRowKey(row, event) {
        const key = event.get_key_symbol();
        if (key !== Clutter.KEY_Up && key !== Clutter.KEY_Down &&
            key !== Clutter.KEY_Left && key !== Clutter.KEY_Right)
            return Clutter.EVENT_PROPAGATE;

        const idx = this._rows.indexOf(row);
        const forward = key === Clutter.KEY_Down || key === Clutter.KEY_Right;
        const next = forward
            ? (idx + 1) % this._rows.length
            : (idx - 1 + this._rows.length) % this._rows.length;
        this._rows[next].grab_key_focus();
        return Clutter.EVENT_STOP;
    }

    close() {
        if (!this.isOpen)
            return;
        this.isOpen = false;

        if (this._stagePressId) {
            global.stage.disconnect(this._stagePressId);
            this._stagePressId = 0;
        }

        try {
            Main.layoutManager.removeChrome(this.actor);
        } catch (e) {
            // Not added, or already removed.
        }
        this.actor.destroy();
        this._rows = [];
        this._onClose?.();
    }
}