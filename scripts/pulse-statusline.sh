#!/bin/sh
# Pulse status line: hand Claude Code's status line JSON to the local Pulse server, which keeps the plan limits
# (5-hour and weekly) for the dashboard's status bar, and print the line it sends back: "Opus 5.5 · 5h 42% · week 18%".
# Only the status line is told these limits, so this has to be the status line command in ~/.claude/settings.json:
#   "statusLine": { "type": "command", "command": "sh \"$HOME/path/to/pulse/scripts/pulse-statusline.sh\"" }
# To keep another status line too, pass its command as the first argument; its output is printed after Pulse's.
# If Pulse is not running, the line is just the other command's output (or nothing), and Claude Code carries on.
[ -n "$PULSE_INTERNAL" ] && exit 0
PORT="${PULSE_PORT:-4777}"
p="$(cat)"
out="$(printf '%s' "$p" | curl -s -m 1 -X POST -H 'content-type: application/json' --data-binary @- "http://127.0.0.1:$PORT/limits" 2>/dev/null \
    | sed -n 's/.*"line":"\(.*\)"}.*/\1/p' | sed 's/\\u00b7/·/g; s/\\"/"/g')"
if [ -n "$1" ]; then
    more="$(printf '%s' "$p" | sh -c "$1" 2>/dev/null)"
    [ -n "$more" ] && out="${out:+$out  }$more"
fi
printf '%s' "$out"
exit 0
