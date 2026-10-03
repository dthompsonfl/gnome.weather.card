#!/usr/bin/env python3
"""
generate-assets.py — Weather Card asset and stylesheet generator.

Emits, from one set of design tokens:

  * 12 original SVG weather icons (one family, two colour schemes)
  * stylesheet.css          — scheme-independent structure and geometry
  * stylesheet-dark.css     — dark palette
  * stylesheet-light.css    — light palette

Why the split: GNOME Shell loads exactly ONE stylesheet variant per
extension, picked from a fixed list at activation time, and never
re-selects it when the system colour scheme changes. So the shared
stylesheet carries every structural rule and geometry, and the variants
carry only colour. material.js swaps the variant at runtime through the
public St.Theme API, and a swap can never alter layout.

Deterministic by construction: no randomness, no timestamps, no dependence
on dict ordering. Running this twice must produce no Git diff.

Run from the repo root:  python3 tools/generate-assets.py
"""

import math
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
EXT = os.path.join(HERE, "..", "weather-card@z.ai")

# ------------------------------------------------------------ geometry ----
# Mirrors tokens.js so the painted CSS and the runtime actor tree cannot
# disagree about sizes. tokens.js stays authoritative at runtime; these are
# the paint values.

RADIUS_CARD = 26
RADIUS_MENU = 18
RADIUS_CONTROL = 12

PAD_X = 24
PAD_TOP = 22
PAD_BOTTOM = 18

TYPE_TOKENS = {
    "T_HERO": 66,
    "T_HERO_TRACKING": -2.5,
    "T_LOCATION": 15,
    "T_CONDITION": 16,
    "T_META": 13,
    "T_HOUR_TIME": 11,
    "T_HOUR_TEMP": 13,
    "T_STATUS": 12,
    "T_TITLE": 20,
    "T_BODY": 14,
}

# ------------------------------------------------------------ SVG tokens ---

T_MAIN = "MAIN"    # primary silhouette (clouds, moon)
T_SOFT = "SOFT"    # secondary shapes (back clouds, snow, stars)
T_SUN = "SUN"      # warm accent (sun, rays, bolt)
T_COOL = "COOL"    # precipitation accent (rain, drizzle)
T_MIST = "MIST"    # fog lines

ALL_TOKENS = (T_MAIN, T_SOFT, T_SUN, T_COOL, T_MIST)

# Artwork palettes, deliberately independent of the card's own palette: the
# glass stays neutral, the art carries the weather.
SCHEMES = {
    "dark": {
        T_MAIN: "#E8ECF4",
        T_SOFT: "#7F8AA0",
        T_SUN: "#F5BE55",
        T_COOL: "#9CC3E8",
        T_MIST: "#B4BECB",
    },
    "light": {
        T_MAIN: "#39414F",
        T_SOFT: "#A9B1C1",
        T_SUN: "#DE9A2C",
        T_COOL: "#4A6F98",
        T_MIST: "#6E7686",
    },
}

# ------------------------------------------------------------ css tokens ----

# The full set of colour names a palette must supply. Keeping this explicit
# means a missing key fails loudly at generation time rather than silently
# emitting an unresolved variable.
COLOR_NAMES = (
    "SURFACE", "SURFACE_TOP", "SURFACE_BOTTOM", "SHEEN", "SHEEN_BOTTOM",
    "KEYLINE", "SHADOW", "FG", "FG_DIM", "FG_FAINT", "HAIRLINE", "ACCENT",
    "CRITICAL", "BTN", "BTN_HOVER", "BTN_ACTIVE", "FOCUS", "SKELETON",
    "SCENE_GLOW", "MENU", "MENU_ITEM_HOVER", "DROP", "FLAKE", "MIST_BAR",
)

# Dark: a deep, slightly cool glass that keeps white artwork crisp and
# separates itself from both bright and dark wallpapers.
DARK = {
    "SURFACE": "rgba(20, 22, 27, 0.62)",
    "SURFACE_TOP": "rgba(46, 51, 61, 0.58)",
    "SURFACE_BOTTOM": "rgba(14, 15, 19, 0.66)",
    "SHEEN": "rgba(255, 255, 255, 0.085)",
    "SHEEN_BOTTOM": "rgba(255, 255, 255, 0.012)",
    "KEYLINE": "rgba(255, 255, 255, 0.16)",
    "SHADOW": "rgba(0, 0, 0, 0.44)",
    "FG": "rgba(247, 249, 252, 0.98)",
    "FG_DIM": "rgba(247, 249, 252, 0.62)",
    "FG_FAINT": "rgba(247, 249, 252, 0.44)",
    "HAIRLINE": "rgba(255, 255, 255, 0.13)",
    "ACCENT": "rgba(245, 190, 85, 0.9)",
    "CRITICAL": "rgba(255, 166, 128, 0.95)",
    "BTN": "rgba(255, 255, 255, 0.13)",
    "BTN_HOVER": "rgba(255, 255, 255, 0.20)",
    "BTN_ACTIVE": "rgba(255, 255, 255, 0.27)",
    "FOCUS": "rgba(255, 255, 255, 0.75)",
    "SKELETON": "rgba(255, 255, 255, 0.09)",
    "SCENE_GLOW": "rgba(255, 255, 255, 0.07)",
    "MENU": "rgba(26, 28, 34, 0.90)",
    "MENU_ITEM_HOVER": "rgba(255, 255, 255, 0.10)",
    "DROP": "rgba(156, 195, 232, 0.85)",
    "FLAKE": "rgba(255, 255, 255, 0.82)",
    "MIST_BAR": "rgba(255, 255, 255, 0.30)",
}

# Light: a bright, cool glass that keeps dark artwork legible and never
# washes out against a pale wallpaper.
LIGHT = {
    "SURFACE": "rgba(252, 252, 254, 0.66)",
    "SURFACE_TOP": "rgba(255, 255, 255, 0.80)",
    "SURFACE_BOTTOM": "rgba(233, 236, 243, 0.70)",
    "SHEEN": "rgba(255, 255, 255, 0.55)",
    "SHEEN_BOTTOM": "rgba(255, 255, 255, 0.10)",
    "KEYLINE": "rgba(12, 15, 22, 0.13)",
    "SHADOW": "rgba(16, 20, 30, 0.22)",
    "FG": "rgba(20, 23, 29, 0.96)",
    "FG_DIM": "rgba(20, 23, 29, 0.62)",
    "FG_FAINT": "rgba(20, 23, 29, 0.46)",
    "HAIRLINE": "rgba(12, 15, 22, 0.11)",
    "ACCENT": "rgba(196, 124, 12, 0.95)",
    "CRITICAL": "rgba(178, 66, 38, 0.95)",
    "BTN": "rgba(16, 20, 30, 0.075)",
    "BTN_HOVER": "rgba(16, 20, 30, 0.125)",
    "BTN_ACTIVE": "rgba(16, 20, 30, 0.17)",
    "FOCUS": "rgba(16, 20, 30, 0.75)",
    "SKELETON": "rgba(16, 20, 30, 0.085)",
    "SCENE_GLOW": "rgba(255, 255, 255, 0.55)",
    "MENU": "rgba(252, 252, 254, 0.92)",
    "MENU_ITEM_HOVER": "rgba(16, 20, 30, 0.07)",
    "DROP": "rgba(58, 104, 152, 0.72)",
    "FLAKE": "rgba(40, 52, 70, 0.62)",
    "MIST_BAR": "rgba(30, 40, 55, 0.24)",
}

# High contrast is a set of overrides keyed to the same names, applied by a
# style class so it composes with either colour variant rather than
# replacing it.
HIGH_CONTRAST = {
    "SURFACE": "rgba(0, 0, 0, 0.96)",
    "SURFACE_TOP": "rgba(0, 0, 0, 0.96)",
    "SURFACE_BOTTOM": "rgba(0, 0, 0, 0.96)",
    "SHEEN": "rgba(255, 255, 255, 0.06)",
    "SHEEN_BOTTOM": "rgba(255, 255, 255, 0.0)",
    "KEYLINE": "rgba(255, 255, 255, 0.75)",
    "SHADOW": "rgba(0, 0, 0, 0.6)",
    "FG": "rgba(255, 255, 255, 1)",
    "FG_DIM": "rgba(255, 255, 255, 0.92)",
    "FG_FAINT": "rgba(255, 255, 255, 0.82)",
    "HAIRLINE": "rgba(255, 255, 255, 0.45)",
    "ACCENT": "rgba(255, 226, 150, 1)",
    "CRITICAL": "rgba(255, 190, 160, 1)",
    "BTN": "rgba(255, 255, 255, 0.20)",
    "BTN_HOVER": "rgba(255, 255, 255, 0.32)",
    "BTN_ACTIVE": "rgba(255, 255, 255, 0.42)",
    "FOCUS": "rgba(255, 255, 255, 1)",
    "SKELETON": "rgba(255, 255, 255, 0.18)",
    "SCENE_GLOW": "rgba(255, 255, 255, 0.10)",
    "MENU": "rgba(0, 0, 0, 0.98)",
    "MENU_ITEM_HOVER": "rgba(255, 255, 255, 0.24)",
    "DROP": "rgba(190, 220, 250, 1)",
    "FLAKE": "rgba(255, 255, 255, 1)",
    "MIST_BAR": "rgba(255, 255, 255, 0.55)",
}

PALETTES = {"dark": DARK, "light": LIGHT}

# ------------------------------------------------------------ svg helpers ---


def circle(cx, cy, r, color, opacity=None):
    op = f' opacity="{opacity}"' if opacity is not None else ""
    return (f'    <circle cx="{cx:.2f}" cy="{cy:.2f}" r="{r:.2f}"'
            f' fill="{color}"{op}/>')


def rrect(x, y, w, h, r, color, opacity=None):
    op = f' opacity="{opacity}"' if opacity is not None else ""
    return (f'    <rect x="{x:.2f}" y="{y:.2f}" width="{w:.2f}"'
            f' height="{h:.2f}" rx="{r:.2f}" fill="{color}"{op}/>')


def line(x1, y1, x2, y2, color, width):
    return (f'    <line x1="{x1:.2f}" y1="{y1:.2f}" x2="{x2:.2f}"'
            f' y2="{y2:.2f}" stroke="{color}" stroke-width="{width:.2f}"/>')


def polygon(points, color, stroke_width=3.0):
    pts = " ".join(f"{x:.2f},{y:.2f}" for x, y in points)
    return (f'    <polygon points="{pts}" fill="{color}"'
            f' stroke="{color}" stroke-width="{stroke_width:.2f}"/>')


def sun(cx, cy, r, ray_in, ray_out, ray_width, color):
    """Filled disc plus eight round-capped rays."""
    parts = [circle(cx, cy, r, color)]
    for i in range(8):
        a = math.pi / 4 * i
        parts.append(line(
            cx + math.cos(a) * ray_in, cy + math.sin(a) * ray_in,
            cx + math.cos(a) * ray_out, cy + math.sin(a) * ray_out,
            color, ray_width))
    return parts


def cloud(cx, cy, scale, color, opacity=None):
    """One family cloud: three circles over a rounded base bar.

    scale 1.0 spans 42 units wide, bottom edge at cy + 14.
    """
    s = scale
    return [
        circle(cx - 13 * s, cy + 3 * s, 11 * s, color, opacity),
        circle(cx + 3 * s, cy - 2 * s, 15 * s, color, opacity),
        circle(cx + 14 * s, cy + 5 * s, 9 * s, color, opacity),
        rrect(cx - 21 * s, cy + 2 * s, 42 * s, 12 * s, 6 * s, color, opacity),
    ]


def crescent(cx, cy, r, color, cut_dx, cut_dy, cut_scale=0.82):
    """Moon masked by an offset circle."""
    cut_r = r * cut_scale
    return (
        f'    <mask id="cut">\n'
        f'      <rect x="0" y="0" width="96" height="96" fill="#ffffff"/>\n'
        f'      <circle cx="{cx + cut_dx:.2f}" cy="{cy + cut_dy:.2f}"'
        f' r="{cut_r:.2f}" fill="#000000"/>\n'
        f'    </mask>\n'
        f'    <circle cx="{cx:.2f}" cy="{cy:.2f}" r="{r:.2f}"'
        f' fill="{color}" mask="url(#cut)"/>'
    )


def sparkle(cx, cy, s, color):
    """Four-point star (two diamonds crossing)."""
    pts = [
        (cx, cy - s), (cx + s * 0.32, cy - s * 0.32), (cx + s, cy),
        (cx + s * 0.32, cy + s * 0.32), (cx, cy + s),
        (cx - s * 0.32, cy + s * 0.32), (cx - s, cy),
        (cx - s * 0.32, cy - s * 0.32),
    ]
    return polygon(pts, color, 0.0)


def drop(x, y, length, slant, color, width):
    """A round-capped rain stroke, slanting left-down by default."""
    return line(x, y, x - length * slant, y + length, color, width)


def flake(cx, cy, s, color, width=4.0):
    parts = []
    for a in (0, math.pi / 3, math.pi * 2 / 3):
        dx = math.cos(a) * s
        dy = math.sin(a) * s
        parts.append(line(cx - dx, cy - dy, cx + dx, cy + dy, color, width))
    return parts


BOLT = [(52, 57), (41, 72), (48, 72), (44, 84), (57, 66), (50, 66), (54, 57)]

# ---------------------------------------------------------------- icons -----

def icon_clear_day():
    return sun(48, 40, 15, 21, 27, 5, T_SUN)


def icon_clear_night():
    return [
        crescent(42, 46, 16, T_MAIN, 9, -7, 0.82),
        sparkle(71, 27, 5.5, T_SOFT),
        sparkle(79, 45, 3.5, T_SOFT),
        sparkle(63, 17, 3, T_SOFT),
    ]


def icon_partly_day():
    return sun(33, 32, 10, 15.5, 20.5, 4.5, T_SUN) + cloud(55, 49, 0.86, T_MAIN)


def icon_partly_night():
    return ([
        crescent(33, 30, 11, T_MAIN, 6.5, -5, 0.82),
        sparkle(56, 19, 4, T_SOFT),
    ] + cloud(55, 49, 0.86, T_MAIN))


def icon_cloudy():
    return cloud(48, 48, 1.0, T_MAIN)


def icon_overcast():
    return cloud(59, 37, 0.62, T_SOFT, 0.9) + cloud(46, 51, 1.0, T_MAIN)


def icon_fog():
    return cloud(48, 38, 0.92, T_MAIN) + [
        line(26, 62, 62, 62, T_MIST, 5.5),
        line(35, 74, 66, 74, T_MIST, 5.5),
        line(43, 86, 70, 86, T_MIST, 5.5),
    ]


def icon_drizzle():
    return cloud(48, 44, 0.96, T_MAIN) + [
        drop(36, 64, 8, 0, T_COOL, 5),
        drop(48, 64, 8, 0, T_COOL, 5),
        drop(60, 64, 8, 0, T_COOL, 5),
    ]


def icon_rain():
    return cloud(48, 42, 0.96, T_MAIN) + [
        drop(40, 61, 13, 0.42, T_COOL, 5.5),
        drop(52, 61, 15, 0.42, T_COOL, 5.5),
        drop(64, 61, 13, 0.42, T_COOL, 5.5),
    ]


def icon_sleet():
    parts = cloud(48, 42, 0.96, T_MAIN) + [drop(38, 60, 13, 0.42, T_COOL, 5.5)]
    parts += flake(52, 68, 6.5, T_SOFT, 4.2)
    parts += [drop(64, 60, 13, 0.42, T_COOL, 5.5)]
    return parts


def icon_snow():
    return cloud(48, 42, 0.96, T_MAIN) + [
        flake(36, 68, 6.5, T_SOFT, 4.2),
        flake(50, 76, 6.5, T_SOFT, 4.2),
        flake(64, 68, 6.5, T_SOFT, 4.2),
    ]


def icon_thunderstorm():
    return cloud(48, 40, 0.96, T_MAIN) + [polygon(BOLT, T_SUN, 3.0)]


ICONS = {
    "clear-day": icon_clear_day,
    "clear-night": icon_clear_night,
    "partly-day": icon_partly_day,
    "partly-night": icon_partly_night,
    "cloudy": icon_cloudy,
    "overcast": icon_overcast,
    "fog": icon_fog,
    "drizzle": icon_drizzle,
    "rain": icon_rain,
    "sleet": icon_sleet,
    "snow": icon_snow,
    "thunderstorm": icon_thunderstorm,
}


def svg_document(parts):
    # Icon builders compose helpers that return lists, so the result can be
    # nested. Flattening here keeps every builder free to use either style.
    flat = []
    for part in parts:
        if isinstance(part, (list, tuple)):
            flat.extend(part)
        else:
            flat.append(part)
    body = "\n".join(flat)
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"'
        ' width="96" height="96">\n'
        '  <g fill="none" stroke-linecap="round" stroke-linejoin="round">\n'
        f'{body}\n'
        '  </g>\n'
        '</svg>\n'
    )


def write_icons():
    base = os.path.join(EXT, "icons")
    written = 0
    for scheme in ("dark", "light"):
        palette = SCHEMES[scheme]
        scheme_dir = os.path.join(base, scheme)
        os.makedirs(scheme_dir, exist_ok=True)
        for name in ICONS:
            doc = svg_document(ICONS[name]())
            for token, hexcolor in palette.items():
                doc = doc.replace(token, hexcolor)

            # A token surviving into a file would mean a broken asset.
            for token in ALL_TOKENS:
                assert token not in doc, f"unresolved token {token} in {name}"

            # Generated artwork must stay inert and self-contained: no
            # scripting, no remote references, no embedded tracking.
            for forbidden in ("<script", "xlink:href", "http://www.w3.org",
                              "@import", "<image", "<foreignObject"):
                # The xmlns declaration is the one permitted URL.
                stripped = doc.replace(
                    'xmlns="http://www.w3.org/2000/svg"', "")
                assert forbidden not in stripped, \
                    f"{forbidden} found in {scheme}/{name}.svg"

            with open(os.path.join(scheme_dir, f"{name}.svg"), "w") as fh:
                fh.write(doc)
            written += 1
    print(f"icons: wrote {written} svg files "
          f"({len(ICONS)} conditions x {len(SCHEMES)} schemes)")


# ---------------------------------------------------------- stylesheets ----

BASE_CSS = """\
/* Weather Card — structure, geometry and type.
 *
 * GENERATED by tools/generate-assets.py. Edit the tokens there, not here.
 *
 * Every scheme-independent rule lives here. Colour arrives through the
 * @define-color names that stylesheet-dark.css / stylesheet-light.css set,
 * and those files are loaded alongside this one. GNOME Shell loads exactly
 * one *variant* at activation and never re-selects it, so material.js swaps
 * the variant at runtime through St.Theme; keeping structure here means a
 * swap can never change layout.
 */

/* --- card shell ------------------------------------------------------
 * The Bin is only a positioning box. All paint belongs to the material
 * layers, so press and hover feedback never repaints the content. */

.wc-card {
    padding: @PAD_TOP@px @PAD_X@px @PAD_BOTTOM@px;
}

/* --- material layers --------------------------------------------------
 * Four stacked planes build the sense of thickness:
 *   base    translucent fill — the glass itself
 *   light   top-edge highlight, as if lit from above
 *   keyline 1px separation from any wallpaper
 *   depth   soft lift, which answers hover and press
 * Only opacity and transform ever animate; no layout property does. */

.wc-material {
    border-radius: @RADIUS_CARD@px;
}

.wc-mat-base {
    background-color: $SURFACE$;
    background-gradient-start: $SURFACE_TOP$;
    background-gradient-end: $SURFACE_BOTTOM$;
    background-gradient-direction: vertical;
    border-radius: @RADIUS_CARD@px;
}

.wc-mat-light {
    background-gradient-start: $SHEEN$;
    background-gradient-end: $SHEEN_BOTTOM$;
    background-gradient-direction: vertical;
    border-radius: @RADIUS_CARD@px;
    /* The brighter top edge is what separates the card from a dark
     * wallpaper; without it the glass reads as a flat rectangle. */
    box-shadow: inset 0 1px 0 $SHEEN$;
}

.wc-mat-keyline {
    border: 1px solid $KEYLINE$;
    border-radius: @RADIUS_CARD@px;
    background-color: transparent;
}

.wc-mat-depth {
    border-radius: @RADIUS_CARD@px;
    box-shadow: 0 1px 2px $SHADOW$, 0 8px 24px $SHADOW$;
    background-color: transparent;
}

.wc-mat-depth-hover {
    box-shadow: 0 2px 4px $SHADOW$, 0 14px 34px $SHADOW$;
}

/* Pressing settles the card rather than shrinking it: the depth cue
 * tightens, which reads as physical without playful bounce. */
.wc-mat-depth-pressed {
    box-shadow: 0 1px 1px $SHADOW$, 0 4px 12px $SHADOW$;
}

/* --- high contrast ----------------------------------------------------
 * Translucency is dropped entirely and legibility leans on a strong
 * keyline, so the card never depends on the wallpaper behind it. */

.wc-material-hc .wc-mat-base {
    background-color: $HC_SURFACE$;
    background-gradient-start: $HC_SURFACE_TOP$;
    background-gradient-end: $HC_SURFACE_BOTTOM$;
}
.wc-material-hc .wc-mat-light {
    box-shadow: none;
}
.wc-material-hc .wc-mat-keyline {
    border: 2px solid $HC_KEYLINE$;
}
.wc-material-hc .wc-mat-depth {
    box-shadow: 0 0 0 1px $HC_KEYLINE$;
}
.wc-material-hc .wc-location,
.wc-material-hc .wc-condition,
.wc-material-hc .wc-temp,
.wc-material-hc .wc-title {
    color: $HC_FG$;
}
.wc-material-hc .wc-meta,
.wc-material-hc .wc-status,
.wc-material-hc .wc-body,
.wc-material-hc .wc-hour-time,
.wc-material-hc .wc-attribution {
    color: $HC_FG_DIM$;
}
.wc-material-hc .wc-menu {
    background-color: $HC_MENU$;
}

/* --- typography ------------------------------------------------------
 * Hierarchy comes from weight, scale and tracking rather than a bundled
 * typeface: St resolves the system font and no web font is shipped. */

.wc-location {
    font-size: @T_LOCATION@pt;
    font-weight: 600;
    letter-spacing: 0.2px;
    color: $FG$;
}

/* Open-Meteo's licence requires a link beside displayed data; this is
 * that link's anchor text. */
.wc-attribution {
    font-size: 10pt;
    font-weight: 400;
    color: $FG_FAINT$;
}

.wc-temp {
    font-size: @T_HERO@pt;
    font-weight: 300;
    letter-spacing: @T_HERO_TRACKING@px;
    color: $FG$;
}

.wc-condition {
    font-size: @T_CONDITION@pt;
    font-weight: 500;
    letter-spacing: 0.1px;
    color: $FG$;
}

.wc-meta {
    font-size: @T_META@pt;
    font-weight: 400;
    color: $FG_DIM$;
}

.wc-meta-sep {
    font-size: @T_META@pt;
    color: $FG_FAINT$;
}

.wc-hour-time {
    font-size: @T_HOUR_TIME@pt;
    font-weight: 400;
    color: $FG_DIM$;
}

.wc-hour-temp {
    font-size: @T_HOUR_TEMP@pt;
    font-weight: 600;
    color: $FG$;
}

.wc-status {
    font-size: @T_STATUS@pt;
    font-weight: 400;
    color: $FG_DIM$;
}

.wc-status-dot {
    background-color: $FG_FAINT$;
    border-radius: 3px;
}

/* Colour is never the only signal: the critical state also changes the
 * dot's shape, so it is distinguishable without colour vision. */
.wc-status-dot-critical {
    background-color: $CRITICAL$;
    border-radius: 1px;
}

.wc-title {
    font-size: @T_TITLE@pt;
    font-weight: 600;
    letter-spacing: -0.1px;
    color: $FG$;
}

.wc-body {
    font-size: @T_BODY@pt;
    font-weight: 400;
    color: $FG_DIM$;
}

.wc-hairline {
    background-color: $HAIRLINE$;
    height: 1px;
}

/* --- weather scene ---------------------------------------------------
 * The artwork is the repository's own generated SVG. The glow behind it
 * carries the condition's atmosphere; it animates only with the scene's
 * own breathing transition, never per frame. */

.wc-scene-glow {
    background-color: $SCENE_GLOW$;
    border-radius: 999px;
}

/* Precipitation accents: a handful of marks, not a particle system. */
.wc-scene-drop {
    background-color: $DROP$;
    border-radius: 2px;
}

.wc-scene-flake {
    background-color: $FLAKE$;
    border-radius: 999px;
}

.wc-scene-mist {
    background-color: $MIST_BAR$;
    border-radius: 999px;
}

/* Lightning reads as a brief illumination of the scene's glow, not as a
 * full-card flash — deliberately gentle for photosensitivity. */
.wc-scene-flash {
    background-color: transparent;
    border-radius: 999px;
    background-gradient-start: rgba(255, 244, 214, 0.85);
    background-gradient-end: rgba(255, 214, 140, 0.0);
    background-gradient-direction: radial;
}

/* --- loading ---------------------------------------------------------
 * A static skeleton in the card's own material. It does not shimmer: a
 * looping shimmer would run forever for a state that lasts a second. */

.wc-skel {
    background-color: $SKELETON$;
    border-radius: 8px;
}

.wc-skel-round {
    border-radius: 999px;
}

/* --- controls -------------------------------------------------------- */

.wc-btn-primary,
.wc-btn-secondary,
.wc-btn-quiet {
    border-radius: @RADIUS_CONTROL@px;
    padding: 9px 16px;
    font-size: 13.5pt;
    font-weight: 600;
    border: none;
}

.wc-btn-primary {
    background-color: $BTN$;
    color: $FG$;
}
.wc-btn-primary:hover { background-color: $BTN_HOVER$; }
.wc-btn-primary:active { background-color: $BTN_ACTIVE$; }

.wc-btn-secondary {
    background-color: transparent;
    color: $FG_DIM$;
}
.wc-btn-secondary:hover { background-color: $BTN$; }
.wc-btn-secondary:active { background-color: $BTN_HOVER$; }

.wc-btn-quiet {
    background-color: transparent;
    color: $FG_DIM$;
    padding: 5px 10px;
    font-size: 12pt;
    font-weight: 500;
}
.wc-btn-quiet:hover { background-color: $BTN$; }

/* One visible focus treatment for every interactive element, so keyboard
 * use is never ambiguous. */
.wc-btn-primary:focus,
.wc-btn-secondary:focus,
.wc-btn-quiet:focus,
.wc-menu-item:focus {
    box-shadow: inset 0 0 0 2px $FOCUS$;
    background-color: $BTN_HOVER$;
}

/* --- menu ------------------------------------------------------------
 * The same material language as the card, so opening it reads as part of
 * one object rather than a foreign popup. */

.wc-menu {
    background-color: $MENU$;
    background-gradient-start: $SURFACE_TOP$;
    background-gradient-end: $MENU$;
    background-gradient-direction: vertical;
    border: 1px solid $KEYLINE$;
    border-radius: @RADIUS_MENU@px;
    padding: 6px;
    box-shadow: 0 8px 28px $SHADOW$;
}

.wc-menu-item {
    background-color: transparent;
    border-radius: 10px;
    padding: 8px 12px;
}

.wc-menu-item:hover,
.wc-menu-item:active {
    background-color: $MENU_ITEM_HOVER$;
}

.wc-menu-item-label {
    font-size: 13.5pt;
    font-weight: 500;
    color: $FG$;
}
"""


def build_base_css():
    """Resolve geometry/type tokens and inline the high-contrast palette."""
    out = BASE_CSS

    substitutions = dict(TYPE_TOKENS)
    substitutions.update({
        "RADIUS_CARD": RADIUS_CARD,
        "RADIUS_MENU": RADIUS_MENU,
        "RADIUS_CONTROL": RADIUS_CONTROL,
        "PAD_X": PAD_X,
        "PAD_TOP": PAD_TOP,
        "PAD_BOTTOM": PAD_BOTTOM,
        # High contrast inlines its own values so the rule set is complete
        # whichever variant is loaded.
        "HC_SURFACE": HIGH_CONTRAST["SURFACE"],
        "HC_SURFACE_TOP": HIGH_CONTRAST["SURFACE_TOP"],
        "HC_SURFACE_BOTTOM": HIGH_CONTRAST["SURFACE_BOTTOM"],
        "HC_KEYLINE": HIGH_CONTRAST["KEYLINE"],
        "HC_FG": HIGH_CONTRAST["FG"],
        "HC_FG_DIM": HIGH_CONTRAST["FG_DIM"],
        "HC_MENU": HIGH_CONTRAST["MENU"],
    })

    for key, value in substitutions.items():
        out = out.replace(f"@{key}@", str(value))

    # High-contrast rules referenced the same $NAME$ form as ordinary colour
    # rules, which the variant stylesheets do not define. Substitute them
    # explicitly, otherwise a high-contrast card would silently fall back to
    # undefined colours.
    for name in ("SURFACE", "SURFACE_TOP", "SURFACE_BOTTOM", "KEYLINE",
                 "FG", "FG_DIM", "MENU"):
        out = out.replace(f"$HC_{name}$", HIGH_CONTRAST[name])

    # Any surviving @TOKEN@ means a typo in BASE_CSS; any surviving $NAME$
    # means a colour no variant defines.
    leftovers = [tok for tok in
                 set(list(substitutions) + list(TYPE_TOKENS))
                 if f"@{tok}@" in out]
    assert not leftovers, f"unsubstituted tokens: {sorted(leftovers)}"

    defined = set(COLOR_NAMES)
    unresolved = sorted(set(re.findall(r"\$([A-Z_]+)\$", out)) - defined)
    assert not unresolved, f"undefined colours in stylesheet.css: {unresolved}"
    return out


def build_variant_css(scheme, palette):
    missing = [name for name in COLOR_NAMES if name not in palette]
    assert not missing, f"{scheme} palette is missing: {missing}"

    lines = [
        f"/* Weather Card — {scheme} palette.",
        " *",
        " * GENERATED by tools/generate-assets.py. Edit the tokens there, not",
        " * here. Only colour lives in this file; geometry and type are in",
        " * stylesheet.css, which the shell loads alongside it.",
        " */",
        "",
    ]
    for name in COLOR_NAMES:
        lines.append(f"@define-color {name} {palette[name]};")
    lines.append("")
    return "\n".join(lines)


def write_stylesheets():
    with open(os.path.join(EXT, "stylesheet.css"), "w") as fh:
        fh.write(build_base_css())

    for scheme in ("dark", "light"):
        path = os.path.join(EXT, f"stylesheet-{scheme}.css")
        with open(path, "w") as fh:
            fh.write(build_variant_css(scheme, PALETTES[scheme]))

    print("css: wrote stylesheet.css, stylesheet-dark.css, "
          "stylesheet-light.css")


if __name__ == "__main__":
    write_icons()
    write_stylesheets()