import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const dir = path.join(import.meta.dirname, '..', 'out', '__tests__');
const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.test.js'))
    .map(f => path.join(dir, f));

if (files.length === 0) {
    process.stderr.write('run-unit-tests: no test files found in out/__tests__\n');
    process.exit(1);
}

const setup = path.join(import.meta.dirname, 'test-setup.mts');
// A test that never settles fails after 30 s instead of holding the whole run (11.11.2026: two
// runs hung on a held promise while a scheduler test was red).
const result = spawnSync(process.execPath, ['--require', setup, '--test', '--test-timeout=30000', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
