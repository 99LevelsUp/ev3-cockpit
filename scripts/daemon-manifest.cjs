'use strict';
/**
 * Writes the manifest of a build of the native daemon beside its binary,
 * `ev3-cockpitd.manifest.json`: the binary's file name, its SHA-256, its version and its build
 * kind. A client starts only a copy of the binary whose hash matches the manifest, so it is written
 * after each cargo build; `npm run daemon:build` does both.
 *
 * - The binary is found where cargo put it: `<target dir>/[<triple>/]<profile>/`. The target dir is
 *   daemon/target, or CARGO_TARGET_DIR as cargo reads it (relative to daemon/, where the build runs).
 * - The version is the repository's package.json version, the one the daemon's build compiles in.
 * - The build kind is release only when EV3_COCKPIT_RELEASE_BUILD=1, the variable the daemon's own
 *   build reads; run both steps in the same environment.
 *
 * usage: node scripts/daemon-manifest.cjs [--profile debug|release] [--target <triple>]
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MANIFEST = 'ev3-cockpitd.manifest.json';
const root = path.join(__dirname, '..');
const USAGE = 'usage: node scripts/daemon-manifest.cjs [--profile debug|release] [--target <triple>]';

function fail(message) {
	process.stderr.write(`daemon-manifest: ${message}\n`);
	process.exit(1);
}

/** The daemon's file name for a target triple, or for this machine without one. */
function binaryName(triple) {
	const windows = triple ? triple.includes('-windows-') : process.platform === 'win32';
	return windows ? 'ev3-cockpitd.exe' : 'ev3-cockpitd';
}

const args = process.argv.slice(2);
let profile = 'debug';
let triple;
for (let i = 0; i < args.length; i++) {
	if (args[i] === '--profile' && (args[i + 1] === 'debug' || args[i + 1] === 'release')) {
		profile = args[++i];
	} else if (args[i] === '--target' && /^[a-z0-9_]+(-[a-z0-9_]+){2,3}(\.[0-9.]+)?$/.test(args[i + 1] ?? '')) {
		// cargo zigbuild takes a glibc suffix (`x86_64-unknown-linux-gnu.2.35`) and builds into the plain triple.
		triple = args[++i].replace(/\.[0-9.]+$/, '');
	} else {
		fail(`not understood: ${args[i]}\n${USAGE}`);
	}
}

const targetDir = path.resolve(root, 'daemon', process.env.CARGO_TARGET_DIR || 'target');
const dir = path.join(targetDir, ...(triple ? [triple] : []), profile);
const binary = binaryName(triple);
const file = path.join(dir, binary);
if (!fs.existsSync(file)) { fail(`${file} is missing; build it with cargo build -p ev3-cockpitd in daemon/ first.`); }

const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
if (typeof version !== 'string' || version.length === 0) { fail('package.json has no version.'); }

const manifest = {
	binary,
	sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
	version,
	buildKind: process.env.EV3_COCKPIT_RELEASE_BUILD === '1' ? 'release' : 'development',
};
const target = path.join(dir, MANIFEST);
const temp = `${target}.${process.pid}.tmp`;
fs.writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`);
fs.renameSync(temp, target);
process.stdout.write(`${target}: ${manifest.sha256} ${manifest.version} ${manifest.buildKind}\n`);
