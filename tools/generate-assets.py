#!/usr/bin/env python3
"""
generate-assets.py — Weather Card design system generator.

Emits, from a single set of design tokens:
  * 12 original SVG weather icons (one family, two color schemes)
  * stylesheet-dark.css / stylesheet-light.css / stylesheet.css

All icon geometry is built from primitives (circles, rounded rectangles,
round-capped lines, polygons, masks) so every member of the family shares
exactly the same visual vocabulary. No arc-flag path math, no guessing.

Run from the repo root:  python3 tools/generate-assets.py
"""

import math
import os
import shutil

HERE = os.path.dirname(os.path.abspath(__file__))
EXT = os.path.join(HERE, "..", "weather-card@z.ai")

# ---------------------------------------------------------------- tokens ----

# SVG color tokens — replaced with scheme hex by SCHEMAS below.
T_MAIN = "MAIN"    # primary silhouette (clouds, moon)
T_SOFT = "SOFT"    # secondary shapes (back clouds, snow, stars)
T_SUN = "SUN"      # warm accent (sun, rays, bolt)
T_COOL = "COOL"    # precipitation accent (rain, drizzle)
T_MIST = "MIST"    # fog lines

SCHEMES = {
    "dark": {
        "MAIN": "#E7EBF3",
        "SOFT": "#8A94A7",
        "SUN": "#F2B84C",
        "COOL": "#9FC4E6",
        "MIST": "#BCC5D3",
    },
    "light": {
        "MAIN": "#3B4352",
        "SOFT": "#B4BBC9",
        "SUN": "#D8952A",
        "COOL": "#4F749C",
        "MIST": "#78808F",
    },
}

# ------------------------------------------------------------ svg helpers ---

def esc(color):
    return color  # tokens are plain alphanumerics; nothing to escape


def circle(cx, cy, r, color, opacity=None):
    op = f' opacity="{opacity}"' if opacity is not None else ""
    return f'    <circle cx="{cx:.2f}" cy="{cy:.2f}" r="{r:.2f}" fill="{esc(color)}"{op}/>'


def rrect(x, y, w, h, r, color, opacity=None):
    op = f' opacity="{opacity}"' if opacity is not None else ""
    return f'    <rect x="{x:.2f}" y="{y:.2f}" width="{w:.2f}" height="{h:.2f}" rx="{r:.2f}" fill="{esc(color)}"{op}/>'


def line(x1, y1, x2, y2, color, width):
    return (f'    <line x1="{x1:.2f}" y1="{y1:.2f}" x2="{x2:.2f}" y2="{y2:.2f}"'
            f' stroke="{esc(color)}" stroke-width="{width:.2f}"/>')


def polygon(points, color, stroke_width=3.0):
    pts = " ".join(f"{x:.2f},{y:.2f}" for x, y in points)
    return (f'    <polygon points="{pts}" fill="{esc(color)}"'
            f' stroke="{esc(color)}" stroke-width="{stroke_width:.2f}"/>')


def sun(cx, cy, r, ray_in, ray_out, ray_width, color):
    """Filled disc plus eight round-capped rays."""
    parts = [circle(cx, cy, r, color)]
    for i in range(8):
        a = math.pi / 4 * i
        x1 = cx + math.cos(a) * ray_in
        y1 = cy + math.sin(a) * ray_in
        x2 = cx + math.cos(a) * ray_out
        y2 = cy + math.sin(a) * ray_out
        parts.append(line(x1, y1, x2, y2, color, ray_width))
    return parts


def cloud(cx, cy, scale, color, opacity=None):
    """One family cloud: three circles over a rounded base bar.

    scale 1.0 spans 42 units wide, bottom edge at cy + 14.
    """
    s = scale
    parts = [
        circle(cx - 13 * s, cy + 3 * s, 11 * s, color, opacity),
        circle(cx + 3 * s, cy - 2 * s, 15 * s, color, opacity),
        circle(cx + 14 * s, cy + 5 * s, 9 * s, color, opacity),
        rrect(cx - 21 * s, cy + 2 * s, 42 * s, 12 * s, 6 * s, color, opacity),
    ]
    return parts


def crescent(cx, cy, r, color, cut_dx, cut_dy, cut_scale=0.82):
    """Moon masked by an offset circle (mask keeps the token colors clean)."""
    cut_r = r * cut_scale
    return (
        f'    <mask id="cut">\n'
        f'      <rect x="0" y="0" width="96" height="96" fill="#ffffff"/>\n'
        f'      <circle cx="{cx + cut_dx:.2f}" cy="{cy + cut_dy:.2f}" r="{cut_r:.2f}" fill="#000000"/>\n'
        f'    </mask>\n'
        f'    <circle cx="{cx:.2f}" cy="{cy:.2f}" r="{r:.2f}" fill="{esc(color)}" mask="url(#cut)"/>'
    )


def sparkle(cx, cy, s, color):
    """Four-point star (two diamonds crossing)."""
    pts = [
        (cx, cy - s), (cx + s * 0.32, cy - s * 0.32), (cx + s, cy),
        (cx + s * 0.32, cy + s * 0.32), (cx, cy + s), (cx - s * 0.32, cy + s * 0.32),
        (cx - s, cy), (cx - s * 0.32, cy - s * 0.32),
    ]
    return polygon(pts, color, 0.0)


def drop(x, y, length, slant, color, width):
    """A round-capped rain stroke, slanting left-down by default."""
    dx = length * slant
    return line(x, y, x - dx, y + length, color, width)


def flake(cx, cy, s, color, width=4.0):
    parts = []
    for a in (0, math.pi / 3, math.pi * 2 / 3):
        dx = math.cos(a) * s
        dy = math.sin(a) * s
        parts.append(line(cx - dx, cy - dy, cx + dx, cy + dy, color, width))
    return parts


BOLT = [(52, 57), (41, 72), (48, 72), (44, 84), (57, 66), (50, 66), (54, 57)]

# --------------------------------------------------------------- icons -----

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
    parts = sun(33, 32, 10, 15.5, 20.5, 4.5, T_SUN)
    parts += cloud(55, 49, 0.86, T_MAIN)
    return parts


def icon_partly_night():
    parts = [
        crescent(33, 30, 11, T_MAIN, 6.5, -5, 0.82),
        sparkle(56, 19, 4, T_SOFT),
    ]
    parts += cloud(55, 49, 0.86, T_MAIN)
    return parts


def icon_cloudy():
    return cloud(48, 48, 1.0, T_MAIN)


def icon_overcast():
    parts = cloud(59, 37, 0.62, T_SOFT, 0.9)
    parts += cloud(46, 51, 1.0, T_MAIN)
    return parts


def icon_fog():
    parts = cloud(48, 38, 0.92, T_MAIN)
    parts += [
        line(26, 62, 62, 62, T_MIST, 5.5),
        line(35, 74, 66, 74, T_MIST, 5.5),
        line(43, 86, 70, 86, T_MIST, 5.5),
    ]
    return parts


def icon_drizzle():
    parts = cloud(48, 44, 0.96, T_MAIN)
    parts += [
        drop(36, 64, 8, 0, T_COOL, 5),
        drop(48, 64, 8, 0, T_COOL, 5),
        drop(60, 64, 8, 0, T_COOL, 5),
    ]
    return parts


def icon_rain():
    parts = cloud(48, 42, 0.96, T_MAIN)
    parts += [
        drop(40, 61, 13, 0.42, T_COOL, 5.5),
        drop(52, 61, 15, 0.42, T_COOL, 5.5),
        drop(64, 61, 13, 0.42, T_COOL, 5.5),
    ]
    return parts


def icon_sleet():
    parts = cloud(48, 42, 0.96, T_MAIN)
    parts += [
        drop(38, 60, 13, 0.42, T_COOL, 5.5),
    ]
    parts += flake(52, 68, 6.5, T_SOFT, 4.2)
    parts += [
        drop(64, 60, 13, 0.42, T_COOL, 5.5),
    ]
    return parts


def icon_snow():
    parts = cloud(48, 42, 0.96, T_MAIN)
    parts += flake(36, 68, 6.5, T_SOFT, 4.2)
    parts += flake(50, 76, 6.5, T_SOFT, 4.2)
    parts += flake(64, 68, 6.5, T_SOFT, 4.2)
    return parts


def icon_thunderstorm():
    parts = cloud(48, 40, 0.96, T_MAIN)
    parts += [polygon(BOLT, T_SUN, 3.0)]
    return parts


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
    body = "\n".join(parts)
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width="96" height="96">\n'
        '  <g fill="none" stroke-linecap="round" stroke-linejoin="round">\n'
        f'{body}\n'
        '  </g>\n'
        '</svg>\n'
    )


def write_icons():
    base = os.path.join(EXT, "icons")
    for scheme, palette in SCHEMES.items():
        scheme_dir = os.path.join(base, scheme)
        os.makedirs(scheme_dir, exist_ok=True)
        for name, builder in ICONS.items():
            doc = svg_document(builder())
            for token, hexcolor in palette.items():
                doc = doc.replace(token, hexcolor)
            # A token leaking into a file would mean a broken asset; assert.
            assert "MAIN" not in doc and "SOFT" not in doc and "SUN" not in doc
            assert "COOL" not in doc and "MIST" not in doc
            with open(os.path.join(scheme_dir, f"{name}.svg"), "w") as fh:
                fh.write(doc)
    print(f"icons: wrote {len(ICONS)} x {len(SCHEMES)} schemes -> {base}")


# ----------------------------------------------------------- stylesheets ---

CSS_TOKENS = {
    "dark": {
        "BG": "rgba(22, 24, 28, 0.82)",
        "TEXT": "rgba(246, 247, 250, 0.96)",
        "DIM": "rgba(246, 247, 250, 0.56)",
        "FAINT": "rgba(246, 247, 250, 0.40)",
        "HAIR": "rgba(255, 255, 255, 0.10)",
        "BTN": "rgba(255, 255, 255, 0.15)",
        "BTN_H": "rgba(255, 255, 255, 0.22)",
        "BTN_A": "rgba(255, 255, 255, 0.28)",
        "FLAT_H": "rgba(255, 255, 255, 0.08)",
        "MENU": "rgba(28, 30, 35, 0.96)",
        "ITEM_H": "rgba(255, 255, 255, 0.09)",
        "SKEL": "rgba(255, 255, 255, 0.10)",
        "FOCUS": "rgba(246, 247, 250, 0.55)",
    },
    "light": {
        "BG": "rgba(250, 250, 252, 0.90)",
        "TEXT": "rgba(24, 26, 30, 0.94)",
        "DIM": "rgba(24, 26, 30, 0.56)",
        "FAINT": "rgba(24, 26, 30, 0.42)",
        "HAIR": "rgba(9, 10, 14, 0.09)",
        "BTN": "rgba(23, 26, 33, 0.08)",
        "BTN_H": "rgba(23, 26, 33, 0.13)",
        "BTN_A": "rgba(23, 26, 33, 0.17)",
        "FLAT_H": "rgba(9, 10, 14, 0.06)",
        "MENU": "rgba(252, 252, 254, 0.98)",
        "ITEM_H": "rgba(9, 10, 14, 0.06)",
        "SKEL": "rgba(9, 10, 14, 0.09)",
        "FOCUS": "rgba(24, 26, 30, 0.55)",
    },
}

CSS_TEMPLATE = """\
/* Weather Card — {label} stylesheet.
 * Generated by tools/generate-assets.py; edit tokens there, not here.
 * Layout constants live in widget.js; colors and type live here.
 */

.wc-card {{
    background-color: {BG};
    border-radius: 22px;
    padding: 24px 26px 20px;
    color: {TEXT};
    font-family: "Ubuntu", "Adwaita Sans", "Cantarell", sans-serif;
}}

/* --- header --- */
.wc-location {{
    font-size: 15px;
    font-weight: 600;
    letter-spacing: 0.2px;
    color: {TEXT};
}}
.wc-updated {{
    font-size: 12px;
    font-weight: 400;
    color: {FAINT};
}}

/* --- hero --- */
.wc-temp {{
    font-size: 62px;
    font-weight: 300;
    letter-spacing: -2px;
    color: {TEXT};
}}
.wc-condition {{
    font-size: 16px;
    font-weight: 500;
    letter-spacing: 0.1px;
    color: {TEXT};
}}
.wc-meta {{
    font-size: 13px;
    font-weight: 400;
    color: {DIM};
}}
.wc-sep {{
    background-color: {HAIR};
    border-radius: 1px;
}}

/* --- hourly --- */
.wc-hour-time {{
    font-size: 12px;
    font-weight: 400;
    color: {DIM};
}}
.wc-hour-temp {{
    font-size: 13px;
    font-weight: 600;
    color: {TEXT};
}}

/* --- status / footnote --- */
.wc-footnote {{
    font-size: 12px;
    font-weight: 400;
    color: {FAINT};
}}
.wc-title {{
    font-size: 20px;
    font-weight: 600;
    letter-spacing: -0.1px;
    color: {TEXT};
}}
.wc-body {{
    font-size: 14px;
    font-weight: 400;
    color: {DIM};
}}

/* --- skeleton --- */
.wc-skel {{
    background-color: {SKEL};
    border-radius: 8px;
}}
.wc-skel-round {{
    background-color: {SKEL};
    border-radius: 14px;
}}

/* --- buttons --- */
.wc-btn {{
    border-radius: 12px;
    padding: 10px 16px;
    font-size: 13.5px;
    font-weight: 600;
}}
.wc-btn:hover {{ background-color: {FLAT_H}; }}
.wc-btn:focus {{
    border-width: 2px;
    border-color: {FOCUS};
}}
.wc-btn-primary {{
    background-color: {BTN};
    color: {TEXT};
    border-radius: 12px;
    padding: 10px 16px;
    font-size: 13.5px;
    font-weight: 600;
}}
.wc-btn-primary:hover {{ background-color: {BTN_H}; }}
.wc-btn-primary:active {{ background-color: {BTN_A}; }}
.wc-btn-primary:focus {{
    border-width: 2px;
    border-color: {FOCUS};
}}
.wc-btn-text {{
    color: {DIM};
    border-radius: 12px;
    padding: 10px 16px;
    font-size: 13.5px;
    font-weight: 500;
}}
.wc-btn-text:hover {{ background-color: {FLAT_H}; }}
.wc-btn-text:focus {{
    border-width: 2px;
    border-color: {FOCUS};
}}

/* --- menu --- */
.wc-menu {{
    background-color: {MENU};
    border-radius: 16px;
    padding: 6px;
}}
.wc-menu-item {{
    border-radius: 10px;
    padding: 9px 14px;
    font-size: 13.5px;
    font-weight: 450;
    color: {TEXT};
}}
.wc-menu-item-label {{
    font-size: 13.5px;
    font-weight: 450;
    color: {TEXT};
}}
.wc-menu-item:hover {{ background-color: {ITEM_H}; }}
.wc-menu-item:active {{ background-color: {ITEM_H}; }}
.wc-menu-item:focus {{
    border-width: 2px;
    border-color: {FOCUS};
}}
.wc-menu-sep {{
    background-color: {HAIR};
    border-radius: 1px;
    margin: 5px 10px;
}}
"""


def write_stylesheets():
    for scheme, tokens in CSS_TOKENS.items():
        css = CSS_TEMPLATE.format(label=scheme, **tokens)
        path = os.path.join(EXT, f"stylesheet-{scheme}.css")
        with open(path, "w") as fh:
            fh.write(css)
    # Plain stylesheet.css = dark values (fallback for exotic session modes
    # where no variant resolves).
    css = CSS_TEMPLATE.format(label="dark (fallback)", **CSS_TOKENS["dark"])
    with open(os.path.join(EXT, "stylesheet.css"), "w") as fh:
        fh.write(css)
    print("css: wrote stylesheet-dark.css, stylesheet-light.css, stylesheet.css")


if __name__ == "__main__":
    write_icons()
    write_stylesheets()
