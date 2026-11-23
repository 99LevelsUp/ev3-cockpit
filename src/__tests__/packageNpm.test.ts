/**
 * The npm packages: `scripts/package-npm.cjs` stages `@ev3-cockpit/client`, `ev3-cockpit` and one
 * `@ev3-cockpit/<platform>` package per platform, all at the root version. The client carries no
 * native module; the cockpit carries the `ev3` command and the MCP server and takes the platform
 * packages as optional dependencies, of which npm installs the one whose `os` and `cpu` match;
 * each platform package carries that platform's daemon and the manifest recording its SHA-256.
 *
 * The bundles are built here, into a temporary folder, and the daemons are stand-ins with manifests
 * of their own: the real binaries are built per platform in CI and checked by the same rules.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { DAEMON_PACKAGES, installation, platformDaemonDir } from '../cli/installation';
import { DaemonStartError } from '../client/nativeLaunch';

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
const npm = require(path.join(REPO, 'scripts', 'package-npm.cjs')) as PackageNpm;
const { bundle } = require(path.join(REPO, 'scripts', 'bundle.cjs')) as { bundle(options: { names: string[]; outDir: string }): void };
const packaging = require(path.join(REPO, 'scripts', 'packaging.cjs')) as {
	TARGETS: Record<string, { os: string; cpu: string }>; NATIVE_MODULES: string[]; UDEV_RULES: string[]; DAEMON_MANIFEST: string;
	daemonBinary(target: string): string;
};
/* eslint-enable @typescript-eslint/no-var-requires */

const read = (file: string): Manifest => JSON.parse(fs.readFileSync(file, 'utf8')) as Manifest;
const ROOT = read(path.join(REPO, 'package.json'));
const TARGETS = Object.keys(packaging.TARGETS);
const HOST = `${process.platform}-${process.arch}`;
const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

function filesUnder(dir: string, suffix: string): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) { return filesUnder(full, suffix); }
		return entry.name.endsWith(suffix) ? [full] : [];
	});
}

/** A built daemon for `target` in a folder of its own, with the manifest a release build gets. */
function standInDaemon(work: string, target: string, overrides: Record<string, unknown> = {}, data = `daemon for ${target}`): string {
	const dir = fs.mkdtempSync(path.join(work, `daemon-${target}-`));
	const binary = packaging.daemonBinary(target);
	fs.writeFileSync(path.join(dir, binary), data);
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
		// whose timing tests then fail; one core is enough for two bundles.
		process.env.GOMAXPROCS = '1';
		bundle({ names: ['cli', 'mcp'], outDir: bundles });
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

	it('the cockpit package names its two executables and takes exactly the platform packages, at its own version', () => {
		const cockpit = read(path.join(staged.cockpit, 'package.json'));
		assert.deepEqual(cockpit.bin, { ev3: 'out/cli.js', 'ev3-cockpit-mcp': 'out/mcp.js' });
		for (const file of Object.values(cockpit.bin ?? {})) {
			assert.ok(fs.readFileSync(path.join(staged.cockpit, file), 'utf8').startsWith('#!/usr/bin/env node\n'), `${file} runs from a shell`);
		}
		assert.equal(cockpit.dependencies, undefined, 'everything is inlined in the bundles');
		assert.deepEqual(cockpit.optionalDependencies, Object.fromEntries(TARGETS.map((target) => [`@ev3-cockpit/${target}`, ROOT.version])));
		// The names the command resolves at run time are the ones the package installs.
		assert.deepEqual(Object.entries(DAEMON_PACKAGES).sort(), TARGETS.map((target) => [target, npm.platformPackageName(target)]).sort());
	});

	it('carries no Node native module, no Node daemon and no daemon binary of its own', () => {
		const files = filesUnder(staged.cockpit, '').map((file) => path.relative(staged.cockpit, file).split(path.sep).join('/')).sort();
		assert.deepEqual(files, ['LICENSE', ...packaging.UDEV_RULES, 'out/cli.js', 'out/mcp.js', 'package.json'].sort());
		for (const name of ['cli', 'mcp']) {
			const required = npm.requiredModules(fs.readFileSync(path.join(staged.cockpit, 'out', `${name}.js`), 'utf8'));
			assert.deepEqual(required, [], `out/${name}.js requires nothing`);
		}
		for (const dir of Object.values(platforms)) {
			const manifest = read(path.join(dir, 'package.json'));
			assert.equal(manifest.dependencies, undefined);
			assert.equal(manifest.optionalDependencies, undefined);
		}
	});

	it('each bundle runs its own entry and no other module\'s', () => {
		// A second `require.main === module` in a bundle would start that module's main too.
		for (const name of ['cli', 'mcp']) {
			const source = fs.readFileSync(path.join(staged.cockpit, 'out', `${name}.js`), 'utf8');
			assert.equal(source.split('require.main === module').length - 1, 1, `out/${name}.js`);
		}
	});

	it('ev3 --version prints the root version, from the staged package', () => {
		const printed = execFileSync(process.execPath, [path.join(staged.cockpit, 'out', 'cli.js'), '--version'], { encoding: 'utf8', timeout: 20_000 });
		assert.equal(printed.trim(), ROOT.version);
	});

	it('carries the udev rules at the paths the daemon\'s messages name', () => {
		for (const [file, name] of [['usb/mod.rs', 'LINUX_UDEV_RULE_PATH'], ['bt_linux/radio_watch.rs', 'LINUX_BT_RESTART_RULE_PATH']]) {
			const rule = rustConstant(file, name);
			assert.ok(fs.existsSync(path.join(staged.cockpit, rule)), `ev3-cockpit carries ${rule}`);
		}
	});

	it('each platform package carries its daemon and manifest, and npm installs it only on its platform', () => {
		for (const target of TARGETS) {
			const dir = platforms[target];
			const manifest = read(path.join(dir, 'package.json'));
			const binary = packaging.daemonBinary(target);
			assert.equal(manifest.name, `@ev3-cockpit/${target}`);
			assert.deepEqual([manifest.os, manifest.cpu], [[packaging.TARGETS[target].os], [packaging.TARGETS[target].cpu]]);
			assert.deepEqual(manifest.files, [binary, packaging.DAEMON_MANIFEST]);
			const daemon = JSON.parse(fs.readFileSync(path.join(dir, packaging.DAEMON_MANIFEST), 'utf8')) as { binary: string; sha256: string };
			assert.equal(daemon.binary, binary);
			assert.equal(daemon.sha256, sha256(fs.readFileSync(path.join(dir, binary))), `${target}: the manifest records the binary's SHA-256`);
			if (process.platform !== 'win32' && packaging.TARGETS[target].os !== 'win32') {
				assert.equal(fs.statSync(path.join(dir, binary)).mode & 0o111, 0o111, `${target}: executable`);
			}
		}
	});

	it('refuses to stage a daemon its manifest does not describe: another hash, version or build kind', () => {
		const out = path.join(work, 'refused');
		const stage = (dir: string, target = HOST in packaging.TARGETS ? HOST : 'linux-x64'): void => { npm.stagePlatform(out, ROOT, target, { daemonDir: dir }); };
		assert.throws(() => stage(standInDaemon(work, 'linux-x64', { sha256: sha256('another build') }), 'linux-x64'), /SHA-256 .* records/);
		assert.throws(() => stage(standInDaemon(work, 'win32-x64', { version: '0.0.0' }), 'win32-x64'), /version 0\.0\.0; the package is/);
		assert.throws(() => stage(standInDaemon(work, 'linux-arm64', { buildKind: 'development' }), 'linux-arm64'), /development build/);
		assert.throws(() => stage(path.join(work, 'no-such-dir'), 'win32-x64'), /is missing; build the daemon for win32-x64 with EV3_COCKPIT_RELEASE_BUILD=1/);
	});

	describe('finding the daemon when installed', () => {
		/** An npm install of ev3-cockpit, with the platform package for `target` beside it or not. */
		function install(name: string, target?: string, withBinary = true): string {
			const modules = path.join(work, name, 'node_modules');
			fs.cpSync(staged.cockpit, path.join(modules, 'ev3-cockpit'), { recursive: true });
			if (target) {
				const dir = path.join(modules, '@ev3-cockpit', target);
				fs.cpSync(platforms[target], dir, { recursive: true });
				if (!withBinary) { fs.rmSync(path.join(dir, packaging.daemonBinary(target))); }
			}
			return path.join(modules, 'ev3-cockpit', 'out');
		}

		it('resolves this platform\'s package and takes its daemon, a release build at the installed version', { skip: !(HOST in DAEMON_PACKAGES) && 'no release ships for this platform' }, () => {
			const here = install('installed', HOST);
			const found = installation(here);
			assert.equal(found.buildKind, 'release');
			assert.equal(found.version, ROOT.version);
			const launch = found.daemon();
			assert.equal(launch.binary, path.join(path.dirname(here), '..', '@ev3-cockpit', HOST, packaging.daemonBinary(HOST)));
			assert.equal(launch.sha256, sha256(fs.readFileSync(launch.binary)));
			assert.equal(launch.buildKind, 'release');
			assert.equal(launch.version, ROOT.version);
		});

		it('resolves the package for the platform it runs on, never another one beside it', () => {
			const here = install('two-platforms', 'linux-arm64');
			fs.cpSync(platforms['linux-x64'], path.join(here, '..', '..', '@ev3-cockpit', 'linux-x64'), { recursive: true });
			assert.equal(platformDaemonDir(here, 'linux', 'arm64'), path.join(here, '..', '..', '@ev3-cockpit', 'linux-arm64'));
			assert.equal(platformDaemonDir(here, 'linux', 'x64'), path.join(here, '..', '..', '@ev3-cockpit', 'linux-x64'));
		});

		it('refuses a missing platform package, and a platform with none, saying what to do', () => {
			const here = install('without-platform');
			const failure = (pattern: RegExp) => (error: unknown): boolean =>
				error instanceof DaemonStartError && error.failure === 'missing_binary' && pattern.test(error.message);
			assert.throws(() => platformDaemonDir(here, 'linux', 'x64'),
				failure(/@ev3-cockpit\/linux-x64, is not installed beside ev3-cockpit.*without --omit=optional/));
			assert.throws(() => platformDaemonDir(here, 'darwin', 'arm64'), failure(/no daemon for darwin-arm64: it runs on Windows x64, Linux x64 and Linux arm64/));
			assert.throws(() => installation(here).daemon(), failure(/no daemon for|is not installed/));
		});

		it('the staged ev3 command says so before it reaches any daemon', { skip: !(HOST in DAEMON_PACKAGES) && 'no release ships for this platform' }, () => {
			// The command takes its daemon before it connects, so with none found it stops there; it
			// never reaches the user's channel. The home is a temporary one all the same.
			const home = fs.mkdtempSync(path.join(work, 'home-'));
			const env = { ...process.env, LOCALAPPDATA: home, XDG_STATE_HOME: home, XDG_RUNTIME_DIR: home, HOME: home, USERPROFILE: home };
			const ev3 = (here: string) => spawnSync(process.execPath, [path.join(here, 'cli.js'), 'status'], { env, encoding: 'utf8', timeout: 20_000 });
			const missing = ev3(install('cli-without-platform'));
			assert.notEqual(missing.status, 0);
			assert.match(missing.stdout + missing.stderr, new RegExp(`@ev3-cockpit/${HOST}, is not installed beside ev3-cockpit`));
			// With the package present but its binary gone, the bundle names the binary it resolved.
			const resolved = ev3(install('cli-without-binary', HOST, false));
			assert.notEqual(resolved.status, 0);
			assert.match(resolved.stdout + resolved.stderr, /@ev3-cockpit.*ev3-cockpitd(\.exe)? is missing/);
		});
	});

	it('counts a require only where it is a call, not inside generated code\'s strings', () => {
		const source = 'var a = require("fs"); var b = __require("usb"); var c = require("vscode-jsonrpc/node");\n'
			+ 'x.code = \'require("ajv/dist/runtime/uri").default\'; y = _`require("ajv-formats/dist/formats")`; z = require("@scope/pkg/deep");';
		assert.deepEqual(npm.requiredModules(source), ['@scope/pkg', 'usb', 'vscode-jsonrpc']);
	});
});
