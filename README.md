# Weather Card — a quiet weather widget for the GNOME desktop

A native GNOME Shell extension that puts one elegant, restrained weather
card on your desktop. Built for **Ubuntu 26.04 LTS / GNOME Shell 50**
(and 51). No Electron, no WebView, no daemon — just GJS/ES modules and
the shell's own St/Clutter toolkit.

- ~300–360 px wide, airy, strongly hierarchical
- Current conditions, feels-like, today's high/low, precipitation
  probability, a subtle next-hours strip, last-updated state
- Original SVG icon family (two color schemes), HiDPI-crisp
- Light & dark appearance following the system style
- Full location consent flow through GNOME (GeoClue), with manual city
  search as a first-class fallback
- Cached weather at startup, offline behavior, calm error states
- Refreshes every 10–15 minutes — never per-minute polling; negligible
  idle cost

Weather data by [Open-Meteo](https://open-meteo.com) (no API key, no
account, no tracking).

---

## Design principles

The goal is a widget that feels quiet, premium, native, and obvious to
use — not a dashboard:

- Typography and spacing do the work: one 62 px light-weight
  temperature, one condition line, two quiet metadata lines.
- Hairline separator, generous margins, no borders, no shadows, no
  glass, no gradients, no glow.
- Every state is designed (first run, locating, loading, offline,
  errors). The card is never blank.
- Micro-animation is subtle (content cross-fade ~180 ms, a gentle
  loading pulse) and disappears entirely when
  *Settings → Accessibility → Reduce animation* is on.

## Requirements

- GNOME Shell 50 or 51 (Ubuntu 26.04 LTS or newer Fedora/Arch)
- `geoclue-2.0` (recommended — Ubuntu ships it; enables the
  permission-based automatic location)
- `librsvg` (rasterizes the SVG icons; standard on GNOME)
- `glib-compile-schemas` (usually in `libglib2.0-bin`) for installation

## Installation

From a checkout of this repository:

```bash
./install.sh
gnome-extensions enable weather-card@z.ai
```

`install.sh` copies the extension to
`~/.local/share/gnome-shell/extensions/weather-card@z.ai/`, compiles the
GSettings schema, and installs a small `.desktop` file whose only job
is to give GNOME's location permission dialog a proper name
("Weather Card").

If the shell doesn't notice the new extension immediately, log out and
back in (Wayland) or press `Alt+F2`, type `r`, press Enter (X11).

Manual equivalent:

```bash
mkdir -p ~/.local/share/gnome-shell/extensions
cp -R weather-card@z.ai ~/.local/share/gnome-shell/extensions/
glib-compile-schemas ~/.local/share/gnome-shell/extensions/weather-card@z.ai/schemas
cp weather-card.desktop ~/.local/share/applications/
```

You can also manage the extension with the **Extensions** app or
<https://extensions.gnome.org/local/>.

## Enabling / disabling

```bash
gnome-extensions enable weather-card@z.ai
gnome-extensions disable weather-card@z.ai
gnome-extensions info weather-card@z.ai
```

Disabling tears everything down: network requests are cancelled,
timers removed, D-Bus subscriptions released, the card and its menu
destroyed. Enabling rebuilds from cache — the card appears instantly
with the last known weather, then quietly updates if stale.

## First run & location

On first launch the card shows:

> **Weather where you are**
> Allow Weather to use your approximate location to show local
> conditions.
> [ Use Current Location ] [ Choose Location ]

- **Use Current Location** asks through GNOME's normal location
  permission dialog (GeoClue agent). City-level accuracy is all that is
  requested — never street-level.
- **Choose Location** opens a search dialog (Open-Meteo's geocoding
  service; the search term, not your location, is what gets sent).

If permission is declined, location services are off, or GeoClue is
missing, the card explains the situation calmly and offers
**Choose Location…** — manual search is a complete fallback, not an
afterthought.

Coordinates are rounded to **two decimals (~1 km)** before they are
used anywhere, and are stored locally only so the widget doesn't ask
location services again on every login.

## Interacting with the card

- **Drag** the card anywhere on the desktop; the position is remembered.
- **Click** (or press `Return` once the card is focused) for a small
  menu: *Refresh · Switch to °F/°C · Change Location… · Reset Position*.
- The menu is fully keyboard-navigable (`↑` `↓` `Enter` `Esc`).
- Preferences (Extensions app → gear) cover location, units, refresh
  interval, and resetting the card position — nothing else, on purpose.

## States

| Situation | What you see |
| --- | --- |
| First launch | Onboarding card with the two actions above |
| Requesting location | "Finding your location…" with a soft pulse |
| Loading weather (no cache) | Skeleton card, "Updating…" |
| Normal | The full weather card |
| Offline with cache | Weather + quiet "Offline — updated 2:14 PM" + *Try Again* |
| Permission declined | Explanation + *Choose Location…* / *Try Again* |
| Location unavailable | Explanation + *Choose Location…* / *Try Again* |
| Network unavailable (no cache) | "No connection" + *Try Again*; auto-refresh when back |
| Provider error / busy | "Weather service hiccup" + *Try Again* (backoff) |
| Malformed response | "Couldn't read the update" + *Try Again* |
| Empty search results | "No matching places. Check the spelling…" |

## Refresh & performance behavior

- Refresh interval: 10/15/30/60 minutes (default **15**).
- The last successful response is cached
  (`~/.cache/weather-card@z.ai/weather.json`) and rendered
  immediately at startup.
- On wake from suspend, the widget refreshes **only if the cache is
  stale** (after a short settle delay).
- When connectivity returns, it refreshes if stale — no repeated
  requests while offline, no polling every minute.
- Failures back off exponentially (interval ×2, ×4, capped at ×4).
- Every request has hard timeouts (20 s I/O + 30 s ceiling) and is
  cancelled on disable.
- Idle cost is one GLib timeout and zero wake-ups otherwise: the shell
  journal stays silent, CPU/memory usage is negligible.

## Privacy

- **Coordinates never leave this machine except to the weather
  provider** (`api.open-meteo.com`), in the form of two-decimal
  rounded values. They are not logged, not analyzed, not transmitted
  anywhere else.
- Location acquisition happens through **GeoClue2 over D-Bus** — the
  same mechanism the XDG portals use — with the consent dialog handled
  by GNOME Shell itself. The extension never reads location without
  that consent, and never does IP-based lookups.
- The only other network calls are city-name **searches** you type
  yourself (`geocoding-api.open-meteo.com`) — those send the search
  term, not your location.
- No analytics, telemetry, accounts, or cloud backends. No API keys or
  secrets are embedded.
- Stored locally: your preferences and saved position (GSettings /
  dconf), the last weather snapshot (cache file), and the rounded
  coordinates described above. Remove them all with `./uninstall.sh`.

## Weather data source & units

- [Open-Meteo](https://open-meteo.com) forecast API, requested with
  exactly the fields displayed, in the location's own timezone.
- Provider weather codes are mapped into the widget's own domain
  model; UI code never sees provider-specific values, so the backend
  can be swapped by reimplementing `provider.js`.
- Units: automatic (locale-based — °F where customary, °C elsewhere) or
  an explicit choice. Switching re-renders instantly from cached data.

## Troubleshooting

Look at the shell journal:

```bash
journalctl -f /usr/bin/gnome-shell   # then reproduce the issue
```

- **Card doesn't appear after install:** log out/in (Wayland), then
  check `gnome-extensions info weather-card@z.ai`.
- **"Couldn't determine location":** check
  *Settings → Privacy → Location Services*, and that `geoclue` is
  installed; or simply choose a city manually.
- **Permission was denied earlier:** geoclue remembers denials; allow
  "Weather Card" in the location permission list, or use manual
  location.
- **Weather service hiccup for a long time:** Open-Meteo rate-limits
  anonymous traffic per IP; the widget backs off and retries
  automatically.
- **Icons missing/blank:** ensure `librsvg` is installed
  (`gdk-pixbuf` SVG loader).
- **Position lost after monitor changes:** the card re-clamps into the
  primary monitor; use *Reset Position* in the menu.

## Development

```
weather-card@z.ai/           the extension (installable directory)
  extension.js               lifecycle, state machine, scheduling
  widget.js                  card UI: layout, states, drag, menu
  weather.js                 domain model + payload validation (pure)
  provider.js                Open-Meteo transport (Soup 3)
  geoclue.js                 one-shot location service (D-Bus)
  store.js                   settings + snapshot cache
  icons.js                   icon rendering (St.TextureCache)
  prefs.js                   preferences window (Adwaita)
  stylesheet-dark|light.css  color schemes (auto-selected by the shell)
  schemas/                   GSettings schema
  icons/{dark,light}/*.svg   original icon family
tools/
  generate-assets.py         regenerates icons + stylesheets from tokens
  verify-logic.mjs           unit-style checks for weather.js
install.sh / uninstall.sh
weather-card.desktop         GeoClue app identity for the permission dialog
```

- Regenerate the icon family and stylesheets after tweaking design
  tokens: `python3 tools/generate-assets.py`
- Run the logic checks: `node tools/verify-logic.mjs` (add `--live`
  to also parse a real API response)
- Reload after changes: disable, `./install.sh`, enable (Wayland may
  need a re-login; X11: `Alt+F2` → `r`).

## License

MIT — see `LICENSE`. Weather data © Open-Meteo, used under their
terms. This project is not affiliated with Open-Meteo, GNOME, or
Ubuntu. The visual design and all icon artwork are original; no Apple
assets or artwork are used.
