'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const dir = path.join(__dirname, '..', 'out', '__tests__');
const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.test.js'))
    .map(f => path.join(dir, f));

if (files.length === 0) {
    process.stderr.write('run-unit-tests: no test files found in out/__tests__\n');
    process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
