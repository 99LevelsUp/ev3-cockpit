// Copies all files from hooks/ into the repository's hooks folder and makes them executable.
// Runs automatically via the "prepare" npm script after npm install / npm ci.
//
// The hooks folder is asked of git rather than assumed at .git/hooks: in a worktree .git is a
// file pointing at the main repository, whose hooks the worktree shares, and `npm ci` there
// failed on this script. Outside a git repository there is nothing to install into; that is
// said, not failed, so installing the package does not break.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const srcDir = path.join(root, 'hooks');

let dstDir;
try {
    const out = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], { cwd: root, encoding: 'utf8' }).trim();
    dstDir = path.resolve(root, out);
} catch {
    process.stdout.write('install-hooks: not a git repository; no hooks installed.\n');
    process.exit(0);
}

fs.mkdirSync(dstDir, { recursive: true });
for (const file of fs.readdirSync(srcDir)) {
    const src = path.join(srcDir, file);
    const dst = path.join(dstDir, file);
    fs.copyFileSync(src, dst);
    fs.chmodSync(dst, 0o755);
    process.stdout.write(`installed: ${path.relative(root, dst)}\n`);
}
