/* Pulse workspace: browse a project's files, read and lightly edit them with real syntax highlighting, review every change
   side by side, commit and push, and see exactly what each agent changed. Three views share one state: the explorer and
   source control (both in the left sidebar) and the editor area (tabs over the center, with the graph as the first tab).
   Self-contained like terminal.js: no build step, loads Monaco from /vendor/monaco on first use, exposes window.PulseWorkspace. */
(() => {
"use strict";
if (window.PulseWorkspace) return;

// ============ Setup ============
const SRC = document.currentScript && document.currentScript.src;
const VS = new URL("/vendor/monaco/vs", SRC || location.href).href;
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const MOD = IS_MAC ? "⌘" : "Ctrl+";
const reduce = matchMedia("(prefers-reduced-motion: reduce)");
const FONT = '"Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
const K_EXP = "pulse.ws.expanded", K_TABS = "pulse.ws.tabs", K_PREFS = "pulse.ws.prefs";
const THROTTLE = 3000, MAX_TABS = 40, NARROW = 600;
const MISSING = "Pulse's file service isn't answering yet. Restart Pulse to load the new version.";
const MSG_PLACEHOLDER = "Commit message";

// ============ Helpers ============
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const norm = (p) => { const s = String(p || "").trim(); return s.length > 1 ? s.replace(/\/+$/, "") : s; };
const base = (p) => String(p || "").split("/").filter(Boolean).pop() || String(p || "");
const dirOf = (p) => { const s = String(p || ""), i = s.lastIndexOf("/"); return i > 0 ? s.slice(0, i) : i === 0 ? "/" : ""; };
const join = (a, b) => (!a ? b : a.endsWith("/") ? a + b : `${a}/${b}`);
const tilde = (p) => String(p || "").replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
const extOf = (name) => { const n = String(name).toLowerCase(), i = n.lastIndexOf("."); return i > 0 ? n.slice(i + 1) : ""; };
const inside = (p, root) => !!root && !!p && (p === root || p.startsWith(root === "/" ? "/" : `${root}/`));
const relTo = (abs, root) => (abs === root ? "" : abs.slice(root === "/" ? 1 : root.length + 1));
const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } };
const keep = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode: not remembered */ } };
const fmtSize = (n) => (!Number.isFinite(n) ? "" : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const clock = (t) => (t ? new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "");
const shortSha = (s) => String(s || "").slice(0, 7);
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const byName = (a, b) => ((a.type === "dir") !== (b.type === "dir") ? (a.type === "dir" ? -1 : 1) : collator.compare(a.name, b.name));
const splitLines = (s) => (s ? String(s).replace(/\r?\n$/, "").split(/\r?\n/) : []);
// Rough +/- line counts for a before/after pair (a multiset difference): cheap, and close to what a real diff reports.
function lineCounts(a, b) {
    const left = new Map();
    for (const l of splitLines(a)) left.set(l, (left.get(l) || 0) + 1);
    let add = 0, del = 0;
    for (const l of splitLines(b)) { const c = left.get(l) || 0; if (c) left.set(l, c - 1); else add++; }
    for (const c of left.values()) del += c;
    return { add, del };
}
const prefs = Object.assign({ grouped: true, inline: false, mode: "all" }, load(K_PREFS, {}));
const setPref = (k, v) => { prefs[k] = v; keep(K_PREFS, prefs); };

const svg = (d, cls = "") => `<svg${cls ? ` class="${cls}"` : ""} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const PAGE = '<path d="M13.5 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9z"/><path d="M13.5 3.5V9H19"/>';
const I = {
    chev: svg('<path d="m9.5 6.5 5.5 5.5-5.5 5.5"/>'),
    folder: svg('<path d="M3.5 7.5a2 2 0 0 1 2-2h3.7l2 2h7.3a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>'),
    folderOpen: svg('<path d="M3.5 17.5v-10a2 2 0 0 1 2-2h3.7l2 2h6.3a2 2 0 0 1 2 2v1"/><path d="M3.6 18.2 6 11.9a1.6 1.6 0 0 1 1.5-1h12.2a1 1 0 0 1 .95 1.35l-2.2 6a1.8 1.8 0 0 1-1.7 1.2H4.7a1.2 1.2 0 0 1-1.1-1.25z"/>'),
    file: svg(PAGE),
    code: svg('<path d="m8.5 7.5-4.5 4.5 4.5 4.5M15.5 7.5l4.5 4.5-4.5 4.5M13.3 5.5l-2.6 13"/>'),
    angle: svg('<path d="m9 6.5-5.5 5.5L9 17.5M15 6.5l5.5 5.5-5.5 5.5"/>'),
    braces: svg('<path d="M9 4.5c-1.9 0-2.8.9-2.8 2.6v2.3c0 1.2-.7 2-1.9 2.1v1c1.2.1 1.9.9 1.9 2.1v2.3c0 1.7.9 2.6 2.8 2.6M15 4.5c1.9 0 2.8.9 2.8 2.6v2.3c0 1.2.7 2 1.9 2.1v1c-1.2.1-1.9.9-1.9 2.1v2.3c0 1.7-.9 2.6-2.8 2.6"/>'),
    doc: svg(`${PAGE}<path d="M8.5 13h7M8.5 16.5h4.5"/>`),
    hash: svg('<path d="M10 4 8 20M16 4l-2 16M4.5 9h15M4 15h15"/>'),
    image: svg('<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="m20.5 16-4.8-4.8L6 19.5"/>'),
    shell: svg('<path d="m5 7.5 4.5 4.5L5 16.5M12 17h7"/>'),
    lock: svg('<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>'),
    git: svg('<circle cx="6.5" cy="6" r="2"/><circle cx="6.5" cy="18" r="2"/><circle cx="17.5" cy="8" r="2"/><path d="M6.5 8v8M17.5 10c0 3.5-4 4-9.3 6.8"/>'),
    pkg: svg('<path d="M12 3.5 19.5 7.5v9L12 20.5 4.5 16.5v-9z"/><path d="m4.5 7.5 7.5 4 7.5-4M12 11.5v9"/>'),
    gear: svg('<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>'),
    test: svg('<path d="M9.5 3.5h5M10.5 3.5v5.5L5.2 18a1.7 1.7 0 0 0 1.5 2.5h10.6a1.7 1.7 0 0 0 1.5-2.5L13.5 9V3.5"/><path d="M7.4 14.5h9.2"/>'),
    db: svg('<ellipse cx="12" cy="6" rx="7" ry="2.5"/><path d="M5 6v12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V6M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5"/>'),
    archive: svg('<rect x="3.5" y="4.5" width="17" height="5" rx="1.5"/><path d="M5 9.5v8.5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9.5M10 13.5h4"/>'),
    font: svg('<path d="M5 19 11 5h2l6 14M7.5 14h9"/>'),
    media: svg('<circle cx="12" cy="12" r="8.5"/><path d="m10 8.8 5 3.2-5 3.2z"/>'),
    license: svg('<path d="M12 4.5v15M7 19.5h10M6 8h12M6 8l-2.5 5.5a2.5 2.5 0 0 0 5 0zM18 8l-2.5 5.5a2.5 2.5 0 0 0 5 0z"/>'),
    x: svg('<path d="M7 7l10 10M17 7 7 17"/>'),
    refresh: svg('<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4"/>'),
    collapse: svg('<path d="M8.5 4.5h10a1 1 0 0 1 1 1v10"/><rect x="4.5" y="8.5" width="11" height="11" rx="2"/><path d="M7.5 14h5"/>'),
    search: svg('<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.3-4.3"/>'),
    branch: svg('<circle cx="6.5" cy="5.5" r="2"/><circle cx="6.5" cy="18.5" r="2"/><circle cx="17.5" cy="7.5" r="2"/><path d="M6.5 7.5v9M17.5 9.5c0 4-5.5 3.5-10.2 7.5"/>'),
    up: svg('<path d="M12 19V5M6 11l6-6 6 6"/>'),
    check: svg('<path d="m5 12.5 4.5 4.5L19 7.5"/>'),
    spark: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M11 2.5l1.9 5.6 5.6 1.9-5.6 1.9L11 17.5l-1.9-5.6L3.5 10l5.6-1.9zM18.5 14.5l.95 2.05 2.05.95-2.05.95-.95 2.05-.95-2.05-2.05-.95 2.05-.95z"/></svg>`,
    pencil: svg('<path d="M4.5 19.5h4l10.3-10.3a2 2 0 0 0 0-2.8l-1.2-1.2a2 2 0 0 0-2.8 0L4.5 15.5z"/><path d="m13.5 6.5 4 4"/>'),
    save: svg('<path d="M5.5 4.5h10.2l3.8 3.8v10.2a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1z"/><path d="M8 4.5v4.5h7V4.5M8 19.5v-5.5h8v5.5"/>'),
    diff: svg('<rect x="3.5" y="4.5" width="7.5" height="15" rx="2"/><rect x="13" y="4.5" width="7.5" height="15" rx="2"/><path d="M5.5 12h3.5M15 12h3.5M16.75 10.25v3.5"/>'),
    split: svg('<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M12 4.5v15"/>'),
    inline: svg('<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M3.5 12h17"/>'),
    robot: svg('<rect x="4.5" y="8" width="15" height="11.5" rx="3.5"/><path d="M12 4.5V8M9.5 13.2v.6M14.5 13.2v.6M9.5 16.5h5M2.5 12.5v3M21.5 12.5v3"/><circle cx="12" cy="3.8" r="1"/>'),
    graph: svg('<path d="M3 12h4l2.2-6.5L13 18.5l2.4-9L17 12h4"/>'),
    list: svg('<path d="M9 6.5h11M9 12h11M9 17.5h11M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01"/>'),
    tree: svg('<path d="M4.5 5.5h6M8.5 11.5h11M8.5 17.5h11M6.5 5.5v12h2M6.5 11.5h2"/>'),
    open: svg(`${PAGE}<path d="M12 12.5v5M9.5 15h5"/>`),
    warn: svg('<path d="M12 4.5 21 19.5H3z"/><path d="M12 10v4M12 17h.01"/>'),
    info: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8h.01"/>'),
    ok: svg('<circle cx="12" cy="12" r="8.5"/><path d="m8.5 12.2 2.4 2.4 4.6-4.9"/>'),
    back: svg('<path d="M10 6 4 12l6 6M4 12h16"/>'),
    head: svg('<circle cx="12" cy="12" r="3.2"/><path d="M3.5 12h5.3M15.2 12h5.3"/>'),
};
const CODE = new Set("js mjs cjs jsx ts mts cts tsx py pyi rb go rs java kt kts swift c h cc cpp cxx hpp hh m mm cs fs php pl lua r dart scala clj ex exs erl hs elm zig nim jl sol vy groovy gradle coffee vb ps1 wasm wat graphql gql proto".split(" "));
function fileIcon(name) {
    const n = String(name).toLowerCase(), x = extOf(n);
    if (/\.(test|spec)\.[a-z0-9]+$/.test(n) || /^test_.*\.py$/.test(n)) return I.test;
    if (/^(package\.json|cargo\.toml|go\.mod|pyproject\.toml|gemfile|requirements\.txt|composer\.json|pubspec\.yaml|pipfile)$/.test(n)) return I.pkg;
    if (/^\.git(ignore|attributes|modules|keep)$/.test(n)) return I.git;
    if (/^\.env/.test(n) || x === "lock" || /-lock\.(json|yaml)$/.test(n) || /^(pem|key|crt|p12)$/.test(x)) return I.lock;
    if (/^(license|licence|copying)(\.|$)/.test(n)) return I.license;
    if (/^readme/.test(n) || /^(md|mdx|markdown|txt|rst|adoc|org|tex)$/.test(x)) return I.doc;
    if (/^(png|jpe?g|gif|webp|bmp|ico|icns|svg|avif|heic|tiff?)$/.test(x)) return I.image;
    if (/^(json|jsonc|json5|ya?ml|toml|ini|cfg|conf|xml|plist|csv|tsv|properties|env)$/.test(x)) return I.braces;
    if (/^(css|scss|sass|less|styl|pcss)$/.test(x)) return I.hash;
    if (/^(html?|xhtml|vue|svelte|astro|hbs|ejs|njk|liquid)$/.test(x)) return I.angle;
    if (/^(sh|bash|zsh|fish|bat|cmd|command)$/.test(x)) return I.shell;
    if (/^(sql|db|sqlite3?|prisma)$/.test(x)) return I.db;
    if (/^(zip|gz|tgz|tar|rar|7z|dmg|pkg|xz|bz2|jar|asar)$/.test(x)) return I.archive;
    if (/^(ttf|otf|woff2?|eot)$/.test(x)) return I.font;
    if (/^(mp3|wav|m4a|ogg|flac|aac|mp4|mov|webm|avi|mkv)$/.test(x)) return I.media;
    if (/^(makefile|dockerfile|procfile|rakefile|justfile|brewfile|vagrantfile)$/.test(n) || /^\.[a-z0-9_-]+rc(\.[a-z]+)?$/.test(n) || /\.config\.[a-z]+$/.test(n) || /^\.(editorconfig|prettierrc|npmrc|nvmrc)$/.test(n) || /^docker-compose/.test(n)) return I.gear;
    if (CODE.has(x)) return I.code;
    return I.file;
}
// Git status letters: what the row shows, the words for it, and its color class.
const ST = { M: ["M", "Modified", "m"], A: ["A", "Added", "a"], "?": ["U", "Untracked", "a"], D: ["D", "Deleted", "d"], R: ["R", "Renamed", "a"], U: ["!", "Conflict", "d"] };
const RANK = { U: 5, M: 4, R: 3, A: 3, "?": 3, D: 2 };

// ============ Server (contract F) ============
async function call(url, params, body) {
    let r;
    try {
        r = body === undefined
            ? await fetch(`${url}?${new URLSearchParams(params || {})}`, { cache: "no-store" })
            : await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    } catch {
        return { ok: false, error: "Pulse isn't answering. Is the server still running?", offline: true };
    }
    let j = null;
    try { j = await r.json(); } catch { /* not JSON */ }
    if (!j || typeof j !== "object") return { ok: false, status: r.status, error: r.status === 404 ? MISSING : `Unexpected reply from Pulse (HTTP ${r.status}).` };
    if (!r.ok && j.ok !== false) j.ok = false;
    if (j.ok === false && !j.error && !j.conflict) j.error = r.status === 404 ? MISSING : `Pulse said no (HTTP ${r.status}).`;
    j.status = r.status;
    return j;
}
const get = (url, params) => call(url, params);
const post = (url, body) => call(url, null, body || {});
const opened = new Map(); // root -> promise of POST /workspace/open
function openRoot(root) {
    if (!root) return Promise.resolve({ ok: false });
    if (!opened.has(root)) {
        const p = post("/workspace/open", { root }).then((r) => { if (!r.ok) setTimeout(() => opened.delete(root), 4000); return r; });
        opened.set(root, p);
    }
    return opened.get(root);
}

// ============ Shared state ============
const W = { snap: null, root: "", names: new Map(), last: new Map(), timers: new Map() };

function projects() {
    const m = new Map();
    for (const s of W.snap?.sessions || []) {
        if (!s.cwd || s.empty) continue;
        const p = m.get(s.cwd), at = s.lastAt || s.startedAt || 0;
        if (!p) m.set(s.cwd, { cwd: s.cwd, name: s.project || base(s.cwd), at, branch: s.branch || "" });
        else if (at > p.at) Object.assign(p, { at, branch: s.branch || p.branch });
    }
    return [...m.values()].sort((a, b) => b.at - a.at);
}
// The page's callsigns: a chat's main agent is C1, C2... within its project, subagents are A<n>.
function nameAgents() {
    W.names.clear();
    const groups = new Map();
    for (const s of [...(W.snap?.sessions || [])].sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0))) {
        if (s.empty) continue;
        const i = (groups.get(s.cwd) || 0) + 1;
        groups.set(s.cwd, i);
        for (const a of s.agents || []) {
            const sign = a.id === "main" ? `C${i}` : `A${a.n}`;
            W.names.set(`${s.id}|${a.id}`, { sign, type: a.id === "main" ? "main agent" : String(a.type || "subagent").split(":").pop() });
        }
        if (!(s.agents || []).some((a) => a.id === "main")) W.names.set(`${s.id}|main`, { sign: `C${i}`, type: "main agent" });
    }
}
function sign(session, agent) {
    if (!agent || agent === "main") return W.names.get(`${session}|main`)?.sign || "Main";
    const hit = W.names.get(`${session}|${agent}`);
    if (hit) return hit.sign;
    return /^[A-Z]\d+$/.test(agent) ? agent : String(agent).slice(0, 8);
}
const sessionOf = (id) => (W.snap?.sessions || []).find((s) => s.id === id) || null;
// The project root a path belongs to: the longest known root that contains it.
function findRoot(abs) {
    const roots = new Set([W.root, X.root, C.root, ...projects().map((p) => p.cwd), ...E.tabs.map((t) => t.root)].filter(Boolean));
    let best = "";
    for (const r of roots) if (inside(abs, r) && r.length > best.length) best = r;
    return best;
}

// ---- git status, shared by the explorer (decorations), source control and the editor ----
const G = new Map(); // root -> { data, at, p }
const gitSubs = new Set();
function gitStatus(root, force) {
    if (!root) return Promise.resolve(null);
    let g = G.get(root);
    if (!g) G.set(root, (g = { data: null, at: 0, p: null }));
    if (g.p) return g.p;
    if (!force && g.data && Date.now() - g.at < 1500) return Promise.resolve(g.data);
    g.p = (async () => {
        await openRoot(root);
        const r = await get("/git/status", { root });
        g.data = r; g.at = Date.now(); g.p = null;
        for (const f of gitSubs) { try { f(root); } catch (err) { console.warn(err); } }
        return r;
    })();
    return g.p;
}
function gitMap(root) {
    const d = G.get(root)?.data;
    if (!d || !d.ok || d.repo === false) return null;
    if (d._map) return d._map;
    const files = new Map(), dirs = new Map();
    for (const f of d.files || []) {
        files.set(f.path, f);
        for (let p = dirOf(f.path); p && p !== "/"; p = dirOf(p)) { const cur = dirs.get(p); if (!cur || RANK[f.status] > RANK[cur]) dirs.set(p, f.status); }
    }
    Object.defineProperty(d, "_map", { value: { files, dirs }, enumerable: false });
    return d._map;
}

// ---- live refresh: new tool activity in a project refreshes its git state, listings and open files (throttled) ----
function projectSig(root, snap) {
    let n = 0, t = 0;
    for (const s of snap?.sessions || []) {
        if (!s.cwd || !(inside(s.cwd, root) || inside(root, s.cwd))) continue;
        for (const a of s.agents || []) { n += a.tools || 0; t = Math.max(t, a.lastAt || 0); }
    }
    return `${n}:${t}`;
}
function watchedRoots() { return new Set([X.root, C.root, ...E.tabs.map((t) => t.root)].filter(Boolean)); }
function scheduleRefresh(root) {
    if (W.timers.has(root)) return;
    const wait = Math.max(700, (W.last.get(root) || 0) + THROTTLE - Date.now());
    W.timers.set(root, setTimeout(() => { W.timers.delete(root); W.last.set(root, Date.now()); refreshRoot(root, true); }, wait));
}
async function refreshRoot(root, fromAgents) {
    const jobs = [gitStatus(root, true)];
    if (X.root === root) jobs.push(xRefresh(true));
    if (C.root === root && C.session && C.mode === "chat") jobs.push(cLoadChat());
    await Promise.all(jobs);
    eRefreshFrom(root, fromAgents);
}
document.addEventListener("pulse:snapshot", (e) => {
    const prev = W.snap;
    W.snap = e.detail || null;
    nameAgents();
    // Compare with the previous snapshot itself, so a project opened between two snapshots still refreshes on the next.
    if (prev && W.snap) for (const root of watchedRoots()) if (projectSig(root, prev) !== projectSig(root, W.snap)) scheduleRefresh(root);
    if (!X.root) xRender();
    if (C.session) cRenderSeg();
});

// ============ Monaco ============
let monacoP = null;
function script(src) {
    return new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = src;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error(`Could not load ${src}`));
        document.head.appendChild(s);
    });
}
const THEME = {
    base: "vs-dark", inherit: true,
    rules: [
        { token: "", foreground: "E6E6EA" },
        { token: "comment", foreground: "6E6E76", fontStyle: "italic" },
        { token: "keyword", foreground: "C99BFF" },
        { token: "keyword.flow", foreground: "C99BFF" },
        { token: "storage", foreground: "C99BFF" },
        { token: "string", foreground: "8AEFB9" },
        { token: "string.escape", foreground: "5CD5E0" },
        { token: "string.key.json", foreground: "9CC4FF" },
        { token: "string.value.json", foreground: "8AEFB9" },
        { token: "keyword.json", foreground: "F4B659" },
        { token: "regexp", foreground: "FF9292" },
        { token: "number", foreground: "F4B659" },
        { token: "constant", foreground: "F4B659" },
        { token: "type", foreground: "5CD5E0" },
        { token: "type.identifier", foreground: "5CD5E0" },
        { token: "identifier", foreground: "E6E6EA" },
        { token: "variable", foreground: "E6E6EA" },
        { token: "variable.predefined", foreground: "9CC4FF" },
        { token: "predefined", foreground: "9CC4FF" },
        { token: "function", foreground: "9CC4FF" },
        { token: "annotation", foreground: "FFE27A" },
        { token: "delimiter", foreground: "9A9AA2" },
        { token: "operator", foreground: "9A9AA2" },
        { token: "tag", foreground: "6EA8FF" },
        { token: "metatag", foreground: "6EA8FF" },
        { token: "attribute.name", foreground: "C99BFF" },
        { token: "attribute.value", foreground: "8AEFB9" },
        { token: "key", foreground: "9CC4FF" },
        { token: "emphasis", fontStyle: "italic" },
        { token: "strong", fontStyle: "bold" },
        { token: "invalid", foreground: "FF6B6B" },
    ],
    colors: {
        "editor.background": "#0B0B0D", "editor.foreground": "#E6E6EA", "editorCursor.foreground": "#FFD21F",
        "editor.lineHighlightBackground": "#FFFFFF08", "editor.lineHighlightBorder": "#00000000",
        "editorLineNumber.foreground": "#46464C", "editorLineNumber.activeForeground": "#A7A7AE",
        "editor.selectionBackground": "#FFFFFF2B", "editor.inactiveSelectionBackground": "#FFFFFF16", "editor.selectionHighlightBackground": "#FFFFFF12",
        "editor.wordHighlightBackground": "#FFFFFF12", "editor.wordHighlightStrongBackground": "#FFFFFF1C",
        "editor.findMatchBackground": "#FFD21F59", "editor.findMatchHighlightBackground": "#FFD21F26", "editor.findRangeHighlightBackground": "#FFFFFF0A",
        "editorIndentGuide.background1": "#FFFFFF0F", "editorIndentGuide.activeBackground1": "#FFFFFF30",
        "editorWhitespace.foreground": "#FFFFFF1F", "editorRuler.foreground": "#FFFFFF10",
        "editorBracketMatch.background": "#FFD21F1A", "editorBracketMatch.border": "#FFD21F66",
        "editorBracketHighlight.foreground1": "#D6D6DB", "editorBracketHighlight.foreground2": "#C99BFF", "editorBracketHighlight.foreground3": "#6EA8FF",
        "editorBracketHighlight.foreground4": "#D6D6DB", "editorBracketHighlight.foreground5": "#C99BFF", "editorBracketHighlight.foreground6": "#6EA8FF",
        "editorGutter.background": "#0B0B0D", "editorOverviewRuler.border": "#00000000", "scrollbar.shadow": "#00000000",
        "scrollbarSlider.background": "#FFFFFF1F", "scrollbarSlider.hoverBackground": "#FFFFFF38", "scrollbarSlider.activeBackground": "#FFFFFF4D",
        "minimap.background": "#0B0B0D", "minimapSlider.background": "#FFFFFF12", "minimapSlider.hoverBackground": "#FFFFFF20", "minimapSlider.activeBackground": "#FFFFFF2C",
        "editorWidget.background": "#17171B", "editorWidget.border": "#FFFFFF1F", "editorWidget.foreground": "#E6E6EA",
        "editorHoverWidget.background": "#17171B", "editorHoverWidget.border": "#FFFFFF1F",
        "editorSuggestWidget.background": "#17171B", "editorSuggestWidget.border": "#FFFFFF1F", "editorSuggestWidget.selectedBackground": "#FFFFFF14", "editorSuggestWidget.highlightForeground": "#FFD21F",
        "input.background": "#0B0B0D", "input.border": "#FFFFFF1F", "inputOption.activeBorder": "#FFD21F99", "inputOption.activeBackground": "#FFD21F26", "focusBorder": "#FFFFFF40",
        "list.hoverBackground": "#FFFFFF0F", "list.activeSelectionBackground": "#FFFFFF1A", "list.focusBackground": "#FFFFFF14", "list.highlightForeground": "#FFD21F",
        "menu.background": "#17171B", "menu.foreground": "#E6E6EA", "menu.selectionBackground": "#FFFFFF1A", "menu.separatorBackground": "#FFFFFF1A", "menu.border": "#FFFFFF1F",
        "diffEditor.insertedTextBackground": "#5BE49B2E", "diffEditor.removedTextBackground": "#FF6B6B33",
        "diffEditor.insertedLineBackground": "#5BE49B14", "diffEditor.removedLineBackground": "#FF6B6B14",
        "diffEditorGutter.insertedLineBackground": "#5BE49B26", "diffEditorGutter.removedLineBackground": "#FF6B6B26",
        "diffEditorOverview.insertedForeground": "#5BE49B80", "diffEditorOverview.removedForeground": "#FF6B6B80",
        "diffEditor.diagonalFill": "#FFFFFF0D", "diffEditor.border": "#FFFFFF14",
        "diffEditor.unchangedRegionBackground": "#141417", "diffEditor.unchangedRegionForeground": "#A7A7AE", "diffEditor.unchangedCodeBackground": "#FFFFFF05",
        "editorStickyScroll.background": "#0B0B0D", "editorStickyScrollHover.background": "#16161A", "editorStickyScroll.shadow": "#00000099",
        "editorLink.activeForeground": "#FFD21F", "editorError.foreground": "#FF6B6B", "editorWarning.foreground": "#F4B659", "editorInfo.foreground": "#6EA8FF",
    },
};
function setupMonaco(m) {
    m.editor.defineTheme("pulse-dark", THEME);
    const ts = m.typescript || m.languages.typescript;
    // A reader, not a compiler: without the project's node_modules every import would be a red squiggle.
    try {
        for (const d of [ts.typescriptDefaults, ts.javascriptDefaults]) {
            d.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: true, noSuggestionDiagnostics: true });
            d.setCompilerOptions({ ...d.getCompilerOptions(), allowJs: true, allowNonTsExtensions: true, jsx: 1 });
        }
    } catch { /* optional */ }
    try { (m.json || m.languages.json).jsonDefaults.setDiagnosticsOptions({ validate: true, allowComments: true, trailingCommas: "ignore", schemaValidation: "ignore", enableSchemaRequest: false }); } catch { /* optional */ }
    if (!window.MonacoEnvironment || (!window.MonacoEnvironment.getWorker && !window.MonacoEnvironment.getWorkerUrl)) {
        // editor.main normally installs this itself; keep the workers on this origin if it ever does not.
        const boot = (url) => URL.createObjectURL(new Blob([`importScripts(${JSON.stringify(url)});`], { type: "text/javascript" }));
        window.MonacoEnvironment = { getWorker: () => new Worker(boot(`${VS}/editor/editor.worker.js`)) };
    }
    try { document.fonts?.load?.('13px "Geist Mono"').then(() => m.editor.remeasureFonts()).catch(() => {}); } catch { /* optional */ }
}
function ensureMonaco() {
    if (E.m) return Promise.resolve(E.m);
    if (monacoP) return monacoP;
    monacoP = (async () => {
        if (!window.monaco?.editor) {
            if (typeof window.require?.config !== "function") {
                await script(`${VS}/loader.js`);
                // UMD libraries loaded later (xterm) must keep registering as globals, not as anonymous AMD modules.
                try { if (window.define) window.define.amd = undefined; } catch { /* read-only */ }
            }
            window.require.config({ paths: { vs: VS } });
            await new Promise((resolve, reject) => window.require(["vs/editor/editor.main"], () => resolve(), (err) => reject(err)));
        }
        setupMonaco(window.monaco);
        E.m = window.monaco;
        return E.m;
    })();
    monacoP.catch(() => { monacoP = null; });
    return monacoP;
}
const EXTRA_LANG = { mjs: "javascript", cjs: "javascript", mts: "typescript", cts: "typescript", jsonc: "json", json5: "json", zsh: "shell", bash: "shell", fish: "shell", env: "shell", toml: "ini", conf: "ini", svelte: "html", vue: "html", astro: "html", plist: "xml", gitignore: "shell" };
function langFor(hint, path) {
    const langs = E.m.languages.getLanguages();
    if (hint) {
        const id = String(hint).toLowerCase();
        if (langs.some((l) => l.id === id)) return id;
        const alias = langs.find((l) => (l.aliases || []).some((a) => a.toLowerCase() === id));
        if (alias) return alias.id;
    }
    const name = base(path).toLowerCase(), x = extOf(name);
    const hit = langs.find((l) => (l.filenames || []).some((f) => f.toLowerCase() === name)) || (x && langs.find((l) => (l.extensions || []).includes(`.${x}`)));
    if (hit) return hit.id;
    if (EXTRA_LANG[x]) return EXTRA_LANG[x];
    if (/^\.(env|.*rc)$/.test(name) || name === ".gitignore") return "shell";
    return "plaintext";
}
const langName = (id) => { const l = E.m?.languages.getLanguages().find((x) => x.id === id); return (l && l.aliases && l.aliases[0]) || id || "Plain Text"; };
let modelSeq = 0;
function newModel(text, hint, abs, tag) {
    const m = E.m, p = String(abs || "untitled");
    const uri = m.Uri.from({ scheme: "pulse", authority: tag, path: p.startsWith("/") ? p : `/${p}`, query: String(++modelSeq) });
    return m.editor.createModel(String(text ?? ""), langFor(hint, p), uri);
}
function editorOptions() {
    const still = reduce.matches;
    return {
        theme: "pulse-dark", fontFamily: FONT, fontSize: 13, lineHeight: 20, fontLigatures: false, automaticLayout: true,
        editContext: false, // a real textarea, so the page's single-key shortcuts know you are typing
        scrollBeyondLastLine: false, smoothScrolling: !still, cursorBlinking: still ? "solid" : "smooth", cursorSmoothCaretAnimation: still ? "off" : "on",
        renderLineHighlight: "all", padding: { top: 12, bottom: 12 }, lineNumbersMinChars: 4, glyphMargin: false, folding: true, showFoldingControls: "mouseover",
        minimap: { enabled: true, renderCharacters: false, showSlider: "mouseover", maxColumn: 90 },
        scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false, alwaysConsumeMouseWheel: false },
        overviewRulerBorder: false, bracketPairColorization: { enabled: true }, guides: { indentation: true, highlightActiveIndentation: true, bracketPairs: false },
        stickyScroll: { enabled: true, maxLineCount: 4 }, renderWhitespace: "selection", unicodeHighlight: { ambiguousCharacters: false }, mouseWheelZoom: false,
        readOnlyMessage: { value: "Read-only. Press **Edit** above to make changes." }, "semanticHighlighting.enabled": false, wordWrap: "off",
    };
}

// ============ Explorer (mountExplorer) ============
const X = { host: null, dom: null, root: "", focus: "", sel: "", filter: "", rows: [], ids: new Map(), typed: "", typedAt: 0 };
const trees = new Map(); // root -> { root, nodes, expanded }
function tree(root) {
    let t = trees.get(root);
    if (!t) {
        const saved = (load(K_EXP, {}) || {})[root];
        t = { root, nodes: new Map([["", { path: "", name: base(root), type: "dir", children: null }]]), expanded: new Set(Array.isArray(saved) ? saved : []) };
        trees.set(root, t);
    }
    return t;
}
function persistExpanded(t) {
    const all = load(K_EXP, {}) || {};
    delete all[t.root];
    all[t.root] = [...t.expanded].slice(-300);
    const roots = Object.keys(all);
    while (roots.length > 30) delete all[roots.shift()];
    keep(K_EXP, all);
}
function dropSubtree(t, path) {
    for (const k of [...t.nodes.keys()]) if (k === path || k.startsWith(`${path}/`)) t.nodes.delete(k);
}
function listDir(t, dir) {
    const n = t.nodes.get(dir);
    if (!n) return Promise.resolve();
    if (n.loading) return n.loading;
    n.loading = (async () => {
        const o = await openRoot(t.root);
        const r = o && o.ok === false && o.status !== 404 ? o : await get("/fs/list", { root: t.root, dir });
        n.loading = null;
        if (!r.ok) { n.error = r.error || "I couldn't read this folder."; if (!n.children) n.children = []; return; }
        n.error = "";
        const kids = (r.entries || []).map((e) => ({ path: e.path || join(dir, e.name), name: e.name || base(e.path), type: e.type === "dir" ? "dir" : "file", link: e.type === "link", size: e.size, ignored: !!e.ignored }));
        kids.sort(byName);
        const now = new Set(kids.map((k) => k.path));
        for (const old of n.children || []) if (!now.has(old)) dropSubtree(t, old);
        for (const k of kids) {
            const prev = t.nodes.get(k.path);
            if (prev && prev.type === k.type) Object.assign(prev, k);
            else t.nodes.set(k.path, { ...k, children: null });
        }
        n.children = kids.map((k) => k.path);
    })();
    return n.loading;
}
function mountExplorer(host, opts = {}) {
    if (!host) return;
    const root = norm(opts.root || W.root || "");
    if (C.host === host) C.host = null;
    if (X.host !== host || !X.dom || !host.contains(X.dom)) {
        X.host = host;
        X.dom = el("div", "pw-explorer");
        X.dom.innerHTML = `
<div class="pw-xhead">
    <label class="pw-filter">${I.search}<input type="text" placeholder="Filter files" aria-label="Filter files" spellcheck="false" autocomplete="off"><button class="pw-clear" type="button" aria-label="Clear filter" hidden>${I.x}</button></label>
    <button class="pw-ib" type="button" data-act="refresh" aria-label="Refresh files" title="Refresh">${I.refresh}</button>
    <button class="pw-ib" type="button" data-act="collapse" aria-label="Collapse all folders" title="Collapse all folders">${I.collapse}</button>
</div>
<div class="pw-tree" role="tree" tabindex="0" aria-label="Files"></div>`;
        host.replaceChildren(X.dom);
        wireExplorer();
    }
    if (root !== X.root) { if (root) setRootOnly(root); xSetRoot(root); }
    else { xRenderHead(); xRender(); if (root) xRefresh(true); }
}
function wireExplorer() {
    const d = X.dom, treeEl = d.querySelector(".pw-tree"), input = d.querySelector(".pw-filter input"), clear = d.querySelector(".pw-clear");
    d.querySelector(".pw-xhead").addEventListener("click", (e) => {
        const b = e.target.closest("button[data-act]");
        if (!b || !X.root) return;
        if (b.dataset.act === "refresh") { b.classList.add("pw-spin"); refreshRoot(X.root).finally(() => setTimeout(() => b.classList.remove("pw-spin"), 400)); }
        else if (b.dataset.act === "collapse") { const t = tree(X.root); t.expanded.clear(); persistExpanded(t); xRender(); }
    });
    let deepTimer = 0;
    input.addEventListener("input", () => {
        X.filter = input.value.trim();
        clear.hidden = !input.value;
        xRender();
        clearTimeout(deepTimer);
        if (X.filter) deepTimer = setTimeout(xDeepSearch, 180);
    });
    input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Escape" && input.value) { e.preventDefault(); input.value = ""; X.filter = ""; clear.hidden = true; xRender(); }
        else if (e.key === "ArrowDown" || e.key === "Enter") { e.preventDefault(); if (X.rows.length) { if (!X.ids.has(X.focus)) setFocus(X.rows[0].node.path); treeEl.focus(); } }
    });
    clear.addEventListener("click", () => { input.value = ""; X.filter = ""; clear.hidden = true; xRender(); input.focus(); });
    treeEl.addEventListener("click", (e) => {
        const retry = e.target.closest("[data-retry]");
        if (retry) { const t = tree(X.root), n = t.nodes.get(retry.dataset.retry); if (n) { n.children = null; n.error = ""; xRender(); listDir(t, n.path).then(xRender); } return; }
        const pick = e.target.closest("[data-root]");
        if (pick) { setRoot(pick.dataset.root); return; }
        const row = e.target.closest(".pw-row");
        if (!row) return;
        const path = row.dataset.path, n = tree(X.root).nodes.get(path);
        if (!n) return;
        setFocus(path, true);
        if (n.type === "dir") xToggle(path);
        else openFile(X.root, path, { preview: true });
    });
    treeEl.addEventListener("dblclick", (e) => {
        const row = e.target.closest(".pw-row");
        if (!row || row.classList.contains("pw-dir")) return;
        openFile(X.root, row.dataset.path, { focus: true });
    });
    treeEl.addEventListener("keydown", xKey);
    treeEl.addEventListener("focus", () => { if (!X.ids.has(X.focus) && X.rows.length) setFocus(X.sel && X.ids.has(X.sel) ? X.sel : X.rows[0].node.path); });
}
function setRootOnly(root) {
    W.root = root;
    openRoot(root);
}
async function xSetRoot(root) {
    X.root = root; X.focus = ""; X.sel = ""; X.filter = "";
    const input = X.dom?.querySelector(".pw-filter input");
    if (input) { input.value = ""; X.dom.querySelector(".pw-clear").hidden = true; }
    xRenderHead(); xRender();
    if (!root) return;
    const t = tree(root);
    gitStatus(root).then(() => { if (X.root === root) xRenderHead(); });
    await listDir(t, "");
    if (X.root !== root) return;
    xRender();
    await restoreExpanded(t);
    if (X.root === root) xRender();
}
async function restoreExpanded(t) {
    const byDepth = new Map();
    for (const p of t.expanded) { const d = p.split("/").length; if (!byDepth.has(d)) byDepth.set(d, []); byDepth.get(d).push(p); }
    let changed = false;
    for (const d of [...byDepth.keys()].sort((a, b) => a - b)) {
        await Promise.all(byDepth.get(d).map((p) => {
            const n = t.nodes.get(p);
            if (!n || n.type !== "dir") { t.expanded.delete(p); changed = true; return null; }
            return n.children ? null : listDir(t, p);
        }));
    }
    if (changed) persistExpanded(t);
}
// Re-list what is on screen (root and open folders), keeping expansion and focus.
async function xRefresh(quiet) {
    const root = X.root;
    if (!root) return;
    const t = tree(root);
    const dirs = ["", ...[...t.expanded].filter((p) => t.nodes.get(p)?.children)];
    if (!quiet) gitStatus(root, true);
    await Promise.all(dirs.map((p) => { const n = t.nodes.get(p); if (n && !n.loading) return listDir(t, p); return n?.loading; }));
    if (X.root === root) { xRenderHead(); xRender(); }
}
// Filtering looks through the whole project, not just open folders: list the unopened ones breadth-first, skipping
// what git ignores and the usual dependency folders, up to a budget so a monorepo can't stall the page.
const SKIP_DIRS = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", ".cache", ".next", ".turbo", ".gradle", "Pods", "DerivedData", ".svn", ".hg"]);
const DEEP_BUDGET = 400;
let deepRun = 0;
function unlisted(t) {
    const out = [], walk = (p) => {
        const n = t.nodes.get(p);
        if (!n || n.type !== "dir" || (p && (n.ignored || n.link || SKIP_DIRS.has(n.name)))) return;
        if (!n.children) { if (!n.error) out.push(p); return; }
        for (const c of n.children) walk(c);
    };
    walk("");
    return out;
}
async function xDeepSearch() {
    const root = X.root;
    if (!root || !X.filter) return;
    const t = tree(root), run = ++deepRun;
    let queue = unlisted(t), paint = 0;
    if (!queue.length) return;
    X.searching = true;
    xRender();
    while (queue.length && (t.deepCount || 0) < DEEP_BUDGET) {
        if (run !== deepRun || X.root !== root || !X.filter) break;
        const batch = queue.splice(0, 8);
        await Promise.all(batch.map((p) => listDir(t, p)));
        t.deepCount = (t.deepCount || 0) + batch.length;
        queue = unlisted(t);
        if (Date.now() - paint > 120) { paint = Date.now(); if (X.root === root) xRender(); }
    }
    if (run !== deepRun) return;
    X.searching = false;
    X.searchCapped = queue.length > 0;
    if (X.root === root) xRender();
}
async function xToggle(path, open) {
    const t = tree(X.root), n = t.nodes.get(path);
    if (!n || n.type !== "dir") return;
    if (open === undefined) open = !t.expanded.has(path);
    if (open) {
        t.expanded.add(path);
        persistExpanded(t);
        xRender();
        if (!n.children) { await listDir(t, path); if (X.root === t.root) xRender(); }
    } else {
        t.expanded.delete(path);
        persistExpanded(t);
        xRender();
    }
}
// The page's picker already names the project, so the explorer's own header is just filter + actions, named for the project.
function xRenderHead() {
    if (!X.dom) return;
    const name = X.root ? base(X.root) : "";
    const input = X.dom.querySelector(".pw-filter input");
    input.placeholder = name ? `Filter ${name}` : "Filter files";
    input.disabled = !X.root;
    X.dom.querySelector(".pw-filter").title = X.root ? tilde(X.root) : "";
    X.dom.querySelector(".pw-tree").setAttribute("aria-label", name ? `Files in ${name}` : "Files");
    for (const btn of X.dom.querySelectorAll(".pw-xhead > button")) btn.disabled = !X.root;
}
function highlight(name, q) {
    const i = name.toLowerCase().indexOf(q);
    if (i < 0 || !q) return esc(name);
    return `${esc(name.slice(0, i))}<mark>${esc(name.slice(i, i + q.length))}</mark>${esc(name.slice(i + q.length))}`;
}
function xRender() {
    if (!X.dom || !X.dom.isConnected) return;
    const treeEl = X.dom.querySelector(".pw-tree");
    if (!X.filter) { X.searching = false; X.searchCapped = false; }
    if (!X.root) {
        const list = projects().slice(0, 8);
        treeEl.innerHTML = `<div class="pw-empty pw-empty-big"><span class="pw-empty-ic">${I.folder}</span><b>No project open</b><span>Pick one and I'll lay out its files here.</span></div>`
            + (list.length ? `<div class="pw-picks">${list.map((p) => `<button type="button" class="pw-pick" data-root="${esc(p.cwd)}" title="${esc(tilde(p.cwd))}">${I.folder}<b>${esc(p.name)}</b><span>${esc(tilde(dirOf(p.cwd)))}</span></button>`).join("")}</div>` : "");
        X.rows = []; X.ids.clear();
        return;
    }
    const t = tree(X.root), q = X.filter.toLowerCase(), g = gitMap(X.root), rootNode = t.nodes.get("");
    const rows = [], memo = new Map();
    const hit = (n) => {
        if (!n) return false;
        if (memo.has(n.path)) return memo.get(n.path);
        memo.set(n.path, false);
        let v = n.name.toLowerCase().includes(q);
        if (!v && n.type === "dir" && n.children) v = n.children.some((c) => hit(t.nodes.get(c)));
        memo.set(n.path, v);
        return v;
    };
    const walk = (dir, depth) => {
        const n = t.nodes.get(dir);
        if (!n.children) { rows.push({ info: true, depth, html: `<span class="pw-spinner"></span>Loading…` }); return; }
        if (n.error) rows.push({ info: true, depth, cls: "pw-err", html: `${esc(n.error)} <button type="button" class="pw-link" data-retry="${esc(dir)}">Try again</button>` });
        else if (!n.children.length && !q) rows.push({ info: true, depth, html: dir ? "Empty folder" : "This folder is empty." });
        for (const p of n.children) {
            const c = t.nodes.get(p);
            if (!c || (q && !hit(c))) continue;
            const open = c.type === "dir" && (t.expanded.has(p) || (!!q && !!c.children && c.children.some((k) => hit(t.nodes.get(k)))));
            rows.push({ node: c, depth, open });
            if (open) walk(p, depth + 1);
        }
    };
    walk("", 0);
    X.rows = rows.filter((r) => r.node);
    X.ids = new Map(X.rows.map((r, i) => [r.node.path, `pwx-${i}`]));
    if (!X.ids.has(X.focus)) X.focus = X.ids.has(X.sel) ? X.sel : "";
    let html = "", i = 0;
    for (const r of rows) {
        if (r.info) { html += `<div class="pw-info ${r.cls || ""}" style="--d:${r.depth}">${r.html}</div>`; continue; }
        const n = r.node, dir = n.type === "dir";
        const st = g ? (dir ? g.dirs.get(n.path) : g.files.get(n.path)?.status) : "";
        const meta = st && ST[st];
        const cls = ["pw-row", dir && "pw-dir", r.open && "pw-open", n.ignored && "pw-ign", n.path === X.sel && "pw-sel", n.path === X.focus && "pw-foc", meta && `pw-s-${meta[2]}`].filter(Boolean).join(" ");
        const deco = !meta ? "" : dir ? `<i class="pw-dot" aria-hidden="true"></i>` : `<span class="pw-dec">${meta[0]}</span>`;
        const tip = `${n.path}${meta ? ` · ${dir ? "Contains changes" : meta[1]}` : ""}${n.ignored ? " · Ignored by git" : ""}`;
        html += `<div class="${cls}" role="treeitem" id="pwx-${i++}" data-path="${esc(n.path)}" aria-level="${r.depth + 1}"${dir ? ` aria-expanded="${!!r.open}"` : ""} aria-selected="${n.path === X.sel}" style="--d:${r.depth}" title="${esc(tip)}"><span class="pw-chev">${dir ? I.chev : ""}</span><span class="pw-fic">${dir ? (r.open ? I.folderOpen : I.folder) : fileIcon(n.name)}</span><span class="pw-nm">${q ? highlight(n.name, q) : esc(n.name)}</span>${deco}</div>`;
    }
    if (q && X.searching) html += `<div class="pw-hint"><span class="pw-spinner"></span>Looking through the project…</div>`;
    else if (q && !X.rows.length && rootNode.children) html += `<div class="pw-empty">Nothing matches “${esc(X.filter)}”${X.searchCapped ? ". I stopped after the first few hundred folders; open one to look deeper" : ""}.</div>`;
    else if (q && X.searchCapped) html += `<div class="pw-hint">Searched the first ${DEEP_BUDGET} folders. Open a folder to look deeper.</div>`;
    const top = treeEl.scrollTop;
    treeEl.innerHTML = html;
    treeEl.scrollTop = top;
    if (X.ids.has(X.focus)) treeEl.setAttribute("aria-activedescendant", X.ids.get(X.focus));
    else treeEl.removeAttribute("aria-activedescendant");
}
function setFocus(path, select) {
    const treeEl = X.dom?.querySelector(".pw-tree");
    if (!treeEl) return;
    const next = X.ids.get(path);
    for (const r of treeEl.querySelectorAll(".pw-foc")) r.classList.remove("pw-foc");
    X.focus = path;
    if (select) {
        for (const r of treeEl.querySelectorAll(".pw-sel")) { r.classList.remove("pw-sel"); r.setAttribute("aria-selected", "false"); }
        X.sel = path;
    }
    if (next) {
        const r = document.getElementById(next);
        r?.classList.add("pw-foc");
        if (select) { r?.classList.add("pw-sel"); r?.setAttribute("aria-selected", "true"); }
        treeEl.setAttribute("aria-activedescendant", next);
        r?.scrollIntoView({ block: "nearest" });
    }
}
// Like VS Code's auto-reveal: the open file is selected in the tree, its folders opened on the way.
async function xReveal(root, path) {
    if (X.root !== root || !X.dom) return;
    if (X.ids.has(path)) { setFocus(path, true); return; }
    const t = tree(root), dirs = [];
    for (let p = dirOf(path); p && p !== "/"; p = dirOf(p)) dirs.unshift(p);
    let changed = false;
    for (const d of dirs) {
        const n = t.nodes.get(d);
        if (!n) { const parent = t.nodes.get(dirOf(d)); if (parent && !parent.children) await listDir(t, dirOf(d)); }
        const node = t.nodes.get(d);
        if (!node || node.type !== "dir" || node.ignored) break;
        if (!t.expanded.has(d)) { t.expanded.add(d); changed = true; }
        if (!node.children) await listDir(t, d);
    }
    if (X.root !== root) return;
    if (changed) persistExpanded(t);
    X.sel = path;
    xRender();
    if (X.ids.has(path)) setFocus(path, true);
}
function xKey(e) {
    const rows = X.rows;
    if (e.metaKey || e.ctrlKey || e.altKey || !rows.length) return;
    let i = rows.findIndex((r) => r.node.path === X.focus);
    const cur = i >= 0 ? rows[i] : null;
    const go = (j) => setFocus(rows[clamp(j, 0, rows.length - 1)].node.path);
    const page = Math.max(1, Math.floor((X.dom.querySelector(".pw-tree").clientHeight || 300) / 26) - 1);
    let handled = true;
    if (i < 0 && /^(Arrow|Home|End|Page)/.test(e.key)) { go(0); e.preventDefault(); e.stopPropagation(); return; }
    switch (e.key) {
        case "ArrowDown": go(i + 1); break;
        case "ArrowUp": go(i - 1); break;
        case "Home": go(0); break;
        case "End": go(rows.length - 1); break;
        case "PageDown": go(i + page); break;
        case "PageUp": go(i - page); break;
        case "ArrowRight":
            if (cur?.node.type === "dir") { if (!cur.open) xToggle(cur.node.path, true); else if (rows[i + 1] && rows[i + 1].depth > cur.depth) go(i + 1); }
            break;
        case "ArrowLeft":
            if (cur?.node.type === "dir" && cur.open) xToggle(cur.node.path, false);
            else if (cur) { const p = dirOf(cur.node.path); if (p && X.ids.has(p)) setFocus(p); }
            break;
        case "Enter":
            if (!cur) break;
            setFocus(cur.node.path, true);
            if (cur.node.type === "dir") xToggle(cur.node.path);
            else openFile(X.root, cur.node.path, { focus: true });
            break;
        case " ":
            if (!cur) break;
            setFocus(cur.node.path, true);
            if (cur.node.type === "dir") xToggle(cur.node.path);
            else openFile(X.root, cur.node.path, { preview: true });
            break;
        case "Escape":
            if (X.filter) { const input = X.dom.querySelector(".pw-filter input"); input.value = ""; X.filter = ""; X.dom.querySelector(".pw-clear").hidden = true; xRender(); }
            else handled = false;
            break;
        default:
            if (e.key.length === 1 && /\S/.test(e.key)) {
                // Type to jump: the next row whose name starts with what you typed.
                const now = Date.now();
                X.typed = now - X.typedAt > 800 ? e.key.toLowerCase() : X.typed + e.key.toLowerCase();
                X.typedAt = now;
                const n = rows.length, from = X.typed.length > 1 ? Math.max(i, 0) : i + 1;
                for (let k = 0; k < n; k++) { const r = rows[(from + k) % n]; if (r.node.name.toLowerCase().startsWith(X.typed)) { setFocus(r.node.path); break; } }
            } else handled = false;
    }
    if (handled) { e.preventDefault(); e.stopPropagation(); }
}

// ============ Source control (mountChanges) ============
const C = { host: null, dom: null, root: "", session: "", mode: prefs.mode === "chat" ? "chat" : "all", unchecked: new Map(), chat: null, chatFor: "", chatLoading: false, busy: "", note: null, noteTimer: 0 };
function mountChanges(host, opts = {}) {
    if (!host) return;
    const root = norm(opts.root || W.root || "");
    const session = opts.session || "";
    if (X.host === host) X.host = null;
    if (C.host !== host || !C.dom || !host.contains(C.dom)) {
        C.host = host;
        C.dom = el("div", "pw-changes");
        C.dom.innerHTML = `
<div class="pw-xhead pw-chead">
    <div class="pw-branch"></div>
    <button class="pw-ib" type="button" data-act="group" aria-pressed="false" aria-label="Group by folder" title="Group by folder">${I.tree}</button>
    <button class="pw-ib" type="button" data-act="refresh" aria-label="Refresh changes" title="Refresh">${I.refresh}</button>
</div>
<div class="pw-seg pw-cseg" role="group" aria-label="Which changes" hidden></div>
<div class="pw-lhead"></div>
<div class="pw-clist" role="list" aria-label="Changed files"></div>
<div class="pw-commit">
    <div class="pw-msgbox">
        <textarea class="pw-msg" rows="3" placeholder="${MSG_PLACEHOLDER}" aria-label="Commit message" spellcheck="true"></textarea>
    </div>
    <div class="pw-cacts">
        <button class="pw-btn pw-gen" type="button" title="Draft a message from the ticked changes" aria-label="Generate a commit message">${I.spark}</button>
        <button class="pw-btn pw-primary pw-commitb" type="button">${I.check}<span>Commit</span></button>
        <button class="pw-btn pw-push" type="button">${I.up}<span>Push</span></button>
    </div>
    <div class="pw-note" role="status" aria-live="polite"></div>
</div>`;
        host.replaceChildren(C.dom);
        wireChanges();
    }
    const rootChanged = root !== C.root, sessionChanged = session !== C.session;
    C.root = root;
    C.session = session;
    if (root && root !== W.root) setRootOnly(root);
    if (!session && C.mode === "chat") C.mode = "all";
    if (sessionChanged) { C.chat = null; C.chatFor = ""; }
    cRender();
    if (root) gitStatus(root, !rootChanged).then(() => cRender());
    if (session && C.mode === "chat") cLoadChat();
}
function wireChanges() {
    const d = C.dom;
    d.querySelector(".pw-xhead").addEventListener("click", (e) => {
        const b = e.target.closest("button[data-act]");
        if (!b) return;
        if (b.dataset.act === "group") { setPref("grouped", !prefs.grouped); cRender(); }
        else if (b.dataset.act === "refresh" && C.root) { b.classList.add("pw-spin"); refreshRoot(C.root).then(() => (C.mode === "chat" ? cLoadChat() : null)).finally(() => setTimeout(() => b.classList.remove("pw-spin"), 400)); }
    });
    d.querySelector(".pw-cseg").addEventListener("click", (e) => {
        const b = e.target.closest("button[data-mode]");
        if (!b || b.dataset.mode === C.mode) return;
        C.mode = b.dataset.mode;
        setPref("mode", C.mode);
        cRender();
        if (C.mode === "chat") cLoadChat();
    });
    d.querySelector(".pw-lhead").addEventListener("change", (e) => {
        if (!e.target.matches("input[type=checkbox]")) return;
        const set = uncheckedFor(C.root);
        for (const it of cItems()) if (it.status) (e.target.checked ? set.delete(it.path) : set.add(it.path));
        cRender();
    });
    const list = d.querySelector(".pw-clist");
    list.addEventListener("change", (e) => {
        const box = e.target.closest("input[type=checkbox]");
        if (!box) return;
        const set = uncheckedFor(C.root), p = box.closest("[data-path]").dataset.path;
        if (box.checked) set.delete(p); else set.add(p);
        cRenderHead(); cRenderButtons();
    });
    list.addEventListener("click", (e) => {
        if (e.target.closest("input[type=checkbox]")) return;
        const openBtn = e.target.closest("[data-open]");
        const row = e.target.closest(".pw-crow");
        if (!row) return;
        const it = cItems().find((x) => x.path === row.dataset.path);
        if (!it) return;
        if (openBtn) { openFile(C.root, it.path, { focus: true }); return; }
        if (!e.target.closest(".pw-cmain")) return;
        if (C.mode === "chat") openAgentChanges(C.session, null, it.abs, { preview: true });
        else openDiff(C.root, it.path, { preview: true });
    });
    list.addEventListener("dblclick", (e) => {
        const row = e.target.closest(".pw-crow");
        if (!row || e.target.closest("input, [data-open]")) return;
        const t = E.tabs.find((x) => x.preview);
        if (t) { t.preview = false; eRenderTabs(); persistTabs(); }
    });
    const msg = d.querySelector(".pw-msg");
    msg.addEventListener("keydown", (e) => e.stopPropagation());
    msg.addEventListener("input", () => { cRenderButtons(); });
    d.querySelector(".pw-gen").addEventListener("click", cGenerate);
    d.querySelector(".pw-commitb").addEventListener("click", cCommit);
    d.querySelector(".pw-push").addEventListener("click", cPush);
}
function uncheckedFor(root) {
    if (!C.unchecked.has(root)) C.unchecked.set(root, new Set());
    return C.unchecked.get(root);
}
function cItems() {
    const d = G.get(C.root)?.data;
    if (C.mode === "chat") {
        const g = gitMap(C.root);
        return (C.chat?.files || []).map((f) => {
            const abs = f.path || "", rel = f.rel || (inside(abs, C.root) ? relTo(abs, C.root) : abs);
            const gf = g && g.files.get(rel);
            return { path: rel, abs, status: gf ? gf.status : "", oldPath: gf?.oldPath, edits: f.edits || [], outside: !inside(abs, C.root) };
        });
    }
    return d && d.ok && d.repo !== false ? (d.files || []).map((f) => ({ ...f, abs: join(C.root, f.path) })) : [];
}
const cChecked = () => { const set = uncheckedFor(C.root); return cItems().filter((i) => i.status && !set.has(i.path)); };
async function cLoadChat() {
    if (!C.session) return;
    const s = C.session;
    C.chatLoading = true;
    if (!C.chat) cRenderList();
    const r = await get("/agent/changes", { session: s });
    if (C.session !== s) return;
    C.chatLoading = false;
    C.chat = r.ok ? r : { files: [], error: r.error || "I couldn't read this chat's edits." };
    C.chatFor = s;
    cRender();
}
function cRender() {
    if (!C.dom || !C.dom.isConnected) return;
    cRenderHead(); cRenderSeg(); cRenderList(); cRenderButtons(); cRenderNote();
}
function cRenderHead() {
    const d = G.get(C.root)?.data, head = C.dom.querySelector(".pw-xhead");
    const br = head.querySelector(".pw-branch");
    if (d && d.ok && d.repo !== false && d.branch) {
        const sync = [
            `<span class="pw-sync${d.ahead ? " pw-hot" : ""}" title="${d.ahead ? `${d.ahead} commit${d.ahead === 1 ? "" : "s"} to push` : "Nothing to push"}">↑${d.ahead || 0}</span>`,
            `<span class="pw-sync${d.behind ? " pw-hot" : ""}" title="${d.behind ? `${d.behind} commit${d.behind === 1 ? "" : "s"} to pull` : "Nothing to pull"}">↓${d.behind || 0}</span>`,
        ].join("");
        br.innerHTML = `${I.branch}<b title="${esc(d.upstream ? `${d.branch} tracks ${d.upstream}` : `${d.branch} isn't on the remote yet`)}">${esc(d.branch)}</b>${d.upstream ? sync : `<span class="pw-noup" title="Only on this Mac so far. Publish pushes it to the remote.">local</span>`}`;
    } else br.innerHTML = C.root ? `${I.git}<b>${d && d.ok && d.repo === false ? "No git" : "Source control"}</b>` : "";
    const g = head.querySelector('[data-act="group"]');
    g.setAttribute("aria-pressed", String(!!prefs.grouped));
    g.innerHTML = prefs.grouped ? I.tree : I.list;
    g.title = prefs.grouped ? "Grouped by folder. Click for a flat list" : "Flat list. Click to group by folder";
    for (const b of head.querySelectorAll("button")) b.disabled = !C.root;
    // List header: tri-state "all" box and the count.
    const items = cItems(), commit = items.filter((i) => i.status), checked = cChecked();
    const lh = C.dom.querySelector(".pw-lhead");
    const label = C.mode === "chat" ? "Edited in this chat" : "Changes";
    lh.innerHTML = commit.length || items.length ? `<label class="pw-all"><input type="checkbox" class="pw-check"${commit.length && checked.length === commit.length ? " checked" : ""}${!commit.length ? " disabled" : ""} aria-label="Include all in the commit"><span>${label}</span></label>${C.session ? "" : `<span class="pw-count">${items.length}</span>`}` : "";
    const all = lh.querySelector("input");
    if (all) all.indeterminate = checked.length > 0 && checked.length < commit.length;
}
function cRenderSeg() {
    if (!C.dom || !C.dom.isConnected) return;
    const seg = C.dom.querySelector(".pw-cseg");
    seg.hidden = !C.session;
    if (!C.session) return;
    const d = G.get(C.root)?.data, all = d && d.ok && d.repo !== false ? (d.files || []).length : 0;
    const s = sessionOf(C.session);
    const chatName = s ? sign(C.session, "main") : "This chat";
    const n = C.chat && C.chatFor === C.session ? (C.chat.files || []).length : null;
    const html = `<button type="button" data-mode="all" aria-pressed="${C.mode === "all"}">All changes<span class="pw-count">${all}</span></button><button type="button" data-mode="chat" aria-pressed="${C.mode === "chat"}" title="Files edited by ${esc(chatName)} and its subagents">This chat${n != null ? `<span class="pw-count">${n}</span>` : ""}</button>`;
    if (seg.dataset.h !== html) { seg.innerHTML = html; seg.dataset.h = html; }
}
function cRenderList() {
    const list = C.dom.querySelector(".pw-clist");
    const d = G.get(C.root)?.data;
    if (!C.root) { list.innerHTML = `<div class="pw-empty pw-empty-big"><span class="pw-empty-ic">${I.git}</span><b>No project open</b><span>Choose a project and its changes will show up here.</span></div>`; return; }
    if (!d) { list.innerHTML = `<div class="pw-info"><span class="pw-spinner"></span>Checking git…</div>`; return; }
    if (!d.ok) { list.innerHTML = `<div class="pw-empty pw-empty-big pw-err"><span class="pw-empty-ic">${I.warn}</span><b>Git isn't answering</b><span>${esc(d.error || "Unknown error.")}</span></div>`; return; }
    if (d.repo === false) { list.innerHTML = `<div class="pw-empty pw-empty-big"><span class="pw-empty-ic">${I.git}</span><b>Not a git repository</b><span>This folder isn't under git, so there's nothing to commit here.</span></div>`; return; }
    if (C.mode === "chat" && (!C.chat || C.chatFor !== C.session) && C.chatLoading) { list.innerHTML = `<div class="pw-info"><span class="pw-spinner"></span>Gathering this chat's edits…</div>`; return; }
    if (C.mode === "chat" && C.chat?.error) { list.innerHTML = `<div class="pw-empty pw-err">${esc(C.chat.error)}</div>`; return; }
    const items = cItems();
    if (!items.length) {
        list.innerHTML = C.mode === "chat"
            ? `<div class="pw-empty pw-empty-big"><span class="pw-empty-ic">${I.robot}</span><b>No edits yet</b><span>This chat's agents haven't changed any files so far.</span></div>`
            : `<div class="pw-empty pw-empty-big pw-clean"><span class="pw-empty-ic">${I.ok}</span><b>All clean</b><span>Nothing to commit. The working tree matches ${esc(d.branch || "HEAD")}.</span></div>`;
        return;
    }
    const set = uncheckedFor(C.root);
    const row = (it, grouped) => {
        const meta = ST[it.status];
        const name = base(it.path), dir = dirOf(it.path);
        const agents = C.mode === "chat" ? [...new Set(it.edits.map((e) => sign(C.session, e.agent)))] : [];
        const tip = `${it.oldPath ? `${it.oldPath} → ` : ""}${it.path}${meta ? ` · ${meta[1]}` : " · No uncommitted change"}${C.mode === "chat" ? ` · ${it.edits.length} edit${it.edits.length === 1 ? "" : "s"}` : ""}`;
        return `<div class="pw-crow${meta ? ` pw-s-${meta[2]}` : " pw-none"}${grouped ? " pw-in" : ""}${it.status === "D" ? " pw-gone" : ""}" role="listitem" data-path="${esc(it.path)}">
<input type="checkbox" class="pw-check"${meta && !set.has(it.path) ? " checked" : ""}${meta ? "" : " disabled"} aria-label="Include ${esc(name)} in the commit">
<button type="button" class="pw-cmain" title="${esc(tip)}"><span class="pw-fic">${fileIcon(name)}</span><span class="pw-nm">${esc(name)}</span>${!grouped && dir ? `<span class="pw-cdir">${esc(it.outside ? tilde(dir) : dir)}</span>` : ""}${agents.length ? `<span class="pw-agents">${agents.slice(0, 3).map((a) => `<i>${esc(a)}</i>`).join("")}</span>` : ""}</button>
${it.status !== "D" && !it.outside ? `<button type="button" class="pw-ib pw-copen" data-open aria-label="Open ${esc(name)}" title="Open file">${I.open}</button>` : ""}
<span class="pw-dec" title="${esc(meta ? meta[1] : "Committed or reverted since")}">${meta ? meta[0] : "·"}</span></div>`;
    };
    let html = "";
    if (prefs.grouped) {
        const groups = new Map();
        for (const it of items) { const k = it.outside ? tilde(dirOf(it.path)) : dirOf(it.path); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(it); }
        for (const k of [...groups.keys()].sort(collator.compare)) {
            const g = groups.get(k).sort((a, b) => collator.compare(base(a.path), base(b.path)));
            html += `<div class="pw-cgroup" title="${esc(k || base(C.root))}">${I.folder}<span>${esc(k || base(C.root))}</span><span class="pw-count">${g.length}</span></div>${g.map((it) => row(it, true)).join("")}`;
        }
    } else html = [...items].sort((a, b) => collator.compare(a.path, b.path)).map((it) => row(it, false)).join("");
    list.innerHTML = html;
}
function cRenderButtons() {
    if (!C.dom) return;
    const d = G.get(C.root)?.data, repo = !!(d && d.ok && d.repo !== false);
    const checked = cChecked(), msg = C.dom.querySelector(".pw-msg");
    const gen = C.dom.querySelector(".pw-gen"), commit = C.dom.querySelector(".pw-commitb"), push = C.dom.querySelector(".pw-push");
    gen.disabled = !repo || !checked.length || !!C.busy;
    gen.classList.toggle("pw-busy", C.busy === "gen");
    gen.title = C.busy === "gen" ? "Thinking…" : "Draft a message from the ticked changes";
    const ready = repo && checked.length && msg.value.trim() && !C.busy;
    commit.setAttribute("aria-disabled", String(!ready));
    commit.disabled = !repo || !!C.busy;
    commit.classList.toggle("pw-busy", C.busy === "commit");
    commit.querySelector("span").innerHTML = C.busy === "commit" ? "Committing…" : `Commit${checked.length ? ` <b class="pw-badge">${checked.length}</b>` : ""}`;
    commit.title = !checked.length ? "Tick the files to commit" : !msg.value.trim() ? "Write a message first, or press Generate" : `Commit ${checked.length} file${checked.length === 1 ? "" : "s"}`;
    const canPush = repo && !!d.branch && (d.ahead > 0 || !d.upstream);
    push.disabled = !canPush || !!C.busy;
    push.classList.toggle("pw-busy", C.busy === "push");
    push.querySelector("span").innerHTML = C.busy === "push" ? "Pushing…" : d && d.ok && !d.upstream && d.branch ? "Publish" : `Push${d && d.ahead ? ` <b class="pw-badge">${d.ahead}</b>` : ""}`;
    push.title = !repo ? "" : !d.upstream ? `Push ${d.branch || "this branch"} and set its upstream` : d.ahead ? `Push ${d.ahead} commit${d.ahead === 1 ? "" : "s"} to ${d.upstream}` : "Nothing to push";
    msg.disabled = !repo;
}
function cNote(kind, text, detail) {
    C.note = { kind, text, detail };
    clearTimeout(C.noteTimer);
    if (kind === "ok" || kind === "info") C.noteTimer = setTimeout(() => { C.note = null; cRenderNote(); }, kind === "ok" ? 14000 : 9000);
    cRenderNote();
}
function cRenderNote() {
    if (!C.dom) return;
    const n = C.dom.querySelector(".pw-note"), v = C.note;
    n.className = `pw-note${v ? ` pw-${v.kind}` : ""}`;
    n.innerHTML = v ? `${v.kind === "ok" ? I.ok : v.kind === "err" ? I.warn : I.info}<div><span>${esc(v.text)}</span>${v.detail ? `<pre>${esc(v.detail)}</pre>` : ""}</div>${v.kind === "err" ? `<button type="button" class="pw-ib" aria-label="Dismiss" title="Dismiss">${I.x}</button>` : ""}` : "";
    const x = n.querySelector("button");
    if (x) x.onclick = () => { C.note = null; cRenderNote(); };
}
function setMessage(ta, text) {
    ta.focus();
    ta.select();
    // insertText keeps the textarea's own undo history, so Cmd+Z brings your words back.
    let ok = false;
    try { ok = document.execCommand("insertText", false, text); } catch { ok = false; }
    if (!ok || ta.value !== text) ta.value = text;
    ta.setSelectionRange(0, 0);
    ta.scrollTop = 0;
}
async function cGenerate() {
    const root = C.root, items = cChecked();
    if (C.busy || !root) return;
    if (!items.length) { cNote("info", "Tick at least one file and I'll describe it."); return; }
    const ta = C.dom.querySelector(".pw-msg");
    C.busy = "gen";
    ta.classList.add("pw-thinking");
    ta.placeholder = "Reading the changes…";
    cRenderButtons();
    const r = await post("/git/message", { root, paths: items.flatMap((i) => (i.oldPath ? [i.path, i.oldPath] : [i.path])) });
    C.busy = "";
    ta.classList.remove("pw-thinking");
    ta.placeholder = MSG_PLACEHOLDER;
    if (C.root === root) {
        if (r.ok && r.message) {
            setMessage(ta, String(r.message).trim());
            const ai = /claude|haiku|ai|model|llm/i.test(String(r.source || ""));
            cNote("info", ai ? "Drafted by Claude. Read it before you commit." : "Drafted from the list of changed files. Edit it to taste.");
        } else cNote("err", "I couldn't draft a message this time.", r.error || "");
    }
    cRenderButtons();
}
async function cCommit() {
    const root = C.root;
    if (C.busy || !root) return;
    const ta = C.dom.querySelector(".pw-msg"), message = ta.value.trim(), items = cChecked();
    if (!items.length) { cNote("info", "Nothing is ticked. Tick the files you want in this commit."); return; }
    if (!message) { ta.focus(); cNote("info", "A message first, or press Generate and I'll draft one."); return; }
    C.busy = "commit";
    cRenderButtons();
    const r = await post("/git/commit", { root, message, paths: items.flatMap((i) => (i.oldPath ? [i.path, i.oldPath] : [i.path])) });
    C.busy = "";
    cRenderButtons();
    if (r.ok) {
        if (C.root === root) ta.value = "";
        for (const i of items) uncheckedFor(root).delete(i.path);
        cNote("ok", `Committed ${shortSha(r.commit) || "your changes"}.`, r.summary || "");
    } else cNote("err", "Git didn't take the commit.", r.error || "Unknown error.");
    await gitStatus(root, true);
    cRender();
    eRefreshFrom(root, false);
}
async function cPush() {
    const root = C.root, d = G.get(root)?.data;
    if (C.busy || !root) return;
    C.busy = "push";
    cRenderButtons();
    const r = await post("/git/push", { root });
    C.busy = "";
    cRenderButtons();
    if (r.ok) {
        const lines = String(r.output || "").trim().split("\n").filter(Boolean);
        cNote("ok", d && !d.upstream ? `Published ${d.branch || "the branch"}.` : "Pushed. The remote is up to date.", lines.slice(-2).join("\n"));
    } else cNote("err", "The push didn't go through.", r.error || "Unknown error.");
    await gitStatus(root, true);
    cRender();
}
gitSubs.add((root) => {
    if (root === X.root) { xRenderHead(); xRender(); }
    if (root === C.root) cRender();
    const t = activeTab();
    if (t && t.root === root) eRenderCrumbs(t);
});

// ============ Editor area (mountEditor) ============
const E = { host: null, dom: null, tabsEl: null, body: null, crumbs: null, banner: null, stage: null, edits: null, codeHost: null, diffHost: null, place: null, dialog: null, insert: null, tabs: [], active: "graph", code: null, diff: null, m: null, layoutOn: null, restored: false, drag: null, flash: 0 };
const activeTab = () => E.tabs.find((t) => t.id === E.active) || null;

function mountEditor(host) {
    if (!host) return;
    if (!E.dom) buildEditor();
    if (E.host !== host) {
        if (E.host) E.host.classList.remove("pw-host");
        E.host = host;
    }
    host.classList.add("pw-host");
    if (E.dom.parentNode !== host) host.appendChild(E.dom);
    if (!E.restored) restoreTabs();
    eRender();
}
function buildEditor() {
    const d = el("section", "pw-editor pw-glass pw-graph pw-none");
    d.setAttribute("aria-label", "Editor");
    d.innerHTML = `
<div class="pw-tabbar" role="tablist" aria-label="Open editors"><div class="pw-tab pw-gtab" role="tab" data-id="graph" title="The agent graph"><span class="pw-tic">${I.graph}</span><span class="pw-tname">Graph</span></div><div class="pw-tabs" role="presentation"></div><i class="pw-insert" hidden></i></div>
<div class="pw-body">
    <div class="pw-crumbs"></div>
    <div class="pw-banner" role="alert" hidden></div>
    <div class="pw-stage" data-view="place">
        <aside class="pw-edits" aria-label="Edits"></aside>
        <div class="pw-pane"><div class="pw-code"></div><div class="pw-diff"></div><div class="pw-place"></div></div>
    </div>
    <div class="pw-dialog" hidden></div>
</div>`;
    E.dom = d;
    E.bar = d.querySelector(".pw-tabbar"); E.gtab = d.querySelector(".pw-gtab");
    E.tabsEl = d.querySelector(".pw-tabs"); E.insert = d.querySelector(".pw-insert");
    E.body = d.querySelector(".pw-body"); E.crumbs = d.querySelector(".pw-crumbs"); E.banner = d.querySelector(".pw-banner");
    E.stage = d.querySelector(".pw-stage"); E.edits = d.querySelector(".pw-edits");
    E.codeHost = d.querySelector(".pw-code"); E.diffHost = d.querySelector(".pw-diff"); E.place = d.querySelector(".pw-place"); E.dialog = d.querySelector(".pw-dialog");
    wireEditor();
}
function wireEditor() {
    const d = E.dom;
    // Save and close belong to the editor while you are in it; plain keys stay here so the page's one-key shortcuts don't fire while typing.
    d.addEventListener("keydown", (e) => {
        const mod = IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
        if (mod && !e.altKey) {
            const k = e.key.toLowerCase();
            if (k === "s" && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); const t = activeTab(); if (t && t.kind === "file") saveTab(t); return; }
            if (k === "w" && !e.shiftKey && activeTab()) { e.preventDefault(); e.stopPropagation(); closeTab(E.active); return; }
        }
    }, true);
    d.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && !E.dialog.hidden) { e.preventDefault(); e.stopPropagation(); closeDialog(); return; }
        // Typing in the editor stays in the editor: the page has one-key shortcuts (T, A, R...) that must not fire mid-word.
        if (!e.metaKey && !e.ctrlKey && e.target.closest(".monaco-editor, .monaco-diff-editor, .pw-dialog")) e.stopPropagation();
    });
    // Tabs: click to switch, middle-click or × to close, drag to reorder, arrows to move between them.
    E.bar.addEventListener("pointerdown", tabPointerDown);
    E.bar.addEventListener("mousedown", (e) => { if (e.button === 1) e.preventDefault(); });
    E.bar.addEventListener("auxclick", (e) => {
        if (e.button !== 1) return;
        const tab = e.target.closest(".pw-tab");
        if (tab && tab.dataset.id !== "graph") { e.preventDefault(); closeTab(tab.dataset.id); }
    });
    E.bar.addEventListener("click", (e) => {
        const x = e.target.closest(".pw-tx");
        if (x) { e.stopPropagation(); closeTab(x.closest(".pw-tab").dataset.id); }
    });
    E.bar.addEventListener("dblclick", (e) => {
        const tab = e.target.closest(".pw-tab");
        const t = tab && E.tabs.find((x) => x.id === tab.dataset.id);
        if (t && t.preview) { t.preview = false; eRenderTabs(); persistTabs(); }
    });
    E.tabsEl.addEventListener("scroll", tabFades, { passive: true });
    E.bar.addEventListener("keydown", (e) => {
        const tab = e.target.closest(".pw-tab");
        if (!tab) return;
        const ids = ["graph", ...E.tabs.map((t) => t.id)], i = ids.indexOf(tab.dataset.id);
        let j = -1;
        if (e.key === "ArrowRight") j = (i + 1) % ids.length;
        else if (e.key === "ArrowLeft") j = (i - 1 + ids.length) % ids.length;
        else if (e.key === "Home") j = 0;
        else if (e.key === "End") j = ids.length - 1;
        else if ((e.key === "Delete" || e.key === "Backspace") && tab.dataset.id !== "graph") { e.preventDefault(); closeTab(tab.dataset.id); return; }
        else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activate(tab.dataset.id, { focus: true }); return; }
        if (j < 0) return;
        e.preventDefault();
        activate(ids[j]);
        E.bar.querySelector(`.pw-tab[data-id="${CSS.escape(ids[j])}"]`)?.focus();
    });
    E.tabsEl.addEventListener("wheel", (e) => {
        if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && E.tabsEl.scrollWidth > E.tabsEl.clientWidth) { E.tabsEl.scrollLeft += e.deltaY; e.preventDefault(); }
    }, { passive: false });
    E.crumbs.addEventListener("click", crumbAction);
    E.banner.addEventListener("click", crumbAction);
    E.place.addEventListener("click", crumbAction);
    E.edits.addEventListener("click", (e) => {
        const b = e.target.closest("[data-edit]");
        if (b) selectEdit(activeTab(), Number(b.dataset.edit));
    });
    E.edits.addEventListener("keydown", (e) => {
        const t = activeTab();
        if (!t || t.kind !== "agent" || !t.edits?.length) return;
        if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
        e.preventDefault();
        selectEdit(t, clamp(t.sel + (e.key === "ArrowDown" ? 1 : -1), 0, t.edits.length - 1));
        E.edits.querySelector(`[data-edit="${t.sel}"]`)?.focus();
    });
    E.dialog.addEventListener("click", (e) => {
        const b = e.target.closest("button[data-dlg]");
        if (b && E.dialogResolve) E.dialogResolve(b.dataset.dlg);
    });
}

// ---- tabs ----
function tabIcon(t) {
    if (t.kind === "diff") return I.diff;
    if (t.kind === "agent") return I.robot;
    return fileIcon(t.name);
}
function tabDesc(t) {
    const dup = E.tabs.some((o) => o !== t && o.name === t.name && (o.abs !== t.abs || o.kind === t.kind));
    const where = dup ? (t.path ? dirOf(t.path) : tilde(dirOf(t.abs))) : "";
    if (t.kind === "diff") return ["Changes", where].filter(Boolean).join(" · ");
    if (t.kind === "agent") return [t.agent ? `${sign(t.session, t.agent)} edits` : "Chat edits", where].filter(Boolean).join(" · ");
    return where;
}
function tabTitle(t) {
    const where = t.root && t.path ? tilde(join(t.root, t.path)) : tilde(t.abs);
    if (t.kind === "diff") return `${where} · working tree vs HEAD`;
    if (t.kind === "agent") return `${where} · edits by ${t.agent ? sign(t.session, t.agent) : "this chat"}`;
    return `${where}${t.preview ? " · preview (double-click to keep open)" : ""}`;
}
// Keyed: tabs keep their DOM node across renders, so a double-click or a drag that re-renders mid-gesture still lands.
function eRenderTabs() {
    if (!E.dom) return;
    const g = E.active === "graph";
    E.gtab.classList.toggle("pw-on", g);
    E.gtab.setAttribute("aria-selected", String(g));
    E.gtab.tabIndex = g ? 0 : -1;
    const have = new Map([...E.tabsEl.children].map((n) => [n.dataset.id, n]));
    let prev = null;
    for (const t of E.tabs) {
        let n = have.get(t.id);
        have.delete(t.id);
        const on = t.id === E.active;
        const cls = `pw-tab${on ? " pw-on" : ""}${t.preview ? " pw-preview" : ""}${t.dirty ? " pw-dirty" : ""}${t.kind !== "file" ? ` pw-k-${t.kind}` : ""}`;
        const desc = tabDesc(t);
        const html = `<span class="pw-tic">${tabIcon(t)}</span><span class="pw-tname">${esc(t.name)}</span>${desc ? `<span class="pw-tdesc">${esc(desc)}</span>` : ""}<button class="pw-tx" type="button" tabindex="-1" aria-label="Close ${esc(t.name)}">${I.x}</button>`;
        const title = tabTitle(t);
        if (!n) { n = el("div"); n.dataset.id = t.id; n.setAttribute("role", "tab"); }
        if (n.className !== cls) n.className = cls;
        if (n.dataset.h !== html) { n.innerHTML = html; n.dataset.h = html; }
        n.title = title;
        n.setAttribute("aria-selected", String(on));
        n.tabIndex = on ? 0 : -1;
        const want2 = prev ? prev.nextSibling : E.tabsEl.firstChild;
        if (want2 !== n) E.tabsEl.insertBefore(n, want2);
        prev = n;
    }
    for (const n of have.values()) n.remove();
    const on = E.tabsEl.querySelector(".pw-tab.pw-on");
    if (on) {
        const a = on.offsetLeft, b = a + on.offsetWidth, l = E.tabsEl.scrollLeft, w = E.tabsEl.clientWidth;
        if (a < l) E.tabsEl.scrollLeft = a - 24; else if (b > l + w) E.tabsEl.scrollLeft = b - w + 24;
    }
    tabFades();
}
// Soft edges on the tab strip when there are more tabs than fit.
function tabFades() {
    const s = E.tabsEl, max = s.scrollWidth - s.clientWidth;
    s.classList.toggle("pw-fl", max > 1 && s.scrollLeft > 1);
    s.classList.toggle("pw-fr", max > 1 && s.scrollLeft < max - 1);
}
function tabPointerDown(e) {
    const tab = e.target.closest(".pw-tab");
    if (!tab || e.button !== 0 || e.target.closest(".pw-tx")) return;
    const id = tab.dataset.id;
    if (id !== E.active) activate(id);
    if (id === "graph") return;
    E.drag = { id, x0: e.clientX, y0: e.clientY, on: false, pid: e.pointerId, to: -1 };
    const move = (ev) => {
        const g = E.drag;
        if (!g) return;
        if (!g.on) {
            if (Math.abs(ev.clientX - g.x0) < 5 && Math.abs(ev.clientY - g.y0) < 5) return;
            g.on = true;
            try { tab.setPointerCapture(g.pid); } catch { /* ok */ }
            tab.classList.add("pw-lifted");
            E.dom.classList.add("pw-dragging");
        }
        const tabs = [...E.tabsEl.querySelectorAll(".pw-tab:not(.pw-gtab)")];
        let to = tabs.length, x = 0;
        for (let k = 0; k < tabs.length; k++) {
            const r = tabs[k].getBoundingClientRect();
            if (ev.clientX < r.left + r.width / 2) { to = k; x = r.left; break; }
            x = r.right;
        }
        g.to = to;
        const bar = E.tabsEl.parentNode.getBoundingClientRect();
        E.insert.hidden = false;
        E.insert.style.left = `${x - bar.left + 1}px`;
    };
    const up = () => {
        removeEventListener("pointermove", move);
        removeEventListener("pointerup", up);
        removeEventListener("pointercancel", up);
        const g = E.drag;
        E.drag = null;
        E.insert.hidden = true;
        tab.classList.remove("pw-lifted");
        E.dom.classList.remove("pw-dragging");
        if (!g || !g.on || g.to < 0) return;
        const from = E.tabs.findIndex((t) => t.id === g.id);
        if (from < 0) return;
        const [t] = E.tabs.splice(from, 1);
        E.tabs.splice(g.to > from ? g.to - 1 : g.to, 0, t);
        t.preview = false;
        eRenderTabs();
        persistTabs();
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
    addEventListener("pointercancel", up);
}
function insertTab(t, preview) {
    if (preview) {
        const old = E.tabs.find((x) => x.preview && !x.dirty);
        if (old) {
            const i = E.tabs.indexOf(old);
            E.tabs[i] = t;
            disposeTab(old);
            return;
        }
    }
    const i = E.tabs.findIndex((x) => x.id === E.active);
    E.tabs.splice(i < 0 ? E.tabs.length : i + 1, 0, t);
    while (E.tabs.length > MAX_TABS) {
        const victim = E.tabs.find((x) => !x.dirty && x !== t && x.id !== E.active);
        if (!victim) break;
        E.tabs.splice(E.tabs.indexOf(victim), 1);
        disposeTab(victim);
    }
}
function persistTabs() {
    const tabs = E.tabs.filter((t) => t.kind === "file" || t.kind === "diff").map((t) => ({ kind: t.kind, root: t.root, path: t.path }));
    keep(K_TABS, { tabs });
}
function restoreTabs() {
    E.restored = true;
    const saved = load(K_TABS, {});
    for (const s of (saved && saved.tabs) || []) {
        if (!s || !s.root || !s.path || (s.kind !== "file" && s.kind !== "diff")) continue;
        const id = `${s.kind}:${s.root}:${s.path}`;
        if (E.tabs.some((t) => t.id === id)) continue;
        E.tabs.push({ id, kind: s.kind, root: s.root, path: s.path, abs: join(s.root, s.path), name: base(s.path), state: "idle", editing: s.kind === "file" });
    }
}
function saveView(t) {
    if (!t || t.state !== "ready") return;
    try {
        if (t.kind === "file" && E.code && E.code.getModel() === t.model) t.view = E.code.saveViewState();
        else if (t.kind !== "file" && E.diff) { const m = E.diff.getModel(); if (m && (m.modified === t.modified || m.modified === t.head?.modified)) t.view = E.diff.saveViewState(); }
    } catch { /* view state is a nicety */ }
}
function activate(id, opts = {}) {
    const next = id === "graph" ? null : E.tabs.find((t) => t.id === id);
    if (id !== "graph" && !next) return;
    if (E.active !== id) {
        saveView(activeTab());
        E.active = id;
        if (next && next.kind === "file") xReveal(next.root, next.path);
    }
    eRender();
    if (opts.focus && next) setTimeout(() => focusEditor(next), 0);
}
function focusEditor(t) {
    if (!t || t.id !== E.active) return;
    if (t.kind === "file" && t.state === "ready" && E.code) E.code.focus();
    else if (t.kind !== "file" && E.diff && t.state === "ready") E.diff.getModifiedEditor().focus();
    else E.bar.querySelector(".pw-tab.pw-on")?.focus();
}
function disposeTab(t) {
    try {
        if (E.code && t.model && E.code.getModel() === t.model) E.code.setModel(null);
        const dm = E.diff && E.diff.getModel();
        if (dm && [t.original, t.modified, t.head?.original, t.head?.modified].includes(dm.modified)) E.diff.setModel(null);
        for (const m of [t.model, t.original, t.modified, t.head?.original, t.head?.modified]) if (m && !m.isDisposed()) m.dispose();
    } catch (err) { console.warn(err); }
}
async function closeTab(id, opts = {}) {
    const t = E.tabs.find((x) => x.id === id);
    if (!t) return;
    if (t.dirty && !opts.force) {
        activate(id);
        const choice = await ask(`Save changes to ${t.name}?`, "Your edits will be lost if you close without saving.", [["cancel", "Cancel"], ["discard", "Don't save"], ["save", "Save", "primary"]]);
        if (choice === "save") { const ok = await saveTab(t); if (!ok) return; }
        else if (choice !== "discard") { focusEditor(t); return; }
    }
    const i = E.tabs.indexOf(t);
    if (i < 0) return;
    if (E.active === id) {
        const next = E.tabs[i + 1] || E.tabs[i - 1];
        saveView(t);
        E.active = next ? next.id : "graph";
    }
    E.tabs.splice(i, 1);
    disposeTab(t);
    persistTabs();
    eRender();
    if (E.active !== "graph") setTimeout(() => focusEditor(activeTab()), 0);
}
function ask(title, text, buttons) {
    closeDialog();
    E.dialog.hidden = false;
    E.dialog.innerHTML = `<div class="pw-dlg" role="alertdialog" aria-modal="true" aria-label="${esc(title)}"><b>${esc(title)}</b><p>${esc(text)}</p><div>${buttons.map(([v, label, kind]) => `<button type="button" class="pw-btn${kind ? ` pw-${kind}` : ""}" data-dlg="${v}">${esc(label)}</button>`).join("")}</div></div>`;
    setTimeout(() => E.dialog.querySelector(".pw-primary, button:last-child")?.focus(), 0);
    return new Promise((resolve) => { E.dialogResolve = (v) => { E.dialogResolve = null; closeDialog(); resolve(v); }; });
}
function closeDialog() {
    const r = E.dialogResolve;
    E.dialogResolve = null;
    E.dialog.hidden = true;
    E.dialog.innerHTML = "";
    if (r) r("cancel");
}

// ---- opening things (contract G) ----
function resolvePath(root, path) {
    root = norm(root);
    let p = String(path || "");
    if (p.startsWith("/")) {
        if (root && inside(p, root)) p = relTo(p, root);
        else {
            const r = findRoot(p);
            if (r) { root = r; p = relTo(p, r); } else { root = dirOf(p); p = base(p); }
        }
    }
    p = p.replace(/^\.\//, "").replace(/^\/+/, "");
    return { root, path: p };
}
function openFile(root, path, opts = {}) {
    const r = resolvePath(root, path);
    if (!r.root || !r.path) return false;
    const id = `file:${r.root}:${r.path}`;
    let t = E.tabs.find((x) => x.id === id);
    if (!t) {
        t = { id, kind: "file", root: r.root, path: r.path, abs: join(r.root, r.path), name: base(r.path), state: "idle", preview: !!opts.preview, editing: true };
        insertTab(t, opts.preview);
        persistTabs();
    } else if (!opts.preview && t.preview) { t.preview = false; persistTabs(); }
    if (opts.line) { t.reveal = { line: Number(opts.line) || 1, col: Number(opts.column) || 1 }; }
    // Files are editable straight away; one opened on purpose (not a single-click preview) takes the cursor once it has loaded.
    if (opts.focus || !opts.preview) t.focusOnReady = true;
    activate(t.id, { focus: opts.focus || !!opts.line });
    if (t.reveal && t.state === "ready") revealPending(t);
    xReveal(r.root, r.path);
    if (!E.host) console.warn("PulseWorkspace: mountEditor() has not been called yet");
    return true;
}
function openDiff(root, path, opts = {}) {
    const r = resolvePath(root, path);
    if (!r.root || !r.path) return false;
    const id = `diff:${r.root}:${r.path}`;
    let t = E.tabs.find((x) => x.id === id);
    if (!t) {
        t = { id, kind: "diff", root: r.root, path: r.path, abs: join(r.root, r.path), name: base(r.path), state: "idle", preview: !!opts.preview };
        insertTab(t, opts.preview);
        persistTabs();
    } else if (!opts.preview && t.preview) t.preview = false;
    else if (t.state === "ready") t.stale = true; // opening it again should show the latest diff
    activate(t.id, { focus: opts.focus });
    return true;
}
function openAgentChanges(session, agent, absPath, opts = {}) {
    if (!session || !absPath) return false;
    const abs = String(absPath);
    const id = `agent:${session}:${agent || ""}:${abs}`;
    let t = E.tabs.find((x) => x.id === id);
    if (!t) {
        const s = sessionOf(session);
        const root = s && s.cwd && inside(abs, s.cwd) ? s.cwd : findRoot(abs);
        t = { id, kind: "agent", session, agent: agent && agent !== "*" ? agent : "", abs, root, path: root ? relTo(abs, root) : "", name: base(abs), state: "idle", preview: !!opts.preview, sel: -1, view2: "edits" };
        insertTab(t, opts.preview);
    } else if (!opts.preview && t.preview) t.preview = false;
    else if (t.state === "ready") t.stale = true;
    activate(t.id, { focus: opts.focus });
    return true;
}
function showGraph() { activate("graph"); }
function isEditorOpen() { return !!E.dom && !!E.host && E.active !== "graph"; }
function setRoot(root) {
    root = norm(root);
    if (!root) return;
    const changed = root !== W.root;
    setRootOnly(root);
    if (X.dom && X.dom.isConnected && (changed || X.root !== root)) xSetRoot(root);
    if (C.dom && C.dom.isConnected && C.root !== root) {
        C.root = root;
        const s = sessionOf(C.session);
        if (C.session && (!s || s.cwd !== root)) { C.session = ""; C.chat = null; C.mode = "all"; }
        cRender();
        gitStatus(root).then(cRender);
    }
}

// ---- loading content ----
async function readFile(root, path) {
    await openRoot(root);
    return get("/fs/read", { root, path });
}
async function loadFile(t) {
    if (t.loading) return t.loading;
    t.state = "loading";
    t.loading = (async () => {
        const [r] = await Promise.all([readFile(t.root, t.path), ensureMonaco()]);
        t.loading = null;
        if (!E.tabs.includes(t)) return;
        if (!r.ok) { t.state = "error"; t.error = r.error || "I couldn't read this file."; }
        else if (r.binary) { t.state = "binary"; t.size = r.size; }
        else if (r.tooLarge) { t.state = "large"; t.size = r.size; }
        else {
            t.model = newModel(r.text ?? "", r.language, t.abs, "file");
            t.saved = t.model.getAlternativeVersionId();
            t.mtime = r.mtime;
            t.size = r.size;
            t.model.onDidChangeContent(() => onEdited(t));
            t.state = "ready";
        }
        if (t.id === E.active) eRender(); else eRenderTabs();
    })();
    return t.loading;
}
function onEdited(t) {
    const dirty = t.model.getAlternativeVersionId() !== t.saved;
    if (dirty && t.preview) { t.preview = false; persistTabs(); }
    if (dirty !== !!t.dirty) {
        t.dirty = dirty;
        eRenderTabs();
        if (t.id === E.active) eRenderCrumbs(t);
    }
}
async function loadDiff(t) {
    if (t.loading) return t.loading;
    t.state = t.state === "ready" ? "ready" : "loading";
    t.loading = (async () => {
        await openRoot(t.root);
        const [r] = await Promise.all([get("/git/diff", { root: t.root, path: t.path }), ensureMonaco()]);
        t.loading = null;
        t.stale = false;
        if (!E.tabs.includes(t)) return;
        applyDiff(t, r, "git");
        if (t.id === E.active) eRender(); else eRenderTabs();
    })();
    return t.loading;
}
// Fill a tab (or its "whole file vs HEAD" view) from a /git/diff reply.
function applyDiff(target, r, tag) {
    if (!r.ok) { target.state = "error"; target.error = r.error || "I couldn't get the diff."; return; }
    if (r.binary) { target.state = "binary"; return; }
    if (r.tooLarge) { target.state = "large"; target.size = r.size; return; }
    const before = r.before ?? "", after = r.after ?? "";
    if (target.original && !target.original.isDisposed()) {
        if (target.original.getValue() !== before) target.original.setValue(before);
        if (target.modified.getValue() !== after) target.modified.setValue(after);
    } else {
        target.original = newModel(before, null, target.abs, `${tag}-before`);
        target.modified = newModel(after, null, target.abs, `${tag}-after`);
    }
    target.added = r.before == null || r.before === "";
    target.deleted = r.after == null || r.after === "";
    target.counts = lineCounts(before, after);
    target.state = "ready";
}
async function loadAgent(t) {
    if (t.loading) return t.loading;
    t.state = t.state === "ready" ? "ready" : "loading";
    t.loading = (async () => {
        const [r] = await Promise.all([get("/agent/changes", t.agent ? { session: t.session, agent: t.agent } : { session: t.session }), ensureMonaco()]);
        t.loading = null;
        t.stale = false;
        if (!E.tabs.includes(t)) return;
        if (!r.ok) { t.state = "error"; t.error = r.error || "I couldn't read this agent's edits."; }
        else {
            const files = r.files || [];
            const f = files.find((x) => x.path === t.abs) || files.find((x) => x.rel && t.abs.endsWith(`/${x.rel}`));
            const edits = (f?.edits || []).slice().sort((a, b) => (a.t || 0) - (b.t || 0));
            if (f?.rel && !t.path) t.path = f.rel;
            if (!edits.length) { t.state = "none"; }
            else {
                const grew = !t.edits || edits.length !== t.edits.length;
                t.edits = edits.map((e, i) => ({ ...e, i, counts: lineCounts(e.before, e.after) }));
                if (t.sel < 0 || t.sel >= edits.length || (grew && t.sel === (t.prevLen ?? edits.length) - 1)) t.sel = edits.length - 1;
                t.prevLen = edits.length;
                if (!t.original || t.original.isDisposed()) {
                    t.original = newModel("", null, t.abs, "edit-before");
                    t.modified = newModel("", null, t.abs, "edit-after");
                }
                fillEdit(t);
                t.state = "ready";
            }
        }
        if (t.id === E.active) eRender(); else eRenderTabs();
    })();
    return t.loading;
}
function fillEdit(t) {
    const e = t.edits[t.sel];
    if (!e) return;
    const before = e.before ?? "", after = e.after ?? "";
    if (t.original.getValue() !== before) t.original.setValue(before);
    if (t.modified.getValue() !== after) t.modified.setValue(after);
    t.counts = e.counts;
    t.added = !before;
    t.deleted = !after;
}
function selectEdit(t, i) {
    if (!t || t.kind !== "agent" || !t.edits || i === t.sel || !t.edits[i]) return;
    t.sel = i;
    t.view = null;
    fillEdit(t);
    if (t.view2 !== "edits") t.view2 = "edits";
    eRender();
}
async function loadHead(t) {
    if (!t.root || !t.path) return;
    t.head = t.head || { abs: t.abs, state: "loading" };
    const h = t.head;
    await openRoot(t.root);
    const r = await get("/git/diff", { root: t.root, path: t.path });
    applyDiff(h, r, "head");
    if (t.id === E.active) eRender();
}

// ---- rendering the editor area ----
function syncLayout() {
    const on = !!E.host && E.active !== "graph";
    document.body.classList.toggle("ws-editor", on);
    if (on === E.layoutOn) return;
    E.layoutOn = on;
    dispatchEvent(new CustomEvent("pulse:layout", { detail: { source: "workspace", editor: on, tabs: E.tabs.length } }));
}
function eRender() {
    if (!E.dom) return;
    const t = activeTab();
    if (!t && E.active !== "graph") E.active = "graph";
    E.dom.classList.toggle("pw-graph", !t);
    E.dom.classList.toggle("pw-none", !t && !E.tabs.length);
    eRenderTabs();
    syncLayout();
    if (!t) { if (!E.dialog.hidden) closeDialog(); return; }
    eRenderCrumbs(t);
    eRenderBanner(t);
    eRenderStage(t);
}
function view(name) { if (E.stage.dataset.view !== name) E.stage.dataset.view = name; }
function place(t, { icon, title, text, actions = "", busy = false }) {
    view("place");
    E.edits.hidden = true;
    const html = busy
        ? `<div class="pw-ph pw-ph-busy"><span class="pw-spinner"></span><span>${esc(title)}</span></div>`
        : `<div class="pw-ph"><span class="pw-ph-ic">${icon || I.file}</span><b>${esc(title)}</b>${text ? `<p>${text}</p>` : ""}${actions ? `<div class="pw-ph-acts">${actions}</div>` : ""}</div>`;
    if (E.place.dataset.h !== html) { E.place.innerHTML = html; E.place.dataset.h = html; }
}
function eRenderStage(t) {
    if (!E.m) {
        place(t, { busy: true, title: "Warming up the editor…" });
        ensureMonaco().then(() => { if (activeTab() === t) eRender(); }).catch((err) => {
            console.warn(err);
            if (activeTab() === t) place(t, { icon: I.warn, title: "The editor didn't load", text: `${esc(err && err.message ? err.message : String(err))}<br>Check that Pulse serves <code>/vendor/monaco/</code>.`, actions: `<button type="button" class="pw-btn" data-act="retry-monaco">Try again</button>` });
        });
        return;
    }
    if (t.kind === "file") return stageFile(t);
    if (t.kind === "diff") return stageDiff(t);
    return stageAgent(t);
}
function statePlace(t, what) {
    if (t.state === "loading" || t.state === "idle") return place(t, { busy: true, title: `Opening ${t.name}…` });
    if (t.state === "binary") return place(t, { icon: fileIcon(t.name), title: "Binary file", text: `This is a binary file${t.size ? ` (${esc(fmtSize(t.size))})` : ""}. There's nothing here I can show as text.` });
    if (t.state === "large") return place(t, { icon: fileIcon(t.name), title: "Too large to open here", text: `It's ${esc(fmtSize(t.size) || "very large")}. Opening it in the browser would slow everything down.` });
    if (t.state === "none") return place(t, { icon: I.robot, title: "No recorded edits", text: `I don't have any edits to <code>${esc(t.name)}</code> from ${t.agent ? esc(sign(t.session, t.agent)) : "this chat"}. They may have happened before Pulse was watching.`, actions: t.root && t.path ? `<button type="button" class="pw-btn" data-act="head">${I.head}<span>Show whole file vs HEAD</span></button>` : "" });
    return place(t, { icon: I.warn, title: `I couldn't open ${what || t.name}`, text: esc(t.error || "Something went wrong."), actions: `<button type="button" class="pw-btn" data-act="retry">Try again</button>` });
}
function ensureCode() {
    if (E.code) return E.code;
    E.code = E.m.editor.create(E.codeHost, { ...editorOptions(), model: null, readOnly: true });
    E.code.onDidChangeCursorPosition(() => updatePos());
    E.code.onDidChangeCursorSelection(() => updatePos());
    return E.code;
}
function ensureDiff() {
    if (E.diff) return E.diff;
    E.diff = E.m.editor.createDiffEditor(E.diffHost, {
        ...editorOptions(), readOnly: true, originalEditable: false, renderSideBySide: !prefs.inline, enableSplitViewResizing: true,
        renderOverviewRuler: true, ignoreTrimWhitespace: false, renderMarginRevertIcon: false, renderIndicators: true, minimap: { enabled: false },
        hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 5, revealLineCount: 20 }, useInlineViewWhenSpaceIsLimited: true, renderSideBySideInlineBreakpoint: NARROW,
        diffAlgorithm: "advanced", stickyScroll: { enabled: false },
    });
    // Below NARROW px Monaco shows diffs inline whatever the setting; keep the toggle honest about it.
    new ResizeObserver(() => {
        const w = E.diffHost.clientWidth, narrow = w > 0 && w < NARROW;
        if (narrow === E.narrow) return;
        E.narrow = narrow;
        const t = activeTab();
        if (t && t.kind !== "file") eRenderCrumbs(t);
    }).observe(E.diffHost);
    E.diff.onDidUpdateDiff(() => {
        const t = activeTab();
        if (!t || t.kind === "file") return;
        const changes = E.diff.getLineChanges() || [];
        let add = 0, del = 0;
        for (const c of changes) {
            if (c.modifiedEndLineNumber >= c.modifiedStartLineNumber && c.modifiedEndLineNumber > 0) add += c.modifiedEndLineNumber - c.modifiedStartLineNumber + 1;
            if (c.originalEndLineNumber >= c.originalStartLineNumber && c.originalEndLineNumber > 0) del += c.originalEndLineNumber - c.originalStartLineNumber + 1;
        }
        const target = t.kind === "agent" && t.view2 === "head" ? t.head : t;
        // A whole new or deleted file: Monaco counts the empty other side as a changed line, the plain count is right.
        if (target && !target.added && !target.deleted) { target.counts = { add, del }; updateCounts(target); }
        if (t.kind === "agent" && t.view2 === "edits" && t.edits && t.edits[t.sel] && !t.added && !t.deleted) { t.edits[t.sel].counts = { add, del }; const b = E.edits.querySelector(`[data-edit="${t.sel}"] .pw-ecount`); if (b) b.innerHTML = countsHtml({ add, del }); }
        if (t.firstDiff) { t.firstDiff = false; try { E.diff.revealFirstDiff?.(); } catch { /* optional */ } }
    });
    return E.diff;
}
function stageFile(t) {
    if (t.state === "idle") loadFile(t);
    if (t.state !== "ready") { statePlace(t); return; }
    const ed = ensureCode();
    E.edits.hidden = true;
    view("code");
    if (ed.getModel() !== t.model) {
        ed.setModel(t.model);
        if (t.view) ed.restoreViewState(t.view);
    }
    ed.updateOptions({ readOnly: !t.editing });
    revealPending(t);
    if (t.focusOnReady) { t.focusOnReady = false; setTimeout(() => focusEditor(t), 0); }
    updatePos();
}
function revealPending(t) {
    if (!t.reveal || !E.code || E.code.getModel() !== t.model) return;
    const { line, col } = t.reveal;
    t.reveal = null;
    E.code.setPosition({ lineNumber: line, column: col });
    E.code.revealLineInCenter(line);
    E.code.focus();
}
function stageDiff(t) {
    if (t.state === "idle" || t.stale) loadDiff(t);
    if (t.state !== "ready") { statePlace(t); return; }
    showDiff(t, t, !prefs.inline);
}
function showDiff(t, src, sideBySide) {
    const d = ensureDiff();
    view("diff");
    // An Edit call's before/after is a fragment of the file, so its "line 1" would mislead: no numbers for those.
    const fragment = t.kind === "agent" && src === t && t.edits?.[t.sel]?.kind === "edit";
    d.updateOptions({ renderSideBySide: sideBySide, lineNumbers: fragment ? "off" : "on" });
    const m = d.getModel();
    if (!m || m.original !== src.original || m.modified !== src.modified) {
        if (!src.shown) { src.shown = true; t.firstDiff = true; }
        d.setModel({ original: src.original, modified: src.modified });
        if (t.view && src === (t.kind === "agent" && t.view2 === "head" ? t.head : t)) { try { d.restoreViewState(t.view); } catch { /* ok */ } }
    }
}
function stageAgent(t) {
    if (t.state === "idle" || t.stale) loadAgent(t);
    if (t.view2 === "head") {
        E.edits.hidden = true;
        if (!t.head) loadHead(t);
        const h = t.head || { state: "loading" };
        if (h.state !== "ready") { statePlace({ ...t, ...h, name: t.name }, "the diff"); return; }
        showDiff(t, h, !prefs.inline);
        return;
    }
    if (t.state !== "ready") { statePlace(t); return; }
    renderEdits(t);
    E.edits.hidden = false;
    showDiff(t, t, !prefs.inline);
}
const countsHtml = (c) => (c ? `<i class="pw-add">+${c.add}</i><i class="pw-del">−${c.del}</i>` : "");
function renderEdits(t) {
    const agents = [...new Set(t.edits.map((e) => sign(t.session, e.agent)))];
    const html = `<div class="pw-ehead"><b>${t.edits.length} edit${t.edits.length === 1 ? "" : "s"}</b><span>by ${esc(agents.join(", "))}</span></div>
<div class="pw-elist" role="listbox" aria-label="Edits to ${esc(t.name)}">${t.edits.map((e, i) => `<button type="button" class="pw-edit${i === t.sel ? " pw-on" : ""}" role="option" aria-selected="${i === t.sel}" tabindex="${i === t.sel ? 0 : -1}" data-edit="${i}" title="${esc(`${e.tool || (e.kind === "write" ? "Write" : "Edit")} by ${sign(t.session, e.agent)} at ${clock(e.t)}`)}"><span class="pw-en">${i + 1}</span><span class="pw-emain"><span class="pw-erow"><b>${esc(sign(t.session, e.agent))}</b><span class="pw-etool">${esc(e.tool || (e.kind === "write" ? "Write" : "Edit"))}</span></span><time>${esc(clock(e.t))}</time></span><span class="pw-ecount">${countsHtml(e.counts)}</span></button>`).join("")}</div>`;
    if (E.edits.dataset.h !== html) {
        E.edits.innerHTML = html; E.edits.dataset.h = html;
        E.edits.querySelector(".pw-edit.pw-on")?.scrollIntoView({ block: "nearest" });
    }
}
function crumbPath(t) {
    const segs = [];
    if (t.root && t.path) { segs.push(base(t.root)); segs.push(...t.path.split("/")); }
    else segs.push(...tilde(t.abs).split("/").filter(Boolean));
    const last = segs.length - 1;
    return segs.map((s, i) => (i === last ? `<span class="pw-crumb pw-last"><span class="pw-fic">${fileIcon(s)}</span>${esc(s)}</span>` : `<span class="pw-crumb">${esc(s)}</span>`)).join(`<span class="pw-sep">${I.chev}</span>`);
}
function seg(name, options, value) {
    return `<div class="pw-seg pw-mini" role="group" aria-label="${esc(name)}">${options.map(([v, label, icon, off]) => `<button type="button" data-act="${v}" aria-pressed="${v === value}" title="${esc(off || label)}"${off ? " disabled" : ""}>${icon || ""}<span>${esc(label)}</span></button>`).join("")}</div>`;
}
function eRenderCrumbs(t) {
    if (!t || !E.dom) return;
    let left = `<nav class="pw-path" aria-label="Path">${crumbPath(t)}</nav>`, right = "";
    const layout = seg("Diff layout", [["side", "Side by side", I.split, E.narrow ? "Not enough room side by side. Widen the editor." : ""], ["inline", "Inline", I.inline]], prefs.inline || E.narrow ? "inline" : "side");
    if (t.kind === "file") {
        const gf = gitMap(t.root)?.files.get(t.path);
        const meta = gf && ST[gf.status];
        if (meta) left += `<span class="pw-chip pw-s-${meta[2]}" title="${esc(meta[1])} since the last commit">${meta[1]}</span>`;
        if (t.state === "ready") {
            right += `<span class="pw-pos" aria-live="off"></span><span class="pw-lang">${esc(langName(t.model.getLanguageId()))}</span>`;
            if (gf && gf.status !== "?" && gf.status !== "A") right += `<button type="button" class="pw-cbtn" data-act="diff" title="Compare with the last commit">${I.diff}<span>Changes</span></button>`;
            right += `<button type="button" class="pw-cbtn${t.editing ? " pw-on" : ""}" data-act="edit" aria-pressed="${!!t.editing}" title="${t.editing ? "Stop editing (the file stays open)" : "Make changes to this file"}">${I.pencil}<span>${t.editing ? "Editing" : "Edit"}</span></button>`;
            if (t.editing || t.dirty) right += `<button type="button" class="pw-cbtn pw-primary" data-act="save"${t.dirty && !t.saving ? "" : " disabled"} title="Save (${MOD}S)">${I.save}<span>${t.saving ? "Saving…" : "Save"}</span><kbd>${MOD}S</kbd></button>`;
        }
    } else if (t.kind === "diff") {
        left += `<span class="pw-counts">${t.state === "ready" ? countsHtml(t.counts) : ""}</span>`;
        if (t.state === "ready" && t.added) left += `<span class="pw-chip pw-s-a">New file</span>`;
        if (t.state === "ready" && t.deleted) left += `<span class="pw-chip pw-s-d">Deleted</span>`;
        const gf = gitMap(t.root)?.files.get(t.path);
        if (gf && gf.oldPath) left += `<span class="pw-chip pw-s-a" title="Renamed from ${esc(gf.oldPath)}">Renamed from ${esc(base(gf.oldPath))}</span>`;
        right += layout;
        if (!t.deleted) right += `<button type="button" class="pw-cbtn" data-act="open" title="Open the file">${I.open}<span>Open file</span></button>`;
    } else {
        const cur = t.view2 === "head" ? t.head : t;
        left += `<span class="pw-counts">${cur && cur.state === "ready" ? countsHtml(cur.counts) : ""}</span>`;
        const canHead = !!(t.root && t.path);
        right += seg("What to compare", [["edits", "Agent edits", I.robot], ["head", "Whole file vs HEAD", I.head]], t.view2);
        right += layout;
        if (canHead) right += `<button type="button" class="pw-cbtn" data-act="open" title="Open the file">${I.open}<span>Open file</span></button>`;
        const html = left + right;
        if (E.crumbs.dataset.h !== html) {
            E.crumbs.innerHTML = `<div class="pw-cl">${left}</div><div class="pw-cr">${right}</div>`;
            E.crumbs.dataset.h = html;
            if (!canHead) {
                const b = E.crumbs.querySelector('[data-act="head"]');
                if (b) { b.disabled = true; b.title = "This file is outside the project, so there's no git history to compare with."; }
            }
        }
        return;
    }
    const html = left + right;
    if (E.crumbs.dataset.h !== html) { E.crumbs.innerHTML = `<div class="pw-cl">${left}</div><div class="pw-cr">${right}</div>`; E.crumbs.dataset.h = html; }
    if (t.kind === "file") updatePos();
}
function updateCounts(target) {
    const n = E.crumbs.querySelector(".pw-counts");
    if (n && target && target.counts) n.innerHTML = countsHtml(target.counts);
}
function updatePos() {
    const t = activeTab(), n = E.crumbs && E.crumbs.querySelector(".pw-pos");
    if (!n || !t || t.kind !== "file" || !E.code || E.code.getModel() !== t.model) return;
    const p = E.code.getPosition(), sel = E.code.getSelection();
    if (!p) return;
    const chosen = sel && !sel.isEmpty() ? t.model.getValueInRange(sel).length : 0;
    n.textContent = `Ln ${p.lineNumber}, Col ${p.column}${chosen ? ` (${chosen} selected)` : ""}`;
}
function eRenderBanner(t) {
    let html = "";
    if (t.conflict) html = `<div class="pw-bn pw-warn">${I.warn}<span>This file changed on disk after you opened it. Most likely an agent at work. Keep their version or overwrite it with yours?</span><button type="button" class="pw-btn" data-act="reload">Reload theirs</button><button type="button" class="pw-btn pw-danger" data-act="overwrite">Overwrite with mine</button></div>`;
    else if (t.saveError) html = `<div class="pw-bn pw-errb">${I.warn}<span>${esc(t.saveError)}</span><button type="button" class="pw-btn" data-act="save">Try again</button><button type="button" class="pw-ib" data-act="dismiss" aria-label="Dismiss">${I.x}</button></div>`;
    else if (t.changedOnDisk && t.dirty) html = `<div class="pw-bn pw-infob">${I.info}<span>An agent changed this file while you were editing.</span><button type="button" class="pw-btn" data-act="reload">Reload theirs</button><button type="button" class="pw-ib" data-act="dismiss" aria-label="Keep mine">${I.x}</button></div>`;
    else if (t.flash) html = `<div class="pw-bn pw-okb">${I.ok}<span>${esc(t.flash)}</span></div>`;
    if (E.banner.dataset.h !== html) { E.banner.innerHTML = html; E.banner.dataset.h = html; E.banner.hidden = !html; }
}
function flash(t, text) {
    t.flash = text;
    clearTimeout(t.flashTimer);
    t.flashTimer = setTimeout(() => { t.flash = ""; if (activeTab() === t) eRenderBanner(t); }, 2600);
    if (activeTab() === t) eRenderBanner(t);
}
async function crumbAction(e) {
    const b = e.target.closest("[data-act]");
    const t = activeTab();
    if (!b || !t || b.disabled) return;
    const act = b.dataset.act;
    if (act === "edit") {
        t.editing = !t.editing;
        if (t.editing) t.preview = false;
        eRender();
        if (t.editing) setTimeout(() => E.code && E.code.focus(), 0);
    } else if (act === "save") saveTab(t);
    else if (act === "diff") openDiff(t.root, t.path);
    else if (act === "open") openFile(t.root, t.path, { focus: true });
    else if (act === "side" || act === "inline") { setPref("inline", act === "inline"); saveView(t); eRender(); }
    else if (act === "edits" || act === "head") { saveView(t); t.view = null; t.view2 = act; eRender(); }
    else if (act === "reload") reloadFile(t);
    else if (act === "overwrite") saveTab(t, true);
    else if (act === "dismiss") { t.saveError = ""; t.changedOnDisk = false; eRenderBanner(t); }
    else if (act === "retry") { t.state = "idle"; t.error = ""; if (t.head && t.view2 === "head") t.head = null; eRender(); }
    else if (act === "retry-monaco") eRender();
}

// ---- saving and syncing with disk ----
async function saveTab(t, force) {
    if (!t || t.kind !== "file" || !t.model || t.saving) return false;
    if (!t.dirty && !force) { flash(t, "Nothing to save. It's all on disk."); return true; }
    const text = t.model.getValue(), ver = t.model.getAlternativeVersionId();
    t.saving = true;
    t.saveError = "";
    if (activeTab() === t) eRenderCrumbs(t);
    const r = await post("/fs/write", { root: t.root, path: t.path, text, mtime: force && t.conflict ? t.conflict.mtime : t.mtime });
    t.saving = false;
    if (r.ok) {
        t.mtime = r.mtime ?? t.mtime;
        t.saved = ver;
        t.dirty = t.model.getAlternativeVersionId() !== ver;
        t.conflict = null;
        t.changedOnDisk = false;
        flash(t, `Saved ${t.name}.`);
        eRenderTabs();
        if (activeTab() === t) eRenderCrumbs(t);
        gitStatus(t.root, true);
        return true;
    }
    if (r.conflict) t.conflict = { mtime: r.mtime };
    else t.saveError = `I couldn't save ${t.name}: ${r.error || "unknown error"}`;
    if (activeTab() === t) { eRenderCrumbs(t); eRenderBanner(t); }
    return false;
}
async function reloadFile(t) {
    const r = await readFile(t.root, t.path);
    if (!r.ok || r.binary || r.tooLarge) { t.saveError = r.error || "I couldn't reload the file."; eRenderBanner(t); return; }
    applyDisk(t, r);
    t.conflict = null;
    t.changedOnDisk = false;
    flash(t, "Reloaded from disk. Undo brings your version back.");
    eRender();
}
// Put the disk text into the model as one undoable edit, so nothing you typed is lost for good.
function applyDisk(t, r) {
    const text = r.text ?? "";
    if (t.model.getValue() !== text) {
        const sel = E.code && E.code.getModel() === t.model ? E.code.getSelections() : null;
        t.model.pushEditOperations(sel || [], [{ range: t.model.getFullModelRange(), text }], () => sel);
        t.model.pushStackElement();
    }
    t.saved = t.model.getAlternativeVersionId();
    t.mtime = r.mtime;
    t.dirty = false;
    eRenderTabs();
}
// Agents are editing this project: bring open, unmodified files and diffs up to date.
async function eRefreshFrom(root, fromAgents) {
    const edited = new Set();
    for (const s of W.snap?.sessions || []) for (const a of s.agents || []) for (const f of a.edited || []) edited.add(f);
    const act = activeTab();
    for (const t of E.tabs) {
        if (t.root !== root && !(t.kind === "agent" && t.abs && inside(t.abs, root))) continue;
        if (t.kind === "file" && t.state === "ready") {
            if (t !== act && fromAgents && !edited.has(t.abs)) continue;
            const r = await readFile(t.root, t.path);
            if (!r.ok || r.binary || r.tooLarge || r.mtime === t.mtime) continue;
            if (!t.dirty) { applyDisk(t, r); if (t === activeTab()) { flash(t, "Updated on disk by an agent."); eRenderCrumbs(t); } }
            else if (!t.changedOnDisk) { t.changedOnDisk = true; if (t === activeTab()) eRenderBanner(t); }
        } else if (t.kind === "diff" && t.state === "ready") {
            if (t === act) loadDiff(t); else t.stale = true;
        } else if (t.kind === "agent" && t.state !== "idle") {
            if (t === act) { loadAgent(t); if (t.head) loadHead(t); } else t.stale = true;
        }
    }
    if (act && act.root === root) eRenderCrumbs(act);
}
// In a browser tab, leaving with unsaved edits asks first. The Mac app would silently refuse to close instead, so there
// the app's own quit flow can ask PulseWorkspace.hasUnsaved().
if (!window.pulseDesktop) addEventListener("beforeunload", (e) => {
    if (E.tabs.some((t) => t.dirty)) { e.preventDefault(); e.returnValue = ""; }
});

// ============ API (contract G) ============
window.PulseWorkspace = {
    mountExplorer, mountChanges, mountEditor, setRoot,
    openFile: (root, path, opts) => openFile(root, path, { ...(opts || {}) }),
    openDiff: (root, path, opts) => openDiff(root, path, { ...(opts || {}) }),
    openAgentChanges: (session, agent, absPath, opts) => openAgentChanges(session, agent, absPath, { ...(opts || {}) }),
    showGraph, isEditorOpen,
    hasUnsaved: () => E.tabs.some((t) => t.dirty),
    // Cmd+W from the app menu: close the active file or diff tab (asks first if it has unsaved edits). False if none.
    closeActive: () => { if (!activeTab()) return false; closeTab(E.active); return true; },
    root: () => W.root,
};
})();
