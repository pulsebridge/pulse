// Smoke test for a running Pulse app started with --remote-debugging-port (default 9343).
// Drives window.pulseDesktop over CDP: opens a shell terminal, checks output round-trips and that `claude`
// is on the login PATH, then screenshots the window.   Usage: node scripts/verify.js [port] [screenshot.png]
const os = require("node:os");
const fs = require("node:fs");

const port = +process.argv[2] || 9343;
const shot = process.argv[3] || "";

async function main() {
    let pages = [];
    for (let i = 0; i < 40 && !pages.length; i++) {
        pages = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json()).catch(() => []);
        pages = pages.filter((p) => p.type === "page" && /^http:\/\/127\.0\.0\.1:\d+\/$/.test(p.url));
        if (!pages.length) await new Promise((r) => setTimeout(r, 500));
    }
    if (!pages.length) throw new Error("no Pulse page found over CDP");
    const ws = new WebSocket(pages[0].webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    let seq = 0;
    const waiting = new Map();
    ws.onmessage = (m) => {
        const msg = JSON.parse(m.data);
        if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
    };
    const cdp = (method, params = {}) => new Promise((r) => { const id = ++seq; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });

    const test = async (home) => {
        const d = window.pulseDesktop;
        if (!d) return { error: "window.pulseDesktop missing" };
        const out = {};
        const onData = [];
        const un = d.term.onData((id, data) => onData.push([id, data]));
        let exited = null;
        const unExit = d.term.onExit((id, code) => (exited = [id, code]));
        const text = (id) => onData.filter(([i]) => i === id).map(([, s]) => s).join("");
        const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };
        const t = await d.term.create({ cwd: home, command: "shell", cols: 100, rows: 30 });
        out.created = t;
        await until(() => text(t.id).length > 0, 10000);
        await new Promise((r) => setTimeout(r, 600));
        d.term.write(t.id, "echo pulse-ok\r");
        out.echo = await until(() => /(^|\n)pulse-ok\r?\n/.test(text(t.id)), 10000);
        d.term.write(t.id, "claude --version; echo PATH_HAS_LOCAL=$([[ :$PATH: == *:$HOME/.local/bin:* ]] && echo yes || echo no); echo TERM=$TERM PULSE_TERM_ID=$PULSE_TERM_ID\r");
        out.claude = await until(() => /\(Claude Code\)/.test(text(t.id)), 15000);
        out.claudeLine = (text(t.id).match(/[\d.]+ \(Claude Code\)/) || [""])[0];
        await until(() => /PULSE_TERM_ID=t\d+\r?\n/.test(text(t.id)), 5000);
        out.envLine = (text(t.id).match(/TERM=\S+ PULSE_TERM_ID=t\d+/) || [""])[0];
        out.pathHasLocalBin = /PATH_HAS_LOCAL=yes/.test(text(t.id));
        d.term.resize(t.id, 120, 40);
        const buf = await d.term.buffer(t.id);
        out.bufferHasOk = /(^|\n)pulse-ok\r?\n/.test(buf);
        out.bufferMatchesOnData = buf === text(t.id);
        out.listed = (await d.term.list()).find((x) => x.id === t.id);
        d.term.write(t.id, "exit\r");
        await until(() => exited && exited[0] === t.id, 5000);
        out.exit = exited;
        out.listedAfterExit = (await d.term.list()).find((x) => x.id === t.id);
        d.term.kill(t.id);
        out.listAfterKill = (await d.term.list()).map((x) => x.id);
        un(); unExit();
        out.desktopClass = document.documentElement.classList.contains("desktop");
        out.platform = d.platform;
        return out;
    };
    const r = await cdp("Runtime.evaluate", { expression: `(${test})(${JSON.stringify(os.homedir())})`, awaitPromise: true, returnByValue: true });
    const result = r.result?.result?.value ?? r.result;
    console.log(JSON.stringify(result, null, 2));
    if (shot) {
        const s = await cdp("Page.captureScreenshot", { format: "png" });
        fs.writeFileSync(shot, Buffer.from(s.result.data, "base64"));
        console.log("screenshot:", shot);
    }
    ws.close();
    const ok = result && result.echo && result.claude && result.bufferHasOk && result.desktopClass;
    console.log(ok ? "PASS" : "FAIL");
    process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
