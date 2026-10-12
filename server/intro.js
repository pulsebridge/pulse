/* Pulse intro: the dashboard opens behind a frosted blur for a few seconds with a greeting on top, then the blur
   lifts slowly and the dashboard comes into focus.
   Plays when the page opens with #intro (the Mac app launches that way) or when localStorage "pulse.intro" is "always".
   window.PulseIntro = { play() -> Promise (resolves after the reveal), skip() }. Any failure removes the overlay. */
(() => {
"use strict";
if (window.PulseIntro) return;

const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// Timeline, in seconds from the first frame
const T = { greetIn: .35, greetInDur: .7, hold: 2.6, lift: 1.9, skipDur: .45 };
const BLUR = 26;   // px

let run = null;
const reducedMotion = () => { try { return matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; } };

// The form of address and the on/off switch come from Settings; the page mirrors them into localStorage on every snapshot.
const pref = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
function greeting() {
    const h = new Date().getHours(), who = pref("pulse.addr");
    return `${h >= 5 && h < 12 ? "Good morning" : h >= 12 && h < 17 ? "Good afternoon" : "Good evening"}${who ? `, ${who}` : ""}.`;
}

// The frosted cover. Critical styles are inline so it hides the app sharply even before intro.css has loaded.
function cover() {
    let el = document.getElementById("pulse-intro");
    if (el) return el;
    el = document.createElement("div");
    el.id = "pulse-intro";
    el.setAttribute("aria-hidden", "true");
    const blur = `blur(${BLUR}px) saturate(1.1)`;
    el.style.cssText = `position:fixed;inset:0;z-index:1000;background:rgba(6,8,12,.55);backdrop-filter:${blur};-webkit-backdrop-filter:${blur};`;
    (document.body || document.documentElement).appendChild(el);
    return el;
}

function play() {
    if (run) return run.done;
    let resolve;
    const done = new Promise(r => { resolve = r; });
    run = { done, resolve, raf: 0, timer: 0, off: [] };
    try { start(run); } catch (err) { console.warn("[pulse intro]", err); finish(run); }
    return done;
}
function skip() { try { run?.skip?.(); } catch { if (run) finish(run); } }

function finish(r) {
    if (!r || r.ended) return;
    r.ended = true;
    cancelAnimationFrame(r.raf); clearTimeout(r.timer);
    r.off.forEach(f => { try { f(); } catch {} });
    try { r.el?.remove(); document.getElementById("pulse-intro")?.remove(); } catch {}
    if (run === r) run = null;
    r.resolve();
}

function welcome(r) {
    if (r.welcomed) return;
    r.welcomed = true;
    try { window.Pulse?.welcome?.(); } catch (err) { console.warn("[pulse intro] welcome", err); }
}

function start(r) {
    const el = r.el = cover();
    const still = reducedMotion();
    const msg = document.createElement("div");
    msg.textContent = greeting();
    msg.style.cssText = "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;opacity:0;color:#f4f6fa;" +
        "font:300 clamp(28px,4.2vw,58px)/1.1 -apple-system,BlinkMacSystemFont,'SF Pro Display','Geist',system-ui,sans-serif;letter-spacing:-.01em;" +
        "text-shadow:0 2px 30px rgba(0,0,0,.35);will-change:opacity,transform;";
    el.append(msg);
    // Settings changed while the greeting is up (or the first snapshot just arrived): say it the new way.
    const onSnap = () => { msg.textContent = greeting(); };
    document.addEventListener("pulse:snapshot", onSnap);
    r.off.push(() => document.removeEventListener("pulse:snapshot", onSnap));
    r.timer = setTimeout(() => finish(r), 12000);   // never hold the app hostage

    let t = 0, t0 = 0, liftAt = still ? 1.2 : T.hold, liftDur = still ? .4 : T.lift;
    // Skip: any key or click starts the lift now
    r.skip = () => { if (t < liftAt) { liftAt = t; liftDur = T.skipDur; } };
    const onKey = e => {
        if (t >= liftAt) return;   // once the lift starts, keys belong to the app
        r.skip();
        if (!e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); e.stopImmediatePropagation(); }
    };
    // The click that skips must not land on the app as the overlay stops catching the pointer
    let swallow = 0;
    const onPointer = e => { e.preventDefault(); e.stopPropagation(); swallow = performance.now() + 700; r.skip(); };
    const onClick = e => { if (performance.now() < swallow) { e.preventDefault(); e.stopImmediatePropagation(); } };
    addEventListener("keydown", onKey, true);
    addEventListener("click", onClick, true);
    el.addEventListener("pointerdown", onPointer);
    r.off.push(() => removeEventListener("keydown", onKey, true), () => setTimeout(() => removeEventListener("click", onClick, true), 700));

    function frame(now) {
        try {
            if (!t0) t0 = now;
            t = (now - t0) / 1000;
            if (t >= T.greetIn) welcome(r);
            const lift = t >= liftAt ? clamp((t - liftAt) / liftDur, 0, 1) : 0;
            // Greeting: fades in, holds, drifts up and away as the blur lifts
            const gin = smooth(T.greetIn, T.greetIn + T.greetInDur, t), gout = smooth(0, .45, lift);
            msg.style.opacity = String((gin * (1 - gout)).toFixed(3));
            msg.style.transform = `translateY(${((1 - gin) * 10 - gout * 14).toFixed(1)}px) scale(${(.985 + .015 * gin + .01 * gout).toFixed(4)})`;
            if (lift > 0) {
                if (el.style.pointerEvents !== "none") el.style.pointerEvents = "none";
                const e = lift * lift * (3 - 2 * lift), blur = BLUR * (1 - e), tint = .55 * (1 - smooth(0, .8, lift));
                el.style.background = `rgba(6,8,12,${tint.toFixed(3)})`;
                el.style.backdropFilter = el.style.webkitBackdropFilter = blur > .2 ? `blur(${blur.toFixed(1)}px) saturate(1.1)` : "none";
            }
            if (lift >= 1) return finish(r);
            r.raf = requestAnimationFrame(frame);
        } catch (err) { console.warn("[pulse intro]", err); finish(r); }
    }
    r.raf = requestAnimationFrame(frame);
}

window.PulseIntro = { play, skip };

// Auto-play on launch (#intro), or every load when localStorage "pulse.intro" is "always"
let auto = false;
try {
    if (/intro/.test(location.hash)) { auto = true; history.replaceState(null, "", location.pathname + location.search); }
    if (localStorage.getItem("pulse.intro") === "always") auto = true;
} catch {}
if (auto && pref("pulse.greeting") === "0") {
    // Greeting screen switched off in Settings: still let the crew welcome you by voice.
    addEventListener("load", () => { try { window.Pulse?.welcome?.(); } catch {} });
} else if (auto) {
    try { cover(); } catch {}
    play();
}
})();
