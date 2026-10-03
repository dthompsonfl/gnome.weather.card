/* prefs.js — Weather Card preferences.
 *
 * A deliberately small settings surface:
 *   - Location: automatic (GeoClue) or manual (city search)
 *   - Temperature units (automatic / °C / °F)
 *   - Refresh interval
 *   - Reset card position
 *
 * Opens with the location search front and center when the user came
 * from the card's "Choose Location…" action with nothing configured.
 *
 * SPDX-License-Identifier: MIT
 */

import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/shell/extensions/prefs.js';

import {OpenMeteoProvider} from './provider.js';
import * as weather from './weather.js';

const UNIT_CHOICES = [
    ['auto', 'Automatic', 'Follows your locale'],
    ['celsius', 'Celsius (°C)', ''],
    ['fahrenheit', 'Fahrenheit (°F)', ''],
];

const INTERVAL_CHOICES = [
    [10, 'Every 10 minutes'],
    [15, 'Every 15 minutes'],
    [30, 'Every 30 minutes'],
    [60, 'Every hour'],
];

const SEARCH_DEBOUNCE_MS = 350;

export default class WeatherCardPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: 'Weather Card',
            icon_name: 'preferences-system-symbolic',
        });
        page.add(this._locationGroup(window, settings));
        page.add(this._unitsGroup(settings));
        page.add(this._refreshGroup(settings));
        page.add(this._widgetGroup(settings));
        page.add(this._aboutGroup());
        window.add(page);

        // Arrived from the card's "Choose Location…" with nothing picked:
        // open search immediately.
        if (settings.get_string('location-mode') === 'manual' &&
            settings.get_string('manual-name') === '') {
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._presentSearch(window, settings);
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    /* ----------------------------------------------------------- groups */

    _locationGroup(window, settings) {
        const group = new Adw.PreferencesGroup({
            title: 'Location',
            description: 'Where the card gets its weather from.',
        });

        const autoRow = new Adw.SwitchRow({
            title: 'Use current location',
            subtitle: 'GNOME will ask for permission through location services.',
        });
        autoRow.activatable = false;
        group.add(autoRow);

        const placeRow = new Adw.ActionRow({
            title: 'Chosen location',
        });
        const changeButton = new Gtk.Button({
            label: 'Change…',
            valign: Gtk.Align.CENTER,
        });
        changeButton.connect('clicked', () =>
            this._presentSearch(window, settings));
        placeRow.add_suffix(changeButton);
        this._placeRow = placeRow;
        this._syncPlaceRow(settings);
        settings.connect('changed::manual-name', () => this._syncPlaceRow(settings));
        group.add(placeRow);

        // The switch row maps 'auto'/'manual' onto a boolean.
        const updateSwitch = () => {
            autoRow.active = settings.get_string('location-mode') === 'auto';
        };
        updateSwitch();
        settings.connect('changed::location-mode', updateSwitch);
        autoRow.connect('notify::active', () => {
            const want = autoRow.active ? 'auto' : 'manual';
            if (settings.get_string('location-mode') !== want)
                settings.set_string('location-mode', want);
        });

        return group;
    }

    _syncPlaceRow(settings) {
        const name = settings.get_string('manual-name');
        this._placeRow.subtitle = name !== '' ? name : 'None chosen yet';
    }

    _unitsGroup(settings) {
        const group = new Adw.PreferencesGroup({
            title: 'Display',
        });

        const model = new Gtk.StringList();
        for (const [, label] of UNIT_CHOICES)
            model.append(label);
        const row = new Adw.ComboRow({
            title: 'Temperature units',
            model,
        });
        const sync = () => {
            const value = settings.get_string('unit');
            row.selected = Math.max(0, UNIT_CHOICES.findIndex(([key]) => key === value));
            let subtitle = UNIT_CHOICES[row.selected][2];
            if (value === 'auto')
                subtitle += ` — currently °${weather.resolveUnit('auto') === 'fahrenheit' ? 'F' : 'C'}`;
            row.subtitle = subtitle || null;
        };
        sync();
        settings.connect('changed::unit', sync);
        row.connect('notify::selected', () => {
            const [key] = UNIT_CHOICES[row.selected];
            if (settings.get_string('unit') !== key)
                settings.set_string('unit', key);
        });
        group.add(row);
        return group;
    }

    _refreshGroup(settings) {
        const group = new Adw.PreferencesGroup({
            title: 'Updates',
        });

        const model = new Gtk.StringList();
        for (const [, label] of INTERVAL_CHOICES)
            model.append(label);
        const row = new Adw.ComboRow({
            title: 'Refresh interval',
            model,
        });
        const sync = () => {
            const value = settings.get_uint('refresh-interval');
            row.selected = Math.max(0, INTERVAL_CHOICES.findIndex(([mins]) => mins === value));
        };
        sync();
        settings.connect('changed::refresh-interval', sync);
        row.connect('notify::selected', () => {
            const [mins] = INTERVAL_CHOICES[row.selected];
            if (settings.get_uint('refresh-interval') !== mins)
                settings.set_uint('refresh-interval', mins);
        });
        group.add(row);
        return group;
    }

    _widgetGroup(settings) {
        const group = new Adw.PreferencesGroup({
            title: 'Widget',
        });
        const row = new Adw.ActionRow({
            title: 'Card position',
            subtitle: 'Drag the card on your desktop, or reset it to the default corner.',
        });
        const button = new Gtk.Button({label: 'Reset', valign: Gtk.Align.CENTER});
        button.connect('clicked', () => {
            settings.set_int('card-x', -1);
            settings.set_int('card-y', -1);
        });
        row.add_suffix(button);
        group.add(row);
        return group;
    }

    _aboutGroup() {
        return new Adw.PreferencesGroup({
            title: 'About',
            description:
                'Weather data by Open-Meteo (open-meteo.com). ' +
                'Coordinates are sent only to Open-Meteo — never anywhere else.',
        });
    }

    /* ------------------------------------------------------------ search */

    _presentSearch(window, settings) {
        const dialog = new Adw.Dialog({
            title: 'Choose a location',
            width_request: 420,
            height_request: 460,
        });

        const provider = new OpenMeteoProvider();

        const search = new Gtk.SearchEntry({
            placeholder_text: 'Search for a city…',
            hexpand: true,
        });

        const header = new Adw.HeaderBar();
        header.title_widget = search;

        const list = new Gtk.ListBox({selection_mode: Gtk.SelectionMode.NONE});
        const scrolled = new Gtk.ScrolledWindow({child: list, hscrollbar_policy: Gtk.PolicyType.NEVER});

        const empty = new Gtk.Label({
            label: 'No matching places.\nCheck the spelling or try a larger nearby city.',
            justify: Gtk.Justification.CENTER,
            wrap: true,
            margin_top: 36,
            margin_bottom: 36,
            margin_start: 24,
            margin_end: 24,
        });
        empty.add_css_class('dim-label');

        const hint = new Gtk.Label({
            label: 'Start typing to search.',
            justify: Gtk.Justification.CENTER,
            margin_top: 36,
            margin_bottom: 36,
        });
        hint.add_css_class('dim-label');

        const spinner = new Gtk.Spinner({spinning: true, margin_top: 36, margin_bottom: 36});

        const stack = new Gtk.Stack({vexpand: true});
        stack.add_named(hint, 'hint');
        stack.add_named(spinner, 'searching');
        stack.add_named(scrolled, 'results');
        stack.add_named(empty, 'empty');
        stack.visible_child = hint;

        const toolbar = new Adw.ToolbarView();
        toolbar.add_top_bar(header);
        toolbar.set_content(stack);
        dialog.set_child(toolbar);

        let debounce = 0;
        let request = 0;

        const runSearch = term => {
            if (term.length < 2)
                return;
            stack.visible_child = spinner;
            const myRequest = ++request;
            const language = (GLib.get_language_names()?.[0] ?? 'en').split(/[_.]/)[0] || 'en';
            provider.searchPlaces(term, language).then(places => {
                if (myRequest !== request)
                    return;
                list.remove_all();
                if (places.length === 0) {
                    empty.label =
                        'No matching places.\nCheck the spelling or try a larger nearby city.';
                    stack.visible_child = empty;
                    return;
                }
                for (const place of places) {
                    const subtitle = [place.region, place.country]
                        .filter(s => s !== '').join(', ');
                    const row = new Adw.ActionRow({
                        title: place.name,
                        subtitle: subtitle || null,
                    });
                    row.connect('activated', () => {
                        settings.set_string('manual-name', place.name);
                        settings.set_double('manual-latitude', place.latitude);
                        settings.set_double('manual-longitude', place.longitude);
                        settings.set_string('location-mode', 'manual');
                        provider.dispose();
                        dialog.close();
                    });
                    list.append(row);
                }
                stack.visible_child = scrolled;
            }).catch(e => {
                if (myRequest !== request)
                    return;
                empty.label =
                    'Search isn’t available right now.\nCheck your connection and try again.';
                stack.visible_child = empty;
            });
        };

        search.connect('search-changed', () => {
            if (debounce)
                GLib.source_remove(debounce);
            debounce = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SEARCH_DEBOUNCE_MS, () => {
                debounce = 0;
                runSearch(search.text.trim());
                return GLib.SOURCE_REMOVE;
            });
        });

        dialog.connect('closed', () => {
            if (debounce) {
                GLib.source_remove(debounce);
                debounce = 0;
            }
            request++;  // invalidate in-flight responses
            provider.dispose();
        });

        dialog.present(window);
        search.grab_focus();
    }
}
