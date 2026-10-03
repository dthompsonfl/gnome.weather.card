#!/usr/bin/env bash
# uninstall.sh — remove the Weather Card extension from this user account.
#
# Removes the extension, the GeoClue desktop identity, and the weather
# cache. GSettings values are removed via dconf (best effort).
#
# SPDX-License-Identifier: MIT

set -euo pipefail

EXT_DIR="$HOME/.local/share/gnome-shell/extensions/weather-card@z.ai"
DESKTOP_FILE="$HOME/.local/share/applications/weather-card.desktop"
CACHE_DIR="$HOME/.cache/weather-card@z.ai"
UUID="weather-card@z.ai"

if gnome-extensions show "$UUID" >/dev/null 2>&1; then
    echo "Disabling extension …"
    gnome-extensions disable "$UUID" 2>/dev/null || true
fi

echo "Removing $EXT_DIR …"
rm -rf "$EXT_DIR"

echo "Removing desktop identity …"
rm -f "$DESKTOP_FILE"
update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true

echo "Removing cached weather …"
rm -rf "$CACHE_DIR"

echo "Resetting settings (dconf) …"
dconf reset -f /org/gnome/shell/extensions/weather-card/ 2>/dev/null || true

echo
echo "Removed. Log out and back in (or restart the shell) to finish."
