/**
 * The npm packages (KTD16): `scripts/package-npm.cjs` stages `@ev3-cockpit/client` and `ev3-cockpit`
 * from the root version, the client without any native module, the cockpit with its bundles, its
 * executables and every file the daemon looks for in its installation folder.
 *
 * The bundles are built here, into a temporary folder: the unit tests run before any `npm run
 * bundle`, and the Bluetooth helpers are stand-ins, because native/bin is built per platform and
 * is not in the repository.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';

interface Staged { client: string; cockpit: string; missingHelpers: string[]; version: string }
interface PackageNpm {
	CLIENT_NAME: string;
	COCKPIT_NAME: string;
	HELPERS: string[];
	requiredModules(source: string): string[];
	stageNpm(options: { out: string; bundles: string; nativeBin: string; allowMissingHelpers?: boolean }): Staged;
	stageCockpit(out: string, root: Manifest, options: { bundles: string; nativeBin: string; allowMissingHelpers?: boolean }): { dir: string; missingHelpers: string[] };
}
interface Manifest {
	name: string;
	version: string;
	main?: string;
	types?: string;
	bin?: Record<string, string>;
	dependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
}

const REPO = path.join(__dirname, '..', '..');
/* eslint-disable @typescript-eslint/no-var-requires */
const npm = require(path.join(REPO, 'scripts', 'package-npm.cjs')) as PackageNpm;
const { bundle } = require(path.join(REPO, 'scripts', 'bundle.cjs')) as { bundle(options: { names: string[]; outDir: string }): void };
const { NATIVE_MODULES } = require(path.join(REPO, 'scripts', 'packaging.cjs')) as { NATIVE_MODULES: string[] };
/* eslint-enable @typescript-eslint/no-var-requires */

const read = (file: string): Manifest => JSON.parse(fs.readFileSync(file, 'utf8')) as Manifest;
const ROOT = read(path.join(REPO, 'package.json'));

function filesUnder(dir: string, suffix: string): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) { return filesUnder(full, suffix); }
		return entry.name.endsWith(suffix) ? [full] : [];
	});
}

describe('npm packages (KTD16)', () => {
	let work: string;
	let bundles: string;
	let staged: Staged;

	before(() => {
		work = fs.mkdtempSync(path.join(os.tmpdir(), 'ev3-cockpit-npm-'));
		bundles = path.join(work, 'bundles');
		// esbuild takes every core by default, at the moment the other test files start their daemons,
		// whose timing tests then fail; one core is enough for three bundles.
		process.env.GOMAXPROCS = '1';
		bundle({ names: ['daemon', 'cli', 'mcp'], outDir: bundles });
		const nativeBin = path.join(work, 'native-bin');
		fs.mkdirSync(nativeBin);
		for (const helper of npm.HELPERS) { fs.writeFileSync(path.join(nativeBin, helper), 'stand-in'); }
		fs.writeFileSync(path.join(nativeBin, 'bt-pairing-helper.pdb'), 'debug symbols');
		staged = npm.stageNpm({ out: path.join(work, 'npm'), bundles, nativeBin });
	});

	after(() => {
		if (work) { fs.rmSync(work, { recursive: true, force: true }); }
	});

	it('stages both packages at the root package.json version (R31)', () => {
		const client = read(path.join(staged.client, 'package.json'));
		const cockpit = read(path.join(staged.cockpit, 'package.json'));
		assert.equal(client.name, npm.CLIENT_NAME);
		assert.equal(cockpit.name, npm.COCKPIT_NAME);
		assert.equal(client.version, ROOT.version);
		assert.equal(cockpit.version, ROOT.version);
	});

	it('the client package is the contract and the library with their types, and no native module', () => {
		const client = read(path.join(staged.client, 'package.json'));
		assert.ok(client.main && fs.existsSync(path.join(staged.client, client.main)), 'main');
		assert.ok(client.types && fs.existsSync(path.join(staged.client, client.types)), 'types');
		assert.ok(fs.existsSync(path.join(staged.client, 'contract', 'index.d.ts')), 'the contract, typed');
		const declared = { ...client.dependencies, ...client.optionalDependencies, ...client.peerDependencies };
		for (const native of NATIVE_MODULES) { assert.ok(!(native in declared), `declares ${native}`); }
		// What its code requires, not only what its manifest says.
		const required = new Set(filesUnder(staged.client, '.js').flatMap((file) => npm.requiredModules(fs.readFileSync(file, 'utf8'))));
		assert.deepEqual([...required].sort(), Object.keys(client.dependencies ?? {}).sort(), 'it declares exactly what it requires');
		for (const native of NATIVE_MODULES) { assert.ok(!required.has(native), `requires ${native}`); }
	});

	it('the cockpit package names its two executables and takes the native modules as optional, at the root versions', () => {
		const cockpit = read(path.join(staged.cockpit, 'package.json'));
		assert.deepEqual(cockpit.bin, { ev3: 'out/cli.js', 'ev3-cockpit-mcp': 'out/mcp.js' });
		for (const file of Object.values(cockpit.bin ?? {})) {
			assert.ok(fs.readFileSync(path.join(staged.cockpit, file), 'utf8').startsWith('#!/usr/bin/env node\n'), `${file} runs from a shell`);
		}
		assert.ok(fs.existsSync(path.join(staged.cockpit, 'out', 'daemon.js')), 'the daemon beside them');
		assert.deepEqual(cockpit.optionalDependencies, Object.fromEntries(NATIVE_MODULES.map((name) => [name, ROOT.optionalDependencies?.[name]])));
		assert.equal(cockpit.dependencies, undefined, 'everything else is inlined in the bundles');
		for (const name of ['daemon', 'cli', 'mcp']) {
			const required = npm.requiredModules(fs.readFileSync(path.join(staged.cockpit, 'out', `${name}.js`), 'utf8'));
			assert.deepEqual(required.filter((module) => !NATIVE_MODULES.includes(module)), [], `out/${name}.js needs only native modules`);
		}
	});

	it('each bundle runs its own entry and no other module\'s', () => {
		// A second `require.main === module` in a bundle would start that module's main too.
		for (const name of ['daemon', 'cli', 'mcp']) {
			const source = fs.readFileSync(path.join(staged.cockpit, 'out', `${name}.js`), 'utf8');
			assert.equal(source.split('require.main === module').length - 1, 1, `out/${name}.js`);
		}
	});

	it('ev3 --version prints the root version, from the staged package', () => {
		const printed = execFileSync(process.execPath, [path.join(staged.cockpit, 'out', 'cli.js'), '--version'], { encoding: 'utf8', timeout: 20_000 });
		assert.equal(printed.trim(), ROOT.version);
	});

	it('carries every file the daemon finds from its installation folder (createRuntime)', () => {
		/* eslint-disable @typescript-eslint/no-var-requires */
		const { LINUX_UDEV_RULE_PATH } = require('../core/transports/usbLibusbAdapter') as { LINUX_UDEV_RULE_PATH: string };
		const { LINUX_BT_RESTART_RULE_PATH } = require('../core/transports/bluezRadioWatch') as { LINUX_BT_RESTART_RULE_PATH: string };
		const { MAC_BT_HELPER_PATH } = require('../core/transports/macBluetooth') as { MAC_BT_HELPER_PATH: string };
		/* eslint-enable @typescript-eslint/no-var-requires */
		const source = fs.readFileSync(path.join(REPO, 'src', 'core', 'runtime', 'createRuntime.ts'), 'utf8');
		const joins = [
			['path.join(options.extensionPath, LINUX_UDEV_RULE_PATH)', LINUX_UDEV_RULE_PATH],
			['path.join(options.extensionPath, LINUX_BT_RESTART_RULE_PATH)', LINUX_BT_RESTART_RULE_PATH],
			['path.join(options.extensionPath, mac.MAC_BT_HELPER_PATH)', MAC_BT_HELPER_PATH],
			["path.join(options.extensionPath, 'native', 'bin', 'bt-pairing-helper.exe')", 'native/bin/bt-pairing-helper.exe'],
		] as const;
		// A path createRuntime starts joining that this list does not know fails here, not in an install.
		assert.equal(source.split('path.join(options.extensionPath,').length - 1, joins.length, 'every join is listed');
		for (const [call, relative] of joins) {
			assert.ok(source.includes(call), `createRuntime still joins ${call}`);
			assert.ok(fs.existsSync(path.join(staged.cockpit, relative)), `ev3-cockpit carries ${relative}`);
		}
		assert.ok(!fs.existsSync(path.join(staged.cockpit, 'native', 'bin', 'bt-pairing-helper.pdb')), 'debug symbols do not ship');
	});

	it('refuses to stage without a Bluetooth helper unless told to, and then names it', () => {
		const empty = path.join(work, 'no-helpers');
		fs.mkdirSync(empty, { recursive: true });
		const out = path.join(work, 'npm-without-helpers');
		assert.throws(() => npm.stageCockpit(out, ROOT, { bundles, nativeBin: empty }), /bt-pairing-helper\.exe and ev3-bt-helper/);
		assert.deepEqual(npm.stageCockpit(out, ROOT, { bundles, nativeBin: empty, allowMissingHelpers: true }).missingHelpers, npm.HELPERS);
	});

	it('counts a require only where it is a call, not inside generated code\'s strings', () => {
		const source = 'var a = require("fs"); var b = __require("usb"); var c = require("vscode-jsonrpc/node");\n'
			+ 'x.code = \'require("ajv/dist/runtime/uri").default\'; y = _`require("ajv-formats/dist/formats")`; z = require("@scope/pkg/deep");';
		assert.deepEqual(npm.requiredModules(source), ['@scope/pkg', 'usb', 'vscode-jsonrpc']);
	});
});
