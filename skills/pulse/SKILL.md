---
name: pulse
description: Open, start, restart or stop Pulse, the live dashboard of every Claude Code agent and subagent on this machine (http://127.0.0.1:4777), set up its natural voice, or run its demo. Use when the user asks for Pulse, the agent dashboard, the agent graph, a status update from their agents, or to stop Pulse or its voice.
---

Pulse is a small local Node server plus one web page. The plugin's hook sends every Claude Code event to it and boots it on SessionStart. Code lives in the plugin folder; the voice model, venv and settings live in `~/.pulse`. It makes no network calls except optional Claude Haiku calls (Verbose briefings and commit messages) through the user's own `claude` login.

The plugin root is the folder two levels above this file (`skills/pulse/SKILL.md`). Call it `$PULSE`.

Open (start first if needed):

```bash
mkdir -p ~/.pulse; curl -s -m 1 http://127.0.0.1:4777/health >/dev/null || (nohup node "$PULSE/server/server.js" >> ~/.pulse/pulse.log 2>&1 &) ; sleep 1; curl -s -m 1 http://127.0.0.1:4777/health && { open http://127.0.0.1:4777 2>/dev/null || xdg-open http://127.0.0.1:4777; }
```

- In VS Code: Cmd+Shift+P, "Simple Browser: Show", `http://127.0.0.1:4777`. One Pulse shows every VS Code window and chat on this machine.
- Natural voice (one time, about 350 MB): `sh "$PULSE/scripts/setup-voice.sh"`, then restart Pulse. Without it the page uses the browser's voice.
- Stop: `r=$(cat ~/.pulse/plugin-root 2>/dev/null); pkill -f "(${r:-pulse}|Pulse.app/Contents/Resources)/server/server.js"` (the plugin's server, whose folder the hook records in `~/.pulse/plugin-root`, and the one Pulse.app starts from its bundle). It starts again with the next Claude session or when Pulse.app opens.
- Demo with simulated agents on port 4778: `PULSE_PORT=4778 nohup node "$PULSE/server/server.js" --demo > /tmp/pulse-demo.log 2>&1 &` then open `http://127.0.0.1:4778`. The page is labeled Demo, and the demo closes itself 5 minutes after its last page closes.
- Plan limits (5-hour and weekly, status bar): need the status line `sh "$PULSE/scripts/pulse-statusline.sh"` set as `statusLine` in `~/.claude/settings.json`. Ask before editing that file.
- Settings (how much it says: Quiet, Normal or Verbose; sound cues; voice; Haiku briefings) are in the page and saved to `~/.pulse/settings.json`. Log: `~/.pulse/pulse.log`. Self-test: `node "$PULSE/server/server.js" --test`.

Reply with the URL only. If health fails, show the last lines of the log.
