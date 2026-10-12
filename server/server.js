#!/usr/bin/env node
// Pulse: one live dashboard for every Claude Code agent and subagent on this machine, fed by hooks.
// Voice plays in the page (one tab at a time), so closing the page silences it.
// Code lives in the plugin folder; voice model, venv and settings live in ~/.pulse (PULSE_HOME).
// Run: node server.js [--demo]      Test: node server.js --test
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const readline = require("node:readline");
const { spawn, execFile, execFileSync } = require("node:child_process");
const assert = require("node:assert");
const LINES_FILE = path.join(__dirname, "lines.js");
const L = require(LINES_FILE);
const fsp = fs.promises;

const PORT = +process.env.PULSE_PORT || 4777;
const DEMO = process.argv.includes("--demo");
const HOME = process.env.PULSE_HOME || path.join(os.homedir(), ".pulse");
fs.mkdirSync(HOME, { recursive: true });
const SETTINGS_FILE = path.join(HOME, DEMO ? "settings.demo.json" : "settings.json");
const SPARK_MIN = 15;
const MAX_BODY = 5e6;
const QUIET_MS = 3 * 60_000; // working but no tool call for this long reads as "quiet"
const HISTORY_MAX = 200; // recent steps kept per agent
const TRANSCRIPT_BYTES = 48e6, TRANSCRIPT_MAX = 400; // how deep the first read of a transcript goes, and how many entries the page gets
const DISPATCH_WAIT_MS = 1500, DISPATCH_MAX_MS = 4000; // spawns this close together are said as one line
const FINISH_WAIT_MS = 900; // a finish waits this long for its transcript, and for finishes landing with it
const LONG_TURN_MS = 30_000; // on Quiet, a turn this long is still announced: you have probably looked away
const INTERVALS = [0, 5, 10, 15, 20, 30];
// Quiet: failures, requests and wrap-ups. Normal: every start, dispatch and finish too. Verbose: plus timed briefings.
const VERBOSITY = ["quiet", "normal", "verbose"];
// Two voices, one male and one female: Kokoro's most natural of each (its own grades: Heart A, Michael the best of the
// US male voices). A saved voice from the longer list that came before maps to the one of the same kind.
const VOICES = ["am_michael", "af_heart"];
const voiceOf = (v) => (VOICES.includes(v) ? v : /^[ab]m_/.test(String(v)) ? "am_michael" : "af_heart");
const DEFAULTS = { intervalMin: 5, voice: "af_heart", speed: 1, aiSummaries: true, address: "", greeting: true, welcomeSpoken: true, verbosity: "normal", earcons: true };
const FILE_MAX = 2 * 1024 * 1024, SNIFF = 8192; // the editor opens files up to 2 MB; a NUL byte in the first 8 KB means binary
const EDIT_MAX = 50_000, EDIT_BUDGET = 40e6; // characters kept per side of one agent edit, and per transcript in all

const clip = (s, n = 80) => {
    s = String(s ?? "").replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
};
// How the voice addresses the user: "" (no title), or a word like Sir, Ma'am, Boss, or a name. Every spoken line goes through these
// so one setting changes them all. callTail closes a sentence ("All quiet, Boss."); the phrase bank opens one now and then.
const ADDRESS_MAX = 24;
const cleanAddress = (v) => String(v ?? "").replace(/[^\p{L}\p{N} '.\-]/gu, "").replace(/\s+/g, " ").trim().slice(0, ADDRESS_MAX);
const { upFirst, count } = L;
const callTail = (st) => (st.settings?.address ? `, ${st.settings.address}` : "");
const callRule = (st) => (st.settings?.address ? `Address the user as "${st.settings.address}" exactly once` : "Do not use any title, name or form of address for the user");
const short = (type) => String(type).split(":").pop();
const project = (s) => path.basename(s.cwd) || s.id.slice(0, 8);
const callsign = (a) => (a.id === "main" ? "the main agent" : a.call || `agent ${a.n}`);

// Short human line for a tool call, e.g. "Edit logic.ts".
function describe(tool, input = {}) {
    const base = (p) => path.basename(String(p || ""));
    switch (tool) {
        case "Bash": return clip(input.description || input.command);
        case "Read": case "Edit": case "Write": case "MultiEdit": return `${tool === "MultiEdit" ? "Edit" : tool} ${base(input.file_path)}`;
        case "NotebookEdit": return `Edit ${base(input.notebook_path)}`;
        case "Grep": case "Glob": return clip(`${tool} ${input.pattern || ""}`);
        case "WebFetch": try { return `Fetch ${new URL(input.url).host}`; } catch { return "Fetch"; }
        case "WebSearch": return clip(`Search ${input.query || ""}`);
        case "Agent": case "Task": return clip(`Spawn ${short(input.subagent_type || "agent")}: ${input.description || ""}`);
        case "Skill": return `Skill ${input.skill || ""}`;
        case "TodoWrite": return "Update todo list";
    }
    const mcp = /^mcp__(.+?)__(.+)$/.exec(tool || "");
    return mcp ? clip(`${mcp[1]}: ${mcp[2]}`) : clip(tool || "working");
}

// The full text behind a step, for the page to unfold: the whole command, the pattern, the URL, or what failed. Line breaks kept.
function detailOf(tool, input = {}, error) {
    const cut = (v, n = 1200) => { v = String(v ?? "").replace(/\r/g, "").trim(); return v.length > n ? v.slice(0, n - 1) + "…" : v; };
    const lines = [];
    switch (tool) {
        case "Bash": if (input.description) lines.push(cut(input.description, 200)); lines.push(cut(input.command)); break;
        case "Grep": case "Glob": lines.push(cut(`${input.pattern || ""}${input.path ? `\nin ${input.path}` : ""}`, 400)); break;
        case "WebFetch": lines.push(cut(input.url, 400)); break;
        case "WebSearch": lines.push(cut(input.query, 400)); break;
        case "Agent": case "Task": lines.push(cut(input.description, 300), cut(input.prompt, 600)); break;
        case "Read": case "Edit": case "Write": case "MultiEdit": case "NotebookEdit": lines.push(cut(input.file_path || input.notebook_path, 400)); break;
        default: try { lines.push(cut(JSON.stringify(input), 600)); } catch {}
    }
    if (error) lines.push(`Error: ${cut(typeof error === "string" ? error : JSON.stringify(error), 800)}`);
    return lines.filter(Boolean).join("\n\n");
}

// Turns the harness writes into the chat itself: a background task finishing, a subagent's report, a local command's output.
const HARNESS = /^<(task-notification|agent-message|local-command-[\w-]+|bash-std(out|err)|artifact-content-authored-by-others)\b/;
// What the user actually typed, from a raw prompt (a string, or content parts from a queued prompt).
// VS Code wraps pasted text in <pasted_content> and prepends IDE context (<ide_opened_file>, <ide_selection>), and
// slash commands arrive as <command-name> tags, so a real prompt often starts with "<". Null only for harness turns.
function promptText(raw) {
    const s = (typeof raw === "string" ? raw : textOf(raw))
        .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
        .replace(/<(ide_[a-z_]+)>[\s\S]*?<\/\1>/g, "")
        .trim();
    if (HARNESS.test(s)) return null;
    const cmd = /<command-name>\s*\/?([^<\s]+)\s*<\/command-name>/.exec(s);
    if (cmd) {
        const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(s)?.[1].trim();
        return `/${cmd[1]}${args ? ` ${args}` : ""}`;
    }
    const bash = /^<bash-input>([\s\S]*?)<\/bash-input>/.exec(s);
    if (bash) return `! ${bash[1].trim()}`;
    // The closing tag repeats the id (</pasted_content id="0db3">); dropping both tags keeps the pasted text in place.
    return s.replace(/<\/?pasted_content\b[^>]*>/g, "").replace(/\n{3,}/g, "\n\n").trim();
}
// One short line for a harness turn, e.g. 'Agent "Find the cart totals logic" finished'.
function harnessNotice(s) {
    const tag = (name) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(s)?.[1];
    if (/^\s*<task-notification/.test(s)) return clip(tag("summary") || `Background task ${tag("status") || "update"}`, 160);
    if (/^\s*<agent-message/.test(s)) return "A subagent reported back";
    return clip(s.replace(/<[^>]+>/g, " "), 160) || "Message from Claude Code";
}

function getAgent(st, s, id, type, now) {
    let a = s.agents.get(id);
    if (!a) {
        a = {
            id, n: id === "main" ? 0 : ++st.seq, call: id === "main" ? "" : freeCall(st, now), type: id === "main" ? "main" : type || "subagent", task: "", summary: "", outcome: "",
            status: "working", action: "", startedAt: now, lastAt: now, endedAt: null, turnAt: now,
            tools: 0, errors: 0, ticks: [], history: [], read: new Set(), edited: new Set(), kill: false, note: "", noteAt: 0, stoppedAt: 0,
        };
        s.agents.set(id, a);
    }
    if (type && id !== "main") a.type = type;
    return a;
}

// A subagent's callsign is held while it works and until its crew's wrap-up has named it, then freed, so every new task
// starts again at Atlas, Echo, Nova: the same few names, easy to recognise. A crew that never wraps up (its chat was
// interrupted) lets go after a couple of minutes.
const CALL_HOLD_MS = 2 * 60_000;
function freeCall(st, now) {
    const taken = new Set();
    for (const s of st.sessions.values()) {
        const crew = new Set(s.crew || []), m = s.agents.get("main");
        const busy = m && (m.status === "working" || m.status === "needs-you"); // the task is still running: its crew keep their names
        for (const a of s.agents.values()) {
            if (a.call && (a.status === "working" || a.status === "needs-you" || (crew.has(a.id) && (busy || now - (a.endedAt || now) < CALL_HOLD_MS)))) taken.add(a.call);
        }
    }
    return L.nextCall(taken) || "";
}

// Queue an announcement. `transcript` lets the server swap the fallback text for an AI summary.
const out = (st, item) => st.out.push(item);

// Fold one hook payload into state. Pure apart from st; announcements land in st.out.
function apply(st, p, now = Date.now()) {
    if (!p || !p.session_id) return;
    let s = st.sessions.get(p.session_id);
    if (!s) {
        s = { id: p.session_id, cwd: p.project_dir || p.cwd || "", branch: gitBranch(p.project_dir || p.cwd), startedAt: now, lastAt: now, ended: false, muted: false, agents: new Map(), pending: [], lastNeedsAt: 0, transcript: null, term: "" };
        st.sessions.set(p.session_id, s);
    }
    s.lastAt = now;
    // The Pulse terminal this chat runs in (PULSE_TERM_ID, passed by the hook). Chats started elsewhere send nothing, so keep what we have.
    if (p.term_id) s.term = p.term_id;
    // The project is the folder the chat was opened in (CLAUDE_PROJECT_DIR, passed by the hook); a later cd must not move it.
    if (p.project_dir && s.cwd !== p.project_dir) { s.cwd = p.project_dir; s.branch = gitBranch(p.project_dir); }
    else if (!s.cwd && p.cwd) s.cwd = p.cwd;
    if (p.transcript_path && !p.agent_id) s.transcript = p.transcript_path;
    // Claude Code runs quick helpers of its own (a progress summary of each background agent every 30 seconds or so, a
    // suggestion after each turn) that send a SubagentStop with no SubagentStart, no type and no transcript. They are
    // not agents at work: left out, or each one would pop up on the board and be announced as done.
    if (p.hook_event_name === "SubagentStop" && p.agent_id && !p.agent_type && !s.agents.has(p.agent_id)) return;
    const a = getAgent(st, s, p.agent_id || "main", p.agent_type, now);
    // Hooks run async, so events can land out of order: a finished subagent stays finished,
    // and a main-agent tool event that trails its Stop by a moment does not flip it back to working.
    const late = /^(PreToolUse|PostToolUse|PostToolUseFailure)$/.test(p.hook_event_name) && ((a.status === "done" && !a.stale) || a.status === "ended" || (a.id === "main" && a.status === "idle" && now - a.stoppedAt < 3000));
    if (late) return;
    a.lastAt = now;
    // An agent only guessed to be over (long silence, or its chat interrupted) that sends anything is back at work.
    const revived = !!a.stale;
    if (revived) { a.stale = false; if (a.status === "done") a.endedAt = null; }

    switch (p.hook_event_name) {
        case "SessionStart":
            s.ended = false;
            a.status = "idle";
            break;
        case "UserPromptSubmit": {
            a.status = "working";
            a.turnAt = now;
            a.summary = ""; a.sumTries = 0; // the last turn's summary is old news
            // Harness-injected turns (<task-notification>, <agent-message>...) are not the user's task.
            const text = promptText(p.prompt || "");
            a.harness = text === null;
            if (text === null) break;
            a.kill = false; // a stop meant for the last task does not carry over to this one
            a.plan = []; a.planSeen = now; a.planTool = false; // a new task starts a new checklist
            if (text) a.task = clip(text, 160); // an image-only prompt keeps the last task
            a.action = "Reading your message";
            // A new task: its crew starts from whoever is still out on the last one. A slash command is not a task.
            s.crew = (s.crew || []).filter((id) => { const x = s.agents.get(id); return x && (x.status === "working" || x.status === "needs-you"); });
            // Nothing is said when you send a prompt: you know what you asked. Pulse speaks when helpers go out or work ends.
            break;
        }
        case "PreToolUse": {
            a.status = "working";
            a.action = describe(p.tool_name, p.tool_input);
            a.tools++;
            a.ticks.push(now);
            a.history.push({ t: now, tool: p.tool_name, action: a.action, detail: detailOf(p.tool_name, p.tool_input) });
            if (a.history.length > HISTORY_MAX) a.history.shift();
            // The agent's own to-do list is the checklist under "Your orders" when it keeps one.
            const ti = p.tool_input || {};
            if (p.tool_name === "TodoWrite" && Array.isArray(ti.todos)) { a.planTool = true; a.plan = ti.todos.slice(0, 20).map((x) => ({ text: clip(x.content || x.subject || "", 90), done: x.status === "completed", now: x.status === "in_progress" })); }
            else if (p.tool_name === "TaskCreate" && (ti.subject || ti.description)) { a.planTool = true; (a.plan ||= []).push({ text: clip(ti.subject || ti.description, 90), done: false }); }
            else if (p.tool_name === "TaskUpdate" && a.plan?.[+ti.taskId - 1] && ti.status) a.plan[+ti.taskId - 1] = { ...a.plan[+ti.taskId - 1], done: ti.status === "completed", now: ti.status === "in_progress" };
            const file = p.tool_input?.file_path || p.tool_input?.notebook_path;
            if (file) (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(p.tool_name) ? a.edited : a.read).add(file);
            if (p.tool_name === "Agent" || p.tool_name === "Task") {
                const type = p.tool_input?.subagent_type || "general-purpose", task = clip(p.tool_input?.description, 140);
                // SubagentStart may have landed first: hand the task to a fresh same-type subagent that has none yet.
                const early = [...s.agents.values()].find((x) => x.id !== "main" && x.type === type && !x.task && now - x.startedAt < 10_000);
                if (early) early.task = task;
                else s.pending.push({ type, task, t: now });
            }
            break;
        }
        case "PostToolUse": {
            if (a.status === "needs-you") { a.status = "working"; a.action = describe(p.tool_name, p.tool_input); }
            // An agent stopped by another (TaskStop) gets no SubagentStop: without this it would sit on "needs you" forever.
            // Only a guess of an ending (stale), so a later message that resumes it brings it back.
            const x = p.tool_name === "TaskStop" && s.agents.get(p.tool_input?.task_id);
            if (x && x.id !== "main" && (x.status === "working" || x.status === "needs-you")) Object.assign(x, { status: "done", endedAt: now, kill: false, stale: true, action: `Stopped by ${callsign(a)}` });
            break;
        }
        case "PostToolUseFailure":
            a.errors++;
            a.history.push({ t: now, tool: p.tool_name, action: `Hit a snag: ${describe(p.tool_name, p.tool_input)}`, failed: true, detail: detailOf(p.tool_name, p.tool_input, p.error) });
            if (a.history.length > HISTORY_MAX) a.history.shift();
            break;
        case "SubagentStart": {
            // Claude Code writes each subagent's spawn description next to its transcript (agent-<id>.meta.json): that is
            // its task, exactly. Without it, spawn calls and starts are paired by type, oldest first, which can swap the
            // tasks of two same-type agents started together.
            s.pending = s.pending.filter((x) => now - x.t < 60_000); // spawns that were denied or failed never start
            const exact = spawnDescription(s, a);
            let i = exact ? s.pending.findIndex((x) => x.task === exact) : -1;
            if (i < 0) i = s.pending.findIndex((x) => x.type === a.type);
            if (i >= 0) a.task = s.pending.splice(i, 1)[0].task;
            if (exact) a.task = exact;
            a.status = "working";
            a.action = "Starting";
            s.crew = [...new Set([...(s.crew || []), a.id])];
            // Helpers that land together are said together: a join waits a moment for its siblings, a few seconds at most.
            const open = st.out.find((x) => x.kind === "dispatch" && x.sid === s.id);
            if (open) { open.aids.push(a.id); open.due = Math.min(open.at + DISPATCH_MAX_MS, now + DISPATCH_WAIT_MS); }
            else out(st, { kind: "dispatch", sid: s.id, aids: [a.id], at: now, due: now + DISPATCH_WAIT_MS });
            break;
        }
        case "SubagentStop": {
            if (a.status === "done" && !revived) break;
            const stopped = a.kill; // stopped from Pulse
            a.status = "done";
            a.endedAt = now;
            a.kill = false;
            a.sumTries = 0;
            readSummary(s, a);
            // Finishes wait a moment too: the transcript catches up, and several at once become one line.
            out(st, { kind: "finish", sid: s.id, aid: a.id, at: now, due: now + FINISH_WAIT_MS, transcript: p.agent_transcript_path, stopped });
            break;
        }
        case "PermissionRequest":
        case "Notification":
            // Idle reminders ("Claude is waiting for your input") come a minute after a turn ends. The agent is finished, not blocked.
            if (p.notification_type === "idle_prompt") break;
            if (a.status !== "needs-you") { a.needsAt = now; a.needsSpoken = false; }
            a.status = "needs-you";
            a.action = clip(p.message || (p.tool_name ? `Approve ${describe(p.tool_name, p.tool_input)}` : "Waiting for you"));
            break;
        case "Stop":
            // What to say (a finish, a wrap-up of the crew, or who it is still waiting on) is decided when the line is due.
            if (a.status === "working" || a.status === "needs-you") out(st, { kind: "turn", sid: s.id, aid: a.id, at: now, due: now + FINISH_WAIT_MS, transcript: p.transcript_path, harness: !!a.harness, long: now - a.turnAt >= LONG_TURN_MS });
            readPlan(s, a);
            a.status = "idle";
            a.stoppedAt = now;
            a.action = "Waiting for your next message";
            a.kill = false;
            a.sumTries = 0;
            readSummary(s, a);
            break;
        case "SessionEnd":
            if (isEmpty(s)) { st.sessions.delete(s.id); break; }
            s.ended = true;
            for (const x of s.agents.values()) {
                if (x.status !== "done") { x.status = "ended"; x.endedAt = x.endedAt || now; }
            }
            break;
    }
}

const agentKey = (s, a) => `${s.id}|${a.id}`;
const dropQueued = (st, s, kind) => { for (let i = st.out.length - 1; i >= 0; i--) if (st.out[i].kind === kind && st.out[i].sid === s.id) st.out.splice(i, 1); };
// A chat as said aloud: its project ("Orbit web"), and when the folder has several chats, the same C1, C2 the board and
// the terminal tabs show ("Orbit web C2").
function chatName(st, s, lower = false) {
    const same = [...st.sessions.values()].filter((x) => x.cwd === s.cwd && !isEmpty(x)).sort((x, y) => x.startedAt - y.startedAt);
    const name = project(s).replace(/[-_]+/g, " ");
    return `${lower ? name.toLowerCase() : upFirst(name)}${same.length > 1 ? ` C${same.indexOf(s) + 1}` : ""}`;
}
// What a waiting agent asks permission for, as an order that follows "permission to": "use Bash". Empty if it isn't that.
function permissionOf(a) {
    const t = L.speakable(a.action).replace(/[.:]+$/, "");
    const m = /^(?:Claude needs your permission to|Approve)\s+(.+)$/i.exec(t);
    return m ? L.lowFirst(L.tidyTask(m[1])) : "";
}
// Line kinds by urgency (the page plays a higher one first), and the feed kind for each outcome.
const PRI = { needs: 4, failed: 4, wrap: 3, done: 2, status: 2, start: 1, dispatch: 1, note: 1 };
const KIND_OF = { done: "done", failed: "failed", blocked: "failed", needs: "needs", stopped: "note" };
const BAD_OUTCOME = new Set(["failed", "blocked", "needs"]);
// A session with no prompt, no tool calls and no subagents (e.g. a VS Code window that opened a chat and closed it) is noise.
const isEmpty = (s) => { const m = s.agents.get("main"); return s.agents.size <= 1 && (!m || (!m.task && !m.tools)); };

// The hook's reply. Empty unless the user stopped this agent from Pulse. Talking to an agent happens in its terminal
// (Pulse's own, or wherever it runs); a hook can only act at the agent's next tool call, too late to feel like a conversation.
// Stop ends the main turn (continue:false) or refuses every tool call a subagent tries until it stops.
function decide(st, p) {
    const a = st.sessions.get(p.session_id)?.agents.get(p.agent_id || "main");
    if (!a?.kill || p.hook_event_name !== "PreToolUse") return null;
    if (a.id === "main") return { continue: false, stopReason: "Stopped from Pulse." };
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "The user stopped you from Pulse. Stop right now: make no more tool calls and end your turn with one short line saying you were stopped." } };
}

// One hook event: answer with a pending decision, then fold the event into state. Shared by /hook and the demo.
function handleHook(st, p, now = Date.now()) {
    const d = decide(st, p);
    const agent = () => st.sessions.get(p.session_id)?.agents.get(p.agent_id || "main");
    apply(st, p, now);
    // Kill ended the main turn right here, and Claude Code sends no Stop after continue:false.
    if (d?.continue === false) { const a = agent(); if (a) { a.kill = false; a.status = "idle"; a.stoppedAt = now; a.action = "Stopped from Pulse"; } }
    return d;
}

// Esc sends no Stop hook: Claude Code only writes "[Request interrupted by user]" into the transcript.
// A working chat that went silent and ends on that marker is idle, and its silent subagents died with the turn.
const INTERRUPT_CHECK_MS = 15_000;
function settleInterrupted(st, now = Date.now()) {
    for (const s of st.sessions.values()) {
        // A subagent interrupted on its own (its permission prompt dismissed, or stopped by the main agent) ends on the
        // same marker in its own transcript, while the chat carries on.
        for (const a of s.agents.values()) {
            if (a.id !== "main" && (a.status === "working" || a.status === "needs-you") && now - a.lastAt >= INTERRUPT_CHECK_MS && wasInterrupted(agentTranscript(s, a))) Object.assign(a, { status: "done", endedAt: a.lastAt, kill: false, stale: true, action: "Interrupted" });
        }
        const m = s.agents.get("main");
        if (!m || (m.status !== "working" && m.status !== "needs-you") || now - m.lastAt < INTERRUPT_CHECK_MS || !wasInterrupted(s.transcript)) continue;
        Object.assign(m, { status: "idle", stoppedAt: now, action: "Interrupted", kill: false });
        for (const a of s.agents.values()) {
            if (a.id !== "main" && (a.status === "working" || a.status === "needs-you") && now - a.lastAt >= INTERRUPT_CHECK_MS) Object.assign(a, { status: "done", endedAt: a.lastAt, kill: false, stale: true });
        }
    }
}

// Plain-text context for one status report, and a template fallback if the AI call is off or fails.
// A request for you shows on screen at once and is spoken only after 30 seconds, and only if it is still unanswered by
// then (voiceLines checks again right before speaking): one you approve in that time is never said.
const NEEDS_SPEAK_AFTER = 30_000;
function escalate(st, now = Date.now()) {
    for (const s of st.sessions.values()) {
        for (const a of s.agents.values()) {
            if (a.status !== "needs-you" || a.needsSpoken || now - (a.needsAt || now) < NEEDS_SPEAK_AFTER) continue;
            if (s.muted) { a.needsSpoken = true; continue; }
            if (now - s.lastNeedsAt < 20_000) continue; // another request in this chat was just said: this one waits its turn
            a.needsSpoken = true;
            s.lastNeedsAt = now;
            out(st, { kind: "needs", sid: s.id, aid: a.id, at: now });
        }
    }
}

function statusContext(st, now = Date.now()) {
    const lines = [], fallback = [], ids = [];
    for (const s of st.sessions.values()) {
        if (s.ended || s.muted) continue;
        const live = [...s.agents.values()].filter((a) => a.status === "working" || a.status === "needs-you");
        if (!live.length) continue;
        lines.push(`Project ${project(s)}:`);
        for (const a of live) {
            const mins = Math.round((now - a.startedAt) / 60_000);
            const quiet = Math.round((now - a.lastAt) / 60_000);
            const recent = a.history.slice(-8).map((h) => `${h.action} (${Math.max(0, Math.round((now - h.t) / 60_000))}m ago)`).join("; ");
            const id = agentKey(s, a);
            ids.push(id);
            const plan = a.plan?.length ? ` Checklist, ${a.plan.filter((x) => x.done).length} of ${a.plan.length} done: ${a.plan.map((x, i) => `${i + 1}. ${x.text} (${x.done ? "done" : x.now ? "in progress" : "not yet"})`).join("; ")}.` : "";
            lines.push(`- id ${id}: ${a.id === "main" ? "main agent" : `${a.call || `agent ${a.n}`} (${short(a.type)})`}, task "${a.task || "unknown"}", ${a.status === "needs-you" ? "WAITING FOR THE USER" : now - a.lastAt >= QUIET_MS ? `quiet for ${quiet}m` : "working"}, running ${mins}m, ${a.tools} tool calls, ${a.edited.size} files edited, ${a.errors} failed calls. Recent: ${recent || "none"}.${plan}`);
            if (a.status === "needs-you") fallback.push(`${project(s)} is waiting on you.`);
            else if (now - a.lastAt >= QUIET_MS) fallback.push(`${callsign(a)} has been quiet for ${quiet} minutes.`);
            else fallback.push(a.id === "main" ? `${project(s)} is on ${clip(a.action, 50)}.` : `${a.call || `Agent ${a.n}`} is still on ${clip(L.speakable(a.task || a.action), 60)}.`);
        }
    }
    if (!lines.length) return null;
    const extra = fallback.length > 4 ? ` And ${fallback.length - 4} more.` : "";
    return { context: lines.join("\n"), ids, callRule: callRule(st), fallback: `Here's a quick update${callTail(st)}. ${fallback.slice(0, 4).join(" ")}${extra}` };
}

function prune(st, now = Date.now()) {
    for (const [id, s] of st.sessions) {
        const idleFor = now - s.lastAt;
        if ((s.ended && idleFor > 10 * 60_000) || idleFor > 3 * 3600_000 || (isEmpty(s) && idleFor > 10 * 60_000)) { st.sessions.delete(id); continue; }
        // Helpers saved before they were left out (see apply): no type, no task, no tools, started and ended in one event.
        for (const a of [...s.agents.values()]) if (a.id !== "main" && a.type === "subagent" && !a.task && !a.tools && a.startedAt === a.endedAt) s.agents.delete(a.id);
        // Keep the five most recent finished subagents per session; older ones only add noise.
        const done = [...s.agents.values()].filter((a) => a.status === "done").sort((a, b) => b.endedAt - a.endedAt);
        for (const a of done.slice(5)) if (now - a.endedAt > 20 * 60_000) s.agents.delete(a.id);
        for (const a of s.agents.values()) {
            a.ticks = a.ticks.filter((t) => now - t < SPARK_MIN * 60_000);
            // An interrupted turn (Esc) sends no Stop event; after 15 silent minutes treat it as idle so reports stop nagging.
            // Only a guess, so any later event brings it back (see "stale" in apply). One waiting on you keeps waiting.
            if (a.status === "working" && now - a.lastAt > 15 * 60_000) {
                a.status = a.id === "main" ? "idle" : "done";
                a.endedAt = a.endedAt || a.lastAt;
                a.stale = true;
            }
        }
    }
}

// Tool calls per minute, oldest first.
function spark(ticks, now) {
    const res = new Array(SPARK_MIN).fill(0);
    for (const t of ticks) {
        const m = Math.floor((now - t) / 60_000);
        if (m < SPARK_MIN) res[SPARK_MIN - 1 - m]++;
    }
    return res;
}

function snapshot(st, extra, now = Date.now()) {
    return {
        now,
        quietMs: QUIET_MS,
        ...extra,
        settings: st.settings,
        comms: st.comms.slice(-60),
        workspaces: [...(st.workspaces || [])],
        sessions: [...st.sessions.values()].map((s) => ({
            id: s.id, cwd: s.cwd, project: project(s), branch: s.branch, empty: isEmpty(s), startedAt: s.startedAt, lastAt: s.lastAt, ended: s.ended, muted: s.muted, term: s.term || "",
            agents: [...s.agents.values()].map(({ ticks, turnAt, read, edited, ...a }) => ({
                ...a, spark: spark(ticks, now), read: [...read].slice(-20), edited: [...edited].slice(-20), readCount: read.size,
            })),
        })),
    };
}

function gitBranch(dir) {
    for (let d = dir, i = 0; d && i < 6; d = path.dirname(d), i++) {
        try {
            const head = fs.readFileSync(path.join(d, ".git", "HEAD"), "utf8").trim();
            return head.startsWith("ref: ") ? head.split("/").slice(2).join("/") : head.slice(0, 7);
        } catch {}
        if (d === path.dirname(d)) break;
    }
    return "";
}

// A subagent's spawn description, from the metadata Claude Code keeps beside its transcript. Null if not there (yet).
function spawnDescription(s, a) {
    const file = a.id !== "main" && agentTranscript(s, a);
    if (!file) return null;
    try { return clip(JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, ".meta.json"), "utf8")).description, 140) || null; } catch { return null; }
}
// Where Claude Code keeps a subagent's own transcript, next to the session's.
const agentTranscript = (s, a) => (a.id === "main" ? s.transcript : s.transcript && path.join(s.transcript.replace(/\.jsonl$/, ""), "subagents", `agent-${a.id}.jsonl`));

// ---- Burn: what an agent's tokens would cost at list price. An estimate read from the transcript's own usage lines. ----
// USD per million tokens: input, output, cache read, cache write (5 minute, 1 hour). First match wins, so specific ids come first.
const RATES = [
    [/fable|mythos/, [10, 50, 0.25, 12.5, 20]],
    [/opus-5-5/, [4, 20, 0.2, 5, 8]],
    [/opus-4-[01]\b|opus-4-2025|claude-3-opus/, [15, 75, 1.5, 18.75, 30]],
    [/opus/, [5, 25, 0.5, 6.25, 10]],
    [/sonnet-5/, [2, 10, 0.2, 2.5, 4]],
    [/sonnet/, [3, 15, 0.3, 3.75, 6]],
    [/haiku-3/, [0.8, 4, 0.08, 1, 1.6]],
    [/haiku/, [1, 5, 0.1, 1.25, 2]],
];
const rateFor = (model) => (RATES.find(([re]) => re.test(String(model || "")))?.[1]) || RATES.find(([re]) => re.test("sonnet"))[1];
const usageCost = (model, u) => {
    const r = rateFor(model);
    return (u.input * r[0] + u.output * r[1] + u.read * r[2] + u.write5 * r[3] + u.write1h * r[4]) / 1e6;
};
// file -> { size, rest, msgs: Map(message id -> { t, model, u }) }. Read incrementally; a message id repeats once per content block, the last line has the final counts.
const usageFiles = new Map();
function scanUsage(file) {
    if (!file) return null;
    let fd;
    try {
        fd = fs.openSync(file, "r");
        const size = fs.fstatSync(fd).size;
        let c = usageFiles.get(file);
        if (!c || size < c.size) usageFiles.set(file, (c = { size: 0, rest: Buffer.alloc(0), msgs: new Map() }));
        while (size > c.size) {
            const n = Math.min(size - c.size, 8e6);
            const buf = Buffer.concat([c.rest, readAt(fd, c.size, n)]);
            c.size += n;
            const end = buf.lastIndexOf(10) + 1;
            c.rest = Buffer.from(buf.subarray(end));
            for (const line of buf.toString("utf8", 0, end).split("\n")) {
                if (!line.includes('"usage"')) continue;
                let j; try { j = JSON.parse(line); } catch { continue; }
                const m = j.message, u = m?.usage;
                if (j.type !== "assistant" || !u || !m.id) continue;
                const w = u.cache_creation || {}, w1 = w.ephemeral_1h_input_tokens || 0;
                c.msgs.set(m.id, { t: Date.parse(j.timestamp) || 0, model: m.model, u: { input: u.input_tokens || 0, output: u.output_tokens || 0, read: u.cache_read_input_tokens || 0, write5: w.ephemeral_5m_input_tokens ?? Math.max(0, (u.cache_creation_input_tokens || 0) - w1), write1h: w1 } });
            }
        }
        if (usageFiles.size > 200) usageFiles.delete(usageFiles.keys().next().value);
        return c;
    } catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
}
// The Burn card's numbers. A chat ("main") covers its whole crew: its own transcript plus every subagent's.
const BURN_POINTS = 32;
function burnFor(s, a) {
    const files = a.id === "main" ? [s.transcript, ...[...s.agents.values()].filter((x) => x.id !== "main").map((x) => agentTranscript(s, x))] : [agentTranscript(s, a)];
    const totals = { input: 0, output: 0, read: 0, write: 0, dollars: 0, calls: 0 }, events = [];
    for (const f of files) {
        for (const { t, model, u } of scanUsage(f)?.msgs.values() || []) {
            const d = usageCost(model, u);
            totals.input += u.input; totals.output += u.output; totals.read += u.read; totals.write += u.write5 + u.write1h; totals.dollars += d; totals.calls++;
            events.push([t, d]);
        }
    }
    // Cumulative dollars at even steps from the first call to the last, for the graph.
    events.sort((x, y) => x[0] - y[0]);
    const t0 = events[0]?.[0] || 0, span = Math.max(1, (events.at(-1)?.[0] || 0) - t0), series = Array(BURN_POINTS).fill(0);
    for (const [t, d] of events) series[Math.min(BURN_POINTS - 1, Math.floor(((t - t0) / span) * BURN_POINTS))] += d;
    for (let i = 1; i < BURN_POINTS; i++) series[i] += series[i - 1];
    totals.tokens = totals.input + totals.output + totals.read + totals.write;
    return { ok: true, crew: a.id === "main" && files.length > 1, ...totals, from: t0, to: events.at(-1)?.[0] || 0, series };
}

// ---- Plan limits: the 5-hour and weekly windows of a Pro or Max plan. Only Claude Code's status line is told these
// (rate_limits in its stdin JSON), so scripts/pulse-statusline.sh posts that JSON here. Kept in ~/.pulse/limits.json. ----
const LIMITS_FILE = path.join(HOME, DEMO ? "limits.demo.json" : "limits.json");
const limitWindow = (w) => {
    const pct = Number(w?.used_percentage), resetsAt = Number(w?.resets_at);
    return Number.isFinite(pct) ? { pct: Math.max(0, Math.min(100, pct)), resetsAt: Number.isFinite(resetsAt) && resetsAt > 0 ? resetsAt * 1000 : 0 } : null;
};
// Status line JSON -> { at, five, week }, or null when it carries no limits (API key users, or before the session's first reply).
function parseLimits(p, now = Date.now()) {
    const r = p?.rate_limits, five = limitWindow(r?.five_hour), week = limitWindow(r?.seven_day);
    return five || week ? { at: now, five, week } : null;
}
function loadLimits() {
    try { return JSON.parse(fs.readFileSync(LIMITS_FILE, "utf8")); } catch { return null; }
}
// A window whose reset time has passed starts again from zero.
const liveWindow = (w, now) => (w && w.resetsAt && now >= w.resetsAt ? { pct: 0, resetsAt: 0 } : w);
// What the status line prints: "5h 42% · week 18%".
function limitsLine(l, now = Date.now()) {
    const five = liveWindow(l?.five, now), week = liveWindow(l?.week, now);
    return [five && `5h ${Math.round(five.pct)}%`, week && `week ${Math.round(week.pct)}%`].filter(Boolean).join(" · ");
}

// The agent's own latest narration ("Now checking the edge cases"), read from its transcript. Throttled, zero tokens.
function refreshNote(st, p, now = Date.now()) {
    const s = st.sessions.get(p.session_id), a = s?.agents.get(p.agent_id || "main");
    if (!a || now - a.noteAt < 8000) return;
    a.noteAt = now;
    const text = withoutPulseLine(lastAssistantText(agentTranscript(s, a), 96_000) || "");
    if (text) a.note = clip(text.split(/\n+/).filter(Boolean).pop(), 220);
    if (a.id === "main") readPlan(s, a);
    // A chat whose prompt was never captured (Pulse restarted mid-turn, or an older Pulse skipped it) takes it from the transcript.
    if (a.id === "main" && !a.task && now - (a.taskTriedAt || 0) > 60_000) {
        a.taskTriedAt = now;
        const prompt = readTranscript(s.transcript)?.entries.findLast((e) => e.kind === "user")?.text;
        if (prompt) a.task = clip(prompt.replace(/^(\[image\]\s*)+/, ""), 160);
    }
}

// The last maxBytes of a file as text, and whether anything before that was left out. Null if unreadable.
function readTail(file, maxBytes) {
    let fd;
    try {
        fd = fs.openSync(file, "r");
        const size = fs.fstatSync(fd).size, len = Math.min(size, maxBytes);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, size - len);
        return { text: buf.toString("utf8"), cut: len < size };
    } catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

// The transcript's last entries, newest first, parsed. Unreadable lines (and a line cut in half by the tail) are skipped.
function* tailEntries(file, maxBytes) {
    const tail = readTail(file, maxBytes);
    if (!tail) return;
    for (const line of tail.text.split("\n").reverse()) {
        try { yield JSON.parse(line); } catch {}
    }
}
const textOf = (content) => (typeof content === "string" ? content : Array.isArray(content) ? content.filter((c) => c.type === "text").map((c) => c.text).join("\n") : "").trim();

// Clip keeping line breaks, for text the page shows as a block.
const cut = (s, n) => { s = String(s ?? ""); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

// The most useful raw input of a tool call, as plain text: what you would want to read under the call's title.
function toolInput(tool, i = {}) {
    const edit = (e) => `--- old\n${cut(e.old_string, 1500)}\n+++ new\n${cut(e.new_string, 1500)}`;
    const lines = (from, n) => (n ? ` (lines ${from}-${from + n - 1})` : from > 1 ? ` (from line ${from})` : "");
    let s;
    switch (tool) {
        case "Bash": s = i.command; break;
        case "Read": s = `${i.file_path}${lines(+i.offset || 1, +i.limit || 0)}`; break;
        case "Edit": s = `${i.file_path}\n${edit(i)}`; break;
        case "MultiEdit": s = [i.file_path, ...(i.edits || []).map(edit)].join("\n"); break;
        case "Write": s = `${i.file_path}\n\n${i.content ?? ""}`; break;
        case "NotebookEdit": s = `${i.notebook_path}\n\n${i.new_source ?? ""}`; break;
        case "Grep": case "Glob": s = [i.pattern, i.path && `in ${i.path}`, i.glob && `files ${i.glob}`].filter(Boolean).join("  "); break;
        case "WebFetch": s = [i.url, i.prompt].filter(Boolean).join("\n\n"); break;
        case "WebSearch": s = i.query; break;
        case "Agent": case "Task": s = [i.description, i.prompt].filter(Boolean).join("\n\n"); break;
        case "Skill": s = [i.skill, i.args].filter(Boolean).join(" "); break;
        case "TodoWrite": s = (i.todos || []).map((x) => `${x.status === "completed" ? "[x]" : x.status === "in_progress" ? "[~]" : "[ ]"} ${x.content}`).join("\n"); break;
        default: s = JSON.stringify(i);
    }
    return cut(s, 4000);
}
// A tool result's content is a string or a list of parts; images and documents are too big to ship, so they become markers.
const resultText = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => (x.type === "text" ? x.text : x.type === "tool_reference" ? x.tool_name : `[${x.type}]`)).join("\n") : "");

// One agent's conversation as the page shows it: prompts, assistant text, and each tool call paired with its result.
// The page polls an open chat every second, and chats full of screenshots run to tens of MB, so each file is parsed once
// (its last TRANSCRIPT_BYTES) and after that only the bytes appended since are read. The newest TRANSCRIPT_MAX entries
// go out, oldest first. In the main transcript, sidechain lines belong to subagents, which have their own files.
// The same pass also keeps every file edit in full (c.edits), for the view of the exact code an agent changed.
const transcripts = new Map(); // "file|main" -> { size, tail, rest, skip, cut, early, entries, calls, edits, editIds, editChars, main }
function readTranscript(file, main = true) {
    const c = loadTranscript(file, main);
    return c && { entries: c.entries.slice(-TRANSCRIPT_MAX), truncated: c.cut || c.entries.length > TRANSCRIPT_MAX };
}
function loadTranscript(file, main = true) {
    if (!file) return null;
    let fd;
    try {
        fd = fs.openSync(file, "r");
        const size = fs.fstatSync(fd).size, key = `${file}|${main}`;
        let c = transcripts.get(key);
        // Transcripts only grow; a smaller file, or different bytes where the last read ended, means it was rewritten.
        if (c && (size < c.size || (c.tail.length && !readAt(fd, c.size - c.tail.length, c.tail.length).equals(c.tail)))) c = null;
        if (!c) {
            const from = Math.max(0, size - TRANSCRIPT_BYTES);
            c = { size: from, tail: Buffer.alloc(0), rest: Buffer.alloc(0), skip: from > 0, cut: from > 0, early: from > 0, entries: [], calls: new Map(), edits: [], editIds: new Map(), editChars: 0, main };
            transcripts.delete(key);
            transcripts.set(key, c);
            if (transcripts.size > 40) transcripts.delete(transcripts.keys().next().value);
        }
        // In 8 MB steps, so a deep first read never holds the whole window in memory.
        while (size > c.size) {
            const n = Math.min(size - c.size, 8e6);
            const buf = Buffer.concat([c.rest, readAt(fd, c.size, n)]);
            c.size += n;
            c.tail = Buffer.from(buf.subarray(Math.max(0, buf.length - 64)));
            // Decode whole lines only: a line still being written (or a character split across reads) waits for the next read.
            const end = buf.lastIndexOf(10) + 1;
            c.rest = Buffer.from(buf.subarray(end));
            const lines = buf.toString("utf8", 0, end).split("\n");
            if (c.skip && end) { lines.shift(); c.skip = false; } // the first window starts mid-line
            for (const line of lines) feedTranscript(c, line);
        }
        // A last line with no newline yet may already be complete.
        if (c.rest.length && !c.skip) { try { feedTranscript(c, JSON.parse(c.rest.toString("utf8"))); c.rest = Buffer.alloc(0); } catch {} }
        if (c.entries.length > TRANSCRIPT_MAX * 2) {
            for (const e of c.entries.splice(0, c.entries.length - TRANSCRIPT_MAX)) if (e.kind === "tool") c.calls.delete(e.id);
            c.cut = true;
        }
        return c;
    } catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function readAt(fd, pos, len) {
    const buf = Buffer.alloc(len);
    return buf.subarray(0, fs.readSync(fd, buf, 0, len, pos));
}

// Fold one transcript line (text or already parsed) into a cached conversation.
function feedTranscript(c, line) {
    let j = line;
    if (typeof line === "string") { if (!line) return; try { j = JSON.parse(line); } catch { return; } }
    const { entries, calls } = c;
    const said = (t, raw, images = 0) => {
        const text = typeof raw === "string" ? raw.trim() : textOf(raw);
        if (/^\[Request interrupted by user/.test(text)) return entries.push({ kind: "interrupt", t });
        const typed = promptText(text);
        if (typed === null) return entries.push({ kind: "notice", t, text: harnessNotice(text) });
        if (typed || images) entries.push({ kind: "user", t, text: [...Array(images).fill("[image]"), typed].filter(Boolean).join("\n") });
    };
    if (j.isMeta || (c.main && j.isSidechain)) return;
    const t = Date.parse(j.timestamp) || 0, content = j.message?.content;
    const parts = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
    if (j.type === "assistant") {
        for (const p of parts) {
            // Thinking is skipped. An API error ("Can't reach the API server") is written as assistant text but is not the agent talking.
            if (p.type === "text" && p.text?.trim()) {
                const shown = j.isApiErrorMessage ? p.text.trim() : withoutPulseLine(p.text);
                if (shown) entries.push(j.isApiErrorMessage ? { kind: "notice", t, text: clip(p.text, 160) } : { kind: "assistant", t, text: shown });
            }
            else if (p.type === "tool_use" && !calls.has(p.id)) {
                const e = { kind: "tool", t, id: p.id, tool: p.name, title: describe(p.name, p.input || {}), input: toolInput(p.name, p.input || {}), output: "", error: false, pending: true };
                calls.set(p.id, e);
                entries.push(e);
                noteEdit(c, t, p);
            }
        }
    } else if (j.type === "user") {
        const results = parts.filter((p) => p.type === "tool_result");
        // A result whose call fell before the window has nothing to attach to, so it is dropped.
        for (const r of results) Object.assign(calls.get(r.tool_use_id) || {}, { output: cut(resultText(r.content), 6000), error: r.is_error === true, pending: false });
        for (const r of results) settleEdit(c, r);
        if (results.length) return;
        if (j.isCompactSummary) entries.push({ kind: "notice", t, text: "Conversation compacted: earlier turns were summarized" });
        else said(t, parts, parts.filter((p) => p.type === "image").length);
    } else if (j.type === "attachment" && j.attachment?.type === "queued_command") {
        // A message sent while the agent was busy is only written as an attachment, never as its own user line.
        // Its timestamp is when it was queued; the agent read it here, so it is placed no earlier than the entry before it.
        const p = j.attachment.prompt;
        said(Math.max(t, entries.at(-1)?.t || 0), p, Array.isArray(p) ? p.filter((x) => x.type === "image").length : 0);
    }
}

// What one Edit, MultiEdit, Write or NotebookEdit call changed, in full (each side clipped to EDIT_MAX), kept apart from
// the page's clipped entries. It counts only once its result says it worked. Past EDIT_BUDGET the oldest edits go.
function noteEdit(c, t, p) {
    const i = p.input || {}, file = i.file_path || i.notebook_path;
    if (!file || !/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(p.name)) return;
    const one = (kind, before, after) => ({ t, tool: p.name, file: String(file), kind, before: cut(before, EDIT_MAX), after: cut(after, EDIT_MAX), ok: null });
    const list = p.name === "Edit" ? [one("edit", i.old_string, i.new_string)]
        : p.name === "MultiEdit" ? (Array.isArray(i.edits) ? i.edits : []).map((e) => one("edit", e?.old_string, e?.new_string))
        : p.name === "Write" ? [one("write", "", i.content)]
        : [one("edit", "", i.new_source)];
    c.edits.push(...list);
    c.editIds.set(p.id, list);
    for (const e of list) c.editChars += e.before.length + e.after.length;
    while (c.editChars > EDIT_BUDGET && c.edits.length) {
        const e = c.edits.shift();
        c.editChars -= e.before.length + e.after.length;
        c.early = true;
    }
}
function settleEdit(c, r) {
    const list = c.editIds.get(r.tool_use_id);
    if (!list) return;
    c.editIds.delete(r.tool_use_id);
    for (const e of list) e.ok = r.is_error !== true;
}

function lastAssistantText(file, maxBytes = 400_000) {
    for (const j of tailEntries(file, maxBytes)) {
        const text = j.type === "assistant" && Array.isArray(j.message?.content) && textOf(j.message.content);
        if (text) return text.slice(-4000);
    }
    return null;
}

function wasInterrupted(file) {
    if (!file) return false;
    for (const j of tailEntries(file, 64_000)) {
        if (j.type !== "user" && j.type !== "assistant") continue;
        return j.type === "user" && /^\[Request interrupted by user/.test(textOf(j.message?.content));
    }
    return false;
}

// The page's own scripts and styles, and the libraries it vendors (xterm, Monaco). Only the named files in server/, and
// under server/vendor/ only plain names at every level (no "..", no empty part, nothing hidden), resolved to a real path
// that is still inside vendor/, so nothing else on disk can be reached. The URL parser already folds "/vendor/../x".
const STATIC_TYPES = { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".map": "application/json", ".json": "application/json", ".svg": "image/svg+xml", ".wasm": "application/wasm" };
const STATIC_FILES = new Set(["/terminal.js", "/terminal.css", "/workspace.js", "/workspace.css", "/intro.js", "/intro.css"]);
function staticFile(root, pathname) {
    let file;
    if (STATIC_FILES.has(pathname)) file = path.join(root, pathname.slice(1));
    else if (pathname.startsWith("/vendor/")) {
        let parts;
        try { parts = pathname.slice(8).split("/").map(decodeURIComponent); } catch { return null; }
        if (!parts.every((x) => x && !x.startsWith(".") && !x.includes("..") && !/[/\\\0]/.test(x))) return null;
        const vendor = path.join(root, "vendor");
        file = path.join(vendor, ...parts);
        try { if (!within(fs.realpathSync(vendor), fs.realpathSync(file))) return null; } catch { return null; }
    } else return null;
    try {
        if (!fs.statSync(file).isFile()) return null;
        return { type: STATIC_TYPES[path.extname(file)] || "application/octet-stream", body: fs.readFileSync(file) };
    } catch { return null; }
}

function parseJson(s) {
    try { return JSON.parse(s.slice(s.indexOf("{"), s.lastIndexOf("}") + 1)); } catch { return null; }
}

// ---- One-shot model calls through the local Claude Code CLI (uses your existing login, no API key): Haiku for the Verbose
// briefings and commit messages only. Nothing is called per prompt or per finished turn. ----
const CLAUDE = process.env.PULSE_CLAUDE || [path.join(os.homedir(), ".local/bin/claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"].find((p) => fs.existsSync(p)) || "claude";
let modelChain = Promise.resolve();
// Measured: about 500 input tokens per call (the default Claude Code prompt and tools would add about 34k).
const VOICE_SYSTEM = "You are Pulse, the voice of a developer's agent dashboard, in the manner of JARVIS: a calm, dry-witted British AI butler. Understated, precise, never gushing, never an exclamation mark. You turn raw notes about AI coding agents into short spoken updates for someone who may be listening rather than looking.";
// Haiku for everything: the cheapest model is plenty for one-line summaries.
const VOICE_MODEL = ["--model", "claude-haiku-4-5"];
const haiku = (prompt, system) => askModel(prompt, system, VOICE_MODEL);
function askModel(prompt, system = VOICE_SYSTEM, model = VOICE_MODEL) {
    const run = () => new Promise((resolve) => {
        // Own tiny system prompt, no tools, no thinking, hooks and MCP off (so the summarizer never shows up on the dashboard); tmp cwd skips CLAUDE.md.
        const p = spawn(CLAUDE, ["-p", ...model, "--system-prompt", system, "--tools", "", "--settings", '{"disableAllHooks":true,"alwaysThinkingEnabled":false}', "--strict-mcp-config", "--no-session-persistence"], { cwd: os.tmpdir(), stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, PULSE_INTERNAL: "1" } });
        let text = "";
        const timer = setTimeout(() => p.kill(), 60_000);
        p.stdout.on("data", (d) => (text += d));
        p.on("error", () => resolve(null));
        p.on("close", (code) => { clearTimeout(timer); resolve(code === 0 && text.trim() ? text.trim() : null); });
        p.stdin.on("error", () => {}); // claude exiting before it read the prompt (EPIPE) must not take the server down
        p.stdin.end(prompt);
    });
    return (modelChain = modelChain.then(run, run));
}

const RULES = "Plain, natural spoken English for a text-to-speech voice: no markdown, no lists, no emoji, no file paths (a file name only if it matters), no tool names like Grep or Bash.";

async function summarizeStatus(ctx) {
    const reply = await askModel(`Brief the user on the agents below. Open naturally and ${ctx.callRule}, varying the wording (for example "Here's a quick update." or "A short summary of where things stand."), placing it naturally in the sentence. Then say what has been accomplished so far and what is happening right now; where a checklist is given, say how far along it is in plain words (for example "two of your four asks are done; the settings fix is next"). Anything waiting on the user comes first. At most 45 words, calm and understated, never robotic. Call each agent by its name (Atlas, Echo...) and mention a project name only when there are several. ${RULES}\nAlso write each agent id a plain summary of at most 10 words.\nReply with JSON only: {"spoken": "...", "agents": {"<id>": "..."}}\n\nNotes:\n${ctx.context}`);
    return parseJson(reply || "");
}

// ---- The agent's own one-line summary: zero extra calls. Pulse asks every chat and subagent (through the SessionStart and
// SubagentStart hooks) to end its last message with a marker line, and reads that line back. Nothing is guessed: an agent
// that leaves it out simply has no summary. ----
const PULSE_MARK = "\u27e6pulse\u27e7";
// The line is read aloud, often to someone listening rather than looking, so it names the task and how it ended, and
// nothing about how or what was found: "Atlas has finished the voice template count."
const PULSE_RULE = `Pulse dashboard: end your final message of every turn with one last line, exactly \`${PULSE_MARK} <outcome> | <task>\`. <outcome> is one of: done, failed, blocked, needs you. <task> names the job you were given as a short noun phrase starting with "the", 3 to 8 plain words, the way you'd name it out loud: for example "the voice template count", "the login bug fix", "the search bar redesign". Name the job only: no results, numbers, file names, paths or code. Use "needs you" when you end with a question or are waiting for the user. Do this every time, even for short answers. When the user asks for more than one thing, also write one line near the start of your reply, exactly \`${PULSE_MARK} plan | <first ask>; <second ask>; ...\`, each ask in 2 to 6 of the user's own words, in their order; then each time you finish one, a line \`${PULSE_MARK} check | <its number>\`. Pulse shows these as the user's checklist. Skip the plan for a single ask.`;
const PULSE_LINE = new RegExp(`^[ \\t]*${PULSE_MARK}[ \\t]*(.+?)[ \\t]*$`, "gm");
// The summary from the last marker line in a message, or null.
function pulseLine(text) {
    let last = null;
    for (const m of String(text || "").matchAll(PULSE_LINE)) if (!/^(plan|check)\s*[|:]/i.test(m[1])) last = m[1];
    return last && clip(last, 200);
}

// ---- The checklist under "Your orders": the separate things you asked for, ticked as they get done. It comes from the
// agent's own to-do tool when it uses one (TodoWrite, TaskCreate/TaskUpdate, see apply), and from the plan and check
// lines it writes as it works (\`⟦pulse⟧ plan | first; second\`, \`⟦pulse⟧ check | 2\`). A task reported done ticks the rest. ----
const PLAN_LINE = new RegExp(`^[ \\t]*${PULSE_MARK}[ \\t]*(plan|check)[ \\t]*[|:][ \\t]*(.+?)[ \\t]*$`, "gim");
function planFromText(plan, text) {
    for (const m of String(text || "").matchAll(PLAN_LINE)) {
        if (m[1].toLowerCase() === "plan") plan = m[2].split(/\s*;\s*/).map((x) => L.tidyTask(x)).filter(Boolean).slice(0, 12).map((x) => ({ text: clip(x, 90), done: false }));
        else for (const n of m[2].match(/\d+/g) || []) if (plan[+n - 1]) plan[+n - 1] = { ...plan[+n - 1], done: true, now: false };
    }
    return plan;
}
// New plan and check lines since the last read, oldest first. Incremental, so a long task's early plan line is never
// lost off the end of the transcript tail.
function readPlan(s, a) {
    const fresh = [];
    for (const j of tailEntries(agentTranscript(s, a), 200_000)) {
        const t = Date.parse(j.timestamp) || 0;
        if (t <= (a.planSeen || 0)) break;
        if (j.type === "assistant" && Array.isArray(j.message?.content)) fresh.push([t, textOf(j.message.content)]);
    }
    if (!fresh.length) return;
    a.planSeen = fresh[0][0];
    for (const [, text] of fresh.reverse()) a.plan = planFromText(a.plan || [], text);
}
// The marker line taken out of a message, for showing the conversation.
const withoutPulseLine = (text) => String(text).replace(PULSE_LINE, "").replace(/\n{3,}/g, "\n\n").trim();
// How the agent says its turn ended, { outcome, task }, for the spoken line and the agent's Summary. Null when it left no marker.
const finishOf = (transcript) => L.parseFinish(pulseLine(transcript && lastAssistantText(transcript)));
function noteFinish(a, f) {
    if (!f) return;
    a.summary = L.summaryOf(f);
    a.outcome = f.outcome || "";
    a.said = f.task || ""; // the task in the agent's own words, for the wrap-up
    if (f.outcome === "done" && a.plan) a.plan = a.plan.map((x) => ({ ...x, done: true, now: false }));
}

// An agent's own summary of its last turn, read as soon as the turn ends (a chat working alone gets one too, not only a
// subagent). The transcript can lag the Stop hook by a moment, so the 10 second tick retries a few times.
function readSummary(s, a) {
    if ((a.sumTries || 0) >= 4) return;
    a.sumTries = (a.sumTries || 0) + 1;
    if (a.id === "main") readPlan(s, a); // the plan's lines may only reach the transcript with the turn's last message
    const f = finishOf(agentTranscript(s, a));
    if (f) { noteFinish(a, f); a.sumTries = 4; }
}

// ---- Workspace: the file explorer, editor, source control and per-agent changes the page shows for each project. ----
// A root is a project folder: the folder of a chat Pulse has seen, or one the user opened in the app. The page names files
// by paths relative to it, and every path must still be inside it once symlinks are resolved.

// A refusal the page can show as is: { ok:false, error }.
const refuse = (error, more) => Object.assign(new Error(error), { reply: { ok: false, error, ...more } });
const FS_ERRORS = { ENOENT: "No such file or folder", ENOTDIR: "Not a folder", EISDIR: "That is a folder, not a file", EACCES: "Permission denied", EPERM: "Permission denied", EEXIST: "It already exists", ENOSPC: "The disk is full", EROFS: "The disk is read-only" };
const failure = (e) => e.reply || { ok: false, error: FS_ERRORS[e.code] || e.message || String(e) };

// True when p is root itself or somewhere under it.
function within(root, p) {
    const r = path.relative(root, p);
    return r !== ".." && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r);
}

// The roots the page may use: every chat's folder, plus folders the user opened in the app. Resolves to the real path.
async function projectRoot(st, root) {
    if (typeof root !== "string" || !path.isAbsolute(root)) throw refuse("Pick a project folder first");
    const r = path.resolve(root);
    if (!st.workspaces?.has(r) && ![...st.sessions.values()].some((s) => s.cwd && path.resolve(s.cwd) === r)) throw refuse("That folder is not one of your projects");
    try { return await fsp.realpath(r); } catch { throw refuse("That project folder no longer exists"); }
}
async function openWorkspace(st, root) {
    if (typeof root !== "string" || !path.isAbsolute(root)) throw refuse("Pick a folder by its full path");
    const r = path.resolve(root);
    const s = await fsp.stat(r).catch(() => null);
    if (!s) throw refuse("That folder does not exist");
    if (!s.isDirectory()) throw refuse("That is a file, not a folder");
    st.workspaces.add(r);
    return { ok: true, root: r };
}

// A path the page sent, relative to the root: nothing absolute and no ".." anywhere. Returns it tidied ("" is the root).
function relPath(rel) {
    rel = String(rel ?? "");
    if (rel.includes("\0") || path.isAbsolute(rel) || rel.split("/").includes("..")) throw refuse("That path is outside the project");
    const n = path.posix.normalize(rel || ".").replace(/\/+$/, "");
    return n === "." ? "" : n;
}

// Where a relative path really is, refused unless it stays inside the root once symlinks are resolved. A path that does
// not exist yet (a new file, or one deleted since) is checked through its nearest existing parent. With follow off the
// last part is not resolved, so a symlink is looked at as a link rather than followed.
async function realIn(root, rel, follow = true) {
    const parts = rel ? rel.split("/") : [], rest = [];
    if (!follow && parts.length) rest.push(parts.pop());
    for (;;) {
        let real;
        try { real = await fsp.realpath(path.join(root, ...parts)); } catch (e) {
            if (!parts.length || (e.code !== "ENOENT" && e.code !== "ENOTDIR")) throw e;
            rest.unshift(parts.pop());
            continue;
        }
        real = path.join(real, ...rest);
        if (!within(root, real)) throw refuse("That path leads outside the project");
        return real;
    }
}

// Monaco language ids, by extension or, for files without one, by name.
const LANGS = {
    ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
    json: "json", jsonc: "json", md: "markdown", markdown: "markdown", mdx: "markdown", css: "css", scss: "scss", less: "less", html: "html", htm: "html",
    py: "python", sh: "shell", bash: "shell", zsh: "shell", yml: "yaml", yaml: "yaml", rs: "rust", go: "go", java: "java", kt: "kotlin", swift: "swift",
    rb: "ruby", c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", m: "objective-c", cs: "csharp", php: "php", lua: "lua", sql: "sql",
    xml: "xml", plist: "xml", svg: "xml", toml: "ini", ini: "ini", cfg: "ini", graphql: "graphql", gql: "graphql", dart: "dart", vue: "html",
};
const LANG_NAMES = { dockerfile: "dockerfile", ".bashrc": "shell", ".zshrc": "shell", ".profile": "shell", ".env": "ini" };
function language(file) {
    const base = path.posix.basename(file).toLowerCase();
    return LANG_NAMES[base] || LANGS[path.extname(base).slice(1)] || "plaintext";
}
const isBinary = (buf) => buf.subarray(0, SNIFF).includes(0);
const EMPTY = Buffer.alloc(0);

// One folder for the explorer: folders first, then files, case-insensitive; .git and .DS_Store left out.
const HIDDEN = new Set([".git", ".DS_Store"]), LIST_MAX = 5000;
async function fsList(st, root, dir) {
    root = await projectRoot(st, root);
    dir = relPath(dir);
    const real = await realIn(root, dir);
    const all = (await fsp.readdir(real, { withFileTypes: true })).filter((d) => !HIDDEN.has(d.name));
    const entries = await Promise.all(all.slice(0, LIST_MAX).map(async (d) => {
        const e = { name: d.name, path: dir ? `${dir}/${d.name}` : d.name, type: d.isSymbolicLink() ? "link" : d.isDirectory() ? "dir" : "file", size: 0, ignored: false };
        if (e.type === "dir") return e;
        // A link also says what it points at, so a linked folder can open like any other (reading it is still checked).
        const s = await fsp.stat(path.join(real, d.name)).catch(() => null);
        if (s?.isFile()) e.size = s.size;
        if (e.type === "link") e.target = s ? (s.isDirectory() ? "dir" : "file") : null;
        return e;
    }));
    // Which names git ignores, in one call; outside a repo (or without git) none are.
    if (entries.length) {
        const r = await git(real, ["check-ignore", "--stdin", "-z"], { input: entries.map((e) => `${e.name}${e.type === "dir" ? "/" : ""}\0`).join(""), timeout: 10_000 });
        const ignored = new Set(r.text.split("\0").map((n) => n.replace(/\/$/, "")));
        for (const e of entries) e.ignored = ignored.has(e.name);
    }
    const folder = (e) => (e.type === "dir" || e.target === "dir" ? 0 : 1), low = (e) => e.name.toLowerCase();
    entries.sort((a, b) => folder(a) - folder(b) || (low(a) < low(b) ? -1 : low(a) > low(b) ? 1 : a.name < b.name ? -1 : 1));
    return { ok: true, dir, entries, ...(all.length > LIST_MAX ? { truncated: true } : {}) };
}

// One file for the editor. Over 2 MB or binary comes back without text.
async function fsRead(st, root, rel) {
    root = await projectRoot(st, root);
    rel = relPath(rel);
    if (!rel) throw refuse("Pick a file");
    const real = await realIn(root, rel), s = await fsp.stat(real);
    if (!s.isFile()) throw refuse(s.isDirectory() ? "That is a folder, not a file" : "That is not a regular file");
    const out = { ok: true, path: rel, text: null, size: s.size, mtime: s.mtimeMs, binary: false, tooLarge: s.size > FILE_MAX, language: language(rel) };
    if (!out.tooLarge) {
        const buf = await fsp.readFile(real);
        out.binary = isBinary(buf);
        if (!out.binary) out.text = buf.toString("utf8");
    }
    return out;
}

// A save from the editor. The file must still be as the page read it (same mtime), otherwise nothing is written and the
// page hears of the conflict; mtime null creates a file that does not exist yet. The text goes to a temp file beside it
// that is then renamed over it, so a crash or a full disk never leaves half a file; the original's permissions are kept.
let tmpSeq = 0;
async function fsWrite(st, b) {
    const root = await projectRoot(st, b.root), rel = relPath(b.path);
    if (!rel) throw refuse("Pick a file");
    if (typeof b.text !== "string") throw refuse("Nothing to write");
    const real = await realIn(root, rel);
    let cur = null;
    try { cur = await fsp.stat(real); } catch (e) { if (e.code !== "ENOENT") throw e; }
    if (cur && !cur.isFile()) throw refuse("That is not a regular file");
    if (cur ? cur.mtimeMs !== b.mtime : b.mtime != null) {
        return { ok: false, conflict: true, mtime: cur ? cur.mtimeMs : null, error: cur ? "The file changed on disk since it was opened" : "The file was deleted on disk since it was opened" };
    }
    const dir = path.dirname(real), tmp = path.join(dir, `.${path.basename(real)}.pulse-${process.pid}-${++tmpSeq}.tmp`);
    if (!cur) await fsp.mkdir(dir, { recursive: true });
    try {
        await fsp.writeFile(tmp, b.text, { flag: "wx", mode: cur ? 0o600 : 0o666 });
        if (cur) await fsp.chmod(tmp, cur.mode & 0o7777);
        await fsp.rename(tmp, real);
    } catch (e) {
        await fsp.rm(tmp, { force: true }).catch(() => {});
        throw e;
    }
    return { ok: true, mtime: (await fsp.stat(real)).mtimeMs };
}

// Git, never through a shell: argument lists only, the page's paths after "--" as literal pathspecs (so "[id].tsx" is
// just a name), no credential prompts (a push that wants a password fails instead of hanging), no optional index locks
// (a refresh never fights the user's own git for the index), and a timeout on everything.
function git(cwd, args, { input = "", timeout = 20_000 } = {}) {
    return new Promise((resolve) => {
        const p = execFile("git", args, { cwd, encoding: "buffer", maxBuffer: 32e6, timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" } }, (err, out, stderr) => {
            out = out || EMPTY;
            resolve({ ok: !err, code: err ? err.code : 0, out, text: out.toString("utf8"), stderr: String(stderr || "").trim(), missing: err?.code === "ENOENT", timedOut: !!err?.killed && err.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
        });
        p.stdin?.on("error", () => {});
        p.stdin?.end(input);
    });
}
// Git's own words for a failure. A long hook log is cut from the front: its end says what went wrong.
function why(r) {
    if (r.missing) return "Git is not installed";
    if (r.timedOut) return "Git took too long and was stopped";
    const s = [r.stderr, r.text.trim()].filter(Boolean).join("\n") || `git failed (${r.code})`;
    return s.length > 2000 ? `…${s.slice(-1999)}` : s;
}
// The root's place in its repository ("" at the top, "app/" in a subfolder), or null when it is not in one.
async function repoPrefix(root) {
    const r = await git(root, ["rev-parse", "--is-inside-work-tree", "--show-prefix"]);
    const [inside, prefix = ""] = r.text.split("\n");
    return r.ok && inside === "true" ? prefix : null;
}
async function needRepo(root) {
    const prefix = await repoPrefix(root);
    if (prefix === null) throw refuse("This folder is not a git repository");
    return prefix;
}
// The page's chosen paths as git pathspecs, relative to the root (git runs there). None means everything under the root.
function pathspecs(paths) {
    if (paths == null || (Array.isArray(paths) && !paths.length)) return ["."];
    if (!Array.isArray(paths) || paths.length > 10_000 || !paths.every((p) => typeof p === "string")) throw refuse("Bad list of files");
    return paths.map((p) => { const r = relPath(p); return r ? `:(literal)${r}` : "."; });
}

// `git status --porcelain=v2 --branch -z` as { branch, upstream, ahead, behind, files }. Git names files from the top of
// the repository; they come back relative to the root (prefix is the root's place in the repository).
function parseStatus(out, prefix = "") {
    const res = { branch: "", detached: false, upstream: null, ahead: 0, behind: 0, files: [] }, recs = out.split("\0");
    const rel = (p) => path.posix.relative(`/${prefix}`, `/${p}`);
    // One letter per file, as HEAD compares with the working tree (which is what the diff shows).
    const letter = (xy) => (xy.includes("D") ? "D" : xy[0] === "A" ? "A" : "M");
    let oid = "";
    for (let i = 0; i < recs.length; i++) {
        const r = recs[i], f = r.split(" "), tail = (n) => f.slice(n).join(" ");
        if (r.startsWith("# ")) {
            if (f[1] === "branch.oid") oid = f[2];
            else if (f[1] === "branch.head") { if (tail(2) === "(detached)") res.detached = true; else res.branch = tail(2); }
            else if (f[1] === "branch.upstream") res.upstream = tail(2);
            else if (f[1] === "branch.ab") [res.ahead, res.behind] = [Math.abs(+f[2]) || 0, Math.abs(+f[3]) || 0];
        } else if (r[0] === "1") res.files.push({ path: rel(tail(8)), status: letter(f[1]), staged: f[1][0] !== "." });
        else if (r[0] === "2") res.files.push({ path: rel(tail(9)), status: "R", staged: f[1][0] !== ".", oldPath: rel(recs[++i]) });
        else if (r[0] === "u") res.files.push({ path: rel(tail(10)), status: "U", staged: false });
        else if (r[0] === "?") res.files.push({ path: rel(r.slice(2)), status: "?", staged: false });
    }
    if (res.detached) res.branch = oid.slice(0, 7);
    res.files.sort((a, b) => (a.path < b.path ? -1 : 1));
    return res;
}
async function gitStatus(st, root) {
    root = await projectRoot(st, root);
    const prefix = await repoPrefix(root);
    if (prefix === null) return { ok: true, repo: false, branch: "", upstream: null, ahead: 0, behind: 0, files: [] };
    // "-- ." keeps a root that is a subfolder of its repository to its own files.
    const r = await git(root, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all", "--", "."]);
    if (!r.ok) throw refuse(why(r));
    return { ok: true, repo: true, ...parseStatus(r.text, prefix) };
}

// One file as it is at HEAD and as it is on disk now, for a side-by-side diff. A file that is new since HEAD has before
// "", a deleted one after "". oldPath (optional) is where a renamed file was at HEAD.
async function gitDiff(st, root, rel, oldRel) {
    root = await projectRoot(st, root);
    rel = relPath(rel);
    if (!rel) throw refuse("Pick a file");
    const [head, disk] = await Promise.all([headBlob(root, oldRel ? relPath(oldRel) : rel), diskBlob(await realIn(root, rel, false))]);
    const tooLarge = !!(head.tooLarge || disk.tooLarge), binary = !tooLarge && (isBinary(head.buf) || isBinary(disk.buf));
    const text = (x) => (tooLarge || binary ? null : x.buf.toString("utf8"));
    return { ok: true, path: rel, before: text(head), after: text(disk), binary, tooLarge };
}
async function headBlob(root, rel) {
    // "HEAD:./x" is x relative to the root, wherever the root sits in the repository.
    const spec = `HEAD:./${rel}`, size = await git(root, ["cat-file", "-s", spec]);
    if (!size.ok) return { buf: EMPTY }; // new since HEAD, no commit yet, or no repository
    if (+size.text > FILE_MAX) return { tooLarge: true, buf: EMPTY };
    const r = await git(root, ["cat-file", "blob", spec]);
    return { buf: r.ok ? r.out : EMPTY };
}
async function diskBlob(file) {
    const s = await fsp.lstat(file).catch((e) => { if (e.code === "ENOENT" || e.code === "ENOTDIR") return null; throw e; });
    if (!s) return { buf: EMPTY };
    // Git keeps a symlink as the path it points to, so that is what is compared; a folder (a submodule) has no text.
    if (s.isSymbolicLink()) return { buf: Buffer.from(await fsp.readlink(file)) };
    if (!s.isFile()) return { buf: EMPTY };
    if (s.size > FILE_MAX) return { tooLarge: true, buf: EMPTY };
    return { buf: await fsp.readFile(file) };
}

// A commit message for the chosen changes (or all of them under the root), written by Haiku from the diff against HEAD
// and the new files. With AI summaries off, or if the call fails, a plain "Update 3 files: a, b, c" instead.
const COMMIT_SYSTEM = "You write git commit messages from diffs: conventional, specific and short.";
async function gitMessage(st, b) {
    const root = await projectRoot(st, b.root), prefix = await needRepo(root), specs = pathspecs(b.paths);
    const s = await git(root, ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--", ...specs]);
    const files = s.ok ? parseStatus(s.text, prefix).files : [];
    if (!files.length) throw refuse("There is nothing to commit");
    const fallback = { ok: true, message: plainMessage(files), source: "fallback" };
    if (!st.settings.aiSummaries) return fallback;
    // A first commit has no HEAD, so it is compared with the empty tree.
    const head = await git(root, ["rev-parse", "--verify", "-q", "HEAD"]);
    const base = head.ok ? "HEAD" : (await git(root, ["hash-object", "-t", "tree", "--stdin"])).text.trim();
    const d = await git(root, ["-c", "core.quotepath=off", "diff", "--patch-with-stat", "--no-color", "--no-ext-diff", "--no-textconv", base, "--", ...specs]);
    let notes = cut(d.text.trim(), 12_000);
    const fresh = files.filter((f) => f.status === "?").map((f) => f.path);
    if (fresh.length) notes += `\n\nNew files:\n${await newFiles(root, fresh)}`;
    const reply = await haiku(`Write the git commit message for the change below. First line: a Conventional Commits subject, "type(scope): summary", where type is one of feat, fix, refactor, perf, docs, test, build, ci, chore or style and the scope is optional and short. Imperative mood, specific about what changed, at most 72 characters, no period at the end. If the change needs explaining, add a blank line and a body of at most three short lines wrapped at 72 characters. No markdown, no code fences, no quotes. Reply with the message only.\n\n${notes}`, COMMIT_SYSTEM);
    const message = commitText(reply);
    return message ? { ok: true, message, source: "ai" } : fallback;
}
// New files by name, with the start of a few small ones, so the message can say what they are.
async function newFiles(root, rels) {
    const out = [];
    for (const [i, rel] of rels.slice(0, 40).entries()) {
        let head = "";
        if (i < 5) {
            try {
                const file = await realIn(root, rel), s = await fsp.stat(file);
                const buf = s.isFile() && s.size < 20_000 ? await fsp.readFile(file) : null;
                if (buf && !isBinary(buf)) head = cut(buf.toString("utf8").split("\n").slice(0, 30).join("\n"), 1500);
            } catch {}
        }
        out.push(head ? `${rel}:\n${head}` : rel);
    }
    if (rels.length > 40) out.push(`and ${rels.length - 40} more`);
    return out.join("\n");
}
// Haiku's reply as a clean message: no fences or quotes, and a subject of at most 72 characters.
function commitText(reply) {
    const s = String(reply || "").replace(/^```\w*[ \t]*$/gm, "").trim().replace(/^["'`]+|["'`]+$/g, "").trim();
    const [first = "", ...rest] = s.split("\n");
    let subject = first.replace(/^(subject|commit message):\s*/i, "").trim().replace(/\.$/, "");
    if (subject.length > 72) subject = subject.slice(0, 72).replace(/\s+\S*$/, "");
    const body = rest.join("\n").trim();
    return subject ? (body ? `${subject}\n\n${body}` : subject) : null;
}
function plainMessage(files) {
    const names = files.map((f) => path.posix.basename(f.path));
    if (names.length === 1) return clip(`Update ${names[0]}`, 72);
    return clip(`Update ${names.length} files: ${names.slice(0, 3).join(", ")}${names.length > 3 ? ` and ${names.length - 3} more` : ""}`, 72);
}

// Stage and commit. With no paths at the top of a repository it is a plain commit of everything (which also concludes a
// merge); a chosen set of paths, or a root that is a subfolder, commits only those paths, whatever else is staged.
async function gitCommit(st, b) {
    const root = await projectRoot(st, b.root), prefix = await needRepo(root);
    const message = String(b.message ?? "").replace(/\r\n?/g, "\n").trim();
    if (!message) throw refuse("Write a commit message first");
    const chosen = Array.isArray(b.paths) && b.paths.length > 0, specs = pathspecs(b.paths);
    // A rename already staged with `git mv` leaves its old path in neither the folder nor the index, and `git add` refuses a
    // path it can't find; the commit still records the rename, so such paths are only left out of the add.
    const listed = chosen ? new Set((await git(root, ["ls-files", "-z", "--", ...specs])).text.split("\0")) : null;
    const addable = chosen ? specs.filter((sp) => { const r = sp.replace(/^:\(literal\)/, ""); return fs.existsSync(path.join(root, r)) || listed.has(r); }) : specs;
    const add = addable.length ? await git(root, ["add", "-A", "--", ...addable], { timeout: 60_000 }) : { ok: true };
    if (!add.ok) return { ok: false, error: why(add) };
    // The message goes in on stdin, so its line breaks survive as written. Hooks may run, hence the long timeout.
    const c = await git(root, ["commit", "-F", "-", ...(chosen || prefix ? ["--", ...specs] : [])], { input: message, timeout: 120_000 });
    if (!c.ok) return { ok: false, error: why(c) };
    const sha = (await git(root, ["rev-parse", "--short", "HEAD"])).text.trim();
    const lines = c.text.split("\n").map((l) => l.trim()).filter(Boolean);
    return { ok: true, commit: sha, summary: lines.find((l) => /\bchanged\b/.test(l)) || lines[0] || "" };
}

// Push the current branch; one with no upstream yet is published to origin under its own name.
async function gitPush(st, b) {
    const root = await projectRoot(st, b.root);
    await needRepo(root);
    const up = await git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
    const r = await git(root, up.ok ? ["push"] : ["push", "-u", "origin", "HEAD"], { timeout: 60_000 });
    return r.ok ? { ok: true, output: [r.stderr, r.text.trim()].filter(Boolean).join("\n") } : { ok: false, error: why(r) };
}

// The exact code a chat changed, from its transcripts: every successful Edit, MultiEdit, Write and NotebookEdit, grouped
// by file, oldest first. No agent means the whole chat: the main agent and every subagent that left a transcript.
async function agentChanges(st, sid, agent) {
    const s = st.sessions.get(sid);
    if (!s) throw refuse("That chat is not on the board");
    if (agent && !/^[\w-]{1,80}$/.test(agent)) throw refuse("Unknown agent");
    const sources = [];
    if (!agent || agent === "main") sources.push(["main", s.transcript, true]);
    else sources.push([agent, agentTranscript(s, { id: agent }), false]);
    if (!agent && s.transcript) {
        const dir = path.join(s.transcript.replace(/\.jsonl$/, ""), "subagents");
        for (const name of await fsp.readdir(dir).catch(() => [])) {
            const m = /^agent-([\w-]+)\.jsonl$/.exec(name);
            if (m) sources.push([m[1], path.join(dir, name), false]);
        }
    }
    const files = new Map();
    let truncated = false;
    for (const [id, file, main] of sources) {
        await new Promise(setImmediate); // a first read can be large: let other requests through between files
        const c = loadTranscript(file, main);
        if (!c) continue;
        truncated ||= c.early;
        for (const e of c.edits) {
            if (!e.ok) continue;
            const abs = path.resolve(s.cwd || "/", e.file);
            if (!files.has(abs)) files.set(abs, { path: abs, rel: s.cwd && abs !== s.cwd && within(s.cwd, abs) ? path.relative(s.cwd, abs) : null, edits: [] });
            files.get(abs).edits.push({ t: e.t, agent: id, tool: e.tool, kind: e.kind, before: e.before, after: e.after });
        }
    }
    const list = [...files.values()];
    for (const f of list) f.edits.sort((a, b) => a.t - b.t);
    list.sort((a, b) => a.edits[0].t - b.edits[0].t);
    return { ok: true, files: list, truncated };
}

// ---- Welcome: the crew greets the user when the page opens. A template, so it is instant and costs nothing. ----
function welcomeText(st, now = Date.now(), rand = Math.random) {
    const pick = (xs) => xs[Math.floor(rand() * xs.length)];
    const h = new Date(now).getHours();
    const tail = callTail(st), greet = h >= 5 && h < 12 ? `Good morning${tail}.` : h >= 12 && h < 17 ? `Good afternoon${tail}.` : `Good evening${tail}.`;
    const hello = pick(["Welcome to the command center.", "Welcome back to the command center.", "The command center is at your service."]);
    let working = 0, waiting = 0;
    const where = new Map(); // folder -> project name
    for (const s of st.sessions.values()) {
        if (s.ended || isEmpty(s)) continue;
        for (const a of s.agents.values()) {
            if (a.status === "working") working++;
            else if (a.status === "needs-you") waiting++;
            else continue;
            where.set(s.cwd, project(s));
        }
    }
    const place = where.size === 1 ? `in ${[...where.values()][0]}` : `across ${count(where.size)} projects`;
    const agents = (n) => `${count(n)} agent${n === 1 ? " is" : "s are"}`.replace(/^./, (c) => c.toUpperCase());
    let line;
    if (!working && !waiting) line = pick(["All quiet; your crew is standing by.", "All quiet for now; the crew is ready when you are.", "No agents are at work just now; the crew is standing by."]);
    else if (!working) line = `${agents(waiting)} waiting for you ${place}.`;
    else line = `${agents(working)} ${pick(["at work", "on duty", "busy"])} ${place}${waiting ? `, and ${count(waiting)} ${waiting === 1 ? "is" : "are"} waiting for you` : ""}.`;
    return `${greet} ${hello} ${line}`;
}

// A POST must say it is JSON. Browsers cannot send that cross-site without a preflight this server never answers, so
// together with the Origin check no other website can post a form here.
const isJson = (type) => /^application\/json\s*(;|$)/i.test(String(type || ""));

// ---- Voice: Kokoro-82M (open source, runs locally) renders wavs; the page plays them. ----
// A failed render (the worker died, hung or reported an error) restarts the worker and tries once more, so the page only
// ever uses the system voice when Kokoro is not installed. Failures are logged (the log is ~/.pulse/pulse.log).
// cmd overrides the worker command, for the selftest.
function createVoice(cmd) {
    const py = path.join(HOME, "venv", "bin", "python");
    if (cmd === undefined) cmd = fs.existsSync(py) && fs.existsSync(path.join(HOME, "models", "voices-v1.0.bin")) ? [py, path.join(__dirname, "speak.py")] : null;
    const kokoro = !!cmd, health = { ready: false, model: "", failures: 0, lastError: "", lastErrorAt: 0 };
    let worker = null, job = null, jobs = 0;
    // Stopping on purpose (the page switched its voice off) ends the line in progress quietly, with no retry.
    const stop = () => {
        const w = worker;
        worker = null;
        health.ready = false;
        if (w && job?.worker === w) job.done("stopped");
        w?.kill();
    };
    process.on("exit", stop);
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => process.exit(0));
    const start = () => {
        if (worker) return worker;
        const w = (worker = spawn(cmd[0], cmd.slice(1), { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, PULSE_HOME: HOME } }));
        // Each worker settles only its own line: one being replaced must not fail the line its successor is rendering.
        readline.createInterface({ input: w.stdout }).on("line", (l) => {
            if (l.startsWith("ready")) Object.assign(health, { ready: worker === w, model: l.slice(6) });
            else if (job?.worker === w && l.startsWith("ok ")) job.done(l.slice(3) === job.file ? null : "wrong file");
            else if (job?.worker === w && l.startsWith("err")) job.done(l.slice(4) || "render error");
        });
        w.on("error", (e) => { if (job?.worker === w) job.done(e.message); });
        w.stdin.on("error", () => {});
        w.on("exit", (code, sig) => {
            if (worker === w) { worker = null; health.ready = false; }
            if (job?.worker === w) job.done(`worker exited (${sig || code})`);
        });
        return w;
    };
    // One attempt: a wav Buffer, or why it failed.
    const once = (text, voice, speed) => new Promise((resolve) => {
        const w = start(), file = path.join(os.tmpdir(), `pulse-${process.pid}-${++jobs}.wav`);
        const timer = setTimeout(() => { if (job === mine) { mine.done("timed out"); if (worker === w) stop(); else w.kill(); } }, 30_000);
        const mine = (job = {
            worker: w, file,
            done(err) {
                if (job !== mine) return;
                job = null;
                clearTimeout(timer);
                let buf = null;
                if (!err) try { buf = fs.readFileSync(file); } catch (e) { err = `no wav (${e.code})`; }
                fs.rm(file, { force: true }, () => {});
                resolve(buf || String(err));
            },
        });
        w.stdin.write(JSON.stringify({ text: text.replace(/[_/\\`*#<>|{}[\]]/g, " "), out: file, voice, speed }) + "\n");
    });
    return {
        engine: kokoro ? "kokoro" : "browser",
        stop,
        // Load the model as soon as a page turns its voice on, so the first line does not wait for it.
        warm() { if (kokoro) start(); },
        detail: () => ({ name: kokoro ? "kokoro" : "browser", ...health }),
        // Resolves to a wav Buffer, or null: Kokoro is not installed, the voice was stopped, or both tries failed.
        async render(text, voice, speed) {
            if (!kokoro) return null;
            for (let attempt = 1; attempt <= 2; attempt++) {
                const r = await once(text, voice, speed);
                if (Buffer.isBuffer(r)) return r;
                if (r === "stopped") return null;
                Object.assign(health, { failures: health.failures + 1, lastError: r, lastErrorAt: Date.now() });
                console.error(`${new Date().toISOString()} voice: Kokoro render failed (${r}), ${attempt === 1 ? "restarting the worker and trying again" : "giving up on this line"}: "${clip(text, 80)}"`);
                stop();
            }
            return null;
        },
    };
}

// --demo: a simulated fleet (three projects, subagents spawning, working, finishing) for showing the dashboard off.
function demo(st, flush) {
    // Four chats in three folders: two VS Code chats on orbit-web show up under one project root.
    const projects = ["orbit-web", "lumen-docs", "harbor-api", "orbit-web"].map((p, i) => ({ id: `demo-${i}`, cwd: `${os.homedir()}/code/${p}` }));
    const prompts = ["Fix the cart total rounding bug and add tests", "Rewrite the getting started guide", "Add rate limiting to the public API", "Review the checkout form for accessibility"];
    const jobs = [["Explore", "Find the cart totals logic"], ["Explore", "Map the checkout state"], ["general-purpose", "Fix the flaky payment test"], ["Plan", "Plan the orders table migration"], ["code-reviewer", "Review the docs navigation diff"], ["Explore", "Trace the rate limit middleware"], ["general-purpose", "Write rate limiter tests"]];
    const tools = [["Read", { file_path: "src/app.tsx" }], ["Grep", { pattern: "useAuth" }], ["Edit", { file_path: "src/store/index.ts" }], ["Bash", { description: "Run test suite" }], ["Glob", { pattern: "src/**/*.test.ts" }], ["Read", { file_path: "src/cart/totals.ts" }], ["Edit", { file_path: "src/checkout/form.tsx" }], ["Bash", { description: "Build production bundle" }]];
    const pick = (xs) => xs[Math.floor(Math.random() * xs.length)];
    // Same path as a real hook, so Stop from the page works here too.
    const ev = (s, p) => {
        handleHook(st, { session_id: s.id, cwd: s.cwd, ...p });
        flush();
        const a = st.sessions.get(s.id)?.agents.get(p.agent_id || "main");
        if (p.hook_event_name !== "PreToolUse" || !a || !a.kill || a.winding) return;
        // A refused tool call: the simulated agent reports and stops, like a real one would.
        a.winding = true;
        setTimeout(() => { delete a.winding; ev(s, a.id === "main" ? { hook_event_name: "Stop" } : { hook_event_name: "SubagentStop", agent_id: a.id, agent_type: a.type }); }, 1500);
    };
    let seq = 0;
    projects.forEach((s, i) => {
        ev(s, { hook_event_name: "UserPromptSubmit", prompt: prompts[i] });
        // Start each project with a couple of subagents so the demo has something to show right away.
        for (const [type, description] of [jobs[(i * 2) % jobs.length], jobs[(i * 2 + 1) % jobs.length]]) {
            ev(s, { hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { subagent_type: type, description } });
            ev(s, { hook_event_name: "SubagentStart", agent_id: `d${++seq}`, agent_type: type });
        }
    });
    setInterval(() => {
        const s = pick(projects);
        const live = [...(st.sessions.get(s.id)?.agents.values() || [])].filter((a) => a.id !== "main" && a.status === "working");
        // A stopped chat stays stopped: its subagents wind down and nothing new starts.
        if (st.sessions.get(s.id)?.agents.get("main")?.status !== "working") {
            for (const a of live) ev(s, { hook_event_name: "SubagentStop", agent_id: a.id, agent_type: a.type });
            return;
        }
        const r = Math.random();
        if (r < 0.14 && live.length < 3) {
            const [type, description] = pick(jobs);
            ev(s, { hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { subagent_type: type, description } });
            setTimeout(() => ev(s, { hook_event_name: "SubagentStart", agent_id: `d${++seq}`, agent_type: type }), 400);
        } else if (r < 0.19 && live.length) {
            const a = pick(live);
            ev(s, { hook_event_name: "SubagentStop", agent_id: a.id, agent_type: a.type });
        } else {
            const a = live.length && Math.random() < 0.75 ? pick(live) : null;
            const [tool_name, tool_input] = pick(tools);
            ev(s, { hook_event_name: "PreToolUse", tool_name, tool_input, ...(a ? { agent_id: a.id, agent_type: a.type } : {}) });
        }
    }, 1600);
}

// The board survives restarts: saved to ~/.pulse/state.json every 30 s and on shutdown, reloaded on start if recent.
const STATE_FILE = path.join(HOME, DEMO ? "state.demo.json" : "state.json");
function saveState(st, file = STATE_FILE) {
    const sessions = [...st.sessions.values()].map((s) => ({ ...s, agents: [...s.agents.values()].map((a) => ({ ...a, read: [...a.read], edited: [...a.edited] })) }));
    try { fs.writeFileSync(file, JSON.stringify({ savedAt: Date.now(), seq: st.seq, comms: st.comms.slice(-100), sessions, workspaces: [...st.workspaces] })); } catch {}
}
function loadState(st, file = STATE_FILE) {
    try {
        const j = JSON.parse(fs.readFileSync(file, "utf8"));
        // Folders the user opened stay opened however long Pulse was off; the board itself only if it is recent.
        for (const w of j.workspaces || []) if (typeof w === "string" && path.isAbsolute(w)) st.workspaces.add(w);
        if (Date.now() - j.savedAt > 3 * 3600_000) return;
        st.seq = j.seq || 0;
        st.comms = j.comms || [];
        for (const s of j.sessions || []) {
            const agents = new Map();
            // Boards saved before messaging was dropped still carry its fields; they are left behind here.
            for (const { inbox, sent, undelivered, wrapUp, ...a } of s.agents) agents.set(a.id, { history: [], ticks: [], ...a, read: new Set(a.read), edited: new Set(a.edited) });
            st.sessions.set(s.id, { ...s, agents });
        }
    } catch {}
}

function loadSettings() {
    try {
        const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
        const { announce, ...rest } = saved; // "Speak when" switches from before the verbosity levels
        return { ...DEFAULTS, ...rest, voice: voiceOf(rest.voice ?? DEFAULTS.voice) };
    } catch {
        return { ...DEFAULTS, ...(DEMO ? { aiSummaries: false } : {}) };
    }
}

// Accept only known keys and values from the page.
function mergeSettings(cur, patch) {
    const next = { ...cur };
    if (INTERVALS.includes(patch.intervalMin)) next.intervalMin = patch.intervalMin;
    if (VOICES.includes(patch.voice)) next.voice = patch.voice;
    if (typeof patch.speed === "number" && patch.speed >= 0.8 && patch.speed <= 1.3) next.speed = Math.round(patch.speed * 100) / 100;
    if (typeof patch.aiSummaries === "boolean") next.aiSummaries = patch.aiSummaries;
    if (typeof patch.address === "string") next.address = cleanAddress(patch.address);
    if (typeof patch.greeting === "boolean") next.greeting = patch.greeting;
    if (typeof patch.welcomeSpoken === "boolean") next.welcomeSpoken = patch.welcomeSpoken;
    if (VERBOSITY.includes(patch.verbosity)) next.verbosity = patch.verbosity;
    if (typeof patch.earcons === "boolean") next.earcons = patch.earcons;
    return next;
}

// ---- What the voice says. Queued events (st.out) become lines once due. Each line leads with who ("Atlas: done. Map the
// voice pipeline."), the phrase bank keeps the wording from repeating, and the verbosity level decides what is said at all. ----
const quietMode = (st) => st.settings.verbosity === "quiet";
const whoOf = (st, s, a) => a.call || `Agent ${a.n}`;
const working = (a) => a && (a.status === "working" || a.status === "needs-you");
// Several projects busy at once: a line about your own chat says which one it is.
function leadFor(st, s, now = Date.now()) {
    const busy = new Set();
    for (const x of st.sessions.values()) if (!x.ended && !isEmpty(x) && now - x.lastAt < 10 * 60_000) busy.add(x.cwd);
    return busy.size > 1 ? chatName(st, s, true) : "";
}
const line = (kind, l) => ({ kind, text: l.text, cue: l.earcon });
const said = (sid, kind, l) => ({ ...line(kind, l), sid }); // a line tagged with its chat, so the page keeps a chat's lines in order
const MAIN_KIND = { done: "mainDone", failed: "mainFailed", blocked: "mainBlocked", needs: "mainNeeds", stopped: "mainDone" };

// The lines for a batch of due events, in order, plus the turn ends (turnLine) to settle after them.
function voiceLines(st, ready, mem, now = Date.now(), rand = Math.random) {
    const lines = [], finishes = [], turns = [];
    const addr = st.settings.address;
    for (const it of ready) {
        if (it.text) { lines.push({ kind: it.kind, text: it.text, cue: it.cue || null }); continue; } // ready-made: briefings, notes
        const s = st.sessions.get(it.sid);
        if (!s) continue;
        if (it.kind === "turn") { turns.push([s, it]); continue; }
        const a = s.agents.get(it.aid);
        if (it.kind === "dispatch") {
            const crew = it.aids.map((id) => s.agents.get(id)).filter(Boolean);
            if (s.muted || quietMode(st) || !crew.length) continue;
            lines.push(said(s.id, "dispatch", crew.length === 1 ? L.say("joinOne", { who: whoOf(st, s, crew[0]), job: L.tidyTask(crew[0].task) }, mem, rand) : L.say("joinMany", { names: crew.map((x) => whoOf(st, s, x)) }, mem, rand)));
        } else if (it.kind === "finish" && a) {
            const f = finishOf(it.transcript || agentTranscript(s, a));
            noteFinish(a, f);
            const outcome = it.stopped ? "stopped" : f?.outcome || "done";
            a.outcome = outcome;
            // A lone helper's good news is left to your chat's own finish line, which follows; bad news is said at once.
            const alone = (s.crew || []).length < 2;
            if (s.muted || (outcome === "done" && alone) || (quietMode(st) && !BAD_OUTCOME.has(outcome))) continue;
            finishes.push({ who: whoOf(st, s, a), task: f?.task || "", job: f?.task ? "" : L.tidyTask(a.task), outcome, sid: s.id });
        } else if (it.kind === "needs" && a) {
            if (s.muted || a.status !== "needs-you") continue;
            const perm = permissionOf(a), main = a.id === "main";
            lines.push(said(s.id, "needs", perm ? L.say(main ? "mainPermission" : "permission", { who: whoOf(st, s, a), job: perm, lead: main ? leadFor(st, s, now) : "" }, mem, rand) : L.say(main ? "mainNeeds" : "needs", { who: whoOf(st, s, a), lead: main ? leadFor(st, s, now) : "" }, mem, rand)));
        }
    }
    // Several finishing together are one line, so a burst never turns into a speech.
    if (finishes.length >= 3) lines.push(said(finishes[0].sid, finishes.some((f) => BAD_OUTCOME.has(f.outcome)) ? "failed" : "done", L.batch(finishes)));
    else for (const f of finishes) lines.push(said(f.sid, KIND_OF[f.outcome], L.say(f.outcome, { who: f.who, task: f.task, job: f.job }, mem, rand)));
    return { lines, turns };
}

// Your chat's turn ended. With helpers still out: nothing yet, the line comes when they are back. With a crew of two or
// more: one wrap-up of the task and how everyone did, from the phrase bank. Otherwise:
// its own finish, in the first person. Null: say nothing.
async function turnLine(st, s, it, mem, rand = Math.random) {
    const m = s.agents.get(it.aid);
    if (!m) return null;
    const f = finishOf(it.transcript || s.transcript);
    noteFinish(m, f);
    const crew = (s.crew || []).map((id) => s.agents.get(id)).filter(Boolean);
    if (crew.some(working)) return null;
    s.crew = [];
    const outcome = f?.outcome || "done", task = f?.task || "", lead = leadFor(st, s), addr = st.settings.address;
    if (s.muted) return null;
    if (crew.length >= 2) {
        const results = crew.map((a) => ({ who: whoOf(st, s, a), type: short(a.type), outcome: a.outcome || "done", task: a.said || "" }));
        const bad = results.some((r) => r.outcome === "failed" || r.outcome === "blocked") || outcome === "failed" || outcome === "blocked";
        const l = L.wrap(results, { task, lead }, mem, rand);
        const ask = outcome === "needs" && !bad;
        return { kind: bad ? "failed" : ask ? "needs" : "wrap", text: l.text, cue: bad ? "fail" : ask ? "ask" : "wrap" };
    }
    // A turn Claude Code started itself (a background task reporting in) with no helper coming back has nothing new to say.
    if (it.harness && !crew.length) return null;
    if (quietMode(st) && !BAD_OUTCOME.has(outcome) && !it.long) return null;
    return line(KIND_OF[outcome], L.say(MAIN_KIND[outcome], { task, lead, addr }, mem, rand));
}

function start() {
    const st = { sessions: new Map(), workspaces: new Set(), comms: [], out: [], seq: 0, settings: loadSettings(), limits: loadLimits() };
    if (DEMO) st.limits = { at: Date.now(), five: { pct: 42, resetsAt: Date.now() + 2.2 * 3600_000 }, week: { pct: 18, resetsAt: Date.now() + 3.4 * 86400_000 } };
    if (!DEMO) {
        loadState(st);
        process.on("exit", () => saveState(st));
        setInterval(() => saveState(st), 30_000);
    }
    if (process.env.PULSE_REPORT_MIN) st.settings.intervalMin = +process.env.PULSE_REPORT_MIN;
    const voice = createVoice();
    voice.warm(); // load the model now, so the welcome is not waiting on it when the page opens
    const clients = new Map(); // client id -> response
    const audio = new Map(); // audio id -> wav Buffer (last few only)
    let speaker = null, nextReportAt = 0, reportTimer = null, cid = 0, aid = 0, queued = null;

    const send = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const extra = () => ({ speaker, engine: voice.engine, voiceEngine: voice.detail(), voices: VOICES, intervals: INTERVALS, nextReportAt, demo: DEMO, limits: st.limits });
    const push = () => {
        if (queued) return;
        queued = setTimeout(() => {
            queued = null;
            const snap = snapshot(st, extra());
            for (const res of clients.values()) send(res, "snapshot", snap);
        }, 150);
    };

    // Speak to one tab: the voice owner, or whoever asked for a preview. `cue` is the line's earcon and `kind` sets its
    // urgency: the page plays an urgent line before any less urgent one still waiting, and drops a stale start or dispatch.
    let speakChain = Promise.resolve();
    function speak(text, to = null, { cue = null, kind = "note", t = Date.now(), sid = null } = {}) {
        speakChain = speakChain.then(async () => {
            const target = to || speaker;
            if (!target || !clients.has(target)) return;
            const wav = await voice.render(text, st.settings.voice, st.settings.speed);
            const res = clients.get(target);
            // Gone, or switched its voice off while this line was rendering.
            if (!res || (!to && speaker !== target)) return;
            // With Kokoro installed the page never falls back to the system voice: a line that failed twice (logged)
            // is left unspoken, and still shows in the feed.
            if (!wav && voice.engine === "kokoro") return;
            let url = null;
            if (wav) {
                const id = String(++aid);
                audio.set(id, wav);
                for (const k of audio.keys()) if (audio.size > 30) audio.delete(k); // lines queued while audio was blocked still find their clip
                url = `/audio/${id}`;
            }
            send(res, "speak", { text, url, rate: st.settings.speed, cue: st.settings.earcons ? cue : null, pri: PRI[kind] || 1, kind, t, sid });
        });
    }

    function announce(kind, text, cue = null, sid = null) {
        const t = Date.now();
        st.comms.push({ t, kind, text, cue });
        if (st.comms.length > 200) st.comms.splice(0, st.comms.length - 200);
        push();
        speak(text, null, { cue, kind, t, sid });
    }

    // Queued events become spoken lines once due (see voiceLines); a turn's line may wait on the wrap-up call.
    const mem = L.memory();
    let drainTimer = null;
    function drain() {
        const now = Date.now(), ready = [];
        for (const it of st.out.splice(0)) (it.due > now ? st.out : ready).push(it);
        // Finishes a moment apart are said together: one that is nearly due joins the one that is.
        if (ready.some((x) => x.kind === "finish")) {
            for (let i = st.out.length - 1; i >= 0; i--) if (st.out[i].kind === "finish" && st.out[i].due - now < FINISH_WAIT_MS) ready.push(...st.out.splice(i, 1));
            ready.sort((x, y) => (x.at || 0) - (y.at || 0));
        }
        clearTimeout(drainTimer);
        if (st.out.length) drainTimer = setTimeout(flush, Math.max(50, Math.min(...st.out.map((x) => x.due || now)) - now));
        // A mistake in what to say must never take the dashboard down with it: logged, and that batch is skipped.
        try {
            const { lines, turns } = voiceLines(st, ready, mem, now);
            for (const l of lines) announce(l.kind, l.text, l.cue, l.sid);
            for (const [s, it] of turns) turnLine(st, s, it, mem).then((l) => l && announce(l.kind, l.text, l.cue, s.id), (e) => console.error("Pulse voice:", e));
        } catch (e) { console.error("Pulse voice:", e); }
    }
    const flush = () => { push(); if (st.out.length) drain(); };
    let lastReportAt = 0;
    async function report(force = false) {
        const ctx = statusContext(st);
        if (!ctx) return false;
        // Nothing new since the last report: stay silent and spend nothing.
        const changed = [...st.sessions.values()].some((s) => s.lastAt > lastReportAt);
        if (!changed && !force) return true;
        lastReportAt = Date.now();
        const ai = st.settings.aiSummaries ? await summarizeStatus(ctx) : null;
        if (ai?.agents) {
            for (const [key, text] of Object.entries(ai.agents)) {
                const [sid, agentId] = key.split("|");
                const a = st.sessions.get(sid)?.agents.get(agentId);
                if (a && typeof text === "string") a.summary = clip(text, 90);
            }
        }
        announce("status", typeof ai?.spoken === "string" && ai.spoken.trim() ? clip(ai.spoken, 400) : ctx.fallback);
        return true;
    }
    function schedule() {
        clearTimeout(reportTimer);
        const min = st.settings.verbosity === "verbose" ? st.settings.intervalMin : 0; // timed briefings are Verbose only
        nextReportAt = min ? Date.now() + min * 60_000 : 0;
        if (min) reportTimer = setTimeout(() => { report(); schedule(); }, min * 60_000);
        push();
    }
    schedule();
    setInterval(() => { prune(st); push(); }, 30_000);
    setInterval(() => {
        settleInterrupted(st); escalate(st);
        for (const s of st.sessions.values()) for (const a of s.agents.values()) if ((a.status === "idle" || a.status === "done") && !a.summary) readSummary(s, a);
        flush();
    }, 10_000);
    if (DEMO) {
        demo(st, flush);
        // The demo is for showing off, not for leaving on: it closes itself once no page has watched it for 5 minutes.
        let watchedAt = Date.now();
        setInterval(() => {
            if (clients.size) watchedAt = Date.now();
            else if (Date.now() - watchedAt > 5 * 60_000) { console.log("Demo closed: no page open for 5 minutes."); process.exit(0); }
        }, 30_000);
    }

    const readBody = (req, cb) => {
        let body = "", size = 0;
        req.setEncoding("utf8");
        req.on("data", (c) => { size += c.length; if (size <= MAX_BODY) body += c; });
        req.on("end", () => { try { cb(JSON.parse(body || "{}")); } catch { cb(null); } });
    };
    const json = (res, data) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    const findAgent = (b) => st.sessions.get(b?.session)?.agents.get(b?.agent);
    // Workspace calls are async (git, files); a refusal or a failure comes back as { ok:false, error } like any answer.
    const answer = (res, work) => Promise.resolve().then(work).then((d) => json(res, d), (e) => json(res, failure(e)));

    // Code changes take effect by themselves. Quitting the app never stops the server (hooks report to it), so without this
    // an old server keeps serving old code: open pages reload when a page file changes, and the server hands over to a
    // fresh copy of itself when server.js changes, but only once the new code parses (a half-saved file changes nothing).
    const startedAt = Date.now();
    let reloadTimer = null, restartTimer = null;
    const watch = (file, fn) => fs.watchFile(file, { interval: 1000 }, (cur, prev) => { if (cur.mtimeMs !== prev.mtimeMs) fn(); });
    for (const f of ["index.html", "terminal.js", "terminal.css", "workspace.js", "workspace.css", "intro.js", "intro.css"]) {
        watch(path.join(__dirname, f), () => { clearTimeout(reloadTimer); reloadTimer = setTimeout(() => { for (const res of clients.values()) send(res, "reload", {}); }, 800); });
    }
    const restart = () => {
        for (const f of [__filename, LINES_FILE]) execFileSync(process.execPath, ["--check", f], { stdio: "ignore", env: process.env, timeout: 10_000 }); // throws if it doesn't parse
        console.log("server.js changed: handing over to the new code");
        const log = fs.openSync(path.join(HOME, "pulse.log"), "a");
        spawn(process.execPath, process.argv.slice(1), { detached: true, stdio: ["ignore", log, log], env: { ...process.env, PULSE_HANDOVER: "1" } }).unref();
        process.exit(0); // saves the board; the new server picks it up and waits for the port
    };
    if (!DEMO) for (const f of [__filename, LINES_FILE]) watch(f, () => { clearTimeout(restartTimer); restartTimer = setTimeout(() => { try { restart(); } catch { console.error("server.js changed but does not parse: still running the old code"); } }, 1500); });
    let handoverTries = 0;

    const HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
    const server = http.createServer((req, res) => {
        // Only this machine's own pages: blocks DNS rebinding (Host) and other websites posting here (Origin).
        const origin = req.headers.origin;
        if (!HOSTS.has(req.headers.host) || (origin && !HOSTS.has(origin.replace(/^https?:\/\//, "")))) return res.writeHead(403).end();
        const url = new URL(req.url, "http://x");
        if (req.method === "POST") {
            if (!isJson(req.headers["content-type"])) {
                res.writeHead(415, { "content-type": "application/json" });
                return res.end(JSON.stringify({ ok: false, error: "Send JSON (content-type: application/json)" }));
            }
            return readBody(req, (b) => {
                switch (url.pathname) {
                    case "/hook": {
                        // Every Claude Code hook lands here: record the event, answer with a decision if one is pending.
                        if (!b) return res.end("");
                        if (req.headers["x-pulse-project"]) b.project_dir = String(req.headers["x-pulse-project"]);
                        if (req.headers["x-pulse-term"]) b.term_id = String(req.headers["x-pulse-term"]).slice(0, 128);
                        const d = handleHook(st, b);
                        if (b.hook_event_name === "PreToolUse") refreshNote(st, b);
                        flush();
                        // Ask each new chat and subagent to end its last message with the marker line Pulse reads back.
                        if (!d && (b.hook_event_name === "SessionStart" || b.hook_event_name === "SubagentStart")) return json(res, { hookSpecificOutput: { hookEventName: b.hook_event_name, additionalContext: PULSE_RULE } });
                        return d ? json(res, d) : res.end("");
                    }
                    case "/limits": {
                        // From scripts/pulse-statusline.sh: the status line's JSON in, the line to print back out.
                        const l = parseLimits(b);
                        if (l) {
                            const was = JSON.stringify([st.limits?.five, st.limits?.week]);
                            st.limits = l;
                            if (JSON.stringify([l.five, l.week]) !== was) {
                                if (!DEMO) fs.writeFile(LIMITS_FILE, JSON.stringify(l), () => {});
                                push();
                            }
                        }
                        return json(res, { line: [clip(String(b?.model?.display_name || ""), 40), limitsLine(st.limits)].filter(Boolean).join(" · ") });
                    }
                    case "/kill": {
                        const a = findAgent(b);
                        if (a && (a.status === "working" || a.status === "needs-you")) {
                            a.kill = !a.kill;
                            if (a.kill) announce("note", `Stopping ${callsign(a)} now.`);
                        }
                        push();
                        return json(res, { ok: !!a });
                    }
                    case "/shutdown":
                        // The app replaces a stale server with the current one. The board is saved on exit.
                        json(res, { ok: true });
                        return setTimeout(() => process.exit(0), 100);
                    case "/mute": {
                        const s = st.sessions.get(b?.session);
                        if (s) s.muted = !s.muted;
                        push();
                        return json(res, { muted: s?.muted });
                    }
                    case "/speaker":
                        speaker = b?.id && clients.has(b.id) ? b.id : null;
                        if (speaker) voice.warm();
                        else voice.stop();
                        push();
                        return json(res, { speaker });
                    case "/settings": {
                        const before = `${st.settings.intervalMin}|${st.settings.verbosity}`;
                        st.settings = mergeSettings(st.settings, b || {});
                        fs.writeFile(SETTINGS_FILE, JSON.stringify(st.settings, null, 2), () => {});
                        if (`${st.settings.intervalMin}|${st.settings.verbosity}` !== before) schedule();
                        push();
                        return json(res, st.settings);
                    }
                    case "/replay": {
                        const c = st.comms.find((x) => x.t === b?.t);
                        if (c && b.id) speak(c.text, b.id, { cue: c.cue, kind: c.kind });
                        return json(res, { ok: !!c });
                    }
                    case "/preview":
                        if (b?.id) speak(`Atlas has finished the voice template count. That's the login fix done${callTail(st)}.`, b.id, { cue: "done", kind: "done" });
                        return json(res, { ok: true });
                    case "/client-log":
                        // Errors from the page (see the reporter at the top of index.html), into this log.
                        console.error(`Page${b?.app ? " (app)" : ""}: ${clip(String(b?.msg ?? ""), 2000)}`);
                        return json(res, { ok: true });
                    case "/report":
                        json(res, { ok: true });
                        report(true).then((said) => { if (!said) announce("status", `All quiet${callTail(st)}. No agents are working right now.`); });
                        return;
                    case "/welcome": {
                        // Spoken to the page that just opened, not to the feed.
                        const text = welcomeText(st);
                        if (!b?.id || !clients.has(b.id)) return json(res, { ok: false, error: "Unknown page", text });
                        if (st.settings.welcomeSpoken) speak(text, b.id);
                        return json(res, { ok: true, text });
                    }
                    case "/workspace/open":
                        return answer(res, async () => {
                            const d = await openWorkspace(st, b?.root);
                            if (!DEMO) saveState(st);
                            push();
                            return d;
                        });
                    case "/fs/write": return answer(res, () => fsWrite(st, b || {}));
                    case "/git/message": return answer(res, () => gitMessage(st, b || {}));
                    case "/git/commit": return answer(res, () => gitCommit(st, b || {}));
                    case "/git/push": return answer(res, () => gitPush(st, b || {}));
                }
                res.writeHead(404).end();
            });
        }
        if (url.pathname === "/stream") {
            const id = `c${++cid}`;
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
            clients.set(id, res);
            send(res, "hello", { id });
            send(res, "snapshot", snapshot(st, extra()));
            req.on("close", () => {
                clients.delete(id);
                if (speaker === id) { speaker = null; voice.stop(); push(); } // page closed: voice stops with it
            });
            return;
        }
        if (url.pathname.startsWith("/audio/")) {
            const wav = audio.get(url.pathname.slice(7));
            if (!wav) return res.writeHead(404).end();
            res.writeHead(200, { "content-type": "audio/wav", "content-length": wav.length });
            return res.end(wav);
        }
        if (url.pathname === "/health") return res.end("pulse");
        // Which server.js is answering, so the app can replace a stale copy (e.g. one bundled in an older Pulse.app).
        if (url.pathname === "/version") return json(res, { file: __filename, startedAt });
        if (url.pathname === "/transcript") {
            // Read fresh on each request: the page polls while a chat is open, and the file is the source of truth.
            const s = st.sessions.get(url.searchParams.get("session")), a = s?.agents.get(url.searchParams.get("agent") || "main");
            const r = a && readTranscript(agentTranscript(s, a), a.id === "main");
            return json(res, r ? { ok: true, ...r } : { ok: false, entries: [], truncated: false });
        }
        if (url.pathname === "/usage") {
            const s = st.sessions.get(url.searchParams.get("session")), a = s?.agents.get(url.searchParams.get("agent") || "main");
            return json(res, a ? burnFor(s, a) : { ok: false });
        }
        const q = url.searchParams;
        switch (url.pathname) {
            case "/fs/list": return answer(res, () => fsList(st, q.get("root"), q.get("dir")));
            case "/fs/read": return answer(res, () => fsRead(st, q.get("root"), q.get("path")));
            case "/git/status": return answer(res, () => gitStatus(st, q.get("root")));
            case "/git/diff": return answer(res, () => gitDiff(st, q.get("root"), q.get("path"), q.get("oldPath")));
            case "/agent/changes": return answer(res, () => agentChanges(st, q.get("session"), q.get("agent")));
        }
        if (url.pathname === "/") {
            res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
            try { return res.end(fs.readFileSync(path.join(__dirname, "index.html"))); } catch { return res.end("Pulse is updating. This page reloads in a moment.<script>setTimeout(() => location.reload(), 1500)</script>"); }
        }
        const file = staticFile(__dirname, url.pathname);
        if (file) {
            res.writeHead(200, { "content-type": file.type, "cache-control": "no-store" });
            return res.end(file.body);
        }
        res.writeHead(404).end();
    })
        .on("error", (e) => {
            // A handover: the old server is still letting go of the port.
            if (e.code === "EADDRINUSE" && process.env.PULSE_HANDOVER && handoverTries++ < 40) return setTimeout(() => server.listen(PORT, "127.0.0.1"), 250);
            console.error(e.code === "EADDRINUSE" ? `Port ${PORT} busy (Pulse already running?)` : e.message);
            process.exit(1);
        })
        .listen(PORT, "127.0.0.1", () => console.log(`Pulse on http://127.0.0.1:${PORT} (voice: ${voice.engine}${DEMO ? ", demo" : ""})`));
}

async function selftest() {
    const st = { sessions: new Map(), comms: [], out: [], seq: 0, settings: loadSettings() };
    st.settings = { ...DEFAULTS, aiSummaries: false }; // the self-test never calls a model
    const S = { session_id: "s1", cwd: "/x/orbit-web" };
    const t = 1_000_000;
    apply(st, { ...S, hook_event_name: "UserPromptSubmit", prompt: "fix the   cart bug" }, t);
    apply(st, { ...S, hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { subagent_type: "Explore", description: "find totals logic" } }, t);
    apply(st, { ...S, hook_event_name: "SubagentStart", agent_id: "a1", agent_type: "Explore" }, t);
    apply(st, { ...S, hook_event_name: "PreToolUse", agent_id: "a1", agent_type: "Explore", tool_name: "Grep", tool_input: { pattern: "total" } }, t + 1000);
    apply(st, { ...S, hook_event_name: "PreToolUse", agent_id: "a1", agent_type: "Explore", tool_name: "Edit", tool_input: { file_path: "/x/orbit-web/logic.ts" } }, t + 1000);
    apply(st, { ...S, hook_event_name: "PostToolUseFailure", agent_id: "a1", agent_type: "Explore", tool_name: "Bash", tool_input: { description: "Run tests" } }, t + 1000);
    apply(st, { ...S, hook_event_name: "UserPromptSubmit", prompt: "<task-notification>x</task-notification>" }, t);

    const s = st.sessions.get("s1");
    const main = s.agents.get("main"), sub = s.agents.get("a1");
    assert.equal(main.task, "fix the cart bug");
    assert.equal(main.action, "Spawn Explore: find totals logic");
    assert.equal(sub.task, "find totals logic");
    assert.equal(sub.n, 1);
    assert.equal(sub.action, "Edit logic.ts");
    assert.deepEqual([...sub.edited], ["/x/orbit-web/logic.ts"]);
    assert.equal(sub.errors, 1);
    assert.equal(s.pending.length, 0);

    assert.equal(sub.call, "Atlas", "the first subagent out is Atlas");
    // Nothing is said at Enter. The first line of a task is the helpers it sends out.
    assert.deepEqual(st.out.map((x) => [x.kind, x.aids]), [["dispatch", ["a1"]]], "a prompt queues nothing; a helper does");
    const zero = () => 0, last = () => 0.99;
    assert.deepEqual(voiceLines(st, st.out.splice(0), L.memory(), t + 60_000, zero).lines.map((x) => x.text), ["I've sent Atlas to find totals logic."]);
    const ctx = statusContext(st, t + 2000);
    assert.deepEqual(ctx.ids, ["s1|main", "s1|a1"]);
    assert.match(ctx.context, /Atlas \(Explore\), task "find totals logic", working/);
    assert.equal(ctx.fallback, "Here's a quick update. orbit-web is on Spawn Explore: find totals logic. Atlas is still on find totals logic.");

    apply(st, { ...S, hook_event_name: "SubagentStop", agent_id: "a1", agent_type: "Explore", agent_transcript_path: "/nope.jsonl" }, t + 3000);
    apply(st, { ...S, hook_event_name: "SubagentStop", agent_id: "a1", agent_type: "Explore" }, t + 3100);
    assert.equal(st.out.length, 1, "SubagentStop announces once");
    assert.deepEqual([st.out[0].kind, st.out[0].aid, st.out[0].transcript, st.out[0].due], ["finish", "a1", "/nope.jsonl", t + 3000 + FINISH_WAIT_MS]);
    apply(st, { ...S, hook_event_name: "Stop" }, t + 3000);
    assert.deepEqual([st.out.at(-1).kind, st.out.at(-1).long], ["turn", false]);
    assert.equal(statusContext(st, t + 4000), null, "idle and done agents do not report");
    // A lone helper's good news is left to the chat's own finish, which speaks as "I".
    const mem = L.memory();
    const said = voiceLines(st, st.out.splice(0), mem, t + 4000, zero);
    assert.deepEqual(said.lines, [], "a lone helper that did fine has no line of its own");
    assert.deepEqual(await turnLine(st, said.turns[0][0], said.turns[0][1], mem, zero), { kind: "done", text: "All done.", cue: "done" });

    // Sending a prompt says nothing, however long the task runs: only its finish is said.
    apply(st, { ...S, hook_event_name: "UserPromptSubmit", prompt: "quick one" }, t + 5000);
    assert.deepEqual(st.out, [], "no line queued for a prompt");
    apply(st, { ...S, hook_event_name: "Stop" }, t + 7000);
    st.out.length = 0;

    apply(st, { ...S, hook_event_name: "UserPromptSubmit", prompt: "long job" }, t);
    apply(st, { ...S, hook_event_name: "Stop" }, t + LONG_TURN_MS);
    assert.equal(st.out.at(-1).long, true);
    apply(st, { ...S, hook_event_name: "Notification", notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" }, t + LONG_TURN_MS);
    apply(st, { ...S, hook_event_name: "Notification", notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" }, t + LONG_TURN_MS + 1000);
    assert.equal(st.out.filter((x) => x.kind === "needs").length, 0, "needs-you is not spoken right away");
    escalate(st, t + LONG_TURN_MS + 5000);
    escalate(st, t + LONG_TURN_MS + 25_000);
    assert.equal(st.out.filter((x) => x.kind === "needs").length, 0, "nothing is said for the first 30 seconds");
    escalate(st, t + LONG_TURN_MS + NEEDS_SPEAK_AFTER + 1);
    escalate(st, t + LONG_TURN_MS + NEEDS_SPEAK_AFTER + 20_000);
    assert.equal(st.out.filter((x) => x.kind === "needs").length, 1, "spoken once, a few seconds in");
    assert.deepEqual(voiceLines(st, st.out.filter((x) => x.kind === "needs"), L.memory(), t, zero).lines, [{ kind: "needs", text: "I've been waiting for your approval to use Bash.", cue: "ask", sid: "s1" }]);
    st.out.length = 0;

    s.muted = true;
    apply(st, { ...S, hook_event_name: "UserPromptSubmit", prompt: "muted job" }, t);
    apply(st, { ...S, hook_event_name: "Stop" }, t + LONG_TURN_MS * 2);
    assert.deepEqual(voiceLines(st, st.out.splice(0), L.memory(), t + LONG_TURN_MS * 2 + FINISH_WAIT_MS).lines, [], "a muted session says nothing");
    s.muted = false;

    // Claude Code's own helpers (a SubagentStop with no start and no type) are not agents: no card, no name, no line.
    const H = { sessions: new Map(), out: [], seq: 0, settings: { ...DEFAULTS, aiSummaries: false } };
    apply(H, { session_id: "h1", cwd: "/x/h", hook_event_name: "UserPromptSubmit", prompt: "go" }, t);
    H.out.length = 0;
    apply(H, { session_id: "h1", cwd: "/x/h", hook_event_name: "SubagentStop", agent_id: "helper1" }, t + 1000);
    assert.deepEqual([H.sessions.get("h1").agents.has("helper1"), H.out.length], [false, 0]);
    apply(H, { session_id: "h1", cwd: "/x/h", hook_event_name: "SubagentStart", agent_id: "real1", agent_type: "Explore" }, t + 2000);
    apply(H, { session_id: "h1", cwd: "/x/h", hook_event_name: "SubagentStop", agent_id: "real1" }, t + 9000);
    assert.equal(H.sessions.get("h1").agents.get("real1").status, "done", "a real agent's stop still counts, type or not");

    // The review's fixes. A subagent's task comes from its spawn metadata, so two same-type agents never swap tasks.
    const R = { sessions: new Map(), out: [], seq: 0, settings: { ...DEFAULTS, aiSummaries: false } };
    const rdir = fs.mkdtempSync(path.join(os.tmpdir(), "pulse-meta-")), rtr = path.join(rdir, "sess.jsonl");
    fs.mkdirSync(path.join(rdir, "sess", "subagents"), { recursive: true });
    fs.writeFileSync(path.join(rdir, "sess", "subagents", "agent-m2.meta.json"), JSON.stringify({ description: "Second job" }));
    const RS = { session_id: "r1", cwd: "/x/r", transcript_path: rtr };
    apply(R, { ...RS, hook_event_name: "UserPromptSubmit", prompt: "two jobs" }, t);
    for (const d of ["First job", "Second job"]) apply(R, { ...RS, hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { subagent_type: "Explore", description: d } }, t);
    apply(R, { ...RS, hook_event_name: "SubagentStart", agent_id: "m2", agent_type: "Explore" }, t + 100);
    apply(R, { ...RS, hook_event_name: "SubagentStart", agent_id: "m1", agent_type: "Explore" }, t + 200);
    const rs = R.sessions.get("r1");
    assert.deepEqual([rs.agents.get("m2").task, rs.agents.get("m1").task], ["Second job", "First job"], "started out of order, still the right tasks");
    fs.rmSync(rdir, { recursive: true, force: true });
    // Helpers sent out together are named in one line. New prompts add nothing.
    assert.deepEqual(R.out.filter((x) => x.kind === "dispatch").map((x) => x.aids), [["m2", "m1"]], "one line for helpers sent together");
    R.out.length = 0;
    apply(R, { ...RS, hook_event_name: "UserPromptSubmit", prompt: "quick" }, t + 2000);
    apply(R, { ...RS, hook_event_name: "UserPromptSubmit", prompt: "another" }, t + 3000);
    assert.equal(R.out.length, 0, "prompts queue no lines");
    // A background task reporting in, with no helper coming back, says nothing new.
    assert.equal(await turnLine(R, rs, { kind: "turn", sid: "r1", aid: "main", harness: true }, L.memory()), null);
    // Two requests in one chat a moment apart: both are said, the second a little later.
    R.out.length = 0;
    for (const id of ["m1", "m2"]) Object.assign(rs.agents.get(id), { status: "needs-you", needsAt: t, needsSpoken: false, action: "Approve Run tests" });
    rs.lastNeedsAt = 0;
    escalate(R, t + NEEDS_SPEAK_AFTER + 1);
    escalate(R, t + NEEDS_SPEAK_AFTER + 21_000);
    assert.equal(R.out.filter((x) => x.kind === "needs").length, 2, "the second request is not lost");
    // An agent only guessed to be over comes back when it acts again.
    Object.assign(rs.agents.get("m1"), { status: "working", lastAt: t });
    prune(R, t + 16 * 60_000);
    assert.deepEqual([rs.agents.get("m1").status, rs.agents.get("m1").stale], ["done", true]);
    apply(R, { ...RS, hook_event_name: "PreToolUse", agent_id: "m1", agent_type: "Explore", tool_name: "Read", tool_input: {} }, t + 17 * 60_000);
    assert.equal(rs.agents.get("m1").status, "working", "a timed-out agent that acts again is back at work");

    // The checklist under "Your orders": plan and check lines, the agent's own to-do tool, and a done task ticks the rest.
    const mk = "\u27e6pulse\u27e7";
    let plan = planFromText([], `Four fixes.\n${mk} plan | update me feedback; no recentring; settings goes back; C1 in terminal tabs\nWorking.\n${mk} check | 2`);
    assert.deepEqual(plan.map((x) => [x.text, x.done]), [["update me feedback", false], ["no recentring", true], ["settings goes back", false], ["C1 in terminal tabs", false]]);
    plan = planFromText(plan, `${mk} check | 1, 3`);
    assert.deepEqual(plan.map((x) => x.done), [true, true, true, false]);
    assert.equal(pulseLine(`Done.\n${mk} plan | a; b\n${mk} done | the four page fixes\n${mk} check | 2`), "done | the four page fixes", "plan and check lines are not the finish line");
    const Q = { sessions: new Map(), out: [], seq: 0, settings: { ...DEFAULTS, aiSummaries: false } };
    apply(Q, { session_id: "p1", cwd: "/x/p", hook_event_name: "UserPromptSubmit", prompt: "two things" }, t);
    apply(Q, { session_id: "p1", cwd: "/x/p", hook_event_name: "PreToolUse", tool_name: "TodoWrite", tool_input: { todos: [{ content: "Fix the tabs", status: "completed" }, { content: "Add the list", status: "in_progress" }] } }, t + 1);
    const pm = Q.sessions.get("p1").agents.get("main");
    assert.deepEqual(pm.plan, [{ text: "Fix the tabs", done: true, now: false }, { text: "Add the list", done: false, now: true }]);
    assert.match(statusContext(Q, t + 2).context, /Checklist, 1 of 2 done: 1\. Fix the tabs \(done\); 2\. Add the list \(in progress\)/, "Update me knows the checklist");
    noteFinish(pm, { outcome: "done", task: "the two things" });
    assert.deepEqual(pm.plan.map((x) => x.done), [true, true], "a task reported done ticks what's left");
    apply(Q, { session_id: "p1", cwd: "/x/p", hook_event_name: "UserPromptSubmit", prompt: "next" }, t + 3);
    assert.deepEqual(pm.plan, [], "a new task starts a new checklist");


    // Callsigns: the first free name in roster order, held a while after its agent finishes, then free again.
    const C = { sessions: new Map(), out: [], seq: 0, settings: { ...DEFAULTS, aiSummaries: false } };
    const cs = { session_id: "c1", cwd: "/x/orbit-web" };
    const cAg = (id) => C.sessions.get("c1").agents.get(id);
    apply(C, { ...cs, hook_event_name: "UserPromptSubmit", prompt: "go" }, t);
    for (const id of ["x1", "x2", "x3"]) apply(C, { ...cs, hook_event_name: "SubagentStart", agent_id: id, agent_type: "Explore" }, t + 100);
    assert.deepEqual(["x1", "x2", "x3"].map((id) => cAg(id).call), ["Atlas", "Echo", "Nova"]);
    assert.deepEqual(C.out.map((x) => [x.kind, x.aids]), [["dispatch", ["x1", "x2", "x3"]]], "helpers sent together are named together");
    assert.deepEqual(voiceLines(C, C.out.splice(0), L.memory(), t + 60_000, last).lines.map((x) => x.text), ["Atlas, Echo and Nova are on it now."]);
    apply(C, { ...cs, hook_event_name: "SubagentStop", agent_id: "x1", agent_type: "Explore" }, t + 1000);
    apply(C, { ...cs, hook_event_name: "SubagentStart", agent_id: "x4", agent_type: "Plan" }, t + 2000);
    assert.equal(cAg("x4").call, "Rook", "a name is held for a while after its agent finishes");
    apply(C, { ...cs, hook_event_name: "SubagentStart", agent_id: "x5", agent_type: "Plan" }, t + 3000 + CALL_HOLD_MS);
    assert.equal(cAg("x5").call, "Juno", "while the task runs, its crew keep their names: no second Atlas");
    C.out.length = 0;
    // In a crew, each finish is said; several together are one line.
    for (const id of ["x2", "x3", "x4"]) apply(C, { ...cs, hook_event_name: "SubagentStop", agent_id: id, agent_type: "Explore" }, t + 4000 + CALL_HOLD_MS);
    const burst = voiceLines(C, C.out.splice(0), L.memory(), t + 9000 + CALL_HOLD_MS, last);
    assert.deepEqual(burst.lines.map((l) => [l.text, l.cue]), [["Echo, Nova and Rook have all finished.", "done"]]);
    assert.deepEqual(L.batch([{ who: "Echo", outcome: "done" }, { who: "Nova", outcome: "failed", task: "the server tests" }, { who: "Rook", outcome: "needs" }]), { text: "Echo has finished, but Nova couldn't finish the server tests and Rook needs you.", earcon: "fail" });
    // The chat's turn ends while Juno (x5) is still out: nothing yet. When all are back, one wrap-up.
    apply(C, { ...cs, hook_event_name: "Stop" }, t + 10_000 + CALL_HOLD_MS);
    const cm = C.sessions.get("c1");
    assert.equal(await turnLine(C, cm, C.out.pop(), L.memory(), last), null, "no \"still waiting\" chatter");
    apply(C, { ...cs, hook_event_name: "SubagentStop", agent_id: "x5", agent_type: "Plan" }, t + 11_000 + CALL_HOLD_MS);
    voiceLines(C, C.out.splice(0), L.memory(), t + 12_000 + CALL_HOLD_MS);
    apply(C, { ...cs, hook_event_name: "UserPromptSubmit", prompt: "<task-notification>x</task-notification>" }, t + 12_000 + CALL_HOLD_MS);
    apply(C, { ...cs, hook_event_name: "Stop" }, t + 13_000 + CALL_HOLD_MS);
    Object.assign(cAg("x3"), { outcome: "failed", said: "the server tests" });
    const wrapped = await turnLine(C, cm, C.out.pop(), L.memory(), last);
    assert.deepEqual([wrapped.kind, wrapped.text, wrapped.cue], ["failed", "That's everything back, though Nova couldn't finish the server tests.", "fail"]);
    assert.deepEqual(cm.crew, [], "a crew is wrapped up once");
    apply(C, { ...cs, hook_event_name: "UserPromptSubmit", prompt: "next task" }, t + 14_000 + CALL_HOLD_MS);
    apply(C, { ...cs, hook_event_name: "SubagentStart", agent_id: "x6", agent_type: "Explore" }, t + 14_000 + CALL_HOLD_MS);
    assert.equal(cAg("x6").call, "Atlas", "once a crew is wrapped up, the next task starts again at Atlas");
    // Two projects busy: a line about your own chat says which one; a second chat on a folder is "chat two".
    apply(C, { session_id: "c2", cwd: "/x/api", hook_event_name: "UserPromptSubmit", prompt: "go" }, Date.now());
    apply(C, { session_id: "c3", cwd: "/x/api", hook_event_name: "UserPromptSubmit", prompt: "go" }, Date.now() + 1);
    C.sessions.get("c3").startedAt = C.sessions.get("c2").startedAt + 1;
    cm.lastAt = Date.now();
    assert.deepEqual([chatName(C, C.sessions.get("c2")), chatName(C, C.sessions.get("c3"))], ["Api C1", "Api C2"], "named like the board and the terminal tabs");
    Object.assign(cm.agents.get("main"), { status: "needs-you", action: "Waiting for you" });
    assert.match(voiceLines(C, [{ kind: "needs", sid: "c1", aid: "main" }], L.memory(), Date.now(), zero).lines[0].text, /^Over in orbit web, /);
    cm.agents.get("main").status = "idle";
    // The phrase bank: never the same line twice running; the task named, how it ended, and nothing else.
    const bm = L.memory();
    let prev = "";
    for (let i = 0; i < 60; i++) { const l = L.say("joinMany", { names: ["Atlas", "Echo"] }, bm); assert.notEqual(l.text, prev, "no line twice in a row"); prev = l.text; }
    assert.equal(L.say("done", { who: "Atlas", task: "the voice template count" }, L.memory(), zero).text, "Atlas has finished the voice template count.");
    assert.equal(L.say("failed", { who: "Nova", task: "the server tests" }, L.memory(), zero).text, "Nova couldn't finish the server tests.");
    assert.equal(L.say("mainDone", { task: "the login fix" }, L.memory(), zero).text, "That's the login fix done.");
    assert.equal(L.say("mainDone", { task: "the login fix", addr: "sir" }, L.memory(), () => 0.1).text, "That's the login fix done, sir.", "now and then, the form of address");
    assert.equal(L.say("wrapAll", { task: "the search bar redesign", n: 2 }, L.memory(), zero).text, "The search bar redesign is done, and both finished cleanly.");
    assert.equal(L.say("done", { who: "Atlas", task: "mapped the voice pipeline" }, L.memory(), zero).text, "Atlas mapped the voice pipeline.", "a line from an older chat still reads");
    assert.equal(L.say("failed", { who: "Nova", task: "fix the tests" }, L.memory(), zero).text, "Nova ran into trouble. It was trying to fix the tests.", "an order is said as the job it was given");
    assert.equal(L.say("done", { who: "Atlas" }, L.memory(), last).text, "Atlas is done.", "no task, no dangling words");

    const merged = mergeSettings(DEFAULTS, { intervalMin: 15, voice: "am_michael", speed: 5, verbosity: "chatty", earcons: false, junk: 1 });
    assert.deepEqual([merged.intervalMin, merged.voice, merged.speed, merged.verbosity, merged.earcons, merged.junk], [15, "am_michael", 1, "normal", false, undefined]);
    assert.equal(mergeSettings(DEFAULTS, { voice: "bm_george" }).voice, DEFAULTS.voice, "only the two voices are accepted");
    assert.deepEqual(["am_fenrir", "bm_fable", "af_bella", "bf_emma", undefined].map(voiceOf), ["am_michael", "am_michael", "af_heart", "af_heart", "af_heart"], "an old choice maps to the voice of the same kind");
    assert.equal(mergeSettings(DEFAULTS, { verbosity: "quiet" }).verbosity, "quiet");

    // Save and reload keeps agents, their Sets and their order numbers.
    const saved = { sessions: new Map(), comms: [], seq: 0 };
    const tmpState = path.join(os.tmpdir(), `pulse-state-${process.pid}.json`);
    const realFile = STATE_FILE;
    fs.writeFileSync(tmpState, JSON.stringify({ savedAt: Date.now(), seq: st.seq, comms: [], sessions: [...st.sessions.values()].map((x) => ({ ...x, agents: [...x.agents.values()].map((a) => ({ ...a, read: [...a.read], edited: [...a.edited] })) })) }));
    const j = JSON.parse(fs.readFileSync(tmpState, "utf8"));
    for (const x of j.sessions) saved.sessions.set(x.id, { ...x, agents: new Map(x.agents.map((a) => [a.id, { ...a, read: new Set(a.read), edited: new Set(a.edited) }])) });
    assert.ok(saved.sessions.get("s1").agents.get("a1").edited.has("/x/orbit-web/logic.ts"));
    assert.equal(typeof realFile, "string");
    fs.rmSync(tmpState);

    const tmp = path.join(os.tmpdir(), "pulse-test.jsonl");
    fs.writeFileSync(tmp, [{ type: "assistant", message: { content: [{ type: "text", text: "Found it in logic.ts" }] } }, { type: "user", message: { content: "ok" } }, { type: "assistant", message: { content: [{ type: "tool_use" }] } }].map((x) => JSON.stringify(x)).join("\n"));
    assert.equal(lastAssistantText(tmp), "Found it in logic.ts");
    fs.rmSync(tmp);
    assert.equal(pulseLine(`All done.\n\n${PULSE_MARK} Fixed the merge bug in logic.ts\n`), "Fixed the merge bug in logic.ts");
    assert.equal(pulseLine(`${PULSE_MARK} first\ntext\n${PULSE_MARK}   last one  `), "last one");
    assert.equal(pulseLine("Found the merge bug. Also added tests."), null, "no marker, no summary: nothing is guessed");
    assert.equal(withoutPulseLine(`All done.\n\n${PULSE_MARK} Fixed it`), "All done.");
    fs.writeFileSync(tmp, [{ type: "assistant", message: { content: [{ type: "text", text: `Done.\n\n${PULSE_MARK} Fixed the merge bug` }] } }, { type: "assistant", message: { content: [{ type: "text", text: "No marker here" }] } }].map((x) => JSON.stringify(x)).join("\n"));
    assert.equal(finishOf(tmp), null, "the latest message has no marker, so no summary");
    fs.writeFileSync(tmp, JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: `Done.\n\n${PULSE_MARK} Fixed the merge bug` }] } }));
    assert.deepEqual(finishOf(tmp), { outcome: null, task: "Fixed the merge bug" }, "a line from before the outcome words is the task");
    fs.writeFileSync(tmp, JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: `Done.\n\n${PULSE_MARK} failed | fix \`src/logic.ts\` merge bug.` }] } }));
    assert.deepEqual(finishOf(tmp), { outcome: "failed", task: "fix logic merge bug" }, "paths, extensions and code marks are not read aloud");
    const noted = {};
    noteFinish(noted, finishOf(tmp));
    assert.deepEqual([noted.summary, noted.outcome], ["Failed · fix logic merge bug", "failed"]);
    fs.rmSync(tmp);
    const markConv = { entries: [], calls: new Map(), main: true };
    feedTranscript(markConv, JSON.stringify({ type: "assistant", timestamp: "2026-01-01T00:00:00Z", message: { content: [{ type: "text", text: `Body\n\n${PULSE_MARK} Summary` }, { type: "text", text: `${PULSE_MARK} only the marker` }] } }));
    assert.deepEqual(markConv.entries.map((e) => e.text), ["Body"], "the marker line is not shown in the conversation");
    assert.deepEqual(parseJson('Sure: {"spoken": "hi", "agents": {}} done'), { spoken: "hi", agents: {} });

    const u = t + 300_000; // later than every event above
    // Out-of-order hooks: a straggling tool event must not revive a finished subagent.
    apply(st, { ...S, hook_event_name: "PreToolUse", agent_id: "a1", agent_type: "Explore", tool_name: "Read", tool_input: { file_path: "x" } }, u + 5000);
    assert.equal(sub.status, "done");
    // SubagentStart landing before its Agent call still gets the right task; stale spawns expire.
    apply(st, { ...S, hook_event_name: "SubagentStart", agent_id: "a2", agent_type: "Plan" }, u + 6000);
    apply(st, { ...S, hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { subagent_type: "Plan", description: "plan v20" } }, u + 6100);
    assert.equal(s.agents.get("a2").task, "plan v20");
    s.pending.push({ type: "Explore", task: "denied spawn", t: u });
    apply(st, { ...S, hook_event_name: "SubagentStart", agent_id: "a3", agent_type: "Explore" }, u + 120_000);
    assert.equal(s.agents.get("a3").task, "", "a spawn older than a minute is not paired");
    // Approving a permission prompt clears needs-you.
    const n = s.agents.get("a2");
    apply(st, { ...S, hook_event_name: "Notification", agent_id: "a2", agent_type: "Plan", notification_type: "permission_prompt", message: "Allow Bash?" }, u + 7000);
    apply(st, { ...S, hook_event_name: "PostToolUse", agent_id: "a2", agent_type: "Plan", tool_name: "Bash", tool_input: { description: "Run tests" } }, u + 8000);
    assert.equal(n.status, "working");
    // An interrupted agent (no Stop) goes quiet for good after 15 minutes.
    prune(st, u + 8000 + 16 * 60_000);
    assert.equal(n.status, "done");
    assert.equal(agentTranscript({ transcript: "/p/sess.jsonl" }, { id: "abc" }), "/p/sess/subagents/agent-abc.jsonl");

    // Pulse decisions: only Stop, and only at a tool call.
    const D = { session_id: "d1", cwd: "/x/pulse-test" };
    const w = u + 1_000_000;
    apply(st, { ...D, hook_event_name: "UserPromptSubmit", prompt: "build it" }, w);
    apply(st, { ...D, hook_event_name: "SubagentStart", agent_id: "s1", agent_type: "Explore" }, w);
    const dm = st.sessions.get("d1").agents.get("main"), ds = st.sessions.get("d1").agents.get("s1");
    assert.equal(decide(st, { ...D, hook_event_name: "PreToolUse" }), null, "nothing asked, no reply");
    dm.kill = true;
    assert.equal(decide(st, { ...D, hook_event_name: "PostToolUse" }), null, "a stop lands before a tool call");
    assert.deepEqual(decide(st, { ...D, hook_event_name: "PreToolUse" }), { continue: false, stopReason: "Stopped from Pulse." });
    ds.kill = true;
    assert.equal(decide(st, { ...D, agent_id: "s1", hook_event_name: "PreToolUse" }).hookSpecificOutput.permissionDecision, "deny");
    // The project folder comes from CLAUDE_PROJECT_DIR and survives the agent changing directory.
    apply(st, { session_id: "pd", cwd: "/work/app", project_dir: "/work/app", hook_event_name: "UserPromptSubmit", prompt: "go" }, w);
    apply(st, { session_id: "pd", cwd: "/tmp/elsewhere", project_dir: "/work/app", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {} }, w);
    apply(st, { session_id: "pd", cwd: "/tmp/elsewhere", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {} }, w);
    assert.equal(st.sessions.get("pd").cwd, "/work/app");
    // A window that opened a chat and closed it without doing anything leaves no trace.
    apply(st, { session_id: "e1", cwd: "/x/pulse-test", hook_event_name: "SessionStart" }, w);
    assert.equal(isEmpty(st.sessions.get("e1")), true);
    apply(st, { session_id: "e1", cwd: "/x/pulse-test", hook_event_name: "SessionEnd" }, w);
    assert.equal(st.sessions.has("e1"), false);

    // Kill ends a main turn at once: Claude Code sends no Stop after continue:false, so it must not stay "working".
    const K = { session_id: "k1", cwd: "/x/kill" };
    handleHook(st, { ...K, hook_event_name: "UserPromptSubmit", prompt: "go" }, w);
    const km = st.sessions.get("k1").agents.get("main");
    km.kill = true;
    assert.equal(handleHook(st, { ...K, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {} }, w + 1000).continue, false);
    assert.deepEqual([km.status, km.kill], ["idle", false]);
    // Esc sends no Stop hook either; the transcript's interrupt marker settles the chat and its silent subagents.
    const tr = path.join(os.tmpdir(), `pulse-int-${process.pid}.jsonl`);
    const line = (type, content) => JSON.stringify({ type, message: { content } });
    fs.writeFileSync(tr, [line("assistant", [{ type: "tool_use" }]), line("user", [{ type: "tool_result" }]), line("user", [{ type: "text", text: "[Request interrupted by user for tool use]" }])].join("\n"));
    assert.equal(wasInterrupted(tr), true);
    const I = { session_id: "i1", cwd: "/x/int", transcript_path: tr };
    handleHook(st, { ...I, hook_event_name: "UserPromptSubmit", prompt: "go" }, w);
    handleHook(st, { ...I, hook_event_name: "SubagentStart", agent_id: "i1a", agent_type: "Explore" }, w);
    const im = st.sessions.get("i1").agents.get("main"), ia = st.sessions.get("i1").agents.get("i1a");
    settleInterrupted(st, w + 5000);
    assert.equal(im.status, "working", "a fresh event is not second-guessed");
    settleInterrupted(st, w + 20_000);
    assert.deepEqual([im.status, ia.status], ["idle", "done"]);
    // A subagent interrupted on its own (its transcript ends on the marker) settles while its chat keeps working.
    const intDir = path.join(tr.replace(/\.jsonl$/, ""), "subagents");
    fs.mkdirSync(intDir, { recursive: true });
    fs.writeFileSync(path.join(intDir, "agent-i1b.jsonl"), fs.readFileSync(tr));
    handleHook(st, { ...I, hook_event_name: "UserPromptSubmit", prompt: "again" }, w + 30_000);
    handleHook(st, { ...I, hook_event_name: "SubagentStart", agent_id: "i1b", agent_type: "Explore" }, w + 30_000);
    handleHook(st, { ...I, hook_event_name: "PermissionRequest", agent_id: "i1b", tool_name: "Bash", tool_input: {} }, w + 31_000);
    fs.writeFileSync(tr, line("assistant", [{ type: "text", text: "Working on it" }]));
    assert.equal(wasInterrupted(tr), false);
    handleHook(st, { ...I, hook_event_name: "PreToolUse", tool_name: "Read", tool_input: {} }, w + 50_000);
    settleInterrupted(st, w + 50_000);
    assert.deepEqual([im.status, st.sessions.get("i1").agents.get("i1b").status], ["working", "done"]);
    fs.rmSync(tr.replace(/\.jsonl$/, ""), { recursive: true });
    fs.rmSync(tr);
    // An agent stopped by another (TaskStop) sends no SubagentStop; the stopper's tool call settles it.
    const TS = { session_id: "ts1", cwd: "/x/ts" };
    handleHook(st, { ...TS, hook_event_name: "UserPromptSubmit", prompt: "go" }, w);
    handleHook(st, { ...TS, hook_event_name: "SubagentStart", agent_id: "tsa", agent_type: "general-purpose" }, w);
    handleHook(st, { ...TS, hook_event_name: "PermissionRequest", agent_id: "tsa", tool_name: "Bash", tool_input: {} }, w + 1000);
    handleHook(st, { ...TS, hook_event_name: "PreToolUse", tool_name: "TaskStop", tool_input: { task_id: "tsa" } }, w + 2000);
    handleHook(st, { ...TS, hook_event_name: "PostToolUse", tool_name: "TaskStop", tool_input: { task_id: "tsa" } }, w + 2100);
    const tsa = st.sessions.get("ts1").agents.get("tsa");
    assert.deepEqual([tsa.status, tsa.action], ["done", "Stopped by the main agent"]);
    handleHook(st, { ...TS, hook_event_name: "PreToolUse", agent_id: "tsa", tool_name: "Read", tool_input: {} }, w + 9000);
    assert.equal(tsa.status, "working", "a resumed agent comes back");
    // A closed chat stamps when its agents ended, so they fold like any other finished agent.
    handleHook(st, { ...K, hook_event_name: "SubagentStart", agent_id: "k1a", agent_type: "Plan" }, w);
    handleHook(st, { ...K, hook_event_name: "SessionEnd" }, w + 2000);
    assert.equal(st.sessions.get("k1").agents.get("k1a").endedAt, w + 2000);

    // Prompts as VS Code and the CLI really send them: pasted text, IDE context, slash commands, harness turns.
    const pasted = '\n\n<pasted_content id="0db3">\nwhy are the agents\nstill running\n</pasted_content id="0db3">\n';
    assert.equal(promptText(pasted), "why are the agents\nstill running");
    assert.equal(promptText(`look at this ${pasted} thanks`), "look at this \n\nwhy are the agents\nstill running\n\n thanks");
    assert.equal(promptText("<ide_opened_file>The user opened the file /x/a.ts in the IDE.</ide_opened_file>\nfix it"), "fix it");
    assert.equal(promptText("fix it<system-reminder>\nbe brief\n</system-reminder>"), "fix it");
    assert.equal(promptText("<command-message>model</command-message>\n<command-name>/model</command-name>\n<command-args>sonnet</command-args>"), "/model sonnet");
    assert.equal(promptText("<command-message>review</command-message>\n<command-name>/review</command-name>"), "/review");
    assert.equal(promptText("<bash-input>ls -la</bash-input>"), "! ls -la");
    assert.equal(promptText("<div> renders twice"), "<div> renders twice", "typed markup is still the user's words");
    assert.equal(promptText([{ type: "text", text: "queued note" }]), "queued note");
    for (const h of ["<task-notification>\n<task-id>a1</task-id>", '<agent-message from="a1">\n[Subagent hand-back]', "<local-command-stdout>Set model</local-command-stdout>", "<bash-stdout>x</bash-stdout>"]) assert.equal(promptText(h), null, h);
    assert.equal(harnessNotice('<task-notification>\n<status>completed</status>\n<summary>Agent "Map it" finished</summary>'), 'Agent "Map it" finished');
    const P = { session_id: "p1", cwd: "/x/pulse" };
    apply(st, { ...P, hook_event_name: "UserPromptSubmit", prompt: pasted }, w);
    assert.equal(st.sessions.get("p1").agents.get("main").task, "why are the agents still running");
    apply(st, { ...P, hook_event_name: "UserPromptSubmit", prompt: "<task-notification>\n<summary>done</summary>" }, w);
    assert.equal(st.sessions.get("p1").agents.get("main").task, "why are the agents still running", "a harness turn keeps the task");
    for (let i = 0; i < HISTORY_MAX + 50; i++) apply(st, { ...P, hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: `/f${i}` } }, w);
    assert.equal(st.sessions.get("p1").agents.get("main").history.length, HISTORY_MAX);

    // A chat started in a Pulse terminal carries its id; events without one (subagents, older hooks) keep it.
    apply(st, { ...P, term_id: "t7", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {} }, w);
    apply(st, { ...P, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {} }, w);
    assert.equal(snapshot(st, {}, w).sessions.find((x) => x.id === "p1").term, "t7");
    assert.equal(snapshot(st, {}, w).sessions.find((x) => x.id === "s1").term, "");

    // The conversation view: a small transcript with every kind of line Claude Code writes.
    const fx = path.join(os.tmpdir(), `pulse-conv-${process.pid}.jsonl`);
    const at = (s) => `2026-09-29T10:00:${String(s).padStart(2, "0")}.000Z`;
    const U = (s, content, more) => ({ type: "user", timestamp: at(s), message: { role: "user", content }, ...more });
    const A = (s, content, more) => ({ type: "assistant", timestamp: at(s), message: { role: "assistant", content }, ...more });
    fs.writeFileSync(fx, [
        { type: "queue-operation", operation: "enqueue", timestamp: at(0) },
        U(1, [{ type: "image", source: {} }, { type: "text", text: pasted }]),
        U(1, [{ type: "text", text: "[Image: source: /tmp/1.png]" }], { isMeta: true }),
        A(2, [{ type: "thinking", thinking: "hmm" }]),
        A(3, [{ type: "text", text: "Looking at the server." }]),
        A(4, [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls server", description: "List server files" } }]),
        U(5, [{ tool_use_id: "tu1", type: "tool_result", content: "server.js\nindex.html", is_error: false }]),
        A(6, [{ type: "tool_use", id: "tu2", name: "Read", input: { file_path: "/x/shot.png" } }]),
        U(7, [{ tool_use_id: "tu2", type: "tool_result", content: [{ type: "image", source: {} }, { type: "text", text: "a screenshot" }] }]),
        A(8, [{ type: "tool_use", id: "tu3", name: "Edit", input: { file_path: "/x/a.js", old_string: "let a = 1", new_string: "const a = 1" } }]),
        U(9, [{ tool_use_id: "tu3", type: "tool_result", content: "String not found", is_error: true }]),
        A(10, [{ type: "text", text: "Subagent line" }], { isSidechain: true }),
        { type: "system", subtype: "api_error", timestamp: at(11), level: "error" },
        A(12, [{ type: "text", text: "API Error: Can't reach the API server" }], { isApiErrorMessage: true }),
        U(13, "<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>Background command \"Run tests\" completed</summary>\n</task-notification>", { origin: { kind: "task-notification" } }),
        { type: "attachment", timestamp: at(14), attachment: { type: "queued_command", prompt: [{ type: "text", text: "also check the page" }] } },
        { type: "attachment", timestamp: at(14), attachment: { type: "hook_additional_context", content: ["ignored"] } },
        A(15, [{ type: "tool_use", id: "tu4", name: "mcp__github__search_issues", input: { query: "is:open label:bug" } }]),
        U(16, [{ type: "text", text: "[Request interrupted by user for tool use]" }]),
        U(17, "<command-name>/model</command-name>\n<command-args>sonnet</command-args>"),
        U(18, "<local-command-stdout>Set model to sonnet</local-command-stdout>"),
    ].map((x) => JSON.stringify(x)).join("\n") + "\n");
    const conv = readTranscript(fx);
    const T0 = Date.parse(at(0));
    assert.equal(conv.truncated, false);
    assert.deepEqual(conv.entries.map((e) => e.kind), ["user", "assistant", "tool", "tool", "tool", "notice", "notice", "user", "tool", "interrupt", "user", "notice"]);
    const [cu, ca, c1, c2, c3, cn1, cn2, cq, c4, ci, cc, cn3] = conv.entries;
    assert.deepEqual([cu.t - T0, cu.text], [1000, "[image]\nwhy are the agents\nstill running"]);
    assert.equal(ca.text, "Looking at the server.");
    assert.deepEqual({ ...c1 }, { kind: "tool", t: T0 + 4000, id: "tu1", tool: "Bash", title: "List server files", input: "ls server", output: "server.js\nindex.html", error: false, pending: false });
    assert.deepEqual([c2.title, c2.input, c2.output], ["Read shot.png", "/x/shot.png", "[image]\na screenshot"]);
    assert.deepEqual([c3.title, c3.input, c3.error, c3.pending], ["Edit a.js", "/x/a.js\n--- old\nlet a = 1\n+++ new\nconst a = 1", true, false]);
    assert.deepEqual([cn1.text, cn2.text, cq.text], ["API Error: Can't reach the API server", 'Background command "Run tests" completed', "also check the page"]);
    assert.deepEqual([c4.title, c4.input, c4.output, c4.pending], ["github: search_issues", '{"query":"is:open label:bug"}', "", true]);
    assert.deepEqual([ci.t - T0, cc.text, cn3.text], [16000, "/model sonnet", "Set model to sonnet"]);
    // A subagent's own file is all sidechain lines, and its first prompt is the task it was given.
    assert.equal(readTranscript(fx, false).entries.filter((e) => e.kind === "assistant").length, 2);
    // Only the tail is kept: the newest TRANSCRIPT_MAX entries, flagged as truncated.
    fs.writeFileSync(fx, Array.from({ length: TRANSCRIPT_MAX + 20 }, (_, i) => JSON.stringify(A(0, [{ type: "text", text: `step ${i}` }]))).join("\n"));
    const long = readTranscript(fx);
    assert.deepEqual([long.truncated, long.entries.length, long.entries[0].text, long.entries.at(-1).text], [true, TRANSCRIPT_MAX, "step 20", `step ${TRANSCRIPT_MAX + 19}`]);
    fs.rmSync(fx);
    assert.equal(readTranscript(fx), null, "a missing file is unreadable, not empty");
    // Later reads take only the appended bytes: a half-written line (even one split inside a character) waits for the rest.
    const jl = (s, text) => JSON.stringify(A(s, [{ type: "text", text }])) + "\n";
    fs.writeFileSync(fx, jl(1, "first"));
    assert.equal(readTranscript(fx).entries.length, 1);
    const next = Buffer.from(jl(2, "naïve café ✓"));
    const split = next.indexOf(Buffer.from("✓")) + 1; // inside the 3-byte check mark
    fs.appendFileSync(fx, next.subarray(0, split));
    assert.equal(readTranscript(fx).entries.length, 1, "an unfinished line is not parsed");
    fs.appendFileSync(fx, next.subarray(split));
    assert.deepEqual(readTranscript(fx).entries.map((e) => e.text), ["first", "naïve café ✓"]);
    fs.appendFileSync(fx, JSON.stringify(A(3, [{ type: "text", text: "no newline yet" }])));
    assert.equal(readTranscript(fx).entries.at(-1).text, "no newline yet", "a complete last line without a newline counts");
    fs.appendFileSync(fx, "\n" + jl(4, "after"));
    assert.deepEqual(readTranscript(fx).entries.map((e) => e.text).slice(-2), ["no newline yet", "after"], "and is not read twice");
    fs.writeFileSync(fx, jl(1, "rewritten") + jl(2, "file, longer than before, so only the bytes can tell"));
    assert.equal(readTranscript(fx).entries[0].text, "rewritten", "a rewritten file is parsed again from scratch");
    fs.rmSync(fx);
    assert.equal(toolInput("Grep", { pattern: "merge", path: "/x/src" }), "merge  in /x/src");
    assert.equal(toolInput("Agent", { description: "Find it", prompt: "Look in src" }), "Find it\n\nLook in src");
    assert.equal(toolInput("Bash", { command: "x".repeat(5000) }).length, 4000);

    // Static files: the terminal's own files and vendored libraries, nothing else.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pulse-static-"));
    fs.mkdirSync(path.join(root, "vendor"));
    fs.writeFileSync(path.join(root, "terminal.js"), "x");
    fs.writeFileSync(path.join(root, "vendor", "xterm.css"), "y");
    fs.writeFileSync(path.join(root, "vendor", ".secret"), "z");
    fs.writeFileSync(path.join(root, "server.js"), "no");
    assert.deepEqual(staticFile(root, "/terminal.js"), { type: "text/javascript", body: Buffer.from("x") });
    assert.equal(staticFile(root, "/vendor/xterm.css").type, "text/css");
    for (const bad of ["/terminal.css", "/server.js", "/vendor/.secret", "/vendor/..", "/vendor/a/../../server.js", "/vendor/..%2Fserver.js", "/vendor/", "/vendor/nope.js"]) assert.equal(staticFile(root, bad), null, bad);
    // Monaco lives in nested folders under vendor/; every part must be a plain name, and a link out of vendor/ is refused.
    fs.mkdirSync(path.join(root, "vendor", "monaco", "vs", "base", "worker"), { recursive: true });
    fs.writeFileSync(path.join(root, "vendor", "monaco", "vs", "loader.js"), "l");
    fs.writeFileSync(path.join(root, "vendor", "monaco", "vs", "base", "worker", "workerMain.js"), "w");
    fs.writeFileSync(path.join(root, "vendor", "monaco", "vs", "codicon.ttf"), "f");
    fs.writeFileSync(path.join(root, "workspace.js"), "ws");
    fs.symlinkSync(root, path.join(root, "vendor", "monaco", "up"));
    assert.equal(staticFile(root, "/vendor/monaco/vs/loader.js").body.toString(), "l");
    assert.equal(staticFile(root, "/vendor/monaco/vs/base/worker/workerMain.js").type, "text/javascript");
    assert.equal(staticFile(root, "/vendor/monaco/vs/codicon.ttf").type, "font/ttf");
    assert.equal(staticFile(root, "/workspace.js").body.toString(), "ws");
    for (const bad of ["/vendor/monaco//vs/loader.js", "/vendor/monaco/vs/", "/vendor/monaco/.vs/loader.js", "/vendor/monaco/%2e%2e/%2e%2e/server.js", "/vendor/monaco/up/server.js", "/vendor/monaco/vs/%E0%A4%A.js", "/intro.js"]) assert.equal(staticFile(root, bad), null, bad);
    fs.rmSync(root, { recursive: true });

    assert.deepEqual(spark([t, t, t - 60_000], t).slice(-2), [1, 2]);
    assert.equal(describe("mcp__github__search_issues"), "github: search_issues");

    // POSTs must be JSON: with the Origin check, that keeps other websites from posting forms here.
    for (const ok of ["application/json", "application/json; charset=utf-8", "Application/JSON"]) assert.equal(isJson(ok), true, ok);
    for (const bad of [undefined, "", "text/plain", "application/x-www-form-urlencoded", "multipart/form-data", "application/jsonp"]) assert.equal(isJson(bad), false, bad);

    // ---- Workspace: roots, paths, files, git and agent changes, on throwaway folders. ----
    const W = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pulse-ws-")));
    const proj = path.join(W, "proj"), outside = path.join(W, "outside");
    fs.mkdirSync(path.join(proj, "src"), { recursive: true });
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(proj, "a.txt"), "hello\n");
    fs.writeFileSync(path.join(proj, "src", "b.ts"), "export const b = 1;\n");
    fs.writeFileSync(path.join(proj, "Zeta.md"), "# z\n");
    fs.writeFileSync(path.join(proj, "bin.dat"), Buffer.from([1, 0, 2]));
    fs.writeFileSync(path.join(proj, "big.txt"), Buffer.alloc(FILE_MAX + 1, 120));
    fs.writeFileSync(path.join(proj, ".DS_Store"), "x");
    fs.mkdirSync(path.join(proj, ".git"));
    fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
    fs.symlinkSync(outside, path.join(proj, "escape"));
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(proj, "esc.txt"));
    fs.symlinkSync("src", path.join(proj, "inlink"));
    const ws = { sessions: new Map(), workspaces: new Set(), comms: [], out: [], seq: 0, settings: { ...DEFAULTS, aiSummaries: false } };
    apply(ws, { session_id: "w1", cwd: proj, hook_event_name: "UserPromptSubmit", prompt: "go" });
    const refused = (p) => p.then(() => "resolved", (e) => e.reply?.error || e.message);
    // Roots: a chat's folder, or a folder the user opened; nothing else.
    assert.equal(await projectRoot(ws, proj), proj);
    assert.equal(await projectRoot(ws, `${proj}/`), proj);
    assert.match(await refused(projectRoot(ws, outside)), /not one of your projects/);
    assert.match(await refused(projectRoot(ws, "proj")), /project folder/);
    assert.match(await refused(projectRoot(ws, W)), /not one of your projects/, "a parent of a project is not a project");
    assert.match(await refused(openWorkspace(ws, path.join(W, "nope"))), /does not exist/);
    assert.match(await refused(openWorkspace(ws, path.join(proj, "a.txt"))), /not a folder/);
    assert.match(await refused(openWorkspace(ws, "relative")), /full path/);
    assert.deepEqual(await openWorkspace(ws, `${outside}/`), { ok: true, root: outside });
    assert.equal(await projectRoot(ws, outside), outside);
    ws.workspaces.delete(outside);
    // Paths: nothing absolute, no "..", no symlink out of the root; links that stay inside are fine.
    for (const bad of ["../outside/secret.txt", "src/../../outside", "src/../a.txt", "..", "/etc/passwd", "a\0b"]) assert.throws(() => relPath(bad), /outside the project/, bad);
    assert.deepEqual(["", ".", "./", "src/", "./src//b.ts"].map(relPath), ["", "", "", "src", "src/b.ts"]);
    assert.match(await refused(realIn(proj, "escape/secret.txt")), /outside/);
    assert.match(await refused(realIn(proj, "escape")), /outside/);
    assert.match(await refused(realIn(proj, "esc.txt")), /outside/);
    assert.match(await refused(realIn(proj, "escape/brand/new.txt")), /outside/, "a new file behind a link out");
    assert.equal(await realIn(proj, "inlink/b.ts"), path.join(proj, "src", "b.ts"));
    assert.equal(await realIn(proj, "src/new/c.ts"), path.join(proj, "src", "new", "c.ts"));
    assert.equal(await realIn(proj, "esc.txt", false), path.join(proj, "esc.txt"), "a link itself, not followed");
    // fs/list: folders (and links to folders) first, then files, case-insensitive; .git and .DS_Store left out.
    const ls = await fsList(ws, proj, "");
    assert.deepEqual(ls.entries.map((e) => `${e.name}:${e.type}${e.target ? `>${e.target}` : ""}`), ["escape:link>dir", "inlink:link>dir", "src:dir", "a.txt:file", "big.txt:file", "bin.dat:file", "esc.txt:link>file", "Zeta.md:file"]);
    assert.deepEqual(ls.entries.find((e) => e.name === "a.txt"), { name: "a.txt", path: "a.txt", type: "file", size: 6, ignored: false });
    assert.deepEqual((await fsList(ws, proj, "inlink")).entries.map((e) => e.path), ["inlink/b.ts"]);
    assert.equal((await fsList(ws, proj, "src/")).dir, "src");
    for (const bad of ["escape", "../outside", "/tmp"]) assert.match(await refused(fsList(ws, proj, bad)), /outside/, bad);
    assert.match(await refused(fsList(ws, outside, "")), /not one of your projects/);
    // fs/read: text with its language; binary and over-2-MB files come back without text.
    const ra = await fsRead(ws, proj, "a.txt");
    assert.deepEqual([ra.text, ra.size, ra.binary, ra.tooLarge, ra.language, typeof ra.mtime], ["hello\n", 6, false, false, "plaintext", "number"]);
    assert.equal((await fsRead(ws, proj, "src/b.ts")).language, "typescript");
    assert.deepEqual(await fsRead(ws, proj, "bin.dat").then((r) => [r.binary, r.text]), [true, null]);
    assert.deepEqual(await fsRead(ws, proj, "big.txt").then((r) => [r.tooLarge, r.text, r.size]), [true, null, FILE_MAX + 1]);
    assert.match(await refused(fsRead(ws, proj, "esc.txt")), /outside/);
    assert.match(await refused(fsRead(ws, proj, "src")), /folder/);
    assert.equal(failure(await fsRead(ws, proj, "nope.txt").catch((e) => e)).error, "No such file or folder");
    assert.deepEqual(["x.tsx", "x.JSX", "x.md", "x.py", "x.yml", "x.toml", "Dockerfile", "x.sh", "x.weird", "noext"].map(language), ["typescript", "javascript", "markdown", "python", "yaml", "ini", "dockerfile", "shell", "plaintext", "plaintext"]);
    // fs/write: only over the version the page read (same mtime), atomically, keeping permissions; mtime null creates.
    fs.chmodSync(path.join(proj, "a.txt"), 0o754);
    fs.utimesSync(path.join(proj, "a.txt"), 1000, 1000);
    const w1 = await fsWrite(ws, { root: proj, path: "a.txt", text: "hi\n", mtime: 1_000_000 });
    assert.equal(w1.ok, true);
    assert.equal(fs.readFileSync(path.join(proj, "a.txt"), "utf8"), "hi\n");
    assert.equal(fs.statSync(path.join(proj, "a.txt")).mode & 0o777, 0o754);
    assert.equal(w1.mtime, fs.statSync(path.join(proj, "a.txt")).mtimeMs);
    const w2 = await fsWrite(ws, { root: proj, path: "a.txt", text: "lost", mtime: 1_000_000 });
    assert.deepEqual([w2.ok, w2.conflict, w2.mtime], [false, true, w1.mtime]);
    assert.equal((await fsWrite(ws, { root: proj, path: "a.txt", text: "lost" })).conflict, true, "an existing file needs its mtime");
    assert.equal(fs.readFileSync(path.join(proj, "a.txt"), "utf8"), "hi\n");
    assert.equal((await fsWrite(ws, { root: proj, path: "src/new/c.ts", text: "new", mtime: null })).ok, true);
    assert.equal(fs.readFileSync(path.join(proj, "src", "new", "c.ts"), "utf8"), "new");
    assert.equal((await fsWrite(ws, { root: proj, path: "gone.txt", text: "x", mtime: 5 })).conflict, true, "deleted on disk since it was read");
    assert.equal((await fsWrite(ws, { root: proj, path: "inlink/b.ts", text: "via link", mtime: fs.statSync(path.join(proj, "src", "b.ts")).mtimeMs })).ok, true);
    assert.equal(fs.readFileSync(path.join(proj, "src", "b.ts"), "utf8"), "via link", "a link inside the root writes its target");
    assert.equal(fs.lstatSync(path.join(proj, "inlink")).isSymbolicLink(), true);
    for (const bad of ["escape/secret.txt", "escape/new.txt", "../outside/x.txt"]) assert.match(await refused(fsWrite(ws, { root: proj, path: bad, text: "pwned", mtime: null })), /outside/, bad);
    assert.equal(fs.readFileSync(path.join(outside, "secret.txt"), "utf8"), "secret");
    assert.deepEqual(fs.readdirSync(path.join(proj, "src")).sort(), ["b.ts", "new"], "no temp files left behind");
    assert.match(await refused(fsWrite(ws, { root: proj, path: "a.txt", mtime: w1.mtime })), /Nothing to write/);

    // Git: a repository whose "app" folder is the root, so paths come back relative to it, and a bare repo as origin.
    const repo = path.join(W, "repo"), app = path.join(repo, "app"), bare = path.join(W, "origin.git");
    const sh = (cwd, ...a) => execFileSync("git", a, { cwd, stdio: "pipe" }).toString();
    fs.mkdirSync(app, { recursive: true });
    sh(repo, "init", "-q", "-b", "main");
    for (const [k, v] of [["user.name", "Pulse Test"], ["user.email", "test@pulse.local"], ["commit.gpgsign", "false"], ["core.hooksPath", path.join(W, "no-hooks")]]) sh(repo, "config", k, v);
    fs.writeFileSync(path.join(repo, ".gitignore"), "*.log\nbuild/\n");
    fs.writeFileSync(path.join(repo, "top.txt"), "top\n");
    for (const [name, text] of [["keep.txt", "one\n"], ["gone.txt", "bye\n"], ["[id].txt", "x\n"], ["i.txt", "i\n"]]) fs.writeFileSync(path.join(app, name), text);
    sh(repo, "add", "-A");
    sh(repo, "commit", "-qm", "init");
    fs.appendFileSync(path.join(app, "keep.txt"), "two\n");
    fs.rmSync(path.join(app, "gone.txt"));
    fs.writeFileSync(path.join(app, "new file.txt"), "fresh\n");
    fs.writeFileSync(path.join(app, "debug.log"), "noise\n");
    fs.mkdirSync(path.join(app, "build"));
    fs.writeFileSync(path.join(app, "build", "out.js"), "built\n");
    fs.appendFileSync(path.join(repo, "top.txt"), "changed\n");
    apply(ws, { session_id: "w3", cwd: app, hook_event_name: "UserPromptSubmit", prompt: "go" });
    await openWorkspace(ws, repo);
    const gs = await gitStatus(ws, app);
    assert.deepEqual([gs.repo, gs.branch, gs.upstream, gs.ahead, gs.behind], [true, "main", null, 0, 0]);
    assert.deepEqual(gs.files, [{ path: "gone.txt", status: "D", staged: false }, { path: "keep.txt", status: "M", staged: false }, { path: "new file.txt", status: "?", staged: false }], "only the root's files, named from the root");
    assert.deepEqual((await gitStatus(ws, repo)).files.map((f) => f.path), ["app/gone.txt", "app/keep.txt", "app/new file.txt", "top.txt"]);
    assert.deepEqual(await gitStatus(ws, proj), { ok: true, repo: false, branch: "", upstream: null, ahead: 0, behind: 0, files: [] });
    assert.deepEqual((await fsList(ws, app, "")).entries.filter((e) => e.ignored).map((e) => e.name), ["build", "debug.log"]);
    assert.deepEqual((await fsList(ws, app, "build")).entries.map((e) => e.ignored), [true], "inside an ignored folder");
    assert.deepEqual(await gitDiff(ws, app, "keep.txt"), { ok: true, path: "keep.txt", before: "one\n", after: "one\ntwo\n", binary: false, tooLarge: false });
    assert.deepEqual(await gitDiff(ws, app, "gone.txt").then((d) => [d.before, d.after]), ["bye\n", ""]);
    assert.deepEqual(await gitDiff(ws, app, "new file.txt").then((d) => [d.before, d.after]), ["", "fresh\n"]);
    assert.match(await refused(gitDiff(ws, app, "../top.txt")), /outside/);
    // Commit messages without AI: a plain line naming the files.
    assert.deepEqual(await gitMessage(ws, { root: app }), { ok: true, message: "Update 3 files: gone.txt, keep.txt, new file.txt", source: "fallback" });
    assert.equal((await gitMessage(ws, { root: app, paths: ["keep.txt"] })).message, "Update keep.txt");
    assert.equal(commitText('```\nfeat(voice): retry failed Kokoro renders once before giving up on the line entirely.\n\nRestart the worker first.\n```'), "feat(voice): retry failed Kokoro renders once before giving up on the\n\nRestart the worker first.");
    assert.equal(commitText("  "), null);
    // Commit only the chosen paths, taken literally ("[id].txt" is not a pattern that also matches "i.txt").
    fs.appendFileSync(path.join(app, "[id].txt"), "y\n");
    fs.appendFileSync(path.join(app, "i.txt"), "j\n");
    const k1 = await gitCommit(ws, { root: app, message: "fix: keep two\n\nAnd a new file.", paths: ["keep.txt", "new file.txt", "[id].txt"] });
    assert.equal(k1.ok, true, k1.error);
    assert.match(k1.commit, /^[0-9a-f]{7,}$/);
    assert.match(k1.summary, /3 files changed/);
    assert.equal(sh(repo, "log", "-1", "--format=%B").trim(), "fix: keep two\n\nAnd a new file.");
    assert.deepEqual((await gitStatus(ws, app)).files.map((f) => f.path), ["gone.txt", "i.txt"]);
    assert.match(sh(repo, "status", "--porcelain"), /top\.txt/, "a subfolder root never commits files outside it");
    const k2 = await gitCommit(ws, { root: app, message: "fix: nothing", paths: ["keep.txt"] });
    assert.equal(k2.ok, false);
    assert.ok(k2.error);
    assert.match(await refused(gitCommit(ws, { root: app, message: "   " })), /message/);
    assert.match(await refused(gitCommit(ws, { root: app, message: "x", paths: ["../top.txt"] })), /outside/);
    // Everything at the top of the repo; then push to a bare origin: the first push sets the upstream.
    const k3 = await gitCommit(ws, { root: repo, message: "chore: the rest" });
    assert.equal(k3.ok, true, k3.error);
    assert.deepEqual((await gitStatus(ws, repo)).files, []);
    assert.equal((await gitCommit(ws, { root: repo, message: "chore: again" })).ok, false, "nothing to commit");
    execFileSync("git", ["init", "-q", "--bare", bare]);
    sh(repo, "remote", "add", "origin", bare);
    const p1 = await gitPush(ws, { root: app });
    assert.equal(p1.ok, true, p1.error);
    assert.equal(execFileSync("git", ["--git-dir", bare, "rev-parse", "main"]).toString(), sh(repo, "rev-parse", "HEAD"));
    let gs2 = await gitStatus(ws, repo);
    assert.deepEqual([gs2.upstream, gs2.ahead], ["origin/main", 0]);
    fs.appendFileSync(path.join(repo, "top.txt"), "more\n");
    assert.equal((await gitCommit(ws, { root: repo, message: "docs: more" })).ok, true);
    gs2 = await gitStatus(ws, repo);
    assert.deepEqual([gs2.ahead, gs2.behind], [1, 0]);
    assert.equal((await gitPush(ws, { root: repo })).ok, true);
    assert.equal((await gitStatus(ws, repo)).ahead, 0);
    sh(repo, "remote", "set-url", "origin", path.join(W, "missing.git"));
    fs.appendFileSync(path.join(repo, "top.txt"), "again\n");
    await gitCommit(ws, { root: repo, message: "docs: again" });
    const p3 = await gitPush(ws, { root: repo });
    assert.equal(p3.ok, false);
    assert.match(p3.error, /missing\.git|does not appear|not found/i);
    for (const fn of [gitPush, gitCommit, gitMessage]) assert.match(await refused(fn(ws, { root: proj, message: "x" })), /not a git repository/);

    // Agent changes: the exact edits a chat made, from its transcripts (main and subagents), successful calls only.
    const tr0 = path.join(W, "t", "sess.jsonl"), subDir = path.join(W, "t", "sess", "subagents");
    fs.mkdirSync(subDir, { recursive: true });
    const call = (s, id, name, input, more) => A(s, [{ type: "tool_use", id, name, input }], more);
    const result = (s, id, is_error, more) => U(s, [{ type: "tool_result", tool_use_id: id, content: is_error ? "String not found" : "ok", ...(is_error ? { is_error } : {}) }], more);
    const fa = path.join(proj, "a.txt"), big = "x".repeat(EDIT_MAX + 10);
    fs.writeFileSync(tr0, [
        call(1, "e1", "Edit", { file_path: fa, old_string: "hello", new_string: "hi", replace_all: false }), result(2, "e1"),
        call(3, "e2", "Edit", { file_path: fa, old_string: "zzz", new_string: "y" }), result(4, "e2", true),
        call(5, "e3", "Write", { file_path: path.join(proj, "src", "c.ts"), content: big }), result(6, "e3"),
        call(7, "e4", "MultiEdit", { file_path: "/elsewhere/z.js", edits: [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: "d" }] }), result(8, "e4"),
        call(9, "e5", "Edit", { file_path: fa, old_string: "hi", new_string: "never answered" }),
        call(10, "e6", "Edit", { file_path: fa, old_string: "sub", new_string: "line" }, { isSidechain: true }),
    ].map((x) => JSON.stringify(x)).join("\n") + "\n");
    fs.writeFileSync(path.join(subDir, "agent-sub1.jsonl"), [
        call(4, "s1", "Edit", { file_path: fa, old_string: "hi", new_string: "hey" }, { isSidechain: true }), result(5, "s1", false, { isSidechain: true }),
        call(6, "s2", "NotebookEdit", { notebook_path: path.join(proj, "n.ipynb"), new_source: "print(1)" }, { isSidechain: true }), result(7, "s2", false, { isSidechain: true }),
    ].map((x) => JSON.stringify(x)).join("\n") + "\n");
    fs.writeFileSync(path.join(subDir, "agent-sub1.meta.json"), "{}");
    apply(ws, { session_id: "w2", cwd: proj, transcript_path: tr0, hook_event_name: "UserPromptSubmit", prompt: "go" });
    const ch = await agentChanges(ws, "w2");
    const T = (s) => Date.parse(at(s));
    assert.deepEqual(ch.files.map((f) => [f.path, f.rel, f.edits.length]), [[fa, "a.txt", 2], [path.join(proj, "src", "c.ts"), "src/c.ts", 1], [path.join(proj, "n.ipynb"), "n.ipynb", 1], ["/elsewhere/z.js", null, 2]]);
    assert.deepEqual(ch.files[0].edits, [{ t: T(1), agent: "main", tool: "Edit", kind: "edit", before: "hello", after: "hi" }, { t: T(4), agent: "sub1", tool: "Edit", kind: "edit", before: "hi", after: "hey" }], "oldest first, failed and unanswered calls left out");
    assert.deepEqual([ch.files[1].edits[0].kind, ch.files[1].edits[0].before, ch.files[1].edits[0].after.length], ["write", "", EDIT_MAX]);
    assert.deepEqual(ch.files[2].edits[0], { t: T(6), agent: "sub1", tool: "NotebookEdit", kind: "edit", before: "", after: "print(1)" });
    assert.deepEqual(ch.files[3].edits.map((e) => e.after), ["b", "d"]);
    assert.deepEqual((await agentChanges(ws, "w2", "sub1")).files.map((f) => f.rel), ["a.txt", "n.ipynb"]);
    assert.deepEqual((await agentChanges(ws, "w2", "main")).files.map((f) => f.edits.length), [1, 1, 2]);
    assert.deepEqual((await agentChanges(ws, "w2", "nobody")).files, []);
    assert.match(await refused(agentChanges(ws, "w2", "../../x")), /Unknown agent/);
    assert.match(await refused(agentChanges(ws, "nope")), /not on the board/);
    // Appended edits show up on the next call (the transcript cache reads only new bytes), and the page's view is unchanged.
    fs.appendFileSync(tr0, [call(11, "e7", "Write", { file_path: path.join(proj, "d.md"), content: "# d" }), result(12, "e7")].map((x) => JSON.stringify(x)).join("\n") + "\n");
    assert.equal((await agentChanges(ws, "w2", "main")).files.at(-1).rel, "d.md");
    assert.equal(readTranscript(tr0).entries.filter((e) => e.kind === "tool").length, 6);
    assert.equal("edits" in readTranscript(tr0), false, "the conversation view does not carry the edits");

    // Welcome: time of day, then what is online.
    const quiet = { sessions: new Map() };
    const hour = (h) => new Date(2026, 8, 29, h).getTime();
    assert.equal(welcomeText(quiet, hour(19), () => 0), "Good evening. Welcome to the command center. All quiet; your crew is standing by.");
    assert.match(welcomeText({ ...quiet, settings: { address: "Boss" } }, hour(19), () => 0), /^Good evening, Boss\. Welcome/, "the address setting reaches the greeting");
    assert.equal(cleanAddress("  <b>Dr. Ana-Maria</b> ; drop  "), "bDr. Ana-Mariab drop", "only letters, digits, spaces and ' . - survive");
    assert.equal(welcomeText(quiet, hour(2), () => 0.99), "Good evening. The command center is at your service. No agents are at work just now; the crew is standing by.");
    const busy = { sessions: new Map(), seq: 0, settings: ws.settings, out: [] };
    for (const [sid, cwd] of [["b1", "/x/orbit-web"], ["b2", "/x/api"], ["b3", "/x/api"]]) apply(busy, { session_id: sid, cwd, hook_event_name: "UserPromptSubmit", prompt: "go" });
    apply(busy, { session_id: "b1", cwd: "/x/orbit-web", hook_event_name: "SubagentStart", agent_id: "q1", agent_type: "Explore" });
    apply(busy, { session_id: "b3", cwd: "/x/api", hook_event_name: "Notification", notification_type: "permission_prompt", message: "Allow?" });
    assert.equal(welcomeText(busy, hour(9), () => 0), "Good morning. Welcome to the command center. Three agents are at work across two projects, and one is waiting for you.");
    busy.sessions.delete("b2");
    busy.sessions.delete("b1");
    assert.equal(welcomeText(busy, hour(14), () => 0), "Good afternoon. Welcome to the command center. One agent is waiting for you in api.");

    // Workspaces survive a restart, even when the board itself is too old to reload.
    const stateFile = path.join(W, "state.json");
    saveState({ sessions: new Map(), workspaces: new Set([repo]), comms: [], seq: 0 }, stateFile);
    fs.writeFileSync(stateFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(stateFile, "utf8")), savedAt: 0 }));
    const back = { sessions: new Map(), workspaces: new Set(), comms: [], seq: 0 };
    loadState(back, stateFile);
    assert.deepEqual([[...back.workspaces], back.sessions.size], [[repo], 0]);

    // Voice: a worker that dies is restarted and the line tried again; one that keeps failing gives up with null.
    const fake = path.join(W, "fake-voice.js"), marker = path.join(W, "crashed-once");
    fs.writeFileSync(fake, `const fs = require("fs");
console.log("ready fake");
require("readline").createInterface({ input: process.stdin }).on("line", (l) => {
    const job = JSON.parse(l);
    if (job.text.includes("always")) return console.log("err no voice today");
    if (!fs.existsSync(${JSON.stringify(marker)})) { fs.writeFileSync(${JSON.stringify(marker)}, ""); process.exit(1); }
    fs.writeFileSync(job.out, "RIFF"); console.log("ok " + job.out);
});`);
    const v = createVoice([process.execPath, fake]);
    const logged = [], realError = console.error;
    console.error = (...a) => logged.push(a.join(" "));
    try {
        assert.equal(String(await v.render("hello sir", "af_heart", 1)), "RIFF");
        assert.deepEqual([v.detail().failures, v.detail().lastError], [1, "worker exited (1)"]);
        assert.equal(String(await v.render("again", "af_heart", 1)), "RIFF", "the restarted worker keeps working");
        assert.equal(await v.render("always fails", "af_heart", 1), null);
        assert.equal(v.detail().failures, 3);
        assert.equal(logged.length, 3);
        assert.match(logged[2], /giving up/);
        // Stopped on purpose mid-line: no retry, nothing logged.
        const pending = v.render("hello", "af_heart", 1);
        v.stop();
        assert.equal(await pending, null);
        assert.equal(logged.length, 3);
    } finally { console.error = realError; v.stop(); }
    assert.equal(await createVoice(null).render("x"), null, "no Kokoro: the page speaks for itself");

    fs.rmSync(W, { recursive: true, force: true });
    // An idle reminder after a finished turn is not a request: the chat stays idle instead of turning "needs you".
    {
        const idle = { sessions: new Map(), comms: [], out: [], seq: 0, settings: { ...DEFAULTS } };
        const I = { session_id: "idle1", cwd: "/x/idle" };
        apply(idle, { ...I, hook_event_name: "UserPromptSubmit", prompt: "hello" }, 1000);
        apply(idle, { ...I, hook_event_name: "Stop" }, 2000);
        apply(idle, { ...I, hook_event_name: "Notification", notification_type: "idle_prompt", message: "Claude is waiting for your input" }, 62_000);
        assert.equal(idle.sessions.get("idle1").agents.get("main").status, "idle");
        apply(idle, { ...I, hook_event_name: "Notification", notification_type: "permission_prompt", message: "Allow Bash?" }, 63_000);
        assert.equal(idle.sessions.get("idle1").agents.get("main").status, "needs-you");
    }
    // A chat that works alone (no subagents) still gets its summary when the turn stops, and a new prompt clears it.
    {
        const solo = { sessions: new Map(), comms: [], out: [], seq: 0, settings: { ...DEFAULTS } };
        const file = path.join(os.tmpdir(), `pulse-solo-${process.pid}.jsonl`);
        fs.writeFileSync(file, JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: `Done.\n\n${PULSE_MARK} Fixed the merge bug` }] } }));
        const Q = { session_id: "solo", cwd: "/x/solo", transcript_path: file };
        apply(solo, { ...Q, hook_event_name: "UserPromptSubmit", prompt: "fix it" }, 1000);
        apply(solo, { ...Q, hook_event_name: "Stop" }, 2000);
        const me = solo.sessions.get("solo").agents.get("main");
        assert.equal(me.summary, "Fixed the merge bug");
        apply(solo, { ...Q, hook_event_name: "UserPromptSubmit", prompt: "next" }, 3000);
        assert.equal(me.summary, "");
        fs.rmSync(file);
    }
    // Burn: dollars from a transcript's usage lines. A message id repeats per content block (counted once), and a chat adds its subagents.
    {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pulse-burn-")), main = path.join(dir, "s9.jsonl");
        const line = (id, model, u, ts) => JSON.stringify({ type: "assistant", timestamp: ts, message: { id, model, usage: u } });
        fs.writeFileSync(main, [
            line("m1", "claude-sonnet-4-6", { input_tokens: 1000, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, "2026-01-01T00:00:00Z"),
            line("m1", "claude-sonnet-4-6", { input_tokens: 1000000, output_tokens: 1000000, cache_read_input_tokens: 1000000, cache_creation_input_tokens: 1000000, cache_creation: { ephemeral_5m_input_tokens: 400000, ephemeral_1h_input_tokens: 600000 } }, "2026-01-01T00:00:01Z"),
            "not json with \"usage\"",
        ].join("\n") + "\n");
        fs.mkdirSync(path.join(dir, "s9", "subagents"), { recursive: true });
        fs.writeFileSync(path.join(dir, "s9", "subagents", "agent-a1.jsonl"), line("m2", "claude-haiku-4-5", { input_tokens: 1000000, output_tokens: 0 }, "2026-01-01T00:00:02Z") + "\n");
        const sess = { transcript: main, agents: new Map([["main", { id: "main" }], ["a1", { id: "a1" }]]) };
        const own = burnFor(sess, sess.agents.get("a1")), crew = burnFor(sess, sess.agents.get("main"));
        assert.equal(own.dollars, 1); // 1M haiku input at $1
        assert.equal(own.crew, false);
        // sonnet 4.6: 3 + 15 + 0.3 (read) + 0.4 * 3.75 + 0.6 * 6 = 23.4, plus the haiku agent's $1
        assert.ok(Math.abs(crew.dollars - 24.4) < 1e-9, `crew dollars ${crew.dollars}`);
        assert.equal(crew.calls, 2);
        assert.equal(crew.write, 1000000);
        assert.equal(crew.crew, true);
        assert.ok(Math.abs(crew.series.at(-1) - crew.dollars) < 1e-9);
        fs.rmSync(dir, { recursive: true, force: true });
    }
    // Plan limits: read from the status line's rate_limits; a window past its reset reads as 0 %.
    {
        assert.equal(parseLimits({ model: { display_name: "Opus" } }), null);
        const l = parseLimits({ rate_limits: { five_hour: { used_percentage: 41.6, resets_at: 2000 }, seven_day: { used_percentage: 120, resets_at: 9000 } } }, 5);
        assert.deepEqual(l, { at: 5, five: { pct: 41.6, resetsAt: 2_000_000 }, week: { pct: 100, resetsAt: 9_000_000 } });
        assert.equal(limitsLine(l, 1_000_000), "5h 42% · week 100%");
        assert.equal(limitsLine(l, 3_000_000), "5h 0% · week 100%");
        assert.equal(limitsLine(parseLimits({ rate_limits: { seven_day: { used_percentage: 3 } } })), "week 3%");
        assert.equal(limitsLine(null), "");
    }
    console.log("selftest ok");
}

if (process.argv.includes("--test")) selftest().catch((e) => { console.error(e); process.exit(1); });
else start();
