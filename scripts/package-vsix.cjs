/**
 * Builds a platform VSIX: the extension and the native daemon built for that platform.
 *
 *   node scripts/package-vsix.cjs                         this machine's platform
 *   node scripts/package-vsix.cjs linux-arm64             another platform (see below)
 *   node scripts/package-vsix.cjs --daemon-dir <dir>      the daemon and its manifest from <dir>
 *   node scripts/package-vsix.cjs --skip-build            reuse out/extension.js
 *
 * The daemon is not built here: a published one is built with EV3_COCKPIT_RELEASE_BUILD=1 and
 * given its manifest in the same environment (`npm run daemon:build:release`, or the release job
 * of .github/workflows/native-daemon.yml). By default it is taken from where cargo puts it,
 * `daemon/target/release` for this machine's platform and `daemon/target/<triple>/release` for
 * another (CARGO_TARGET_DIR moves both, as for cargo).
 *
 * For the target, a staging folder gets the extension's own files (an allow-list, never the
 * repository), the daemon and its manifest in its root, and on Linux the udev rules; `vsce` packs
 * it; the VSIX is opened again and checked against the rules in packaging.cjs: exactly one daemon,
 * the one its manifest records, a release build at the package's version, executable on Linux,
 * and nothing else. A check that fails stops the build.
 *
 * A Linux VSIX is packed on Linux: vsce keeps each file's mode, and a file packed on Windows has
 * no executable bit, which the check refuses.
 *
 * The VSIXes land in dist-vsix/; the staging folder stays in .vsix-staging/<target>/, where the
 * smoke (`node scripts/daemon-smoke.cjs --daemon-dir .vsix-staging/<target>`) can start its daemon.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { TARGETS, DAEMON_MANIFEST, SHIPPED_FILES_FOR, daemonBinary, readZip, checkVsix } = require('./packaging.cjs');

const REPO = path.resolve(__dirname, '..');
const STAGING = path.join(REPO, '.vsix-staging');
const OUT = path.join(REPO, 'dist-vsix');

function run(command, args, cwd) {
	// A shell would split node's path at the space in "Program Files".
	const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
	if (result.status !== 0) { throw new Error(`${command} ${args.join(' ')} failed in ${cwd} (exit ${result.status}).`); }
}

/** This machine's target, or undefined when no release ships for it. */
function hostTarget() {
	const target = `${process.platform}-${process.arch}`;
	return TARGETS[target] ? target : undefined;
}

/** Where cargo puts a release build of the daemon for a target. */
function defaultDaemonDir(target) {
	const targetDir = path.resolve(REPO, 'daemon', process.env.CARGO_TARGET_DIR || 'target');
	return target === hostTarget() ? path.join(targetDir, 'release') : path.join(targetDir, TARGETS[target].triple, 'release');
}

function stage(target, manifest, daemonDir) {
	const dir = path.join(STAGING, target);
	fs.rmSync(dir, { recursive: true, force: true });
	fs.mkdirSync(dir, { recursive: true });

	for (const file of SHIPPED_FILES_FOR(target)) {
		const from = path.join(REPO, file);
		if (!fs.existsSync(from)) { throw new Error(`${file} is missing; build first (npm run bundle).`); }
		fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
		fs.copyFileSync(from, path.join(dir, file));
	}
	const binary = daemonBinary(target);
	for (const file of [binary, DAEMON_MANIFEST]) {
		const from = path.join(daemonDir, file);
		if (!fs.existsSync(from)) {
			throw new Error(`${from} is missing; build the daemon for ${target} with EV3_COCKPIT_RELEASE_BUILD=1 and write its manifest (npm run daemon:build:release).`);
		}
		fs.copyFileSync(from, path.join(dir, file));
	}
	if (TARGETS[target].os !== 'win32') { fs.chmodSync(path.join(dir, binary), 0o755); }

	// The extension has no dependencies once bundled: the VSIX carries no node_modules.
	const staged = { ...manifest };
	delete staged.dependencies;
	delete staged.devDependencies;
	delete staged.optionalDependencies;
	delete staged.scripts;
	fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(staged, null, '\t')}\n`);
	fs.writeFileSync(path.join(dir, '.vscodeignore'), '.vscodeignore\n');
	return dir;
}

function pack(target, dir, version) {
	fs.mkdirSync(OUT, { recursive: true });
	const vsix = path.join(OUT, `ev3-cockpit-${target}-${version}.vsix`);
	fs.rmSync(vsix, { force: true });
	run(process.execPath, [path.join(REPO, 'node_modules', '@vscode', 'vsce', 'vsce'), 'package',
		'--target', target, '--no-dependencies', '--out', vsix], dir);
	return vsix;
}

function verify(target, vsix, version) {
	const entries = readZip(fs.readFileSync(vsix));
	const { missing, unexpected, problems } = checkVsix(target, entries, version);
	if (missing.length || unexpected.length || problems.length) {
		throw new Error(`${path.basename(vsix)} is wrong.\n  missing: ${missing.join(', ') || '-'}\n  unexpected: ${unexpected.slice(0, 20).join(', ') || '-'}\n  ${problems.join('\n  ') || ''}`);
	}
	const megabytes = (fs.statSync(vsix).size / 1024 / 1024).toFixed(1);
	console.log(`${path.basename(vsix)}: ${entries.length} files, ${megabytes} MB, checked.`);
}

function main() {
	const args = process.argv.slice(2);
	const skipBuild = args.includes('--skip-build');
	const at = args.indexOf('--daemon-dir');
	const daemonDir = at >= 0 ? args[at + 1] : undefined;
	if (at >= 0 && !daemonDir) { throw new Error('--daemon-dir needs a folder.'); }
	const targets = args.filter((arg, i) => !arg.startsWith('--') && (at < 0 || i !== at + 1));
	for (const target of targets) {
		if (!TARGETS[target]) { throw new Error(`Unknown target ${target}; known: ${Object.keys(TARGETS).join(', ')}.`); }
	}
	const chosen = targets.length ? targets : [hostTarget()];
	if (!chosen[0]) { throw new Error(`No release ships for ${process.platform}-${process.arch}; name a target: ${Object.keys(TARGETS).join(', ')}.`); }
	if (daemonDir && chosen.length > 1) { throw new Error('--daemon-dir holds one platform\'s daemon; name one target.'); }
	if (!skipBuild) { run(process.execPath, [path.join(REPO, 'scripts', 'bundle.cjs'), 'extension'], REPO); }
	const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
	for (const target of chosen) {
		const dir = stage(target, manifest, path.resolve(daemonDir ?? defaultDaemonDir(target)));
		verify(target, pack(target, dir, manifest.version), manifest.version);
	}
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
