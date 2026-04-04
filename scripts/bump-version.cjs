// Increments the patch version in package.json.
// Preserves pre-release suffixes: "1.0.0-alpha.1" → "1.0.1-alpha.1".
// Called automatically by the pre-commit git hook.
'use strict';

const fs = require('fs');
const path = require('path');

const pkgPath = path.resolve(__dirname, '..', 'package.json');

let pkg;
try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
} catch (err) {
    process.stderr.write(`bump-version: cannot read package.json: ${err.message}\n`);
    process.exit(1);
}

const match = pkg.version.match(/^(\d+)\.(\d+)\.(\d+)/);
if (!match) {
    process.stderr.write(`bump-version: unrecognized version format "${pkg.version}"\n`);
    process.exit(1);
}

const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
pkg.version = pkg.version.replace(/^\d+\.\d+\.\d+/, `${major}.${minor}.${patch + 1}`);

try {
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
} catch (err) {
    process.stderr.write(`bump-version: cannot write package.json: ${err.message}\n`);
    process.exit(1);
}

process.stdout.write(`version → ${pkg.version}\n`);
