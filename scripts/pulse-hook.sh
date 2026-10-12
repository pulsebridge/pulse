#!/bin/sh
# Pulse hook: send one Claude Code event to the local Pulse server and print its reply.
# The reply is empty unless you asked Pulse to message, stop or kill this agent, so normally it changes nothing.
# If Pulse is not running, the event is dropped quietly and the agent carries on. On SessionStart it boots Pulse.
[ -n "$PULSE_INTERNAL" ] && exit 0 # Pulse's own summarizer
PORT="${PULSE_PORT:-4777}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
p="$(cat)"
# Hooks may run with a bare PATH (GUI launches), so also look where Node usually lives.
find_node() {
    command -v node 2>/dev/null && return
    for n in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.volta/bin/node" "$HOME/.nvm/current/bin/node" "$NVM_BIN/node"; do
        [ -x "$n" ] && { echo "$n"; return; }
    done
    n="$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | tail -n 1)"
    [ -x "$n" ] && echo "$n"
}
# CLAUDE_PROJECT_DIR is the folder the chat was opened in; it stays put even when the agent cd's elsewhere.
# PULSE_TERM_ID is set when Claude runs in a Pulse terminal, so the page can link the chat to that terminal.
send() { printf '%s' "$p" | curl -s -m 2 -X POST -H 'content-type: application/json' -H "x-pulse-project: ${CLAUDE_PROJECT_DIR:-}" -H "x-pulse-term: ${PULSE_TERM_ID:-}" --data-binary @- "http://127.0.0.1:$PORT/hook" 2>/dev/null; }
# Tell Pulse.app where the plugin lives, so it runs this (current) server instead of the copy bundled inside the app.
case "$p" in *'"SessionStart"'*) mkdir -p "$HOME/.pulse"; [ "$(cat "$HOME/.pulse/plugin-root" 2>/dev/null)" = "$ROOT" ] || printf '%s' "$ROOT" > "$HOME/.pulse/plugin-root" ;; esac
if ! out="$(send)"; then
    case "$p" in
        *'"SessionStart"'*)
            mkdir -p "$HOME/.pulse"
            if node="$(find_node)" && [ -n "$node" ]; then
                nohup "$node" "$ROOT/server/server.js" >>"$HOME/.pulse/pulse.log" 2>&1 &
                sleep 1
                out="$(send)"
            else
                echo "$(date '+%F %T') pulse hook: node not found (PATH, Homebrew, /usr/local, Volta, nvm); install Node.js to run Pulse" >>"$HOME/.pulse/pulse.log"
            fi
            ;;
    esac
fi
printf '%s' "$out"
exit 0
