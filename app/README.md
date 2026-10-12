# Pulse for macOS

Pulse in its own window: the dashboard with no browser tab or port to remember, plus Claude Code terminals (several at once, with splits) built into the page.

Optional: the plugin alone gives you the dashboard in a browser. Download the app from the [latest release](https://github.com/pulsebridge/pulse/releases/latest) (Apple Silicon and Intel DMGs), install it with the repo's installer (`curl -fsSL https://raw.githubusercontent.com/pulsebridge/pulse/main/install.sh | PULSE_APP=1 sh`), or build it yourself as below. It is ad-hoc signed, not notarized: the first time a downloaded copy opens, allow it in System Settings → Privacy & Security → Open Anyway.

## Build

```sh
git clone https://github.com/pulsebridge/pulse && cd pulse/app
npm install          # Electron + node-pty (prebuilt: nothing is compiled, no Xcode needed)
npm start            # dev: runs against ../server
npm run dist         # packaged app -> app/dist/mac-arm64/Pulse.app
npm run dist:dmg     # DMGs for both chips: app/dist/Pulse-<version>-arm64.dmg and -x64.dmg
npm run release      # the same DMGs without re-rendering the icon (what CI runs)
```

Drag `dist/mac-arm64/Pulse.app` to /Applications (or run `npm run install-app`, below). A build you made yourself opens normally. `npm run dist` also re-renders the icon (`build/icon.svg` → `build/icon.icns`, through Electron and `iconutil`).

Smoke test for a running app: start it with `--remote-debugging-port=9343`, then run `npm run verify`. It opens a shell terminal through `window.pulseDesktop`, checks that output comes back and that `claude --version` resolves, then closes it.

## How it works

- **Server.** On launch the app calls `GET http://127.0.0.1:4777/health`. If a Pulse server is already running (for example one the plugin started), the app uses it. Otherwise it starts the server bundled in the app (`Pulse.app/Contents/Resources/server/server.js`; `../server/server.js` in dev). It runs the app's own binary with `ELECTRON_RUN_AS_NODE=1`, so Node doesn't have to be installed. The server runs detached, logs to `~/.pulse/pulse.log`, and **keeps running after the app quits**, because Claude Code hooks post to it. The window shows "Starting Pulse…" until `/health` answers, and retries if the server goes away.
- **Window.** It loads `http://127.0.0.1:4777/` with a hidden-inset title bar. Size and position are saved in `~/.pulse/window.json`. Links to other sites open in your default browser.
- **Terminals.** Terminals are node-pty processes in the main process, so they survive page reloads and closing the window. They end when the app quits, and Pulse asks first if any are still running. Each one runs your login shell (`$SHELL -il`) with the environment your login shell gives. That environment is resolved once at startup, because apps opened from Finder get a bare PATH. Terminals also get `TERM=xterm-256color`, `COLORTERM=truecolor` and `PULSE_TERM_ID=tN`. A "claude" terminal types `claude` into the shell once the shell is ready, so when Claude exits you're back at a prompt in the same folder. Each terminal keeps about 500 KB of scrollback. Output reaches the page in batches, one IPC message about every 8 ms.
- **Menu.** Terminal → New Claude Terminal (⌘T) and Show/Hide Terminals (⌘J) are sent to the page as `onMenu("new-terminal" | "toggle-terminal")`. The Edit menu makes copy and paste work in inputs and terminals. View has reload, dev tools and zoom.

## Page bridge (`window.pulseDesktop`, from preload.js)

```js
{
  platform: "darwin",
  term: {
    create({ cwd, command: "claude" | "shell", cols, rows }) → Promise<{ id, cwd, command, title }>,
    list() → Promise<Array<{ id, cwd, command, title, alive }>>,
    buffer(id) → Promise<string>,        // all output delivered so far; later onData events are new
    write(id, data), resize(id, cols, rows), kill(id),
    onData((id, data) => void) → unsubscribe,
    onExit((id, code) => void) → unsubscribe,   // an exited terminal stays in list() (alive: false) until kill(id)
  },
  pickFolder() → Promise<string | null>,
  onMenu((action) => void) → unsubscribe,
}
```

Ids are `t1`, `t2`, … and a title looks like `pulse · claude`. The bridge only answers pages served by the Pulse server. The preload also adds the `desktop` class to `<html>`.

## Known limits

- **Ad-hoc signed, not notarized.** A build you made yourself, or one installed by `install.sh`, opens normally. A copy downloaded in a browser or AirDropped is quarantined: allow it once in System Settings → Privacy & Security → Open Anyway, or run `xattr -dr com.apple.quarantine /Applications/Pulse.app`. Notarizing needs a paid Apple Developer account.
- **Opening it from Claude Code's or VS Code's shell.** Those shells export `ELECTRON_RUN_AS_NODE=1`, and `open` passes it on to the app, which then exits right away as plain Node. Use `env -u ELECTRON_RUN_AS_NODE open -a Pulse`. Finder, the Dock, Spotlight and Pulse's own terminals are not affected.
- **Updates.** The app runs the plugin's server when the plugin is installed (the hook records its folder in `~/.pulse/plugin-root`), and replaces a stale server it finds running. The server restarts itself when `server.js` changes, and open pages reload when a page file changes, so page and server changes need no rebuild. Only app shell changes (`main.js`, `preload.js`, the icon, Electron) do: quit Pulse, then `npm run install-app` builds it, installs `/Applications/Pulse.app`, and removes the build copy so there is only one Pulse to pin. It only replaces an existing `/Applications/Pulse.app` whose bundle id matches `build.appId` in `package.json`; anything else stops the install. Page data (settings, layout) lives in `~/Library/Application Support/Pulse` and survives reinstalls. The copy bundled in the app is only used where the plugin isn't installed.
- **node-pty must stay prebuilt.** Keep `npmRebuild: false` and never run `electron-rebuild`, since nothing can be compiled on a Mac without Xcode. The `postinstall` script and `scripts/after-pack.js` make node-pty's `spawn-helper` executable. Without that, every terminal fails with `posix_spawnp failed`.
