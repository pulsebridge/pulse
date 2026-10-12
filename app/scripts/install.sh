#!/bin/sh
# Build Pulse.app and install it as the one copy in /Applications (the one to keep in the Dock).
# The build copy in dist/ is removed afterwards so there is never a second, older Pulse to open by mistake.
# Page and server changes don't need this: the server restarts itself and open pages reload. Only app shell
# changes (main.js, preload.js, the icon, Electron) do. Quit Pulse first so the new app is what opens next.
set -e
cd "$(dirname "$0")/.."
if pgrep -f 'Pulse.app/Contents/MacOS/Pulse$' >/dev/null; then
    echo "Pulse is running. Quit it (Cmd+Q), then run this again." >&2
    exit 1
fi
# Only ever replace a Pulse.app built from this project (same bundle id), never some other app with that name.
APP=/Applications/Pulse.app
ID="$(node -p "require('./package.json').build.appId")"
if [ -e "$APP" ]; then
    HAVE="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Contents/Info.plist" 2>/dev/null || true)"
    if [ "$HAVE" != "$ID" ]; then
        echo "$APP exists but its bundle id is '${HAVE:-unknown}', not '$ID'. Not replacing it: move it aside first." >&2
        exit 1
    fi
fi
npm run pack
rm -rf "$APP"
ditto dist/mac-arm64/Pulse.app "$APP"
rm -rf dist/mac-arm64
echo "Installed $APP. Open it from Finder, Spotlight or the Dock."
