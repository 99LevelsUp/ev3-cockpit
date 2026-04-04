'use strict';
const fs = require('fs');
const path = require('path');

const src = path.resolve(__dirname, '..', 'src', '__tests__');
const dst = path.resolve(__dirname, '..', 'out', '__tests__');

if (!fs.existsSync(dst)) {
    fs.mkdirSync(dst, { recursive: true });
}

for (const file of fs.readdirSync(src)) {
    if (file.endsWith('.js')) {
        fs.copyFileSync(path.join(src, file), path.join(dst, file));
        process.stdout.write(`copied: ${file}\n`);
    }
}
