// Pulse's spoken lines, written the way a calm, capable assistant talks to someone who may be listening rather than
// looking: whole sentences, the task named plainly, how it ended, nothing else. No results read out, no jokes, no chatter.
// Pulse speaks as "I" for your own chat ("That's the login fix done."), and by name for a helper agent ("Atlas has
// finished the voice template count."). Picked so the same words don't come back to back; a short sound (earcon) before
// a line says what kind of news it is before a word is heard.
// Pure: the memory and the random source are passed in, so the self-test can pin every choice down.
"use strict";

// Subagents take the first free name, in this order, so the first one out is nearly always Atlas and the second Echo.
// Twelve names with different first sounds, one or two syllables, easy to tell apart by ear.
const CALLSIGNS = ["Atlas", "Echo", "Nova", "Rook", "Juno", "Pike", "Vega", "Onyx", "Kite", "Mako", "Ivy", "Zed"];

const NUMBERS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
const count = (n) => NUMBERS[n] || String(n);
const upFirst = (t) => String(t).replace(/^./u, (c) => c.toUpperCase());
const lowFirst = (t) => String(t).replace(/^./u, (c) => c.toLowerCase());
const names = (xs) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

// Text a voice can read: no links, no paths (the last part only), no file extensions, no markdown.
function speakable(text) {
    return String(text ?? "")
        .replace(/https?:\/\/\S+/g, "a link")
        .replace(/(?<![\w/])(?:~|\.{1,2})?(?:\/[\w.@-]+)+\/?|\b[\w.@-]+(?:\/[\w@-]+)*\/[\w@-]+\.\w+\b/g, (p) => p.split("/").filter(Boolean).pop() || "")
        .replace(/\b([\w-]+)\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|kt|swift|css|scss|html?|json|ya?ml|toml|md|sh|txt|lock)\b/gi, "$1")
        .replace(/[`*#>~|]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}
// A task as spoken: plain words, no "I've" in front, no closing full stop, at most 20 words (agents are asked for 8).
function tidyTask(text) {
    const words = speakable(text).replace(/^(?:I|we|it)(?:'ve| have)?\s+/i, "").replace(/[.;:,!]+$/, "").split(" ").filter(Boolean);
    return words.slice(0, 20).join(" ");
}

// Agents name their task as a noun phrase ("the voice template count"), which fits any sentence: "Atlas has finished the
// voice template count", "I couldn't finish the login fix". Chats from before this rule end with a past-tense phrase
// ("cleaned up the tree") or an order ("map the pipeline"), and a spawn's description is an order too; each gets
// sentences that fit it. This tells the three apart.
const NOUN = /^(the|a|an|this|that|these|those|your|my|our|its|his|her|their|some|all|both|each|every)\b/i;
const NOT_PAST = /^(embed|feed|need|seed|speed|shed|bleed|breed|proceed|succeed|exceed)\b/i;
const PAST = /^(\w+ed|couldn't|could not|can't|cannot|didn't|did|wasn't|was|were|got|made|found|built|wrote|ran|set|put|took|gave|kept|left|sent|spent|cut|hit|shut|broke|drew|began|came|went|saw|told|thought|brought|caught|won|lost|held|led|met|paid|said|stood|understood|dug|fought|forgot|froze|grew|hid|knew|laid|lit|meant|rode|rose|sat|slept|spoke|stole|stuck|swept|threw|tore|woke|split|spun|redid|rebuilt|rewrote|reran)\b/i;
function formOf(task) {
    if (!task) return "bare";
    if (NOUN.test(task)) return "noun";
    if (PAST.test(task) && !NOT_PAST.test(task)) return "did";
    return "job";
}

// What an agent's closing marker line says: `done | the voice template count`. A line from before the outcome words
// existed is kept as the task, with no outcome.
const OUTCOMES = { done: "done", failed: "failed", blocked: "blocked", "needs you": "needs", needs: "needs", stopped: "stopped" };
function parseFinish(line) {
    if (!line) return null;
    const m = /^\s*(done|failed|blocked|needs you|needs|stopped)\s*[|:·\-–—]\s*(.*)$/i.exec(line);
    if (m) return { outcome: OUTCOMES[m[1].toLowerCase()], task: tidyTask(m[2]) };
    return { outcome: null, task: tidyTask(line) };
}
const OUTCOME_WORD = { done: "Done", failed: "Failed", blocked: "Blocked", needs: "Needs you", stopped: "Stopped" };
// The Summary card's text for a finish: "Done · the voice template count".
const summaryOf = (f) => (!f ? "" : f.outcome ? `${OUTCOME_WORD[f.outcome]}${f.task ? ` · ${f.task}` : ""}` : f.task);

// Templates, one list per form of the task: {task} is a noun phrase, {did} a past-tense phrase, {job} an order, and
// "bare" is for when there is no task at all. {Task} is {task} with a capital. {names} is a spoken list, {all} "both" or
// "all three". Every kind has a "bare" list, so a line always has something to say.
const BANK = {
    // Helpers sent out on your task. Nothing is said when you send a prompt, so this is the first line of a task.
    joinOne: { job: ["I've sent {who} to {job}.", "{who} is going to {job}."], bare: ["I've sent {who} out on it.", "{who} is on it now."] },
    joinMany: { bare: ["I've sent out {names}.", "{names} are on it now."] },

    // A helper agent's finish, by name.
    done: {
        noun: ["{who} has finished {task}.", "{who} is done with {task}.", "{who} has wrapped up {task}."],
        did: ["{who} {did}.", "{who} is done. It {did}."],
        job: ["{who} has finished. It was asked to {job}.", "{who} is done with its part."],
        bare: ["{who} has finished.", "{who} is done."],
    },
    failed: {
        noun: ["{who} couldn't finish {task}.", "{who} ran into trouble with {task}.", "{who} got stuck on {task} and had to stop."],
        did: ["{who} ran into trouble. It {did}.", "{who} couldn't finish. It {did}."],
        job: ["{who} ran into trouble. It was trying to {job}.", "{who} couldn't finish. It was asked to {job}."],
        bare: ["{who} ran into trouble.", "{who} couldn't finish."],
    },
    blocked: {
        noun: ["{who} is stuck on {task}.", "{who} can't go further with {task} without help."],
        did: ["{who} is stuck. It {did}."],
        job: ["{who} is stuck. It was trying to {job}."],
        bare: ["{who} is stuck.", "{who} can't go further without help."],
    },
    needs: {
        noun: ["{who} needs you for {task}.", "{who} is waiting on you about {task}.", "{who} has a question about {task}."],
        did: ["{who} {did}.", "{who} is waiting on you. It {did}."],
        job: ["{who} is waiting on you. It's working on {job}."],
        bare: ["{who} is waiting on you.", "{who} needs a word with you."],
    },
    // A permission prompt: {job} is what it wants to do ("run the tests").
    permission: { job: ["{who} has been waiting for your permission to {job}.", "{who} is still waiting to {job}. It needs your approval."], bare: ["{who} has been waiting for your permission for a while now."] },
    stopped: { bare: ["{who} has stopped, as you asked.", "{who} has stood down."] },

    // Your own chat's finish, in the first person.
    mainDone: {
        noun: ["That's {task} done.", "{Task} is done.", "I've finished {task}.", "All done. {Task} is finished."],
        did: ["Done. I {did}.", "All done. I {did}."],
        job: ["All done.", "That's done."],
        bare: ["All done.", "That's done.", "Finished."],
    },
    mainFailed: {
        noun: ["I couldn't finish {task}.", "I ran into trouble with {task}.", "{Task} didn't work out, I'm afraid."],
        did: ["I ran into trouble. I {did}."],
        job: ["I ran into trouble with that, I'm afraid."],
        bare: ["I ran into trouble with that, I'm afraid.", "That didn't work out."],
    },
    mainBlocked: {
        noun: ["I'm stuck on {task}.", "I can't go further with {task} without you."],
        did: ["I'm stuck. I {did}."],
        job: ["I'm stuck on that one."],
        bare: ["I'm stuck on that one.", "I can't go further without you."],
    },
    mainPermission: { job: ["I've been waiting for your approval to {job}.", "Still waiting on your approval. I'd like to {job}."], bare: ["I've been waiting for your approval for a while now."] },
    mainNeeds: {
        noun: ["I need your input on {task}.", "I have a question for you about {task}.", "Before I go on with {task}, I need you."],
        did: ["I need you. I {did}."],
        job: ["I need your input before I go on."],
        bare: ["I need your input before I go on.", "I have a question for you."],
    },

    // The end of a task that had a crew of two or more.
    wrapAll: {
        noun: ["{Task} is done, and {all} finished cleanly.", "That's {task} done. {All} came back without a problem.", "All done. {Task} is finished, and the whole crew came back clean."],
        bare: ["All done, and {all} finished cleanly.", "Everyone's back, and it all went well.", "That's everything done. {All} came back without a problem."],
    },
    wrapMixed: {
        noun: ["{Task} is done, but {tally}.", "That's {task} finished, though {tally}."],
        bare: ["Everyone's back, but {tally}.", "That's everything back, though {tally}."],
    },
};
// The earcon each kind of line opens with. Acknowledgements get a soft tick; progress chatter gets nothing.
const EARCON = { ack: "tick", ackOne: "tick", ackMany: "tick", done: "done", failed: "fail", blocked: "fail", needs: "ask", permission: "ask", mainPermission: "ask", mainDone: "done", mainFailed: "fail", mainBlocked: "fail", mainNeeds: "ask", wrapAll: "wrap", wrapMixed: "fail" };

const REPEAT_GAP = 3; // a template is not reused within this many lines of its kind
const memory = () => ({ used: new Map(), sinceAddr: 2 });

function fill(tpl, v) {
    return tpl.split("|")
        .filter((part) => [...part.matchAll(/\{(\w+)\}/g)].every(([, k]) => v[k] !== undefined && v[k] !== ""))
        .map((part) => part.replace(/\{(\w+)\}/g, (_, k) => v[k]))
        .join(" ")
        .trim();
}

// One line of a kind. c: { who, task, job, names: [], lead, addr, tally }. Returns { text, earcon }.
// `task` is how the agent named its work; `job` is the order it was given, used when there is no task.
function say(kind, c, mem, rand = Math.random) {
    const bank = BANK[kind];
    if (!bank) return null;
    const task = c.task || "", form = task ? formOf(task) : c.job ? "job" : "bare";
    const list = bank[form] ? form : "bare";
    const job = form === "job" ? lowFirst(task || c.job) : "";
    const pool = bank[list].map((tpl, i) => [`${list}${i}`, tpl]);
    const used = mem.used.get(kind) || [];
    const fresh = pool.filter(([id]) => !used.includes(id));
    const from = fresh.length ? fresh : pool;
    const [id, tpl] = from[Math.min(from.length - 1, Math.floor(rand() * from.length))];
    used.push(id);
    while (used.length > Math.min(REPEAT_GAP, pool.length - 1)) used.shift();
    mem.used.set(kind, used);
    const n = c.n ?? c.names?.length ?? 0;
    const noun = form === "noun" ? lowFirst(task) : "";
    let text = upFirst(fill(tpl, { who: c.who, task: noun, Task: upFirst(noun), did: form === "did" ? task : "", job, names: names(c.names || []), all: n === 2 ? "both" : `all ${count(n)}`, All: n === 2 ? "Both" : `All ${count(n)}`, tally: c.tally || "" }));
    // With several projects busy, a line about your own chat says which ("Over in orbit web, that's the login fix done.");
    // now and then it uses the form of address you picked ("That's the login fix done, sir.").
    if (c.lead) text = `Over in ${c.lead}, ${lowFirst(text)}`;
    else if (c.addr && mem.sinceAddr >= 2 && rand() < 0.4) { text = `${text.replace(/[.!]$/, "")}, ${c.addr}.`; mem.sinceAddr = 0; }
    else mem.sinceAddr++;
    return { text, earcon: EARCON[kind] || null };
}

// How the ones that didn't finish cleanly did, as a clause: "Nova couldn't finish the server tests".
function trouble(list) {
    const verb = { failed: "couldn't finish", blocked: "is stuck on", needs: "needs you for" };
    return names(list.map((f) => {
        if (f.outcome === "stopped") return `${f.who} stopped`;
        const noun = f.task && formOf(f.task) === "noun" ? lowFirst(f.task) : "";
        if (noun) return `${f.who} ${verb[f.outcome]} ${noun}`;
        return `${f.who} ${f.outcome === "needs" ? "needs you" : f.outcome === "blocked" ? "is stuck" : "ran into trouble"}`;
    }));
}

// Several finishes landing together, said as one line: "Atlas and Echo have finished, but Nova couldn't finish the tests."
function batch(finishes, c = {}) {
    const done = finishes.filter((f) => (f.outcome || "done") === "done").map((f) => f.who);
    const bad = finishes.filter((f) => (f.outcome || "done") !== "done");
    const have = done.length === 1 ? "has" : "have";
    let text = !bad.length ? `${names(done)} have all finished.` : done.length ? `${names(done)} ${have} finished, but ${trouble(bad)}.` : `${upFirst(trouble(bad))}.`;
    if (c.lead) text = `Over in ${c.lead}, ${lowFirst(text)}`;
    const worst = bad.some((f) => f.outcome === "failed" || f.outcome === "blocked") ? "fail" : bad.some((f) => f.outcome === "needs") ? "ask" : "done";
    return { text, earcon: worst };
}

// The end of a task with a crew: the task, and how everyone did, in one line. The template the AI line falls back to.
function wrap(crew, c, mem, rand = Math.random) {
    const bad = crew.filter((f) => f.outcome && f.outcome !== "done");
    return bad.length ? say("wrapMixed", { ...c, n: crew.length, tally: trouble(bad) }, mem, rand) : say("wrapAll", { ...c, n: crew.length }, mem, rand);
}

// The first free callsign, given the ones in use. All twelve busy: the agent keeps its number.
const nextCall = (taken) => CALLSIGNS.find((x) => !taken.has(x)) || null;

module.exports = { CALLSIGNS, BANK, count, upFirst, lowFirst, names, speakable, tidyTask, formOf, parseFinish, summaryOf, memory, say, batch, wrap, nextCall, fill };
