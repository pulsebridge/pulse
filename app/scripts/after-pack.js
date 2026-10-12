// electron-builder afterPack hook: node-pty's prebuilt spawn-helper must be executable inside the unpacked asar,
// or every terminal fails with "posix_spawnp failed". (No native rebuild happens: npmRebuild is off.)
const fs = require("node:fs");
const path = require("node:path");

exports.default = async function afterPack(context) {
    const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
    const prebuilds = path.join(app, "Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds");
    let fixed = 0;
    for (const dir of fs.existsSync(prebuilds) ? fs.readdirSync(prebuilds) : []) {
        const helper = path.join(prebuilds, dir, "spawn-helper");
        if (fs.existsSync(helper)) {
            fs.chmodSync(helper, 0o755);
            fixed++;
        }
    }
    if (!fixed) throw new Error(`node-pty spawn-helper not found under ${prebuilds}`);
    console.log(`  • afterPack: spawn-helper executable (${fixed})`);
};
