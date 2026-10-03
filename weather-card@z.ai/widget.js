/* widget.js — Weather Card presentation.
 *
 * Builds and renders the desktop card. This module owns:
 *   - the card actor and its layout (St/Clutter only, no webviews)
 *   - rendering of every designed state (weather, onboarding, loading,
 *     errors, locating, choosing) so the card is never blank
 *   - restrained micro-animation, honoring reduced motion
 *   - drag-to-reposition with a stage grab, click-to-open menu,
 *     keyboard access for all interactive elements
 *
 * The controller (extension.js) decides *which* state to show; this
 * module decides how it looks.
 *
 * SPDX-License-Identifier: MIT
 */

import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import * as icons from './icons.js';
import * as weather from './weather.js';

const CARD_WIDTH = 340;
const HERO_ICON_SIZE = 58;
const HOURLY_ICON_SIZE = 26;
const HOURLY_COUNT = 7;
const V = Clutter.Orientation.VERTICAL;
const H = Clutter.Orientation.HORIZONTAL;
const EASE = Clutter.AnimationMode.EASE_OUT_QUAD;
const EASE_INOUT = Clutter.AnimationMode.EASE_IN_OUT_QUAD;

/* ------------------------------------------------------------ helpers */

/* Vertical box with a little breathing room built in. */
function vbox(spacing = 0) {
    return new St.BoxLayout({orientation: V, spacing});
}

function hbox(spacing = 0) {
    return new St.BoxLayout({orientation: H, spacing});
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

function button(text, styleClass, onActivate) {
    const b = new St.Button({
        label: text,
        style_class: styleClass,
        can_focus: true,
        reactive: true,
    });
    b.connect('clicked', onActivate);
    return b;
}

function separator() {
    const s = new St.Widget({style_class: 'wc-sep', height: 1});
    s.x_expand = true;
    return s;
}

/* ---------------------------------------------------------------- card */

export class WeatherCard {
    /**
     * @param {object} options
     * @param {Gio.Settings} options.settings
     * @param {string} options.basePath - extension directory
     * @param {object} options.callbacks - {refresh, useCurrentLocation,
     *        chooseLocation, unitToggle, resetPosition, positionSaved}
     */
    constructor({settings, basePath, callbacks}) {
        this._settings = settings;
        this._basePath = basePath;
        this._callbacks = callbacks;
        this._scheme = icons.currentScheme();
        this._paintScale = 1;
        this._unit = weather.resolveUnit(settings.get_string('unit'));
        this._content = null;
        this._pulse = null;
        this._menu = null;
        this._destroyed = false;
        this._overviewHidden = false;

        this.actor = new St.Bin({
            style_class: 'wc-card',
            width: CARD_WIDTH,
            reactive: true,
            can_focus: true,
        });

        this._connectCardInput();
    }

    /* ------------------------------------------------------------ input */

    _connectCardInput() {
        this._pressId = this.actor.connect('button-press-event',
            (actor, event) => this._onPress(event));
        this._releaseId = this.actor.connect('button-release-event',
            (actor, event) => this._onRelease(event));
        this._motionId = this.actor.connect('motion-event',
            (actor, event) => this._onMotion(event));
        this._keyId = this.actor.connect('key-press-event',
            (actor, event) => this._onKey(event));
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

        // Guard against stale press state (e.g. pointer re-entered the
        // card after a release we never saw).
        const state = event.get_state();
        if (!(state & Clutter.ModifierType.BUTTON1_MASK)) {
            this._press = null;
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
                // Default threshold is fine.
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

        let [nx, ny] = [press.ax + dx, press.ay + dy];
        [nx, ny] = this._clampToMonitor(nx, ny);
        this.actor.set_position(Math.round(nx), Math.round(ny));
        return Clutter.EVENT_STOP;
    }

    _onRelease(event) {
        const press = this._press;
        if (!press)
            return Clutter.EVENT_PROPAGATE;
        this._press = null;

        if (press.grab)
            press.grab.dismiss();

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
        return Clutter.EVENT_PROPAGATE;
    }

    _clampToMonitor(x, y) {
        try {
            const idx = global.display.get_primary_monitor();
            const mon = global.display.get_monitor_geometry(idx);
            const cardH = this.actor.height || 380;
            x = Math.min(Math.max(mon.x + 8, x), mon.x + mon.width - CARD_WIDTH - 8);
            y = Math.min(Math.max(mon.y + 8, y), mon.y + mon.height - Math.min(cardH, 300) - 8);
        } catch (e) {
            // Best effort only.
        }
        return [x, y];
    }

    /* ------------------------------------------------------------- menu */

    _openMenu() {
        if (this._destroyed || this._menu?.isOpen)
            return;
        // A menu that was closed by an outside click moments ago should
        // not instantly reopen from the same click's release event.
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
        this._render = () =>
            this._setContent(this._buildWeather(snapshot, {offline, refreshing, note}));
        this._render();
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
     * Error states — kind is one of:
     * 'network' | 'provider' | 'malformed' | 'permission' | 'location'
     */
    showError(kind) {
        this._render = () => this._setContent(this._buildError(kind));
        this._render();
    }

    /* Re-render in the current scheme/scale/unit (called by controller). */
    updateUnit() {
        this._unit = weather.resolveUnit(this._settings.get_string('unit'));
        this._render?.();
    }

    setScheme(scheme) {
        this._scheme = scheme;
        this._render?.();
    }

    setScale(paintScale) {
        this._paintScale = Math.max(1, paintScale);
        this._render?.();
    }

    setOverviewHidden(hidden) {
        this._overviewHidden = hidden;
        const animate = icons.animationsEnabled();
        if (hidden) {
            if (animate) {
                this.actor.ease({
                    opacity: 0,
                    duration: 140,
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
            if (animate)
                this.actor.ease({opacity: 255, duration: 140, mode: EASE});
        }
    }

    setPosition(x, y) {
        this.actor.set_position(Math.round(x), Math.round(y));
    }

    /* ---------------------------------------------------- content build */

    _icon(iconKey, size) {
        return icons.iconActor(iconKey, size, {
            basePath: this._basePath,
            scheme: this._scheme,
            paintScale: this._paintScale,
        });
    }

    _weatherFootnote(snapshot, {offline, refreshing, note}) {
        const parts = [];
        if (note)
            parts.push(note);
        if (offline)
            parts.push(`Offline — updated ${weather.formatWallClock(snapshot.fetchedAt)}`);
        else if (refreshing)
            parts.push('Refreshing…');
        return parts.join(' · ');
    }

    _buildWeather(snapshot, {offline, refreshing, note}) {
        const box = vbox();

        const header = hbox();
        const location = label(
            snapshot.location.name ?? 'Current Location',
            'wc-location', {ellipsize: true});
        location.x_expand = true;
        const updated = label(
            `Updated ${weather.formatWallClock(snapshot.fetchedAt)}`, 'wc-updated');
        header.add_child(location);
        header.add_child(updated);
        box.add_child(header);

        const hero = hbox();
        hero.margin_top = 2;
        const temp = label(
            weather.displayTemp(snapshot.current.tempC, this._unit), 'wc-temp');
        const icon = this._icon(snapshot.current.iconKey, HERO_ICON_SIZE);
        icon.x_expand = true;
        icon.x_align = Clutter.ActorAlign.END;
        hero.add_child(temp);
        hero.add_child(icon);
        box.add_child(hero);

        const condition = label(snapshot.current.label, 'wc-condition');
        condition.margin_top = 2;
        box.add_child(condition);

        const meta = vbox();
        meta.margin_top = 7;
        const hl = label(
            `H ${weather.displayTemp(snapshot.today.maxC, this._unit)}   ` +
            `L ${weather.displayTemp(snapshot.today.minC, this._unit)}`,
            'wc-meta');
        meta.add_child(hl);

        let detail = `Feels like ${weather.displayTemp(snapshot.current.feelsC, this._unit)}`;
        const prob = snapshot.today.precipProb;
        if (prob !== null && prob >= 20)
            detail += `  ·  ${Math.round(prob)}% precipitation`;
        else if (snapshot.current.precipMm >= 0.1)
            detail += `  ·  precipitating now`;
        meta.add_child(label(detail, 'wc-meta'));
        box.add_child(meta);

        const sep = separator();
        sep.margin_top = 18;
        sep.margin_bottom = 14;
        box.add_child(sep);

        box.add_child(this._buildHourly(snapshot));

        const footnote = this._weatherFootnote(snapshot, {offline, refreshing, note});
        if (footnote !== '') {
            const row = hbox();
            row.margin_top = 14;
            const text = label(footnote, 'wc-footnote');
            text.y_align = Clutter.ActorAlign.CENTER;
            row.add_child(text);
            if (offline) {
                const retry = button('Try Again', 'wc-btn-text',
                    () => this._callbacks.refresh?.());
                retry.set_style('padding: 4px 10px; font-size: 12px;');
                retry.margin_left = 12;
                row.add_child(retry);
            }
            box.add_child(row);
        }

        return box;
    }

    _buildHourly(snapshot) {
        const row = hbox();
        row.x_expand = true;
        for (const hour of snapshot.hourly.slice(0, HOURLY_COUNT)) {
            const cell = vbox(6);
            cell.x_expand = true;
            const time = label(weather.formatHour(hour.iso), 'wc-hour-time');
            time.x_align = Clutter.ActorAlign.CENTER;
            const icon = this._icon(hour.iconKey, HOURLY_ICON_SIZE);
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

    _buildOnboarding() {
        const box = vbox();

        const mark = this._icon('partly-day', 52);
        mark.x_align = Clutter.ActorAlign.CENTER;
        mark.margin_top = 4;
        box.add_child(mark);

        const title = label('Weather where you are', 'wc-title');
        title.x_align = Clutter.ActorAlign.CENTER;
        title.margin_top = 18;
        box.add_child(title);

        const body = label(
            'Allow Weather to use your approximate location to show local conditions.',
            'wc-body', {wrap: true});
        body.x_align = Clutter.ActorAlign.CENTER;
        body.margin_top = 10;
        box.add_child(body);

        const actions = hbox(10);
        actions.x_align = Clutter.ActorAlign.CENTER;
        actions.margin_top = 24;
        actions.margin_bottom = 4;
        actions.add_child(button('Use Current Location', 'wc-btn-primary',
            () => this._callbacks.useCurrentLocation?.()));
        actions.add_child(button('Choose Location', 'wc-btn-text',
            () => this._callbacks.chooseLocation?.()));
        box.add_child(actions);

        return box;
    }

    _buildLocating() {
        const box = vbox();
        const mark = this._icon('partly-night', 48);
        mark.x_align = Clutter.ActorAlign.CENTER;
        mark.margin_top = 4;
        box.add_child(mark);
        this._pulseAfterRender = mark;

        const title = label('Finding your location…', 'wc-title');
        title.x_align = Clutter.ActorAlign.CENTER;
        title.margin_top = 18;
        box.add_child(title);

        const body = label(
            'GNOME will ask for your permission. This only takes a moment.',
            'wc-body', {wrap: true});
        body.x_align = Clutter.ActorAlign.CENTER;
        body.margin_top = 10;
        box.add_child(body);

        return box;
    }

    _buildLoading() {
        const box = vbox();

        const header = hbox();
        header.add_child(this._skel(120, 14));
        const upd = this._skel(64, 10);
        upd.x_align = Clutter.ActorAlign.END;
        header.add_child(upd);
        box.add_child(header);

        const hero = hbox();
        hero.margin_top = 10;
        hero.add_child(this._skel(120, 56));
        const icon = this._skelRound(HERO_ICON_SIZE);
        icon.x_align = Clutter.ActorAlign.END;
        hero.add_child(icon);
        box.add_child(hero);

        const condition = this._skel(160, 14);
        condition.margin_top = 8;
        box.add_child(condition);

        const meta1 = this._skel(210, 11);
        meta1.margin_top = 10;
        box.add_child(meta1);
        const meta2 = this._skel(140, 11);
        meta2.margin_top = 7;
        box.add_child(meta2);

        const sep = separator();
        sep.margin_top = 18;
        sep.margin_bottom = 14;
        box.add_child(sep);

        const hours = hbox();
        hours.x_expand = true;
        for (let i = 0; i < HOURLY_COUNT; i++) {
            const cell = vbox(7);
            cell.x_expand = true;
            cell.add_child(this._skel(30, 9));
            const icon2 = this._skelRound(HOURLY_ICON_SIZE);
            icon2.x_align = Clutter.ActorAlign.CENTER;
            cell.add_child(icon2);
            cell.add_child(this._skel(28, 10));
            hours.add_child(cell);
        }
        box.add_child(hours);

        const footnote = label('Updating…', 'wc-footnote');
        footnote.margin_top = 14;
        box.add_child(footnote);
        this._pulseAfterRender = box;

        return box;
    }

    _skel(w, h) {
        const s = new St.Widget({style_class: 'wc-skel', width: w, height: h});
        return s;
    }

    _skelRound(size) {
        return new St.Widget({style_class: 'wc-skel-round', width: size, height: size});
    }

    _buildChoosePending() {
        const box = vbox();
        const title = label('Choose a location', 'wc-title');
        title.x_align = Clutter.ActorAlign.CENTER;
        title.margin_top = 6;
        box.add_child(title);
        const body = label(
            'Pick a place in the window that just opened.',
            'wc-body', {wrap: true});
        body.x_align = Clutter.ActorAlign.CENTER;
        body.margin_top = 10;
        box.add_child(body);
        return box;
    }

    _buildError(kind) {
        const specs = {
            'network': {
                title: 'No connection',
                body: 'You appear to be offline. Weather will update automatically once you’re connected again.',
                primary: 'Try Again',
                onPrimary: () => this._callbacks.refresh?.(),
            },
            'provider': {
                title: 'Weather service hiccup',
                body: 'The weather service couldn’t answer just now. This is usually brief.',
                primary: 'Try Again',
                onPrimary: () => this._callbacks.refresh?.(),
            },
            'malformed': {
                title: 'Couldn’t read the update',
                body: 'The weather service sent something unexpected. Trying again usually fixes it.',
                primary: 'Try Again',
                onPrimary: () => this._callbacks.refresh?.(),
            },
            'permission': {
                title: 'Location access declined',
                body: 'You can allow access from Settings → Privacy → Location, or simply choose a place to use instead.',
                primary: 'Choose Location…',
                onPrimary: () => this._callbacks.chooseLocation?.(),
                secondary: 'Try Again',
                onSecondary: () => this._callbacks.useCurrentLocation?.(),
            },
            'location': {
                title: 'Couldn’t determine location',
                body: 'Location services may be switched off or unavailable. You can pick a place manually instead.',
                primary: 'Choose Location…',
                onPrimary: () => this._callbacks.chooseLocation?.(),
                secondary: 'Try Again',
                onSecondary: () => this._callbacks.useCurrentLocation?.(),
            },
        };
        const spec = specs[kind] ?? specs.provider;

        const box = vbox();
        const title = label(spec.title, 'wc-title');
        title.margin_top = 4;
        box.add_child(title);
        const body = label(spec.body, 'wc-body', {wrap: true});
        body.margin_top = 10;
        box.add_child(body);

        const actions = hbox(10);
        actions.margin_top = 22;
        actions.margin_bottom = 4;
        actions.add_child(button(spec.primary, 'wc-btn-primary', spec.onPrimary));
        if (spec.secondary)
            actions.add_child(button(spec.secondary, 'wc-btn-text', spec.onSecondary));
        box.add_child(actions);

        return box;
    }

    /* ------------------------------------------------------ transitions */

    _setContent(content) {
        this._stopPulse();
        const old = this._content;
        this._content = content;
        this.actor.set_child(content);
        if (old)
            old.destroy();

        if (content && icons.animationsEnabled()) {
            content.set_opacity(0);
            content.ease({opacity: 255, duration: 180, mode: EASE});
        }

        // A pulse requested during build starts after the fade-in so the
        // two never fight over the opacity property.
        const pulseTarget = this._pulseAfterRender;
        this._pulseAfterRender = null;
        if (pulseTarget)
            this._startPulse(pulseTarget, 250);
    }

    _startPulse(target, initialDelayMs = 0) {
        this._stopPulse();
        if (!icons.animationsEnabled())
            return;
        this._pulse = target;
        const step = (low, delayMs) => {
            if (this._pulse !== target || this._destroyed)
                return;
            target.ease({
                opacity: low ? 140 : 255,
                duration: 900,
                delay: delayMs,
                mode: EASE_INOUT,
                onComplete: () => step(!low, 0),
            });
        };
        step(true, initialDelayMs);
    }

    _stopPulse() {
        this._pulse = null;
    }

    /* ---------------------------------------------------------- teardown */

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        this._stopPulse();
        this._press = null;
        this._menu?.close();

        for (const id of [this._pressId, this._releaseId, this._motionId, this._keyId]) {
            try {
                this.actor.disconnect(id);
            } catch (e) {
                // Actor may already be gone.
            }
        }

        this.actor.destroy();
        this._content = null;
    }
}

/* ------------------------------------------------------------- menu ---- */

/* A deliberately tiny custom menu: four rows, keyboard navigation,
 * focus-visible styling, closes on outside click. */
class CardMenu {
    constructor({items, onClose}) {
        this._onClose = onClose;
        this.isOpen = false;

        this.actor = new St.BoxLayout({
            orientation: V,
            style_class: 'wc-menu',
            reactive: true,
            visible: false,
        });

        this._rows = [];
        this._stagePressId = 0;
        this._keyId = 0;

        for (const item of items) {
            const row = new St.Button({
                style_class: 'wc-menu-item',
                can_focus: true,
            });
            const content = hbox(8);
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

        this._keyId = this.actor.connect('key-press-event', (a, event) => {
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

        // Measure now that the actor is staged, then anchor it to the
        // card's top-right corner, clamped inside the monitor.
        const [minW, natW] = this.actor.get_preferred_width(-1);
        const [minH, natH] = this.actor.get_preferred_height(-1);
        const [ax, ay] = anchor.get_position();
        let x = ax + anchor.width - natW - 8;
        let y = ay + 8;
        try {
            const idx = global.display.get_primary_monitor();
            const mon = global.display.get_monitor_geometry(idx);
            x = Math.min(Math.max(mon.x + 8, x), mon.x + mon.width - natW - 8);
            y = Math.min(Math.max(mon.y + 8, y), mon.y + mon.height - natH - 8);
        } catch (e) {
            // Best effort.
        }
        this.actor.set_position(Math.round(x), Math.round(y));

        this._stagePressId = global.stage.connect('button-press-event',
            (stage, event) => {
                let node = event.get_source();
                let inside = false;
                while (node) {
                    if (node === this.actor) {
                        inside = true;
                        break;
                    }
                    node = node.get_parent();
                }
                if (!inside)
                    this.close();
                return Clutter.EVENT_PROPAGATE;
            });

        this._rows[0]?.grab_key_focus();

        const animate = icons.animationsEnabled();
        if (animate) {
            this.actor.set_opacity(0);
            this.actor.ease({opacity: 255, duration: 130, mode: EASE});
        }
    }

    _onRowKey(row, event) {
        const key = event.get_key_symbol();
        if (key !== Clutter.KEY_Up && key !== Clutter.KEY_Down)
            return Clutter.EVENT_PROPAGATE;
        const idx = this._rows.indexOf(row);
        const next = key === Clutter.KEY_Down
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
            // Not added / already removed.
        }
        this.actor.destroy();
        this._rows = [];
        this._onClose?.();
    }
}
