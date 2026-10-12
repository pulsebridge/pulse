// Bridge between the Pulse page and the desktop app (contract E). Exposes window.pulseDesktop and nothing else.
// Terminals live in the main process and survive page reloads: on load, call term.list(), then term.buffer(id)
// for each one. buffer() returns all output delivered so far; onData events that arrive after it resolves are new.
const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, cb, dispatch) {
    if (typeof cb !== "function") return () => {};
    const handler = (_e, ...args) => dispatch(cb, ...args);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
}

const call = (cb, ...args) => {
    try {
        cb(...args);
    } catch (e) {
        console.error(e);
    }
};

contextBridge.exposeInMainWorld("pulseDesktop", {
    platform: "darwin",
    term: {
        create: (opts) => ipcRenderer.invoke("pulse:term:create", opts || {}),
        list: () => ipcRenderer.invoke("pulse:term:list"),
        buffer: (id) => ipcRenderer.invoke("pulse:term:buffer", id),
        write: (id, data) => ipcRenderer.send("pulse:term:write", id, String(data)),
        resize: (id, cols, rows) => ipcRenderer.send("pulse:term:resize", id, Math.floor(cols), Math.floor(rows)),
        kill: (id) => ipcRenderer.send("pulse:term:kill", id),
        // Output is batched in the main process (one message per ~8 ms for all terminals).
        onData: (cb) => subscribe("pulse:term:data", cb, (fn, batch) => {
            for (const [id, data] of batch) call(fn, id, data);
        }),
        onExit: (cb) => subscribe("pulse:term:exit", cb, (fn, id, code) => call(fn, id, code)),
    },
    pickFolder: () => ipcRenderer.invoke("pulse:pickFolder"),
    onMenu: (cb) => subscribe("pulse:menu", cb, (fn, action) => call(fn, action)), // "new-terminal" | "toggle-terminal" | "close-terminal" | "cycle-layout"
    // Contract Q: quitting with terminals open. Registering tells the app this page will ask; the app waits up to 5 s
    // for answerQuit, then falls back to a native dialog.
    onQuitRequest: (cb) => {
        // "seen" first: once the page has the question, the app waits for the answer however long the user takes.
        const off = subscribe("pulse:quit-request", cb, (fn, info) => { ipcRenderer.send("pulse:quit-seen"); call(fn, info); });
        ipcRenderer.send("pulse:quit-ready");
        return off;
    },
    answerQuit: (ok) => ipcRenderer.send("pulse:quit-answer", !!ok),
});

// The page uses this class to leave room for the macOS traffic lights.
const mark = () => document.documentElement?.classList.add("desktop");
mark();
window.addEventListener("DOMContentLoaded", mark);
