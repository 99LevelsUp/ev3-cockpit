/**
 * Builds one VSIX per platform (IMPLEMENTATION_PLAN 0.2.5).
 *
 *   node scripts/package-vsix.cjs                       every target in packaging.cjs
 *   node scripts/package-vsix.cjs linux-arm64           one target
 *   node scripts/package-vsix.cjs --skip-build ...      reuse out/extension.js and native/bin
 *
 * It builds the bundle (`npm run bundle`) and, for a Windows VSIX only, the pairing helper, which
 * needs .NET: a Linux machine builds its own VSIX without it.
 *
 * For each target: a staging folder gets the extension's own files (an allow-list, never the
 * repository), the native modules installed for that platform with `npm --os --cpu` (their
 * prebuilt binaries, nothing compiled), other platforms' binaries pruned, and the Windows pairing
 * helper on Windows only; `vsce` packs it; the VSIX is opened again and checked against the rules
 * in packaging.cjs. A check that fails stops the build: a VSIX without its binaries installs
 * cleanly and then has no USB or Bluetooth, which is how this was found.
 *
 * The VSIXes land in dist-vsix/. Building the Linux ones on Windows works: the binaries are
 * prebuilt, and npm fetches the platform package koffi needs.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { TARGETS, NATIVE_MODULES, SHIPPED_FILES, keepPrebuild, listZipEntries, checkVsix } = require('./packaging.cjs');

const REPO = path.resolve(__dirname, '..');
const STAGING = path.join(REPO, '.vsix-staging');
const OUT = path.join(REPO, 'dist-vsix');

function run(command, args, cwd) {
	// npm is a .cmd on Windows and needs a shell; node does not, and a shell would split its path
	// at the space in "Program Files".
	const shell = process.platform === 'win32' && command === 'npm';
	const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell });
	if (result.status !== 0) { throw new Error(`${command} ${args.join(' ')} failed in ${cwd} (exit ${result.status}).`); }
}

/** Removes every prebuilt binary folder that is not this target's, and koffi's other platform packages. */
function prune(dir, target) {
	for (const name of fs.readdirSync(dir)) {
		const full = path.join(dir, name);
		if (!fs.statSync(full).isDirectory()) { continue; }
		if (name === 'prebuilds') {
			// The module is what follows the last node_modules: `usb`, or `@serialport/bindings-cpp`.
			const parts = path.relative(path.join(STAGING, target), dir).split(path.sep);
			const module = parts.slice(parts.lastIndexOf('node_modules') + 1).join('/');
			for (const folder of fs.readdirSync(full)) {
				if (!keepPrebuild(module, folder, target)) { fs.rmSync(path.join(full, folder), { recursive: true, force: true }); }
			}
			continue;
		}
		if (path.basename(dir) === '@koromix' && name.startsWith('koffi-') && name !== `koffi-${target}`) {
			fs.rmSync(full, { recursive: true, force: true });
			continue;
		}
		prune(full, target);
	}
}

function stage(target, manifest) {
	const { os, cpu, helper } = TARGETS[target];
	const dir = path.join(STAGING, target);
	fs.rmSync(dir, { recursive: true, force: true });
	fs.mkdirSync(dir, { recursive: true });

	for (const file of SHIPPED_FILES) {
		const from = path.join(REPO, file);
		if (!fs.existsSync(from)) { throw new Error(`${file} is missing; build first (npm run package).`); }
		fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
		fs.copyFileSync(from, path.join(dir, file));
	}
	if (helper) {
		const bin = path.join(REPO, 'native', 'bin');
		if (!fs.existsSync(path.join(bin, 'bt-pairing-helper.exe'))) { throw new Error('native/bin has no pairing helper; run npm run build:helper.'); }
		fs.mkdirSync(path.join(dir, 'native', 'bin'), { recursive: true });
		for (const file of fs.readdirSync(bin)) {
			if (file.endsWith('.pdb')) { continue; }   // debug symbols do not ship
			fs.copyFileSync(path.join(bin, file), path.join(dir, 'native', 'bin', file));
		}
	}

	// The native modules as dependencies of their own, so npm installs them for the target.
	const staged = { ...manifest };
	delete staged.devDependencies;
	delete staged.optionalDependencies;
	delete staged.scripts;
	// Exactly the versions installed here, which the tests ran against — not the ranges, which would
	// let the VSIX carry a newer release nobody tested.
	staged.dependencies = Object.fromEntries(NATIVE_MODULES.map((name) => {
		const installed = path.join(REPO, 'node_modules', name, 'package.json');
		if (!fs.existsSync(installed)) { throw new Error(`${name} is not installed here; run npm ci.`); }
		return [name, JSON.parse(fs.readFileSync(installed, 'utf8')).version];
	}));
	fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(staged, null, '\t')}\n`);
	fs.writeFileSync(path.join(dir, '.vscodeignore'), '.vscodeignore\n');

	run('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock',
		`--os=${os}`, `--cpu=${cpu}`], dir);
	prune(path.join(dir, 'node_modules'), target);
	return dir;
}

function pack(target, dir, version) {
	fs.mkdirSync(OUT, { recursive: true });
	const vsix = path.join(OUT, `ev3-cockpit-${target}-${version}.vsix`);
	fs.rmSync(vsix, { force: true });
	// The repository's own vsce. It finds the staged modules itself (`npm list --production`): they are
	// the staged package's only dependencies, installed for the target. `--no-dependencies` would drop
	// node_modules altogether.
	run(process.execPath, [path.join(REPO, 'node_modules', '@vscode', 'vsce', 'vsce'), 'package',
		'--target', target, '--skip-license', '--out', vsix], dir);
	return vsix;
}

function verify(target, vsix) {
	const entries = listZipEntries(fs.readFileSync(vsix));
	const { missing, unexpected } = checkVsix(target, entries);
	if (missing.length || unexpected.length) {
		throw new Error(`${path.basename(vsix)} is wrong.\n  missing: ${missing.join(', ') || '-'}\n  unexpected: ${unexpected.slice(0, 20).join(', ') || '-'}`);
	}
	const megabytes = (fs.statSync(vsix).size / 1024 / 1024).toFixed(1);
	console.log(`${path.basename(vsix)}: ${entries.length} files, ${megabytes} MB, checked.`);
}

function main() {
	const args = process.argv.slice(2);
	const skipBuild = args.includes('--skip-build');
	const targets = args.filter((arg) => !arg.startsWith('--'));
	for (const target of targets) {
		if (!TARGETS[target]) { throw new Error(`Unknown target ${target}; known: ${Object.keys(TARGETS).join(', ')}.`); }
	}
	const chosen = targets.length ? targets : Object.keys(TARGETS);
	if (!skipBuild) {
		run('npm', ['run', 'bundle'], REPO);
		// The pairing helper is a Windows program built with .NET: only a Windows VSIX needs it, so a
		// Linux machine can build its own VSIX without .NET.
		if (chosen.some((target) => TARGETS[target].helper)) { run('npm', ['run', 'build:helper'], REPO); }
	}
	const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
	for (const target of chosen) {
		const dir = stage(target, manifest);
		verify(target, pack(target, dir, manifest.version));
	}
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
