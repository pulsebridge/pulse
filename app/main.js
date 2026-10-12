// Pulse for macOS: the Pulse dashboard in its own window, plus Claude terminals that live in this (main) process.
// The dashboard is still served by the Pulse server on 127.0.0.1:4777. If it is not running, this app starts the copy
// bundled with it, detached, so Claude Code hooks keep working after the app quits.
// Terminals are node-pty processes owned here; the page reaches them through preload.js (window.pulseDesktop).
"use strict";
const { app, BrowserWindow, Menu, ipcMain, dialog, shell, screen, session } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");


const PORT = +process.env.PULSE_PORT || 4777;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const PULSE_URL = `${ORIGIN}/`;
const HOME = process.env.PULSE_HOME || path.join(os.homedir(), ".pulse");
const LOG_FILE = path.join(HOME, "pulse.log");
const WINDOW_FILE = path.join(HOME, "window.json");
const BUNDLED_SERVER = app.isPackaged
    ? path.join(process.resourcesPath, "server", "server.js")
    : path.join(__dirname, "..", "server", "server.js");
// The plugin's server is the one kept current (its hook writes ~/.pulse/plugin-root, and it restarts itself when its code
// changes). The copy bundled in the app is a snapshot from build time, used only where the plugin isn't installed.
function serverJs() {
    const root = safe(() => fs.readFileSync(path.join(HOME, "plugin-root"), "utf8").trim());
    const plugin = root && path.join(root, "server", "server.js");
    return plugin && fs.existsSync(plugin) ? plugin : BUNDLED_SERVER;
}
const SHELL = [process.env.SHELL, safe(() => os.userInfo().shell), "/bin/zsh"].find((s) => s && fs.existsSync(s));
const SCROLLBACK = 512 * 1024; // bytes of output kept per terminal for buffer()
const FLUSH_MS = 8; // batch pty output into one IPC message per tick
const MIN_W = 1000, MIN_H = 680;

let win = null;
let quitConfirmed = false;
const pendingMenu = [];

function safe(fn, fallback) {
    try { return fn(); } catch { return fallback; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- login environment ----------
// Apps opened from Finder get launchd's bare PATH. Ask the user's login shell once for its real environment
// (nvm, ~/.local/bin for `claude`, Homebrew…) and use it for terminals and for the server we start.
const LAUNCHER_VARS = /^(npm_|ELECTRON_|VSCODE_|ITERM_|TERM_PROGRAM|TERM_SESSION_ID$|LC_TERMINAL|__CFBundleIdentifier$|CLAUDECODE$|CLAUDE_CODE_ENTRYPOINT$|CLAUDE_CODE_SSE_PORT$|GIT_ASKPASS$|INIT_CWD$|PULSE_TERM_ID$|COLORTERM$|TERM$|PWD$|OLDPWD$|SHLVL$|_$)/;
const SHELL_VARS = /^(PWD|OLDPWD|SHLVL|_)$/;

function cleanEnv(env) {
    const out = {};
    for (const [k, v] of Object.entries(env)) if (!LAUNCHER_VARS.test(k) && v != null) out[k] = String(v);
    return out;
}

function fallbackEnv() {
    const env = cleanEnv(process.env);
    const h = os.homedir();
    const extra = [path.join(h, ".local/bin"), "/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin"];
    const nvm = path.join(h, ".nvm/versions/node");
    const nodes = safe(() => fs.readdirSync(nvm).sort().reverse(), []);
    if (nodes[0]) extra.push(path.join(nvm, nodes[0], "bin"));
    const have = (env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin").split(":");
    env.PATH = [...extra.filter((p) => !have.includes(p)), ...have].join(":");
    return env;
}

function resolveLoginEnv(timeoutMs = 8000) {
    return new Promise((resolve) => {
        const MARK = "__PULSE_ENV_BEGIN__";
        const chunks = [];
        let done = false;
        const finish = (env, why) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            if (why) console.warn(`[pulse] login env: ${why}; using fallback PATH`);
            resolve(env);
        };
        let child;
        try {
            // detached: no controlling tty, so an interactive shell can't stop on terminal I/O.
            child = spawn(SHELL, ["-ilc", `printf '%s' '${MARK}'; command env -0`], {
                cwd: os.homedir(), env: cleanEnv(process.env), stdio: ["ignore", "pipe", "ignore"], detached: true,
            });
        } catch (e) {
            return finish(fallbackEnv(), e.message);
        }
        const timer = setTimeout(() => {
            safe(() => process.kill(-child.pid, "SIGKILL"));
            finish(fallbackEnv(), "timed out");
        }, timeoutMs);
        child.stdout.on("data", (c) => chunks.push(c));
        child.on("error", (e) => finish(fallbackEnv(), e.message));
        child.on("close", () => {
            const out = Buffer.concat(chunks).toString("utf8");
            const at = out.lastIndexOf(MARK);
            if (at < 0) return finish(fallbackEnv(), "no output");
            const env = {};
            for (const line of out.slice(at + MARK.length).split("\0")) {
                const eq = line.indexOf("=");
                if (eq > 0 && !SHELL_VARS.test(line.slice(0, eq))) env[line.slice(0, eq)] = line.slice(eq + 1);
            }
            if (!env.PATH) return finish(fallbackEnv(), "no PATH");
            finish(env);
        });
    });
}

const loginEnv = resolveLoginEnv();

// ---------- Pulse server ----------
function health(timeout = 700) {
    return new Promise((resolve) => {
        const req = http.get({ host: "127.0.0.1", port: PORT, path: "/health", timeout }, (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (c) => (body += c));
            res.on("end", () => resolve(res.statusCode === 200 && body.trim() === "pulse"));
        });
        req.on("timeout", () => req.destroy());
        req.on("error", () => resolve(false));
    });
}

function request(method, route, timeout = 1500) {
    return new Promise((resolve) => {
        const req = http.request({ host: "127.0.0.1", port: PORT, path: route, method, timeout, headers: method === "POST" ? { "content-type": "application/json" } : {} }, (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (c) => (body += c));
            res.on("end", () => resolve(safe(() => JSON.parse(body)) || null));
        });
        req.on("timeout", () => req.destroy());
        req.on("error", () => resolve(null));
        req.end(method === "POST" ? "{}" : undefined);
    });
}

// A running server that is a stale copy (bundled in an older Pulse.app, or from before /version existed) is replaced by the
// current one, so opening the app always shows the latest Pulse. A running plugin server is kept: it updates itself.
async function replaceStaleServer(want) {
    const v = await request("GET", "/version");
    if (v?.file === want || (v?.file && !v.file.includes(".app/Contents/Resources/"))) return;
    console.log(`[pulse] replacing stale server ${v?.file || "(old version)"} with ${want}`);
    if (!(await request("POST", "/shutdown"))?.ok) return; // too old to stop itself; keep using it
    for (let i = 0; i < 20 && (await health(300)); i++) await sleep(150);
}

let starting = null;
// Resolves true once the server answers /health. Uses a running server (e.g. started by the plugin) if there is one.
function ensureServer() {
    if (starting) return starting;
    starting = (async () => {
        const SERVER_JS = serverJs();
        if (await health()) await replaceStaleServer(SERVER_JS);
        if (await health()) return true;
        if (!fs.existsSync(SERVER_JS)) {
            console.error(`[pulse] server not found at ${SERVER_JS}`);
            return false;
        }
        const env = await loginEnv;
        if (await health()) return true; // started by a hook while we were waiting
        fs.mkdirSync(HOME, { recursive: true });
        const log = fs.openSync(LOG_FILE, "a");
        try {
            // Electron's own binary runs as plain Node here. Detached + unref: the server outlives the app.
            const child = spawn(process.execPath, [SERVER_JS], {
                cwd: path.dirname(SERVER_JS),
                env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
                detached: true,
                stdio: ["ignore", log, log],
            });
            child.on("error", (e) => console.error("[pulse] server spawn failed:", e.message));
            child.unref();
        } finally {
            fs.closeSync(log);
        }
        for (let i = 0; i < 25; i++) {
            await sleep(200);
            if (await health(400)) return true;
        }
        return false;
    })().finally(() => (starting = null));
    return starting;
}

// ---------- window ----------
function loadWindowState() {
    const s = safe(() => JSON.parse(fs.readFileSync(WINDOW_FILE, "utf8")), null);
    const def = { width: 1320, height: 860 };
    if (!s || !(s.width >= MIN_W && s.height >= MIN_H)) return def;
    const b = { x: s.x, y: s.y, width: s.width, height: s.height };
    // Only restore the position if the window would still be visible on a connected display.
    const visible = Number.isFinite(b.x) && Number.isFinite(b.y) && screen.getAllDisplays().some(({ workArea: a }) =>
        b.x < a.x + a.width - 80 && b.x + b.width > a.x + 80 && b.y >= a.y - 10 && b.y < a.y + a.height - 80);
    return visible ? { ...b, maximized: !!s.maximized } : { width: b.width, height: b.height, maximized: !!s.maximized };
}

let saveTimer = null;
function saveWindowState() {
    clearTimeout(saveTimer);
    if (!win || win.isDestroyed() || win.isFullScreen() || win.isMinimized()) return;
    const b = win.getNormalBounds();
    safe(() => {
        fs.mkdirSync(HOME, { recursive: true });
        fs.writeFileSync(WINDOW_FILE, JSON.stringify({ ...b, maximized: win.isMaximized() }));
    });
}

function isPulseUrl(url) {
    return safe(() => new URL(url).origin === ORIGIN, false);
}

function openExternal(url) {
    if (/^(https?|mailto):/i.test(url)) shell.openExternal(url).catch(() => {});
}

function createWindow() {
    const state = loadWindowState();
    win = new BrowserWindow({
        ...state,
        minWidth: MIN_W,
        minHeight: MIN_H,
        show: false,
        title: "Pulse",
        titleBarStyle: "hiddenInset",
        trafficLightPosition: { x: 18, y: 18 },
        backgroundColor: "#060607",
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
            webviewTag: false,
            // The welcome line and agent updates are spoken without waiting for a click.
            autoplayPolicy: "no-user-gesture-required",
        },
    });
    if (state.maximized) win.maximize();
    win.once("ready-to-show", () => win?.show());
    setTimeout(() => win && !win.isDestroyed() && !win.isVisible() && win.show(), 2500);

    const wc = win.webContents;
    // Links to anything else open in the default browser; the window only ever shows Pulse.
    wc.setWindowOpenHandler(({ url }) => {
        openExternal(url);
        return { action: "deny" };
    });
    wc.on("will-navigate", (e, url) => {
        if (isPulseUrl(url)) return;
        e.preventDefault();
        openExternal(url);
    });
    wc.on("did-fail-load", (_e, code, _desc, url, isMainFrame) => {
        if (isMainFrame && code !== -3 && isPulseUrl(url)) setTimeout(() => loadPulse(), 800);
    });
    // The page says whether it will ask about quitting itself (its themed modal); a new page starts out unknown.
    wc.on("did-start-navigation", (_e, _url, inPlace, isMainFrame) => { if (isMainFrame && !inPlace) pageAsksQuit = false; });
    wc.on("did-finish-load", () => {
        if (!isPulseUrl(wc.getURL())) return;
        while (pendingMenu.length) wc.send("pulse:menu", pendingMenu.shift());
    });
    wc.on("render-process-gone", (_e, d) => {
        if (d.reason !== "clean-exit") setTimeout(() => loadPulse(), 500);
    });

    const persist = () => {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(saveWindowState, 500);
    };
    win.on("resize", persist);
    win.on("move", persist);
    win.on("close", saveWindowState);
    win.on("closed", () => (win = null));

    loadPulse();
    return win;
}

function showStarting(message) {
    if (!win || win.isDestroyed()) return;
    if (win.webContents.getURL().startsWith("file:") && !message) return;
    win.loadFile(path.join(__dirname, "starting.html"), message ? { query: { msg: message } } : undefined).catch(() => {});
}

let loading = false, introShown = false;
async function loadPulse() {
    if (loading || !win || win.isDestroyed()) return;
    loading = true;
    try {
        for (let attempt = 0; win && !win.isDestroyed(); attempt++) {
            if (await health()) break;
            showStarting(attempt ? `Couldn't reach the Pulse server. Retrying… (log: ${LOG_FILE.replace(os.homedir(), "~")})` : "");
            if (await ensureServer()) break;
            await sleep(Math.min(2000 * (attempt + 1), 10_000));
        }
        // The first load of each launch plays the intro (the page reads #intro, then drops it); crash reloads don't.
        const url = introShown ? PULSE_URL : `${PULSE_URL}#intro`;
        introShown = true;
        if (win && !win.isDestroyed()) await win.loadURL(url).catch(() => {});
    } finally {
        loading = false;
    }
}

function showWindow() {
    if (!win || win.isDestroyed()) createWindow();
    else {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
    }
}

function sendMenu(action) {
    if (win && !win.isDestroyed() && isPulseUrl(win.webContents.getURL()) && !win.webContents.isLoading()) {
        showWindow();
        win.webContents.send("pulse:menu", action);
    } else {
        pendingMenu.push(action);
        showWindow();
    }
}

function buildMenu() {
    const template = [
        { role: "appMenu" },
        { role: "editMenu" },
        {
            label: "View",
            submenu: [
                { role: "reload" },
                { role: "forceReload" },
                { role: "toggleDevTools" },
                { type: "separator" },
                { role: "resetZoom" },
                { role: "zoomIn" },
                { role: "zoomOut" },
                { type: "separator" },
                { role: "togglefullscreen" },
            ],
        },
        {
            label: "Terminal",
            submenu: [
                { label: "New Claude Terminal", accelerator: "CmdOrCtrl+T", click: () => sendMenu("new-terminal") },
                { label: "Show/Hide Terminals", accelerator: "CmdOrCtrl+J", click: () => sendMenu("toggle-terminal") },
                { label: "Cycle Split Layout", accelerator: "CmdOrCtrl+\\", click: () => sendMenu("cycle-layout") },
                { type: "separator" },
                { label: "Close Terminal", accelerator: "CmdOrCtrl+W", click: () => sendMenu("close-terminal") },
            ],
        },
        // Cmd+W belongs to the terminal (menu accelerators fire before the page sees the key), so the window closes on Shift+Cmd+W.
        {
            label: "Window",
            submenu: [
                { role: "minimize" },
                { role: "zoom" },
                { type: "separator" },
                { label: "Close Window", accelerator: "Shift+CmdOrCtrl+W", role: "close" },
                { type: "separator" },
                { role: "front" },
            ],
        },
        {
            role: "help",
            submenu: [
                { label: "Open Pulse in Browser", click: () => shell.openExternal(PULSE_URL) },
                { label: "Show Server Log", click: () => shell.openPath(LOG_FILE) },
            ],
        },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- quitting with terminals open ----------
// The page asks in its own themed modal (contract Q). If it has no handler, or doesn't answer within 5 s
// (a broken page must never trap the user), the same question comes up as a native dialog.
let pageAsksQuit = false, quitAsk = null;
ipcMain.on("pulse:quit-ready", (e) => { if (win && e.sender === win.webContents) pageAsksQuit = true; });
ipcMain.on("pulse:quit-answer", (_e, ok) => settleQuit(!!ok));
ipcMain.on("pulse:quit-seen", () => { if (quitAsk) clearTimeout(quitAsk.timer); });
function settleQuit(ok) {
    if (!quitAsk) return;
    clearTimeout(quitAsk.timer);
    quitAsk = null;
    if (ok) { quitConfirmed = true; app.quit(); }
}
function askQuit(running) {
    // Asked again while the page's question is up (or stuck): answer natively, so quitting can never be blocked.
    if (quitAsk) { clearTimeout(quitAsk.timer); quitAsk = null; return nativeQuitDialog(running); }
    const live = win && !win.isDestroyed() && isPulseUrl(win.webContents.getURL()) && !win.webContents.isLoading();
    if (live && pageAsksQuit) {
        showWindow();
        quitAsk = { timer: setTimeout(() => { quitAsk = null; nativeQuitDialog(running); }, 3000) };
        win.webContents.send("pulse:quit-request", { terminals: running });
        return;
    }
    nativeQuitDialog(running);
}
function nativeQuitDialog(running) {
    if (!running) { quitConfirmed = true; return app.quit(); }
    const opts = {
        type: "question",
        buttons: ["Stay", "Close Pulse"],
        defaultId: 0,
        cancelId: 0,
        message: "Leaving the command center?",
        detail: `${running} terminal${running > 1 ? "s" : ""} will close, and anything running in ${running > 1 ? "them" : "it"} stops. Agents in your other windows keep working, and Pulse keeps listening.`,
    };
    const choice = win && !win.isDestroyed() ? dialog.showMessageBoxSync(win, opts) : dialog.showMessageBoxSync(opts);
    if (choice === 1) { quitConfirmed = true; app.quit(); }
}

// ---------- terminals ----------
let pty = null, ptyError = null;
try {
    pty = require("node-pty");
} catch (e) {
    ptyError = e;
    console.error("[pulse] node-pty failed to load:", e.message);
}

const terms = new Map(); // id -> terminal
let nextId = 0;
const dirty = new Set();
let flushTimer = null;

const info = (t) => ({ id: t.id, cwd: t.cwd, command: t.command, title: t.title, alive: t.alive });

function broadcast(channel, ...args) {
    if (win && !win.isDestroyed() && isPulseUrl(win.webContents.getURL())) win.webContents.send(channel, ...args);
}

function remember(t, data) {
    t.chunks.push(data);
    t.size += data.length;
    while (t.size > SCROLLBACK && t.chunks.length > 1) t.size -= t.chunks.shift().length;
    if (t.size > SCROLLBACK) {
        t.chunks[0] = t.chunks[0].slice(-SCROLLBACK);
        t.size = t.chunks[0].length;
    }
}

// Everything that reaches the page through onData also lands in the scrollback, in the same order,
// so buffer() is always "all output so far" and anything after it arrives through onData.
function flush() {
    clearTimeout(flushTimer);
    flushTimer = null;
    if (!dirty.size) return;
    const batch = [];
    for (const t of dirty) {
        if (!t.pending) continue;
        remember(t, t.pending);
        batch.push([t.id, t.pending]);
        t.pending = "";
    }
    dirty.clear();
    if (batch.length) broadcast("pulse:term:data", batch);
}

function queue(t, data) {
    t.pending += data;
    dirty.add(t);
    if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
}

function resolveCwd(cwd) {
    let dir = typeof cwd === "string" && cwd.trim() ? cwd.trim() : os.homedir();
    if (dir === "~" || dir.startsWith("~/")) dir = path.join(os.homedir(), dir.slice(1));
    dir = path.resolve(dir);
    return safe(() => fs.statSync(dir).isDirectory(), false) ? dir : os.homedir();
}

const dim = (n, def, max) => (Number.isInteger(n) && n > 0 ? Math.min(n, max) : def);

// "claude" terminals are a login shell with `claude` typed in once the shell has settled,
// so quitting claude drops the user back into their shell in the same folder.
function typeWhenReady(t, text) {
    let quiet = null;
    const go = () => {
        clearTimeout(quiet);
        clearTimeout(cap);
        t.onOutput = null;
        if (t.alive) t.pty.write(text);
    };
    const cap = setTimeout(go, 4000);
    t.onOutput = () => {
        clearTimeout(quiet);
        quiet = setTimeout(go, 250);
    };
}

async function createTerm(opts = {}) {
    if (!pty) throw new Error(`Terminals are unavailable: node-pty failed to load (${ptyError?.message})`);
    const command = opts.command === "claude" ? "claude" : "shell";
    const cwd = resolveCwd(opts.cwd);
    const cols = dim(opts.cols, 80, 1000), rows = dim(opts.rows, 24, 500);
    const env = { ...(await loginEnv) };
    const id = `t${++nextId}`;
    Object.assign(env, { TERM: "xterm-256color", COLORTERM: "truecolor", PULSE_TERM_ID: id });
    if (!env.LANG) env.LANG = "en_US.UTF-8";
    const p = pty.spawn(SHELL, ["-il"], { name: "xterm-256color", cols, rows, cwd, env });
    const t = {
        id, cwd, command, pty: p, alive: true, code: null,
        title: `${path.basename(cwd) || cwd} · ${command}`,
        chunks: [], size: 0, pending: "", onOutput: null,
    };
    terms.set(id, t);
    p.onData((d) => {
        queue(t, d);
        t.onOutput?.();
    });
    p.onExit(({ exitCode }) => {
        flush();
        t.alive = false;
        t.code = exitCode;
        broadcast("pulse:term:exit", id, exitCode);
    });
    if (command === "claude") typeWhenReady(t, "claude\r");
    return info(t);
}

function killTerm(id) {
    const t = terms.get(id);
    if (!t) return;
    terms.delete(id);
    dirty.delete(t);
    if (t.alive) safe(() => t.pty.kill());
}

function killAllTerms() {
    for (const id of [...terms.keys()]) killTerm(id);
}

// Only the Pulse page (served from the local server) may drive terminals.
const trusted = (e) => isPulseUrl(e.senderFrame?.url || "");
function handle(channel, fn) {
    ipcMain.handle(channel, (e, ...args) => {
        if (!trusted(e)) throw new Error("not allowed");
        return fn(e, ...args);
    });
}
function on(channel, fn) {
    ipcMain.on(channel, (e, ...args) => {
        if (trusted(e)) safe(() => fn(e, ...args));
    });
}

handle("pulse:term:create", (_e, opts) => createTerm(opts && typeof opts === "object" ? opts : {}));
handle("pulse:term:list", () => [...terms.values()].map(info));
handle("pulse:term:buffer", (_e, id) => {
    flush();
    const t = terms.get(id);
    return t ? t.chunks.join("") : "";
});
handle("pulse:pickFolder", async (e) => {
    const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), {
        title: "Choose a folder for the terminal",
        buttonLabel: "Open Here",
        defaultPath: os.homedir(),
        properties: ["openDirectory", "createDirectory"],
    });
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
});
on("pulse:term:write", (_e, id, data) => {
    const t = terms.get(id);
    if (t?.alive && typeof data === "string") t.pty.write(data);
});
on("pulse:term:resize", (_e, id, cols, rows) => {
    const t = terms.get(id);
    if (t?.alive && Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0)
        t.pty.resize(Math.min(cols, 1000), Math.min(rows, 500));
});
on("pulse:term:kill", (_e, id) => killTerm(id));

// ---------- app lifecycle ----------
if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.setName("Pulse");
    app.on("second-instance", showWindow);

    app.whenReady().then(() => {
        app.setAboutPanelOptions({ applicationName: "Pulse", copyright: "Mission control for Claude Code" });
        if (!app.isPackaged) {
            const icon = path.join(__dirname, "build", "icon.png");
            if (fs.existsSync(icon)) safe(() => app.dock?.setIcon(icon));
        }
        // The page may use the clipboard, notifications and audio; nothing else gets permissions.
        session.defaultSession.setPermissionRequestHandler((wc, _perm, cb) => cb(isPulseUrl(wc.getURL())));
        session.defaultSession.setPermissionCheckHandler((_wc, _perm, origin) => isPulseUrl(origin || ""));
        buildMenu();
        createWindow();
    });

    app.on("activate", showWindow);
    app.on("window-all-closed", () => {
        // macOS: stay in the Dock with terminals running; reopening the window picks them back up.
        if (process.platform !== "darwin") app.quit();
    });

    app.on("before-quit", (e) => {
        const running = [...terms.values()].filter((t) => t.alive).length;
        // The page is asked even with no terminals open: it may hold unsaved edits. It answers at once when nothing would be lost.
        if (!quitConfirmed && (running || pageAsksQuit)) {
            e.preventDefault();
            askQuit(running);
            return;
        }
        saveWindowState();
    });
    app.on("will-quit", killAllTerms);
    for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => {
        quitConfirmed = true;
        app.quit();
    });
    process.on("exit", killAllTerms);
}
