#!/usr/bin/env bash
# install.sh — install the Weather Card extension for the current user.
#
# Installs into ~/.local/share/gnome-shell/extensions/ (user extension),
# compiles the GSettings schema, and installs a .desktop entry used only
# so GNOME's GeoClue permission dialog can show this extension's name.
#
# SPDX-License-Identifier: MIT

set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_SRC="$SRC/weather-card@z.ai"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/weather-card@z.ai"
DESKTOP_SRC="$SRC/weather-card.desktop"
DESKTOP_DIR="$HOME/.local/share/applications"
UUID="weather-card@z.ai"

if [ ! -f "$EXT_SRC/metadata.json" ]; then
    echo "error: cannot find $EXT_SRC — run this from the repository root." >&2
    exit 1
fi

echo "Installing extension to $EXT_DIR …"
mkdir -p "$(dirname "$EXT_DIR")"
rm -rf "$EXT_DIR"
mkdir -p "$EXT_DIR"
cp -R "$EXT_SRC/." "$EXT_DIR"

echo "Compiling GSettings schema …"
glib-compile-schemas "$EXT_DIR/schemas"

echo "Installing GeoClue app identity ($DESKTOP_DIR/weather-card.desktop) …"
mkdir -p "$DESKTOP_DIR"
cp "$DESKTOP_SRC" "$DESKTOP_DIR/weather-card.desktop"
update-desktop-database "$DESKTOP_DIR" 2>/dev/null || true

echo
echo "Installed. To enable it:"
echo "  gnome-extensions enable $UUID"
echo
echo "If the shell does not pick it up immediately, log out and back in"
echo "(Wayland) or press Alt+F2 and type 'r' (X11)."
echo "Manage it visually with the 'Extensions' app or"
echo "https://extensions.gnome.org/local/."
