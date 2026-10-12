/* Pulse terminals: real terminals (xterm.js) in a bottom drawer, with tabs, split panes and quick rearranging.
   Processes run in the Pulse Mac app (window.pulseDesktop); in a plain browser the drawer explains how to get there.
   Self-contained: no build step, loads /vendor/xterm.js on first use, exposes window.PulseTerminals. */
(() => {
"use strict";
if (window.PulseTerminals) return;

// ============ Setup ============
const SRC = document.currentScript && document.currentScript.src;
const asset = (p) => new URL(p, SRC || location.href).href;
const D = window.pulseDesktop && window.pulseDesktop.term ? window.pulseDesktop : null;
const IS_MAC = D && D.platform ? D.platform === "darwin" : /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const MOD = IS_MAC ? "⌘" : "Ctrl+";
const reduce = matchMedia("(prefers-reduced-motion: reduce)");
const GAP = 14, TOP = 68, MIN_H = 180, KEY = "pulse.terminals";
const MAX_PANES = 6;
const LAYOUTS = ["auto", "single", "cols", "rows", "grid"];
const SLOTS = { single: 1, cols: 2, rows: 2, grid: 4 };
const LAYOUT_NAME = { auto: "Fit all", single: "Single", cols: "Two columns", rows: "Two rows", grid: "Grid" };
// [columns, rows] per layout. "auto" gives every open terminal a pane (up to six): side by side up to three, then two
// rows, growing as terminals open and shrinking as they close.
const AUTO_DIMS = [[1, 1], [1, 1], [2, 1], [3, 1], [2, 2], [3, 2], [3, 2]];
const DIMS = { single: [1, 1], cols: [2, 1], rows: [1, 2], grid: [2, 2] };
const FONT = '"Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
const EXITED = "\r\n\x1b[0m\x1b[2m[process exited — press Enter to restart or close]\x1b[0m\r\n";
const THEME = {
    background: "#0B0B0D", foreground: "#F2F2F4", cursor: "#FFD21F", cursorAccent: "#0B0B0D",
    selectionBackground: "rgba(255, 255, 255, .24)", selectionInactiveBackground: "rgba(255, 255, 255, .12)",
    scrollbarSliderBackground: "rgba(255, 255, 255, .12)", scrollbarSliderHoverBackground: "rgba(255, 255, 255, .22)", scrollbarSliderActiveBackground: "rgba(255, 255, 255, .3)",
    black: "#232328", red: "#FF6B6B", green: "#5BE49B", yellow: "#FFD21F", blue: "#6EA8FF", magenta: "#C99BFF", cyan: "#5CD5E0", white: "#D6D6DB",
    brightBlack: "#7A7A83", brightRed: "#FF9292", brightGreen: "#8AEFB9", brightYellow: "#FFE27A", brightBlue: "#9CC4FF", brightMagenta: "#DEBEFF", brightCyan: "#8FE7EF", brightWhite: "#FFFFFF",
};

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const base = (p) => String(p || "").replace(/\/+$/, "").split("/").pop() || String(p || "") || "~";
const tilde = (p) => String(p || "").replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
const quiet = (fn) => { try { const r = fn(); if (r && typeof r.catch === "function") r.catch(() => {}); return r; } catch { return undefined; } };
const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
const readState = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } };

const svg = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const FRAME = '<rect x="3.5" y="5" width="17" height="14" rx="2.5"/>';
const I = {
    term: svg('<rect x="3" y="4.5" width="18" height="15" rx="3.5"/><path d="m7.5 9.5 3 2.5-3 2.5M12.5 15h4"/>'),
    claude: svg('<path d="M12 4v16M5.1 8l13.8 8M5.1 16l13.8-8"/>'),
    shell: svg('<path d="m5 8 4 4-4 4M12 16h7"/>'),
    folder: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
    plus: svg('<path d="M12 5v14M5 12h14"/>'),
    x: svg('<path d="M7 7l10 10M17 7 7 17"/>'),
    max: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
    restore: svg('<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>'),
    hide: svg('<path d="m6 9 6 6 6-6"/>'),
    auto: svg(FRAME + '<path d="M9 5v14M15 5v14M3.5 12h17"/>'), single: svg(FRAME), cols: svg(FRAME + '<path d="M12 5v14"/>'), rows: svg(FRAME + '<path d="M3.5 12h17"/>'), grid: svg(FRAME + '<path d="M12 5v14M3.5 12h17"/>'),
};

// ============ State ============
const saved = readState();
const weights = (w) => (Array.isArray(w) && w.length && w.every((x) => Number(x) > 0) ? w.map(Number) : null);
const S = {
    open: false,
    max: !!saved.max,
    h: Number(saved.h) || 0,
    layout: LAYOUTS.includes(saved.layout) ? saved.layout : "auto",
    cw: weights(saved.cw) || [], // relative column widths and row heights of the split, one per track
    rw: weights(saved.rw) || [],
    focus: 0,
    terms: [], // tab order
    panes: Array(MAX_PANES).fill(null), // which terminal each pane shows; only the first count() are on screen
    projects: [], // from the latest snapshot, most recent first
    status: new Map(), // terminal id -> main agent status from the snapshot
    chats: new Map(), // terminal id -> the chat's name on the board ("C1")
};
const orphans = new Map(); // output for ids we have not bound yet (a create() reply racing its first bytes)
let seq = 0, loading = null, pendingClose = null, menuAnchor = null, menuSlot = 0, liveTimer = 0, fitRaf = 0, barHtml = "";

const byId = (id) => (id ? S.terms.find((t) => t.id === id) : undefined);
const count = () => (S.layout === "auto" ? clamp(S.terms.length, 1, MAX_PANES) : SLOTS[S.layout]);
const dims = () => (S.layout === "auto" ? AUTO_DIMS[count()] : DIMS[S.layout]);
const onScreen = () => S.panes.slice(0, count());
const current = () => S.panes[S.focus] || null;

function save() {
    const st = {
        h: S.h, max: S.max, open: S.open, layout: S.layout, cw: S.cw, rw: S.rw, focus: S.focus,
        order: S.terms.map((t) => t.id).filter(Boolean),
        panes: S.panes.map((t) => (t && t.id) || null),
        sizes: Object.fromEntries(S.terms.filter((t) => t.id).map((t) => [t.id, [t.xterm.cols, t.xterm.rows]])),
    };
    try { localStorage.setItem(KEY, JSON.stringify(st)); } catch { /* private mode: layout just isn't remembered */ }
}

// ============ DOM ============
const drawer = el("section", "pt-drawer pt-glass");
drawer.setAttribute("aria-label", "Terminals");
drawer.inert = true;
drawer.innerHTML = `
<div class="pt-grip" role="separator" aria-orientation="horizontal" aria-label="Resize terminals" tabindex="0" title="Drag to resize · double-click to maximize"></div>
<header class="pt-bar">
    <span class="pt-mark" aria-hidden="true">${I.term}</span>
    <span class="pt-title">Terminals</span>
    <div class="pt-tabs" role="tablist" aria-label="Open terminals"></div>
    <button class="pt-ib pt-add" type="button" aria-label="New terminal" aria-haspopup="menu" aria-expanded="false" title="New terminal (${MOD}T for Claude in your latest project)">${I.plus}</button>
    <span class="pt-fill"></span>
    <div class="pt-seg" role="group" aria-label="Split layout">${LAYOUTS.map((l) => `<button type="button" data-layout="${l}" aria-pressed="false" aria-label="${LAYOUT_NAME[l]}" title="${LAYOUT_NAME[l]} (${MOD}\\ cycles)">${I[l]}</button>`).join("")}</div>
    <button class="pt-ib pt-maxb" type="button" aria-pressed="false" aria-label="Maximize terminals" title="Maximize">${I.max}</button>
    <button class="pt-ib pt-hide" type="button" aria-label="Hide terminals" title="Hide (Esc). Terminals keep running">${I.hide}</button>
</header>
<div class="pt-body"></div>
<div class="pt-start" hidden></div>
<div class="pt-confirm" hidden></div>
<div class="pt-park" aria-hidden="true"></div>`;
const $ = (sel) => drawer.querySelector(sel);
const grip = $(".pt-grip"), tabsEl = $(".pt-tabs"), addBtn = $(".pt-add"), seg = $(".pt-seg"), maxBtn = $(".pt-maxb"), hideBtn = $(".pt-hide");
const body = $(".pt-body"), start = $(".pt-start"), confirmEl = $(".pt-confirm"), park = $(".pt-park");
const panes = Array.from({ length: MAX_PANES }, (_, i) => {
    const p = el("div", "pt-pane");
    p.dataset.slot = i;
    p.innerHTML = `<div class="pt-phead" title="Drag to move this terminal to another pane · double-click to show it alone"></div><div class="pt-pbody"></div><div class="pt-pempty"><span>Drag a tab here, or</span><button type="button" class="pt-btn pt-small" data-new>${I.plus}New terminal</button></div>`;
    body.appendChild(p);
    return { el: p, head: p.querySelector(".pt-phead"), body: p.querySelector(".pt-pbody") };
});
const menu = el("div", "pt-menu pt-glass");
menu.setAttribute("role", "menu");
menu.setAttribute("aria-label", "New terminal");
menu.hidden = true;
const ghost = el("div", "pt-ghost pt-glass");
ghost.hidden = true;
const mark = el("i", "pt-insert");
mark.hidden = true;
tabsEl.after(mark);

// ============ xterm loading ============
function script(src) {
    return new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = src;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error(`Could not load ${src}`));
        document.head.appendChild(s);
    });
}
function ensureXterm() {
    if (loading) return loading;
    loading = (async () => {
        if (!document.querySelector('link[data-pt="xterm"]')) {
            const css = document.createElement("link");
            css.rel = "stylesheet"; css.href = asset("vendor/xterm.css"); css.dataset.pt = "xterm";
            // Before our own sheet so the drawer's overrides win on equal specificity.
            const mine = [...document.querySelectorAll('link[rel="stylesheet"]')].find((l) => /terminal\.css(\?|$)/.test(l.href));
            if (mine) mine.before(css); else document.head.appendChild(css);
        }
        if (!document.querySelector('style[data-pt="font"]')) {
            // The page declares Geist Mono itself; this covers a page that doesn't. The variable font has a real bold.
            const f = document.createElement("style");
            f.dataset.pt = "font";
            f.textContent = `@font-face { font-family: "Geist Mono"; src: url("${asset("vendor/fonts/GeistMono-Variable.woff2")}") format("woff2"); font-weight: 100 900; font-style: normal; font-display: swap; }`;
            document.head.appendChild(f);
        }
        if (!window.Terminal) await script(asset("vendor/xterm.js"));
        await Promise.all([
            window.FitAddon ? null : script(asset("vendor/addon-fit.js")),
            window.WebLinksAddon ? null : script(asset("vendor/addon-web-links.js")).catch(() => null),
        ]);
        // xterm measures the cell once when it opens, so the font must be ready first.
        const fonts = document.fonts ? Promise.all([document.fonts.load('400 13px "Geist Mono"'), document.fonts.load('600 13px "Geist Mono"')]) : null;
        await Promise.race([fonts, new Promise((r) => setTimeout(r, 2500))]).catch(() => null);
    })();
    loading.catch(() => { loading = null; });
    return loading;
}

// ============ Terminals ============
function openLink(uri) {
    if (/^https?:\/\//i.test(uri)) window.open(uri, "_blank", "noopener,noreferrer");
}
function makeTerm({ id = null, cwd = "", command = "claude", alive = true, cols, rows }) {
    const t = { k: String(++seq), id, cwd: cwd || "", command: command === "shell" ? "shell" : "claude", alive, code: null, osc: "", opened: false, attaching: false, restarting: false, live: false, needs: false, lastOut: 0, tabEl: null, resizeTimer: 0 };
    t.xterm = new window.Terminal({
        cols: cols > 1 ? cols : 80, rows: rows > 0 ? rows : 24,
        fontFamily: FONT, fontSize: 13, lineHeight: 1.15, fontWeight: "400", fontWeightBold: "600",
        cursorBlink: !reduce.matches, cursorStyle: "bar", cursorWidth: 2, cursorInactiveStyle: "outline",
        scrollback: 10000, smoothScrollDuration: reduce.matches ? 0 : 60, macOptionIsMeta: false, macOptionClickForcesSelection: true,
        drawBoldTextInBrightColors: false, theme: THEME, linkHandler: { activate: (e, uri) => openLink(uri) },
    });
    t.fit = new window.FitAddon.FitAddon();
    t.xterm.loadAddon(t.fit);
    if (window.WebLinksAddon) t.xterm.loadAddon(new window.WebLinksAddon.WebLinksAddon((e, uri) => openLink(uri)));
    t.host = el("div", "pt-term");
    park.appendChild(t.host);
    t.xterm.onData((d) => input(t, d));
    t.xterm.onResize(({ cols: c, rows: r }) => {
        clearTimeout(t.resizeTimer);
        // Coalesce: a drag resizes every frame, the process only needs the final size.
        t.resizeTimer = setTimeout(() => { if (t.id && t.alive) quiet(() => D.term.resize(t.id, c, r)); save(); }, 60);
    });
    t.xterm.onTitleChange((s) => { t.osc = s; if (t.tabEl) t.tabEl.title = tipFor(t); }); // tooltip only: Claude retitles often
    t.xterm.attachCustomKeyEventHandler((e) => {
        if (isShortcut(e)) return false;
        // Shift+Enter: a newline inside Claude's prompt (ESC CR), like /terminal-setup does in other terminals.
        if (e.key === "Enter" && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
            if (e.type === "keydown") input(t, "\x1b\r");
            return false;
        }
        return true;
    });
    return t;
}
function input(t, data) {
    if (t.restarting) return;
    if (!t.alive) { if (data.includes("\r")) restart(t); return; }
    if (t.id) quiet(() => D.term.write(t.id, data));
}
function output(t, data) {
    t.xterm.write(data);
    t.lastOut = performance.now();
    if (!t.live) { t.live = true; paint(t); }
    if (!liveTimer) liveTimer = setInterval(tickLive, 250);
}
function tickLive() {
    const now = performance.now();
    let any = false;
    for (const t of S.terms) {
        if (!t.live) continue;
        if (now - t.lastOut > 800) { t.live = false; paint(t); } else any = true;
    }
    if (!any) { clearInterval(liveTimer); liveTimer = 0; }
}
function bind(t, id) {
    t.id = id;
    const q = orphans.get(id);
    orphans.delete(id);
    if (q) for (const d of q.chunks) output(t, d);
}
function stash(id, data) {
    let q = orphans.get(id);
    if (!q) orphans.set(id, (q = { at: Date.now(), chunks: [] }));
    if (q.chunks.length < 500) q.chunks.push(data);
    for (const [k, v] of orphans) if (Date.now() - v.at > 15000) orphans.delete(k);
}
function exited(t, code) {
    t.alive = false;
    t.code = code ?? null;
    if (!t.attaching) t.xterm.write(EXITED);
    renderBar(); renderPanes();
}

// New terminals land in the focused pane when it is free, else the first free pane, else replace the focused one.
function slotForNew() {
    const n = count();
    if (S.focus < n && !S.panes[S.focus]) return S.focus;
    for (let i = 0; i < n; i++) if (!S.panes[i]) return i;
    return S.focus < n ? S.focus : 0;
}
async function openTerm({ cwd, command } = {}) {
    command = command === "shell" ? "shell" : "claude";
    if (!D) { showDrawer(); return null; }
    try { await ensureXterm(); } catch { showDrawer(); renderStart(true); return null; }
    const t = makeTerm({ cwd, command });
    S.terms.push(t);
    S.layout = "auto"; // the split grows to show the new terminal next to the others
    const slot = slotForNew();
    const prev = S.panes.indexOf(t);
    if (prev >= 0) S.panes[prev] = null;
    S.panes[slot] = t;
    S.focus = slot;
    normalize();
    if (S.open) render(); else showDrawer(false);
    emit();
    await frame();
    quiet(() => t.fit.fit());
    try {
        const r = await D.term.create({ cwd, command, cols: t.xterm.cols, rows: t.xterm.rows });
        if (!S.terms.includes(t)) { quiet(() => D.term.kill(r.id)); return null; } // closed while starting
        if (r.cwd) t.cwd = r.cwd;
        if (r.command) t.command = r.command === "shell" ? "shell" : "claude";
        bind(t, r.id);
    } catch (err) {
        t.alive = false; t.failed = true;
        t.xterm.write(`\x1b[31mCould not start the terminal: ${String((err && err.message) || err).replace(/[\r\n]+/g, " ")}\x1b[0m\r\n`);
        t.xterm.write(EXITED);
    }
    renderBar(); renderPanes(); save();
    if (current() === t) t.xterm.focus();
    return t.id;
}
async function restart(t) {
    if (t.restarting) return;
    t.restarting = true;
    const old = t.id;
    t.id = null; // late events for the old process are no longer ours
    if (old) quiet(() => D.term.kill(old));
    t.xterm.reset();
    try {
        const r = await D.term.create({ cwd: t.cwd, command: t.command, cols: t.xterm.cols, rows: t.xterm.rows });
        if (!S.terms.includes(t)) { quiet(() => D.term.kill(r.id)); return; }
        t.alive = true; t.code = null; t.failed = false;
        bind(t, r.id);
    } catch (err) {
        t.failed = true;
        t.xterm.write(`\x1b[31mCould not restart: ${String((err && err.message) || err)}\x1b[0m\r\n` + EXITED);
    } finally { t.restarting = false; }
    renderBar(); renderPanes(); save();
}
function closeTerm(t, force) {
    if (!t || !S.terms.includes(t)) return;
    if (t.alive && t.id && !force) { askClose(t); return; }
    const wasFocus = current() === t;
    S.terms.splice(S.terms.indexOf(t), 1);
    // The split shrinks to the terminals left, the ones after it moving up a pane in order.
    S.layout = "auto";
    const at = S.panes.indexOf(t);
    if (at >= 0) { S.panes.splice(at, 1); S.panes.push(null); if (S.focus > at) S.focus--; }
    if (t.id) quiet(() => D.term.kill(t.id));
    t.id = null;
    clearTimeout(t.resizeTimer);
    quiet(() => t.xterm.dispose());
    t.host.remove();
    normalize(); render(); save(); emit();
    if (!S.terms.length) { hideDrawer(); return; }
    if (wasFocus && S.open) requestAnimationFrame(() => focusCurrent());
}

// ============ Panes and layout ============
// Drop closed/duplicate terminals and fill empty on-screen panes with terminals that are not showing, in tab order.
function normalize() {
    const n = count(), seen = new Set();
    S.panes = S.panes.map((t) => (t && S.terms.includes(t) && !seen.has(t) ? (seen.add(t), t) : null));
    const shown = new Set(onScreen().filter(Boolean));
    const spare = S.terms.filter((t) => !shown.has(t));
    for (let i = 0; i < n && spare.length; i++) {
        if (S.panes[i]) continue;
        const t = spare.shift(), j = S.panes.indexOf(t);
        if (j >= 0) S.panes[j] = null;
        S.panes[i] = t;
    }
    if (S.focus >= n) S.focus = n - 1;
}
function setLayout(l) {
    if (!LAYOUTS.includes(l)) return;
    const n = l === "auto" ? clamp(S.terms.length, 1, MAX_PANES) : SLOTS[l];
    // Keep the focused terminal on screen when the layout shrinks.
    if (S.focus >= n) { [S.panes[0], S.panes[S.focus]] = [S.panes[S.focus], S.panes[0]]; S.focus = 0; }
    S.layout = l;
    normalize(); render(); save();
    emit();
}
const cycleLayout = () => setLayout(LAYOUTS[(LAYOUTS.indexOf(S.layout) + 1) % LAYOUTS.length]);
// Show a terminal: focus its pane when it is already on screen, else put it into `slot` (the focused pane by default).
function show(t, slot) {
    const n = count(), at = S.panes.indexOf(t);
    if (slot == null) {
        if (at >= 0 && at < n) { setFocus(at, true); return; }
        slot = S.focus < n ? S.focus : 0;
    }
    if (at !== slot) {
        if (at >= 0) S.panes[at] = S.panes[slot]; // swap with whatever was there
        S.panes[slot] = t;
    }
    S.focus = slot;
    normalize(); render(); save();
    requestAnimationFrame(() => t.xterm.focus());
}
function setFocus(i, focusTerm) {
    if (S.focus !== i) {
        S.focus = i;
        panes.forEach((p, j) => p.el.classList.toggle("pt-focus", j === i));
        renderBar(); save();
    }
    if (focusTerm) { const t = S.panes[i]; if (t) t.xterm.focus(); }
}
function focusCurrent() {
    const t = current();
    if (t && t.opened) t.xterm.focus();
    else (drawer.querySelector(".pt-start:not([hidden]) button, .pt-pane:not([hidden]) [data-new]") || (D ? addBtn : hideBtn)).focus();
}

// ============ Rendering ============
// A tab running a chat the board knows is named like its card, "C1 · pulse", so you can tell which chat is which;
// any other tab is named by its folder ("pulse", "pulse 2").
function labels() {
    const n = new Map(), out = new Map();
    for (const t of S.terms) {
        const key = `${t.cwd}|${t.command}`, i = (n.get(key) || 0) + 1;
        n.set(key, i);
        const chat = t.id && S.chats.get(t.id);
        out.set(t, { name: chat ? `${chat} · ${base(t.cwd)}` : base(t.cwd) + (i > 1 ? ` ${i}` : ""), kind: t.command });
    }
    return out;
}
function tipFor(t, names = labels()) {
    const { name, kind } = names.get(t) || { name: base(t.cwd), kind: t.command }, i = S.terms.indexOf(t);
    return `${name} · ${kind} — ${tilde(t.cwd) || "home"}${t.osc ? `\n${t.osc}` : ""}${!t.alive ? "\nExited" : ""}${i >= 0 && i < 9 ? `\n${MOD}${i + 1}` : ""}`;
}
const stateCls = (t) => (t.live ? " pt-live" : "") + (t.needs ? " pt-needs" : "") + (t.flash ? " pt-flash" : "") + (t.alive ? "" : " pt-dead");
function render() { renderBar(); renderPanes(); renderStart(); }
function renderBar() {
    drawer.classList.toggle("pt-nobridge", !D);
    drawer.classList.toggle("pt-has", S.terms.length > 0);
    const names = labels(), active = current(), shown = new Set(onScreen().filter(Boolean));
    const html = S.terms.map((t, i) => {
        const { name, kind } = names.get(t), on = t === active;
        const tip = tipFor(t, names);
        return `<div class="pt-tab${on ? " pt-on" : ""}${shown.has(t) ? " pt-vis" : ""}${stateCls(t)}" role="tab" aria-selected="${on}" tabindex="${on || (!active && i === 0) ? 0 : -1}" data-k="${t.k}" title="${esc(tip)}">`
            + `<i class="pt-dot"></i><span class="pt-name">${esc(name)}</span><span class="pt-kind">${kind}</span>`
            + `<button type="button" class="pt-x" tabindex="-1" aria-label="Close ${esc(name)} ${kind}" title="Close (${MOD}W)">${I.x}</button></div>`;
    }).join("");
    if (html !== barHtml) {
        const had = document.activeElement && document.activeElement.closest && document.activeElement.closest(".pt-tab");
        const hadK = had && tabsEl.contains(had) ? had.dataset.k : null;
        tabsEl.innerHTML = html;
        barHtml = html;
        if (hadK) { const n = tabsEl.querySelector(`[data-k="${hadK}"]`); if (n) n.focus(); }
    }
    for (const t of S.terms) t.tabEl = tabsEl.querySelector(`[data-k="${t.k}"]`);
    if (active && active.tabEl && !dragging) {
        const r = active.tabEl.getBoundingClientRect(), c = tabsEl.getBoundingClientRect();
        if (r.left < c.left) tabsEl.scrollLeft -= c.left - r.left + 6;
        else if (r.right > c.right) tabsEl.scrollLeft += r.right - c.right + 6;
    }
    for (const b of seg.children) b.setAttribute("aria-pressed", String(b.dataset.layout === S.layout));
    maxBtn.innerHTML = S.max ? I.restore : I.max;
    maxBtn.setAttribute("aria-pressed", String(S.max));
    maxBtn.setAttribute("aria-label", S.max ? "Restore terminal height" : "Maximize terminals");
    maxBtn.title = S.max ? "Restore height" : "Maximize";
}
function paint(t) {
    if (t.tabEl) t.tabEl.classList.toggle("pt-live", t.live);
    const i = onScreen().indexOf(t);
    if (i >= 0) panes[i].el.classList.toggle("pt-live", t.live);
}
function renderGrid() {
    const [c, r] = dims(), n = count();
    if (S.cw.length !== c) S.cw = Array(c).fill(1);
    if (S.rw.length !== r) S.rw = Array(r).fill(1);
    body.style.gridTemplateColumns = S.cw.map((w) => `minmax(0, ${w}fr)`).join(" ");
    body.style.gridTemplateRows = S.rw.map((w) => `minmax(0, ${w}fr)`).join(" ");
    // Five on a three-by-two grid: the last pane takes the rest of its row.
    panes.forEach((p, i) => { p.el.style.gridColumn = i === n - 1 && n < c * r ? `span ${c * r - n + 1}` : ""; });
}
function renderPanes() {
    const n = count(), names = labels();
    body.dataset.layout = n === 1 ? "single" : S.layout;
    body.hidden = !D || !S.terms.length;
    renderGrid();
    panes.forEach((p, i) => {
        const vis = i < n, t = vis ? S.panes[i] : null;
        p.el.hidden = !vis;
        for (const c of [...p.body.children]) if (!t || c !== t.host) park.appendChild(c);
        if (t) {
            if (t.host.parentNode !== p.body) p.body.appendChild(t.host);
            if (!t.opened) { t.opened = true; t.xterm.open(t.host); }
        }
        p.el.className = `pt-pane${i === S.focus ? " pt-focus" : ""}${t ? stateCls(t) : " pt-void"}`;
        const { name, kind } = t ? names.get(t) : {};
        const head = t
            ? `<i class="pt-dot"></i><b>${esc(name)}</b><span>${kind}</span><em>${esc(tilde(t.cwd))}</em>${t.alive ? "" : '<span class="pt-badge">exited</span>'}`
            : "<b>Empty pane</b>";
        if (p.head.dataset.h !== head) { p.head.innerHTML = head; p.head.dataset.h = head; }
    });
    for (const t of S.terms) if (!onScreen().includes(t) && t.host.parentNode !== park) park.appendChild(t.host);
    fitSoon();
}
function recentProjects() {
    const out = S.projects.slice(0, 12), seen = new Set(out.map((p) => p.cwd));
    for (const t of S.terms) if (t.cwd && !seen.has(t.cwd)) { seen.add(t.cwd); out.push({ cwd: t.cwd, name: base(t.cwd) }); }
    return out;
}
function renderStart(failed) {
    const empty = !D || !S.terms.length;
    start.hidden = !empty;
    if (!empty) return;
    let html;
    if (!D) {
        html = `<div class="pt-hero">
            <div class="pt-hero-ic">${I.term}</div>
            <h3>Terminals run in the Pulse app</h3>
            <p>This browser tab shows your agents, but it can't start processes. The Pulse Mac app runs Claude Code in real terminals right here, with tabs and split views, so you never need another chat window.</p>
            <ol class="pt-steps">
                <li><span class="pt-n">1</span><span>Open <b>Pulse.app</b> from Applications, or press <kbd>⌘</kbd><kbd>Space</kbd> and type “Pulse”.</span></li>
                <li><span class="pt-n">2</span><span>Press <kbd>⌘</kbd><kbd>T</kbd> to start Claude in your latest project, or <kbd>⌘</kbd><kbd>\\</kbd> to split.</span></li>
            </ol>
        </div>`;
    } else if (failed) {
        html = `<div class="pt-hero"><div class="pt-hero-ic">${I.term}</div><h3>Couldn't load the terminal</h3><p>The terminal library didn't load. Check that Pulse is running, then try again.</p><div class="pt-quick"><button type="button" class="pt-btn" data-retry>Try again</button></div></div>`;
    } else {
        const quick = recentProjects().slice(0, 3).map((p) => `<button type="button" class="pt-btn" data-cwd="${esc(p.cwd)}" data-cmd="claude" title="${esc(tilde(p.cwd))}">${I.claude}Claude in <b>${esc(p.name)}</b></button>`).join("");
        html = `<div class="pt-hero">
            <div class="pt-hero-ic">${I.term}</div>
            <h3>Run Claude right here</h3>
            <p>Start Claude Code or a shell in any project. Tabs, splits and your agents in one window.</p>
            <div class="pt-quick">${quick}<button type="button" class="pt-btn pt-ghostbtn" data-pick>${I.folder}Choose folder…</button></div>
            <div class="pt-keys"><span><kbd>${MOD}T</kbd>New Claude</span><span><kbd>${MOD}\\</kbd>Split</span><span><kbd>${MOD}1–9</kbd>Switch</span><span><kbd>Esc</kbd>Hide</span></div>
        </div>`;
    }
    if (start.dataset.h !== html) { start.innerHTML = html; start.dataset.h = html; }
}

// ============ Fitting ============
function fitSoon() {
    cancelAnimationFrame(fitRaf);
    fitRaf = requestAnimationFrame(() => {
        for (const t of onScreen()) if (t && t.opened) quiet(() => t.fit.fit());
    });
}
const ro = new ResizeObserver(fitSoon);
panes.forEach((p) => ro.observe(p.body));

// ============ Drawer geometry ============
// The status bar sits under the drawer (--sb: its height plus the space above it).
const statusBar = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--sb")) || 0;
const maxH = () => Math.max(MIN_H, innerHeight - TOP - GAP - statusBar());
const clampH = (v) => Math.round(clamp(v, MIN_H, Math.max(MIN_H, innerHeight * 0.85)));
const height = () => (S.max ? maxH() : clampH(S.h || innerHeight * 0.42));
function geometry(fire = true) {
    const h = height();
    drawer.style.height = `${h}px`;
    const th = S.open ? h + GAP : 0;
    document.body.style.setProperty("--th", `${th}px`);
    drawer.classList.toggle("pt-max", S.max);
    if (fire) emit();
}
let emitted = "";
function emit() {
    const detail = { open: S.open, height: S.open ? height() : 0, maximized: S.max, th: S.open ? height() + GAP : 0, layout: S.layout };
    const sig = JSON.stringify(detail);
    if (sig === emitted) return;
    emitted = sig;
    window.dispatchEvent(new CustomEvent("pulse:layout", { detail }));
}
function showDrawer(focusIt = true) {
    if (!S.open) {
        S.open = true;
        drawer.inert = false;
        drawer.classList.add("pt-open");
        geometry(); save();
        if (D) ensureXterm().catch(() => null);
    }
    render();
    if (focusIt) requestAnimationFrame(() => focusCurrent());
}
function hideDrawer() {
    closeMenu();
    cancelClose(false);
    if (!S.open) return;
    if (drawer.contains(document.activeElement)) document.activeElement.blur();
    S.open = false;
    drawer.classList.remove("pt-open");
    drawer.inert = true;
    geometry(); save();
}
function setMax(on) {
    S.max = !!on;
    geometry(); renderBar(); save();
}

// Drag the top edge to resize; double-click to maximize.
grip.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    stop(e);
    grip.setPointerCapture(e.pointerId);
    const off = e.clientY - drawer.getBoundingClientRect().top;
    drawer.classList.add("pt-resizing");
    let raf = 0;
    const move = (ev) => {
        const h = clampH(innerHeight - GAP - (ev.clientY - off));
        if (S.max) S.max = false;
        S.h = h;
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => { geometry(); renderBar(); });
    };
    const up = () => {
        grip.removeEventListener("pointermove", move);
        grip.removeEventListener("pointerup", up);
        grip.removeEventListener("pointercancel", up);
        drawer.classList.remove("pt-resizing");
        geometry(); save(); fitSoon();
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", up);
});
grip.addEventListener("dblclick", () => setMax(!S.max));
grip.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 96 : 24;
    if (e.key === "ArrowUp" || e.key === "ArrowDown") { S.max = false; S.h = clampH(height() + (e.key === "ArrowUp" ? step : -step)); geometry(); renderBar(); save(); }
    else if (e.key === "Home") { S.max = false; S.h = MIN_H; geometry(); renderBar(); save(); }
    else if (e.key === "End" || e.key === "Enter") setMax(!S.max);
    else return;
    e.preventDefault();
});
addEventListener("resize", () => { geometry(); fitSoon(); });

// Drag the gap between panes to resize the split; double-click it to even out.
// Which gap is under the pointer: { axis: "col" | "row", i } for the one after track i, or null.
function gapAt(x, y) {
    if (count() === 1) return null;
    const [c, r] = dims();
    for (let i = 0; i < c - 1; i++) {
        const a = panes[i].el.getBoundingClientRect();
        if (x >= a.right - 2 && x <= a.right + 12 && y >= a.top) return { axis: "col", i };
    }
    for (let i = 0; i < r - 1; i++) {
        const a = panes[i * c].el.getBoundingClientRect();
        if (y >= a.bottom - 2 && y <= a.bottom + 12 && x >= a.left) return { axis: "row", i };
    }
    return null;
}
let splitting = false;
body.addEventListener("pointermove", (e) => {
    if (splitting) return;
    const g = e.target === body ? gapAt(e.clientX, e.clientY) : null;
    body.style.cursor = g ? (g.axis === "col" ? "col-resize" : "row-resize") : "";
});
body.addEventListener("pointerdown", (e) => {
    if (e.target !== body || e.button !== 0) return;
    const g = gapAt(e.clientX, e.clientY);
    if (!g) return;
    stop(e);
    splitting = true;
    body.setPointerCapture(e.pointerId);
    drawer.classList.add("pt-splitting");
    // The two tracks either side of the gap share their space; the others stay put.
    const c = dims()[0], col = g.axis === "col", w = col ? S.cw : S.rw;
    const a = panes[col ? g.i : g.i * c].el.getBoundingClientRect(), b = panes[col ? g.i + 1 : (g.i + 1) * c].el.getBoundingClientRect();
    const gap = parseFloat(getComputedStyle(body).columnGap) || 8, total = w[g.i] + w[g.i + 1];
    const move = (ev) => {
        const f = col ? clamp((ev.clientX - a.left - gap / 2) / (b.right - a.left - gap), 0.15, 0.85) : clamp((ev.clientY - a.top - gap / 2) / (b.bottom - a.top - gap), 0.15, 0.85);
        w[g.i] = total * f; w[g.i + 1] = total * (1 - f);
        renderGrid();
    };
    const up = () => {
        splitting = false;
        body.removeEventListener("pointermove", move);
        body.removeEventListener("pointerup", up);
        body.removeEventListener("pointercancel", up);
        drawer.classList.remove("pt-splitting");
        save(); fitSoon();
    };
    body.addEventListener("pointermove", move);
    body.addEventListener("pointerup", up);
    body.addEventListener("pointercancel", up);
});
body.addEventListener("dblclick", (e) => {
    if (e.target !== body) return;
    const g = gapAt(e.clientX, e.clientY);
    if (!g) return;
    if (g.axis === "col") S.cw = S.cw.map(() => 1); else S.rw = S.rw.map(() => 1);
    renderGrid(); save();
});

// ============ Tabs and pane heads: click, keyboard, drag to reorder or onto a pane ============
let dragging = null;
const termOf = (node) => { const tab = node && node.closest && node.closest(".pt-tab"); return tab ? S.terms.find((t) => t.k === tab.dataset.k) : null; };
// Press on a tab or a pane's title bar: a click runs `click`, a drag carries the terminal to another pane (swapping
// with whatever is there) or to a new place among the tabs.
function press(e, t, click) {
    const sx = e.clientX, sy = e.clientY;
    let moved = false;
    const move = (ev) => {
        if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
        if (!moved) { moved = true; dragStart(t); }
        dragMove(ev.clientX, ev.clientY);
    };
    const up = (ev) => {
        removeEventListener("pointermove", move);
        removeEventListener("pointerup", up);
        removeEventListener("pointercancel", cancel);
        if (moved) dragEnd(ev.clientX, ev.clientY); else click();
    };
    const cancel = () => {
        removeEventListener("pointermove", move);
        removeEventListener("pointerup", up);
        removeEventListener("pointercancel", cancel);
        if (moved) dragEnd(-1, -1, true);
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
    addEventListener("pointercancel", cancel);
}
tabsEl.addEventListener("pointerdown", (e) => {
    const t = termOf(e.target);
    if (!t || e.button !== 0 || e.target.closest(".pt-x")) return;
    press(e, t, () => show(t));
});
panes.forEach((p, i) => p.head.addEventListener("pointerdown", (e) => {
    const t = S.panes[i];
    if (!t || e.button !== 0 || count() < 2) return;
    e.preventDefault(); // no text selection while dragging
    press(e, t, () => setFocus(i, true));
}));
tabsEl.addEventListener("click", (e) => {
    const x = e.target.closest(".pt-x");
    if (x) { stop(e); closeTerm(termOf(x)); }
});
tabsEl.addEventListener("auxclick", (e) => { if (e.button === 1) { const t = termOf(e.target); if (t) { stop(e); closeTerm(t); } } });
tabsEl.addEventListener("keydown", (e) => {
    const t = termOf(e.target);
    if (!t) return;
    const i = S.terms.indexOf(t);
    if (e.key === "Enter" || e.key === " ") show(t);
    else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        const j = (i + (e.key === "ArrowRight" ? 1 : -1) + S.terms.length) % S.terms.length;
        if (e.altKey || e.shiftKey) { S.terms.splice(i, 1); S.terms.splice(j, 0, t); renderBar(); save(); } // move the tab
        const n = S.terms[e.altKey || e.shiftKey ? S.terms.indexOf(t) : j];
        if (n && n.tabEl) n.tabEl.focus();
    } else if (e.key === "Delete" || e.key === "Backspace") closeTerm(t);
    else return;
    e.preventDefault();
});
tabsEl.addEventListener("wheel", (e) => {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && tabsEl.scrollWidth > tabsEl.clientWidth) { tabsEl.scrollLeft += e.deltaY; e.preventDefault(); }
}, { passive: false });

function dragStart(t) {
    const { name, kind } = labels().get(t);
    dragging = { t, index: -1, slot: -1 };
    ghost.className = `pt-ghost pt-glass${stateCls(t)}`;
    ghost.innerHTML = `<i class="pt-dot"></i><span class="pt-name">${esc(name)}</span><span class="pt-kind">${kind}</span>`;
    ghost.hidden = false;
    drawer.classList.add("pt-dragging");
    if (t.tabEl) t.tabEl.classList.add("pt-lifted");
    panes.forEach((p, i) => p.el.classList.toggle("pt-lifted", i < count() && S.panes[i] === t));
    closeMenu();
}
function dragMove(x, y) {
    if (!dragging) return;
    ghost.style.transform = `translate(${Math.round(x + 12)}px, ${Math.round(y + 10)}px)`;
    const hit = document.elementFromPoint(x, y);
    const overTabs = hit && (hit === tabsEl || tabsEl.contains(hit) || hit.closest(".pt-bar")) && y < body.getBoundingClientRect().top;
    const pane = !overTabs && hit && hit.closest && hit.closest(".pt-pane");
    dragging.index = -1; dragging.slot = -1;
    panes.forEach((p) => p.el.classList.remove("pt-over"));
    if (overTabs) {
        const others = S.terms.filter((o) => o !== dragging.t && o.tabEl);
        let index = others.length;
        for (let i = 0; i < others.length; i++) {
            const r = others[i].tabEl.getBoundingClientRect();
            if (x < r.left + r.width / 2) { index = i; break; }
        }
        dragging.index = index;
        const ref = others[index], last = others[others.length - 1];
        const box = drawer.getBoundingClientRect();
        let left;
        if (ref) left = ref.tabEl.getBoundingClientRect().left - 2;
        else if (last) left = last.tabEl.getBoundingClientRect().right + 1;
        else left = tabsEl.getBoundingClientRect().left;
        const tr = tabsEl.getBoundingClientRect();
        mark.style.left = `${Math.round(clamp(left, tr.left - 2, tr.right) - box.left)}px`;
        mark.hidden = false;
    } else {
        mark.hidden = true;
        if (pane && !pane.hidden) { dragging.slot = Number(pane.dataset.slot); pane.classList.add("pt-over"); }
    }
}
function dragEnd(x, y, cancelled) {
    const d = dragging;
    dragging = null;
    ghost.hidden = true;
    mark.hidden = true;
    drawer.classList.remove("pt-dragging");
    panes.forEach((p) => p.el.classList.remove("pt-over", "pt-lifted"));
    if (!d) return;
    if (d.t.tabEl) d.t.tabEl.classList.remove("pt-lifted");
    if (cancelled) return;
    if (d.index >= 0) {
        const others = S.terms.filter((o) => o !== d.t);
        others.splice(d.index, 0, d.t);
        S.terms = others;
        renderBar(); save();
    } else if (d.slot >= 0) show(d.t, d.slot);
}

// ============ Panes: focus on click, empty-pane buttons ============
body.addEventListener("pointerdown", (e) => {
    const p = e.target.closest(".pt-pane");
    if (p) setFocus(Number(p.dataset.slot), false);
}, true);
body.addEventListener("click", (e) => {
    const b = e.target.closest("[data-new]");
    if (!b) return;
    const p = b.closest(".pt-pane");
    openMenu(b, p ? Number(p.dataset.slot) : S.focus);
});
panes.forEach((p, i) => p.head.addEventListener("dblclick", () => { if (S.panes[i]) setLayout("single"); }));

// ============ Buttons ============
addBtn.addEventListener("click", () => openMenu(addBtn, slotForNew()));
seg.addEventListener("click", (e) => { const b = e.target.closest("[data-layout]"); if (b) setLayout(b.dataset.layout); });
maxBtn.addEventListener("click", () => setMax(!S.max));
hideBtn.addEventListener("click", hideDrawer);
start.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.hasAttribute("data-retry")) { loading = null; render(); ensureXterm().then(() => render(), () => renderStart(true)); }
    else if (b.hasAttribute("data-pick")) pickAndOpen(e.altKey ? "shell" : "claude");
    else if (b.dataset.cwd) openTerm({ cwd: b.dataset.cwd, command: b.dataset.cmd });
});
async function pickAndOpen(command) {
    if (!D || !D.pickFolder) return;
    let dir = null;
    try { dir = await D.pickFolder(); } catch { dir = null; }
    if (dir) return openTerm({ cwd: dir, command });
}
async function newClaude() {
    const cwd = (S.projects[0] && S.projects[0].cwd) || (current() && current().cwd) || (S.terms.length && S.terms[S.terms.length - 1].cwd);
    if (cwd) return openTerm({ cwd, command: "claude" });
    return pickAndOpen("claude");
}

// ============ Close confirmation ============
function askClose(t) {
    const { name, kind } = labels().get(t);
    pendingClose = t;
    showDrawer(false);
    confirmEl.innerHTML = `<div class="pt-dialog pt-glass" role="alertdialog" aria-modal="true" aria-labelledby="pt-cf-t" aria-describedby="pt-cf-d">
        <b id="pt-cf-t">Close ${esc(name)} · ${kind}?</b>
        <p id="pt-cf-d">${kind === "claude" ? "Claude may still be working in this terminal." : "A process is still running in this terminal."} Closing it stops the process.</p>
        <div><button type="button" class="pt-btn" data-cf="no">Cancel</button><button type="button" class="pt-btn pt-danger" data-cf="yes">Close terminal</button></div>
    </div>`;
    confirmEl.hidden = false;
    confirmEl.querySelector('[data-cf="yes"]').focus();
}
function cancelClose(refocus = true) {
    if (confirmEl.hidden) return;
    confirmEl.hidden = true;
    confirmEl.innerHTML = "";
    pendingClose = null;
    if (refocus) focusCurrent();
}
confirmEl.addEventListener("click", (e) => {
    const b = e.target.closest("[data-cf]");
    if (e.target === confirmEl) { cancelClose(); return; }
    if (!b) return;
    const t = pendingClose;
    cancelClose(false);
    if (b.dataset.cf === "yes" && t) closeTerm(t, true); else focusCurrent();
});
confirmEl.addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;
    const bs = [...confirmEl.querySelectorAll("button")], i = bs.indexOf(document.activeElement);
    bs[(i + (e.shiftKey ? -1 : 1) + bs.length) % bs.length].focus();
    e.preventDefault();
});

// ============ New-terminal menu ============
const menuOpen = () => !menu.hidden;
function openMenu(anchor, slot) {
    if (menuOpen()) { const same = menuAnchor === anchor; closeMenu(); if (same) return; }
    if (!D) { showDrawer(); return; }
    menuAnchor = anchor; menuSlot = slot;
    const P = recentProjects();
    const item = (cmd, p) => `<button type="button" role="menuitem" class="pt-mi" data-cwd="${esc(p.cwd)}" data-cmd="${cmd}">`
        + `<span class="pt-mi-ic${cmd === "claude" ? " pt-claude" : ""}">${I[cmd]}</span><span class="pt-mi-t">${cmd === "claude" ? "Claude" : "Shell"} in <b>${esc(p.name)}</b></span><span class="pt-mi-m">${esc(tilde(p.cwd))}</span></button>`;
    menu.innerHTML = (P.length
        ? `<div class="pt-sec">Claude</div>${P.map((p) => item("claude", p)).join("")}<div class="pt-sec">Shell</div>${P.map((p) => item("shell", p)).join("")}<hr>`
        : `<p class="pt-note">No projects yet. They show up here once Claude runs in a folder.</p>`)
        + `<button type="button" role="menuitem" class="pt-mi" data-pick><span class="pt-mi-ic">${I.folder}</span><span class="pt-mi-t">Choose folder…</span><span class="pt-mi-m">Claude · hold ⌥ for a shell</span></button>`;
    menu.hidden = false;
    anchor.setAttribute("aria-expanded", "true");
    const a = anchor.getBoundingClientRect(), w = menu.offsetWidth, mh = menu.offsetHeight;
    const below = innerHeight - a.bottom - 8, above = a.top - 8;
    const down = below >= mh || below >= above;
    menu.style.maxHeight = `${Math.max(160, Math.min(440, down ? below - 6 : above - 6))}px`;
    menu.style.left = `${Math.round(clamp(a.left, 8, innerWidth - w - 8))}px`;
    const h = menu.offsetHeight;
    menu.style.top = `${Math.round(down ? a.bottom + 6 : Math.max(8, a.top - 6 - h))}px`;
    const first = menu.querySelector(".pt-mi");
    if (first) first.focus();
}
function closeMenu(refocus) {
    if (!menuOpen()) return;
    menu.hidden = true;
    menu.innerHTML = "";
    if (menuAnchor) { menuAnchor.setAttribute("aria-expanded", "false"); if (refocus) menuAnchor.focus(); }
    menuAnchor = null;
}
menu.addEventListener("click", (e) => {
    const b = e.target.closest(".pt-mi");
    if (!b) return;
    const slot = menuSlot, alt = e.altKey;
    closeMenu();
    if (slot < count()) S.focus = slot;
    if (b.hasAttribute("data-pick")) pickAndOpen(alt ? "shell" : "claude");
    else openTerm({ cwd: b.dataset.cwd, command: b.dataset.cmd });
});
menu.addEventListener("keydown", (e) => {
    const items = [...menu.querySelectorAll(".pt-mi")], i = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown") items[(i + 1) % items.length].focus();
    else if (e.key === "ArrowUp") items[(i - 1 + items.length) % items.length].focus();
    else if (e.key === "Home") items[0].focus();
    else if (e.key === "End") items[items.length - 1].focus();
    else if (e.key === "Escape") closeMenu(true);
    else if (e.key === "Tab") { closeMenu(); return; }
    else return;
    stop(e);
});
document.addEventListener("pointerdown", (e) => {
    if (menuOpen() && !menu.contains(e.target) && !(menuAnchor && menuAnchor.contains(e.target))) closeMenu();
}, true);
addEventListener("blur", () => closeMenu());

// ============ Keyboard ============
// Only these shortcuts are taken from the terminal; every other key goes to the process.
function isShortcut(e) {
    if (!D || e.altKey) return false;
    const mod = IS_MAC ? e.metaKey && !e.ctrlKey && !e.shiftKey : e.ctrlKey && !e.metaKey;
    if (!mod) return false;
    // Off the Mac, Ctrl+W/T/\ mean things to the shell, so inside a terminal they need Shift as well.
    const inTerm = !!(e.target && e.target.closest && e.target.closest(".xterm"));
    if (!IS_MAC && inTerm && !e.shiftKey) return false;
    return e.code === "KeyT" || e.code === "Backslash" || /^Digit[1-9]$/.test(e.code) || (e.code === "KeyW" && S.open && !!current());
}
addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    const inTerm = !!(e.target && e.target.closest && e.target.closest(".xterm"));
    if (e.key === "Escape") {
        if (inTerm || !S.open) return; // Esc belongs to the terminal (it interrupts Claude)
        if (menuOpen()) { closeMenu(true); stop(e); return; }
        if (!confirmEl.hidden) { cancelClose(); stop(e); return; }
        if (!drawer.contains(e.target)) {
            if (e.target && e.target.closest && e.target.closest("input, textarea, select, [contenteditable]")) return;
            // Let the page close its own layer (details panel, arrange mode, search) first.
            const b = document.body.classList;
            if (b.contains("r-open") || b.contains("arranging") || document.querySelector(".results.show, .pal-back:not([hidden])")) return;
        }
        hideDrawer(); stop(e);
        return;
    }
    if (!isShortcut(e)) return;
    const c = e.code;
    if (c === "KeyT") newClaude();
    else if (c === "KeyW") closeTerm(current());
    else if (c === "Backslash") { showDrawer(false); cycleLayout(); }
    else {
        const n = Number(c.slice(5)), t = n === 9 ? S.terms[S.terms.length - 1] : S.terms[n - 1];
        if (!t) { if (!S.terms.length) return; stop(e); return; }
        showDrawer(false); show(t);
    }
    stop(e);
}, true);

// ============ Snapshot: projects for the menu, session state for tabs ============
document.addEventListener("pulse:snapshot", (e) => {
    const snap = e.detail || {}, map = new Map(), status = new Map(), chats = new Map(), nth = new Map();
    // Numbered exactly as the board numbers chats: per folder, oldest first, empty chats left out.
    for (const s of [...(snap.sessions || [])].filter((x) => !x.empty).sort((a, b) => a.startedAt - b.startedAt)) {
        const i = (nth.get(s.cwd) || 0) + 1;
        nth.set(s.cwd, i);
        if (s.term && !s.ended) chats.set(s.term, `C${i}`);
    }
    for (const s of snap.sessions || []) {
        const at = s.lastAt || s.startedAt || 0;
        if (s.cwd) {
            const p = map.get(s.cwd);
            if (!p) map.set(s.cwd, { cwd: s.cwd, name: s.project || base(s.cwd), at });
            else if (at > p.at) p.at = at;
        }
        if (s.term && !s.ended) {
            // A subagent's permission prompt shows in its chat's terminal too, so any agent waiting marks the tab.
            const main = (s.agents || []).find((a) => a.id === "main");
            if ((s.agents || []).some((a) => a.status === "needs-you" && !a.kill)) status.set(s.term, "needs-you");
            else if (main) status.set(s.term, main.status);
        }
    }
    S.projects = [...map.values()].sort((a, b) => b.at - a.at);
    S.status = status;
    let changed = [...chats].some(([k, v]) => S.chats.get(k) !== v) || chats.size !== S.chats.size;
    S.chats = chats;
    for (const t of S.terms) {
        const needs = t.alive && status.get(t.id) === "needs-you";
        if (needs !== t.needs) { t.needs = needs; changed = true; }
    }
    if (changed) { renderBar(); renderPanes(); }
    if (S.open && !start.hidden) renderStart();
});

// ============ Desktop bridge ============
async function reattach() {
    let list = [];
    try { list = (await D.term.list()) || []; } catch { list = []; }
    if (!Array.isArray(list) || !list.length) return;
    try { await ensureXterm(); } catch { return; }
    const st = readState(), order = st.order || [], sizes = st.sizes || {};
    const rank = (id) => { const i = order.indexOf(id); return i < 0 ? Infinity : i; };
    list = list.slice().sort((a, b) => rank(a.id) - rank(b.id));
    const fresh = [];
    for (const r of list) {
        if (!r || !r.id || byId(r.id)) continue;
        const [cols, rows] = sizes[r.id] || [];
        const t = makeTerm({ id: r.id, cwd: r.cwd, command: r.command, alive: r.alive !== false, cols, rows });
        t.attaching = true; // output that arrives before buffer() answers is already in the buffer
        orphans.delete(r.id);
        S.terms.push(t);
        fresh.push(t);
    }
    if (!fresh.length) return;
    (st.panes || []).forEach((id, i) => { const t = byId(id); if (t && i < MAX_PANES && !S.panes.includes(t)) S.panes[i] = t; });
    S.focus = clamp(Number(st.focus) || 0, 0, MAX_PANES - 1);
    normalize();
    if (st.open) showDrawer(false); else render();
    await Promise.all(fresh.map(async (t) => {
        let buf = "";
        try { buf = (await D.term.buffer(t.id)) || ""; } catch { buf = ""; }
        t.attaching = false;
        if (buf) t.xterm.write(buf);
        if (!t.alive) t.xterm.write(EXITED);
    }));
    renderBar(); renderPanes();
    if (S.open && current()) focusCurrent();
}
function boot() {
    document.body.append(drawer, menu, ghost);
    document.body.style.setProperty("--th", "0px");
    geometry(false);
    render();
    if (!D) return;
    // In the app, warm up xterm while idle so the first terminal opens instantly.
    (window.requestIdleCallback || ((f) => setTimeout(f, 1500)))(() => ensureXterm().catch(() => null));
    quiet(() => D.term.onData((id, data) => {
        const t = byId(id);
        if (!t) stash(id, data);
        else if (!t.attaching) output(t, data);
    }));
    quiet(() => D.term.onExit((id, code) => { const t = byId(id); if (t) exited(t, code); }));
    if (typeof D.onMenu === "function") quiet(() => D.onMenu((action) => {
        if (action === "new-terminal") newClaude();
        else if (action === "toggle-terminal") api.toggle();
        // The app's Cmd+W: the editor's tab when you are in the editor (or the drawer is closed), otherwise the terminal.
        else if (action === "close-terminal") {
            const ws = window.PulseWorkspace, inEditor = document.activeElement?.closest?.("#editor-area") || !api.isOpen();
            if (!(inEditor && ws?.isEditorOpen?.() && ws.closeActive?.())) closeTerm(current());
        }
        else if (action === "cycle-layout") { showDrawer(false); cycleLayout(); }
    }));
    // A fresh launch opens one Claude terminal, ready to type in. Terminals that survived a window close or reload are kept as they are.
    reattach().then(() => { if (!S.terms.length) openTerm({ command: "claude" }); });
}

// ============ Public API ============
const api = {
    available: !!D,
    toggle() { if (S.open) hideDrawer(); else showDrawer(); },
    open: (opts) => openTerm(opts || {}),
    // flash: a brief glow on the pane and its tab, so you can see which terminal is asking you something.
    focus(id, { flash = false } = {}) {
        const t = byId(id);
        if (!D || !t) return false;
        showDrawer(false);
        show(t);
        if (flash) {
            clearTimeout(t.flashTimer);
            t.flash = true;
            renderBar(); renderPanes();
            t.flashTimer = setTimeout(() => { t.flash = false; renderBar(); renderPanes(); }, 2600);
        }
        return true;
    },
    has: (id) => !!(D && byId(id)),
    isOpen: () => S.open,
    layout: (l) => { if (l) setLayout(l); return S.layout; },
};
window.PulseTerminals = api;
if (document.body) boot(); else document.addEventListener("DOMContentLoaded", boot, { once: true });
})();
