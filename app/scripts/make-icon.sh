#!/bin/sh
# Builds build/icon.icns and build/icon.png from build/icon.svg (the Pulse mark with macOS icon padding).
# No Xcode needed: Electron renders the PNGs, iconutil (part of macOS) packs them.
set -e
cd "$(dirname "$0")/.."
SET="build/Pulse.iconset"
rm -rf "$SET"
env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/render-icon.js "$SET"
cp "$SET/icon_512x512@2x.png" build/icon.png
if iconutil -c icns "$SET" -o build/icon.icns 2>/dev/null; then
    echo "build/icon.icns ready"
else
    # iconutil unavailable: electron-builder can convert the 1024 PNG itself.
    echo "iconutil failed; falling back to build/icon.png"
    rm -f build/icon.icns
fi
rm -rf "$SET"
