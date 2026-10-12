#!/bin/sh
# Pulse installer. Checks what Pulse needs, then installs it as a Claude Code plugin from GitHub.
#
#   curl -fsSL https://raw.githubusercontent.com/pulsebridge/pulse/main/install.sh | sh
#
# Options, as environment variables:
#   PULSE_APP=1     also install the Mac app (Pulse.app) from the latest GitHub release, into /Applications
#   PULSE_VOICE=1   also set up the natural local voice (Kokoro, about 350 MB, needs python3 3.10+)
#   PULSE_REPO=...  install from a fork instead (owner/repo)
# Running it again updates Pulse to the latest version.
set -e
REPO="${PULSE_REPO:-pulsebridge/pulse}"
PORT="${PULSE_PORT:-4777}"

say() { printf '%s\n' "$*"; }
fail() { printf '\nPulse: %s\n' "$*" >&2; exit 1; }

say "Installing Pulse, mission control for Claude Code."

# What Pulse needs: Claude Code, Node 18+ (the dashboard server) and curl (the hooks).
command -v claude >/dev/null 2>&1 || fail "Claude Code ('claude') was not found. Install it first: https://docs.claude.com/en/docs/claude-code/setup"
command -v curl >/dev/null 2>&1 || fail "curl was not found. Install it, then run this again."
command -v node >/dev/null 2>&1 || fail "Node.js was not found. Install Node 18 or newer (https://nodejs.org), then run this again."
major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[ "$major" -ge 18 ] 2>/dev/null || fail "Pulse needs Node 18 or newer; this machine has $(node -v)."

# Is NAME in the JSON list that a `claude plugin ... list --json` command prints? (node is here anyway.)
listed() { node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{try{process.exit(JSON.parse(s).some((x)=>x[process.argv[1]]===process.argv[2])?0:1)}catch{process.exit(1)}})' "$1" "$2"; }

# The GitHub repo is its own plugin marketplace, named "pulse". Add it, or refresh it if it is already there.
if claude plugin marketplace list --json 2>/dev/null | listed name pulse; then
    say "Updating the Pulse marketplace"
    claude plugin marketplace update pulse
else
    say "Adding the Pulse marketplace ($REPO)"
    claude plugin marketplace add "$REPO"
fi

if claude plugin list --json 2>/dev/null | listed id pulse@pulse; then
    say "Updating the Pulse plugin"
    claude plugin update pulse@pulse
else
    say "Installing the Pulse plugin"
    claude plugin install pulse@pulse --scope user
fi

# The Mac app: the DMG for this Mac's chip from the latest release, copied into /Applications. An existing
# /Applications/Pulse.app is only replaced if it really is Pulse (same bundle id).
install_app() {
    [ "$(uname -s)" = "Darwin" ] || { say "The Mac app is for macOS only; skipping it."; return 0; }
    case "$(uname -m)" in arm64) arch=arm64 ;; *) arch=x64 ;; esac
    url="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{try{const a=(JSON.parse(s).assets||[]).find((x)=>x.name.endsWith(`-${process.argv[1]}.dmg`));if(a)console.log(a.browser_download_url)}catch{}})' "$arch")"
    [ -n "$url" ] || { say "No Mac app download found in the latest release of $REPO; skipping it."; return 0; }
    id="io.github.pulsebridge.pulse"
    if [ -d /Applications/Pulse.app ]; then
        have="$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' /Applications/Pulse.app/Contents/Info.plist 2>/dev/null || true)"
        [ "$have" = "$id" ] || { say "/Applications/Pulse.app is a different app ($have); leaving it alone. Move it aside to install Pulse."; return 0; }
        pgrep -f 'Pulse.app/Contents/MacOS/Pulse$' >/dev/null 2>&1 && { say "Pulse.app is running. Quit it, then run this again with PULSE_APP=1."; return 0; }
    fi
    tmp="$(mktemp -d)"
    say "Downloading the Mac app ($arch)"
    curl -fL --progress-bar -o "$tmp/Pulse.dmg" "$url"
    hdiutil attach -nobrowse -readonly -mountpoint "$tmp/mnt" "$tmp/Pulse.dmg" >/dev/null
    rm -rf /Applications/Pulse.app
    ditto "$tmp/mnt/Pulse.app" /Applications/Pulse.app
    hdiutil detach "$tmp/mnt" >/dev/null
    rm -rf "$tmp"
    say "Installed /Applications/Pulse.app. Open it from Spotlight, Finder or the Dock."
}
if [ "${PULSE_APP:-0}" = "1" ]; then
    install_app
fi

if [ "${PULSE_VOICE:-0}" = "1" ]; then
    say "Setting up the natural voice"
    curl -fsSL "https://raw.githubusercontent.com/$REPO/main/scripts/setup-voice.sh" | sh
fi

# Start the dashboard now rather than waiting for the next Claude Code session (which would start it anyway).
ROOT="$(claude plugin list --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{try{const p=JSON.parse(s).find((x)=>x.id==="pulse@pulse");if(p)console.log(p.installPath)}catch{}})')"
if [ -n "$ROOT" ] && [ -f "$ROOT/server/server.js" ] && ! curl -s -m 1 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    mkdir -p "$HOME/.pulse"
    printf '%s' "$ROOT" > "$HOME/.pulse/plugin-root"
    nohup node "$ROOT/server/server.js" >>"$HOME/.pulse/pulse.log" 2>&1 &
    sleep 1
fi

say ""
if curl -s -m 1 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    say "Pulse is installed and running: http://127.0.0.1:$PORT"
else
    say "Pulse is installed. Start any Claude Code session and it starts with it, then open http://127.0.0.1:$PORT"
fi
say "Restart any Claude Code sessions that were already open, so they report to Pulse too."
say ""
say "Optional extras (see the README):"
[ "$(uname -s)" = "Darwin" ] && say "  - Mac app:  curl -fsSL https://raw.githubusercontent.com/$REPO/main/install.sh | PULSE_APP=1 sh   (or download it from https://github.com/$REPO/releases/latest)"
say "  - Natural local voice:  curl -fsSL https://raw.githubusercontent.com/$REPO/main/install.sh | PULSE_VOICE=1 sh"
say "  - Plan limits in the status bar: set Pulse's status line in ~/.claude/settings.json"
say "  - Uninstall: see the README (stop the server, uninstall the plugin, remove ~/.pulse)"
