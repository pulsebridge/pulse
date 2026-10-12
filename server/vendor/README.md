# Vendored browser libraries

Copied unmodified from the npm packages below (UMD builds), except that the trailing
`//# sourceMappingURL=` comment was removed from each `.js` file because the source maps are not shipped.
`terminal.js` loads these on first use from `/vendor/`.

| File | Package | Version | License |
| --- | --- | --- | --- |
| `xterm.js`, `xterm.css` | [@xterm/xterm](https://github.com/xtermjs/xterm.js) (`lib/xterm.js`, `css/xterm.css`) | 6.0.0 | MIT |
| `addon-fit.js` | [@xterm/addon-fit](https://github.com/xtermjs/xterm.js/tree/master/addons/addon-fit) (`lib/addon-fit.js`) | 0.11.0 | MIT |
| `addon-web-links.js` | [@xterm/addon-web-links](https://github.com/xtermjs/xterm.js/tree/master/addons/addon-web-links) (`lib/addon-web-links.js`) | 0.12.0 | MIT |

To update: `npm pack @xterm/xterm @xterm/addon-fit @xterm/addon-web-links`, extract, copy the same files, and strip the source-map comments again.

## License notices

@xterm/xterm 6.0.0:

    Copyright (c) 2017-2019, The xterm.js authors (https://github.com/xtermjs/xterm.js)
    Copyright (c) 2014-2016, SourceLair Private Company (https://www.sourcelair.com)
    Copyright (c) 2012-2013, Christopher Jeffrey (https://github.com/chjj/)

@xterm/addon-fit 0.11.0:

    Copyright (c) 2019, The xterm.js authors (https://github.com/xtermjs/xterm.js)

@xterm/addon-web-links 0.12.0:

    Copyright (c) 2017, The xterm.js authors (https://github.com/xtermjs/xterm.js)

All three are released under the MIT License:

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in
    all copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
    THE SOFTWARE.

## Monaco editor

`monaco/` holds [monaco-editor](https://github.com/microsoft/monaco-editor) **0.57.0** (MIT), used by `workspace.js` for the
file editor and the side-by-side diffs. Only the minified AMD build is vendored: the package's `min/vs` folder copied as
`monaco/vs/`, plus its `LICENSE` and `ThirdPartyNotices.txt` next to it. The one change is that the trailing
`//# sourceMappingURL=../../min-maps/vs/loader.js.map` line was removed from `vs/loader.js` (the maps are not shipped;
the other `sourceMappingURL` strings in `ts.worker` are string literals inside the TypeScript compiler, not comments).

`workspace.js` loads it on first use with `/vendor/monaco/vs/loader.js` and
`require.config({ paths: { vs: "/vendor/monaco/vs" } })`. `editor.main.js` pulls in its own stylesheet and starts its web
workers from the same origin (a small `blob:` bootstrap that `importScripts` the files in `vs/assets/`), so the server has
to serve the nested `vendor/monaco/vs/**` paths (`.js` and `.css`).

To update: `npm pack monaco-editor`, extract, replace `monaco/vs` with the package's `min/vs`, copy `LICENSE` and
`ThirdPartyNotices.txt`, and strip the source-map comment from `vs/loader.js` again.

## Geist fonts

`fonts/Geist-Variable.woff2` and `fonts/GeistMono-Variable.woff2` are [Geist](https://github.com/vercel/geist-font) and
Geist Mono by Vercel, copied unmodified from the `geist` npm package **1.7.2** (`dist/fonts/geist-sans/` and
`dist/fonts/geist-mono/`). They are licensed under the SIL Open Font License 1.1; the full text is in `fonts/LICENSE`.
`index.html` declares both with `@font-face`, so the page loads no fonts from outside.
