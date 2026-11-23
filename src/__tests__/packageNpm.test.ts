/**
 * The npm packages: `scripts/package-npm.mts` stages `@ev3-cockpit/client`, `ev3-cockpit` and one
 * `@ev3-cockpit/<platform>` package per platform, all at the root version. The client carries no
 * native module; the cockpit carries the `ev3` launcher and takes the platform packages as optional
 * dependencies, of which npm installs the one whose `os` and `cpu` match; each platform package
 * carries that platform's native `ev3`, its daemon and the manifest recording the daemon's SHA-256.
 *
 * The launcher is bundled here, into a temporary folder, and the binaries are stand-ins with a
 * manifest of their own: the real ones are built per platform in CI and checked by the same rules.
 * Where cargo built the native `ev3` for this computer, the launcher is run against it.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { PLATFORMS, nativeEv3, platformPackage } from '../npm/ev3';

interface Staged { client: string; cockpit: string; version: string }
interface PackageNpm {
	CLIENT_NAME: string;
	COCKPIT_NAME: string;
	platformPackageName(target: string): string;
	requiredModules(source: string): string[];
	stageNpm(options: { out: string; bundles: string }): Staged;
	stagePlatform(out: string, root: Manifest, target: string, options: { daemonDir: string; checkMode?: boolean }): string;
}
interface Manifest {
	name: string;
	version: string;
	main?: string;
	types?: string;
	bin?: Record<string, string>;
	os?: string[];
	cpu?: string[];
	files?: string[];
	dependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
}

const REPO = path.join(__dirname, '..', '..');
/* eslint-disable @typescript-eslint/no-var-requires */
const npm = require(path.join(REPO, 'scripts', 'package-npm.mts')) as PackageNpm;
const { bundle } = require(path.join(REPO, 'scripts', 'bundle.mts')) as { bundle(options: { names: string[]; outDir: string }): void };
const packaging = require(path.join(REPO, 'scripts', 'packaging.mts')) as {
	TARGETS: Record<string, { os: string; cpu: string }>; NATIVE_MODULES: string[]; UDEV_RULES: string[]; DAEMON_MANIFEST: string;
	daemonBinary(target: string): string;
	cliBinary(target: string): string;
};
/* eslint-enable @typescript-eslint/no-var-requires */

const read = (file: string): Manifest => JSON.parse(fs.readFileSync(file, 'utf8')) as Manifest;
const ROOT = read(path.join(REPO, 'package.json'));
const TARGETS = Object.keys(packaging.TARGETS);
const HOST = `${process.platform}-${process.arch}`;
/** The native `ev3` cargo built for this computer (npm run daemon:build), when it did. */
const BUILT_EV3 = path.join(REPO, 'daemon', 'target', 'debug', process.platform === 'win32' ? 'ev3.exe' : 'ev3');
const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

function filesUnder(dir: string, suffix: string): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) { return filesUnder(full, suffix); }
		return entry.name.endsWith(suffix) ? [full] : [];
	});
}

/** A built daemon and `ev3` for `target` in a folder of their own, with the manifest a release build gets. */
function standInDaemon(work: string, target: string, overrides: Record<string, unknown> = {}, data = `daemon for ${target}`): string {
	const dir = fs.mkdtempSync(path.join(work, `daemon-${target}-`));
	const binary = packaging.daemonBinary(target);
	fs.writeFileSync(path.join(dir, binary), data);
	fs.writeFileSync(path.join(dir, packaging.cliBinary(target)), `ev3 for ${target}`);
	fs.writeFileSync(path.join(dir, packaging.DAEMON_MANIFEST),
		JSON.stringify({ binary, sha256: sha256(data), version: ROOT.version, buildKind: 'release', ...overrides }));
	return dir;
}

/** A Rust constant of the transports: the path the daemon's advice names. */
function rustConstant(file: string, name: string): string {
	const source = fs.readFileSync(path.join(REPO, 'daemon', 'crates', 'transports', 'src', file), 'utf8');
	const value = new RegExp(`pub const ${name}: &str = "([^"]+)";`).exec(source)?.[1];
	assert.ok(value, `${file} declares ${name}`);
	return value;
}

describe('npm packages', () => {
	let work: string;
	let bundles: string;
	let staged: Staged;
	const platforms: Record<string, string> = {};

	before(() => {
		work = fs.mkdtempSync(path.join(os.tmpdir(), 'ev3-cockpit-npm-'));
		bundles = path.join(work, 'bundles');
		// esbuild takes every core by default, at the moment the other test files start their daemons,
		// whose timing tests then fail; one core is enough for one bundle.
		process.env.GOMAXPROCS = '1';
		bundle({ names: ['ev3'], outDir: bundles });
		staged = npm.stageNpm({ out: path.join(work, 'npm'), bundles });
		for (const target of TARGETS) {
			platforms[target] = npm.stagePlatform(path.join(work, 'npm'), ROOT, target, { daemonDir: standInDaemon(work, target) });
		}
	});

	after(() => {
		if (work) { fs.rmSync(work, { recursive: true, force: true }); }
	});

	it('stages every package at the root package.json version', () => {
		assert.equal(read(path.join(staged.client, 'package.json')).name, npm.CLIENT_NAME);
		assert.equal(read(path.join(staged.cockpit, 'package.json')).name, npm.COCKPIT_NAME);
		for (const dir of [staged.client, staged.cockpit, ...Object.values(platforms)]) {
			assert.equal(read(path.join(dir, 'package.json')).version, ROOT.version, dir);
		}
	});

	it('the client package is the contract and the library with their types, and no native module', () => {
		const client = read(path.join(staged.client, 'package.json'));
		assert.ok(client.main && fs.existsSync(path.join(staged.client, client.main)), 'main');
		assert.ok(client.types && fs.existsSync(path.join(staged.client, client.types)), 'types');
		assert.ok(fs.existsSync(path.join(staged.client, 'contract', 'generated', 'index.d.ts')), 'the contract, typed');
		const declared = { ...client.dependencies, ...client.optionalDependencies, ...client.peerDependencies };
		for (const native of packaging.NATIVE_MODULES) { assert.ok(!(native in declared), `declares ${native}`); }
		// What its code requires, not only what its manifest says.
		const required = new Set(filesUnder(staged.client, '.js').flatMap((file) => npm.requiredModules(fs.readFileSync(file, 'utf8'))));
		assert.deepEqual([...required].sort(), Object.keys(client.dependencies ?? {}).sort(), 'it declares exactly what it requires');
		for (const native of packaging.NATIVE_MODULES) { assert.ok(!required.has(native), `requires ${native}`); }
	});

	it('the cockpit package names its one executable and takes exactly the platform packages, at its own version', () => {
		const cockpit = read(path.join(staged.cockpit, 'package.json'));
		assert.deepEqual(cockpit.bin, { ev3: 'bin/ev3.js' });
		assert.ok(fs.readFileSync(path.join(staged.cockpit, 'bin', 'ev3.js'), 'utf8').startsWith('#!/usr/bin/env node\n'), 'bin/ev3.js runs from a shell');
		assert.equal(cockpit.dependencies, undefined, 'everything is inlined in the launcher');
		assert.deepEqual(cockpit.optionalDependencies, Object.fromEntries(TARGETS.map((target) => [`@ev3-cockpit/${target}`, ROOT.version])));
		// The packages the launcher resolves at run time are the ones the package installs.
		assert.deepEqual([...PLATFORMS].sort(), [...TARGETS].sort());
		for (const target of TARGETS) {
			const [platform, arch] = target.split('-');
			assert.equal(platformPackage(platform, arch), npm.platformPackageName(target));
		}
	});

	it('carries no Node native module, no binary and no daemon of its own: only the launcher', () => {
		const files = filesUnder(staged.cockpit, '').map((file) => path.relative(staged.cockpit, file).split(path.sep).join('/')).sort();
		assert.deepEqual(files, ['LICENSE', ...packaging.UDEV_RULES, 'bin/ev3.js', 'package.json'].sort());
		assert.deepEqual(npm.requiredModules(fs.readFileSync(path.join(staged.cockpit, 'bin', 'ev3.js'), 'utf8')), [], 'bin/ev3.js requires nothing');
		for (const dir of Object.values(platforms)) {
			const manifest = read(path.join(dir, 'package.json'));
			assert.equal(manifest.dependencies, undefined);
			assert.equal(manifest.optionalDependencies, undefined);
		}
	});

	it('the launcher runs its own entry and no other module\'s', () => {
		// A second `require.main === module` in the bundle would start that module's main too.
		const source = fs.readFileSync(path.join(staged.cockpit, 'bin', 'ev3.js'), 'utf8');
		assert.equal(source.split('require.main === module').length - 1, 1, 'bin/ev3.js');
	});

	it('carries the udev rules at the paths the daemon\'s messages name', () => {
		for (const [file, name] of [['usb/mod.rs', 'LINUX_UDEV_RULE_PATH'], ['bt_linux/radio_watch.rs', 'LINUX_BT_RESTART_RULE_PATH']]) {
			const rule = rustConstant(file, name);
			assert.ok(fs.existsSync(path.join(staged.cockpit, rule)), `ev3-cockpit carries ${rule}`);
		}
	});

	it('each platform package carries its ev3, its daemon and the manifest, and npm installs it only on its platform', () => {
		for (const target of TARGETS) {
			const dir = platforms[target];
			const manifest = read(path.join(dir, 'package.json'));
			const binary = packaging.daemonBinary(target);
			const cli = packaging.cliBinary(target);
			assert.equal(manifest.name, `@ev3-cockpit/${target}`);
			assert.deepEqual([manifest.os, manifest.cpu], [[packaging.TARGETS[target].os], [packaging.TARGETS[target].cpu]]);
			assert.deepEqual(manifest.files, [cli, binary, packaging.DAEMON_MANIFEST]);
			// ev3 finds the daemon beside itself.
			assert.ok(fs.existsSync(path.join(dir, cli)), `${target}: ${cli}`);
			const daemon = JSON.parse(fs.readFileSync(path.join(dir, packaging.DAEMON_MANIFEST), 'utf8')) as { binary: string; sha256: string };
			assert.equal(daemon.binary, binary);
			assert.equal(daemon.sha256, sha256(fs.readFileSync(path.join(dir, binary))), `${target}: the manifest records the binary's SHA-256`);
			if (process.platform !== 'win32' && packaging.TARGETS[target].os !== 'win32') {
				assert.equal(fs.statSync(path.join(dir, binary)).mode & 0o111, 0o111, `${target}: the daemon is executable`);
				assert.equal(fs.statSync(path.join(dir, cli)).mode & 0o111, 0o111, `${target}: ev3 is executable`);
			}
		}
	});

	it('refuses to stage a daemon its manifest does not describe: another hash, version or build kind', () => {
		const out = path.join(work, 'refused');
		const stage = (dir: string, target = HOST in packaging.TARGETS ? HOST : 'linux-x64'): void => { npm.stagePlatform(out, ROOT, target, { daemonDir: dir }); };
		assert.throws(() => stage(standInDaemon(work, 'linux-x64', { sha256: sha256('another build') }), 'linux-x64'), /SHA-256 .* records/);
		assert.throws(() => stage(standInDaemon(work, 'win32-x64', { version: '0.0.0' }), 'win32-x64'), /version 0\.0\.0; the package is/);
		assert.throws(() => stage(standInDaemon(work, 'linux-arm64', { buildKind: 'development' }), 'linux-arm64'), /development build/);
		assert.throws(() => stage(path.join(work, 'no-such-dir'), 'win32-x64'), /is missing; build the daemon and ev3 for win32-x64 with EV3_COCKPIT_RELEASE_BUILD=1/);
		const withoutEv3 = standInDaemon(work, 'win32-x64');
		fs.rmSync(path.join(withoutEv3, packaging.cliBinary('win32-x64')));
		assert.throws(() => stage(withoutEv3, 'win32-x64'), /ev3\.exe is missing/);
	});

	describe('the launcher when installed', () => {
		/** An npm install of ev3-cockpit, with the platform package for `target` beside it or not. */
		function install(name: string, target?: string): string {
			const modules = path.join(work, name, 'node_modules');
			fs.cpSync(staged.cockpit, path.join(modules, 'ev3-cockpit'), { recursive: true });
			if (target) { fs.cpSync(platforms[target], path.join(modules, '@ev3-cockpit', target), { recursive: true }); }
			return path.join(modules, 'ev3-cockpit', 'bin', 'ev3.js');
		}
		/** Resolves as Node does from the installed launcher. */
		const resolverFor = (launcher: string) => (id: string): string => require.resolve(id, { paths: [path.dirname(launcher)] });

		it('resolves the package for the platform it runs on, never another one beside it', () => {
			const launcher = install('two-platforms', 'linux-arm64');
			fs.cpSync(platforms['linux-x64'], path.join(launcher, '..', '..', '..', '@ev3-cockpit', 'linux-x64'), { recursive: true });
			const modules = path.join(launcher, '..', '..', '..');
			assert.deepEqual(nativeEv3('linux', 'arm64', resolverFor(launcher)), { binary: path.join(modules, '@ev3-cockpit', 'linux-arm64', 'ev3') });
			assert.deepEqual(nativeEv3('linux', 'x64', resolverFor(launcher)), { binary: path.join(modules, '@ev3-cockpit', 'linux-x64', 'ev3') });
		});

		it('refuses a missing platform package, and a platform with none, saying what to do', () => {
			const launcher = install('without-platform');
			const missing = nativeEv3('linux', 'x64', resolverFor(launcher));
			assert.ok('problem' in missing && /@ev3-cockpit\/linux-x64 is not installed: install ev3-cockpit again, without --no-optional/.test(missing.problem), JSON.stringify(missing));
			const none = nativeEv3('darwin', 'arm64', resolverFor(launcher));
			assert.ok('problem' in none && /no ev3 for darwin-arm64; it ships for win32-x64, linux-x64, linux-arm64/.test(none.problem), JSON.stringify(none));
		});

		it('ends with exit code 8 and says why when this computer has no ev3 installed', () => {
			const run = spawnSync(process.execPath, [install('launcher-without-platform'), '--version'], { encoding: 'utf8', timeout: 20_000 });
			assert.equal(run.status, 8, run.stderr);
			assert.match(run.stderr, /ev3: (@ev3-cockpit\/\S+ is not installed|EVƎ Cockpit has no ev3 for)/);
		});

		it('runs the native ev3 with the arguments it was given and ends with its exit code', { skip: !(HOST in packaging.TARGETS && fs.existsSync(BUILT_EV3)) && 'cargo built no ev3 for this computer (npm run daemon:build)' }, () => {
			const launcher = install('launcher-native', HOST);
			fs.copyFileSync(BUILT_EV3, path.join(launcher, '..', '..', '..', '@ev3-cockpit', HOST, packaging.cliBinary(HOST)));
			const version = spawnSync(process.execPath, [launcher, '--version'], { encoding: 'utf8', timeout: 20_000 });
			assert.equal(version.status, 0, version.stderr);
			assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+/);
			// A usage error never reaches a daemon: its exit code 2 comes through unchanged.
			const usage = spawnSync(process.execPath, [launcher, 'list', '--no-such-option'], { encoding: 'utf8', timeout: 20_000 });
			assert.equal(usage.status, 2, usage.stderr);
			assert.match(usage.stderr, /Unknown option --no-such-option/);
		});
	});
	it('counts a require only where it is a call, not inside generated code\'s strings', () => {
		const source = 'var a = require("fs"); var b = __require("usb"); var c = require("vscode-jsonrpc/node");\n'
			+ 'x.code = \'require("ajv/dist/runtime/uri").default\'; y = _`require("ajv-formats/dist/formats")`; z = require("@scope/pkg/deep");';
		assert.deepEqual(npm.requiredModules(source), ['@scope/pkg', 'usb', 'vscode-jsonrpc']);
	});
});
