// Copies all files from hooks/ into .git/hooks/ and makes them executable.
// Runs automatically via the "prepare" npm script after npm install / npm ci.
'use strict';

const fs = require('fs');
const path = require('path');

const srcDir = path.resolve(__dirname, '..', 'hooks');
const dstDir = path.resolve(__dirname, '..', '.git', 'hooks');

if (!fs.existsSync(dstDir)) {
    process.stderr.write('install-hooks: .git/hooks not found — not a git repository?\n');
    process.exit(1);
}

for (const file of fs.readdirSync(srcDir)) {
    const src = path.join(srcDir, file);
    const dst = path.join(dstDir, file);
    fs.copyFileSync(src, dst);
    fs.chmodSync(dst, 0o755);
    process.stdout.write(`installed: .git/hooks/${file}\n`);
}
