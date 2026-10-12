// Renders build/icon.svg to an .iconset of transparent PNGs (run with Electron: `electron scripts/render-icon.js <out-dir>`).
// qlmanage flattens SVGs onto white, so this draws the SVG onto a canvas in a hidden window instead.
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const svg = fs.readFileSync(path.join(__dirname, "..", "build", "icon.svg"), "utf8");
const out = process.argv[process.argv.length - 1];
const SIZES = [
    ["icon_16x16.png", 16], ["icon_16x16@2x.png", 32],
    ["icon_32x32.png", 32], ["icon_32x32@2x.png", 64],
    ["icon_128x128.png", 128], ["icon_128x128@2x.png", 256],
    ["icon_256x256.png", 256], ["icon_256x256@2x.png", 512],
    ["icon_512x512.png", 512], ["icon_512x512@2x.png", 1024],
];

app.dock?.hide();
app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, width: 200, height: 200, webPreferences: { sandbox: true, contextIsolation: true } });
    await win.loadURL("data:text/html,<body></body>");
    const src = "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");
    const urls = await win.webContents.executeJavaScript(`(async () => {
        const img = new Image();
        img.src = ${JSON.stringify(src)};
        await img.decode();
        const render = (n) => {
            const c = document.createElement("canvas");
            c.width = c.height = n;
            const g = c.getContext("2d");
            g.imageSmoothingQuality = "high";
            g.drawImage(img, 0, 0, n, n);
            return c.toDataURL("image/png");
        };
        return ${JSON.stringify(SIZES)}.map(([name, n]) => [name, render(n)]);
    })()`);
    fs.mkdirSync(out, { recursive: true });
    for (const [name, url] of urls) fs.writeFileSync(path.join(out, name), Buffer.from(url.split(",")[1], "base64"));
    console.log(`wrote ${urls.length} icons to ${out}`);
    app.quit();
});
