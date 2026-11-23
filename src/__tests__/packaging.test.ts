/**
 * Platform VSIX packaging: the rules of `scripts/packaging.mts`.
 *
 * Each platform's VSIX carries the native daemon built for it and the manifest recording its
 * SHA-256, version and build kind; the client refuses a daemon whose hash does not match, so a VSIX
 * whose manifest and binary disagree installs and then cannot start. Nothing else ships: no Node
 * native module and no Node daemon, and nothing of the repository beyond an allow-list (a
 * deny-list once shipped review scratch, notes and a junction to the firmware sources).
 *
 * The zips here are written by the test, so the checks run the same on every system; the VSIXes
 * themselves are built and checked by `scripts/package-vsix.mts` with the same rules.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import * as zlib from 'node:zlib';

interface ZipEntry { name: string; unix: boolean; mode: number; data(): Buffer }
interface Checked { missing: string[]; unexpected: string[]; problems: string[] }
interface Packaging {
	TARGETS: Record<string, { os: string; cpu: string; triple: string; udevRule: boolean }>;
	DAEMON_MANIFEST: string;
	NATIVE_MODULES: string[];
	UDEV_RULES: string[];
	SHIPPED_FILES_FOR(target: string): string[];
	daemonBinary(target: string): string;
	readZip(zip: Uint8Array): ZipEntry[];
	listZipEntries(zip: Uint8Array): string[];
	checkVsix(target: string, entries: readonly ZipEntry[], version: string): Checked;
	requiredModules(source: string): string[];
}
const REPO = path.join(__dirname, '..', '..');
/* eslint-disable @typescript-eslint/no-var-requires */
const packaging = require(path.join(REPO, 'scripts', 'packaging.mts')) as Packaging;
const { bundle } = require(path.join(REPO, 'scripts', 'bundle.mts')) as { bundle(options: { names: string[]; outDir: string }): void };
/* eslint-enable @typescript-eslint/no-var-requires */

const VERSION = '1.2.3';
const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

interface FileSpec { name: string; data: Buffer | string; mode?: number; unix?: boolean; deflate?: boolean }

/** A zip of these files, as vsce writes one: made on Unix with each file's mode unless told otherwise. */
function writeZip(files: readonly FileSpec[]): Buffer {
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;
	for (const file of files) {
		const raw = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data);
		const body = file.deflate ? zlib.deflateRawSync(raw) : raw;
		const name = Buffer.from(file.name);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(file.deflate ? 8 : 0, 8);
		local.writeUInt32LE(body.length, 18);
		local.writeUInt32LE(raw.length, 22);
		local.writeUInt16LE(name.length, 26);
		const unix = file.unix ?? true;
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(unix ? 0x0314 : 0x0014, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(file.deflate ? 8 : 0, 10);
		central.writeUInt32LE(body.length, 20);
		central.writeUInt32LE(raw.length, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt32LE(unix ? ((0o100000 | (file.mode ?? 0o644)) << 16) >>> 0 : 0, 38);
		central.writeUInt32LE(offset, 42);
		locals.push(local, name, body);
		centrals.push(central, name);
		offset += local.length + name.length + body.length;
	}
	const directory = Buffer.concat(centrals);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(files.length, 8);
	end.writeUInt16LE(files.length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, directory, end]);
}

const BINARY = Buffer.from('\x7fELF a stand-in daemon');

function manifest(target: string, overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({ binary: packaging.daemonBinary(target), sha256: sha256(BINARY), version: VERSION, buildKind: 'release', ...overrides });
}

/** What a correct VSIX for `target` holds, as vsce writes it on its own platform. */
function vsixFiles(target: string): FileSpec[] {
	const linux = packaging.TARGETS[target].os === 'linux';
	return [
		{ name: 'extension.vsixmanifest', data: '<PackageManifest/>' },
		{ name: '[Content_Types].xml', data: '<Types/>' },
		{ name: 'extension/package.json', data: '{}' },
		{ name: 'extension/readme.md', data: '#' },
		{ name: 'extension/LICENSE.txt', data: 'MIT' },
		{ name: 'extension/out/extension.js', data: 'const vscode = require("vscode"); const fs = require("fs");', deflate: true },
		{ name: `extension/${packaging.daemonBinary(target)}`, data: BINARY, mode: linux ? 0o755 : 0o644, unix: linux, deflate: true },
		{ name: `extension/${packaging.DAEMON_MANIFEST}`, data: manifest(target), unix: linux },
		...(linux ? packaging.UDEV_RULES.map((rule) => ({ name: `extension/${rule}`, data: '# rule' })) : []),
	];
}

function check(target: string, files: readonly FileSpec[], version = VERSION): Checked {
	return packaging.checkVsix(target, packaging.readZip(writeZip(files)), version);
}

const OK: Checked = { missing: [], unexpected: [], problems: [] };
const replace = (files: FileSpec[], name: string, change: Partial<FileSpec>): FileSpec[] =>
	files.map((file) => (file.name === name ? { ...file, ...change } : file));

/** A constant of the Rust transports: the path the daemon's advice names. */
function rustConstant(file: string, name: string): string {
	const source = fs.readFileSync(path.join(REPO, 'daemon', 'crates', 'transports', 'src', file), 'utf8');
	const value = new RegExp(`pub const ${name}: &str = "([^"]+)";`).exec(source)?.[1];
	assert.ok(value, `${file} declares ${name}`);
	return value;
}

describe('Platform VSIX packaging', () => {
	it('ships Windows x64, Linux x64 and Linux arm64, each with the daemon built for its Rust target', () => {
		assert.deepEqual(Object.keys(packaging.TARGETS).sort(), ['linux-arm64', 'linux-x64', 'win32-x64']);
		assert.deepEqual(Object.values(packaging.TARGETS).map((t) => t.triple).sort(),
			['aarch64-unknown-linux-gnu', 'x86_64-pc-windows-msvc', 'x86_64-unknown-linux-gnu']);
		assert.equal(packaging.daemonBinary('win32-x64'), 'ev3-cockpitd.exe');
		assert.equal(packaging.daemonBinary('linux-arm64'), 'ev3-cockpitd');
	});

	it('reads a zip\'s names, Unix modes and contents, stored or deflated', () => {
		const zip = writeZip([
			{ name: 'a.txt', data: 'stored' },
			{ name: 'bin/tool', data: 'deflated '.repeat(20), mode: 0o755, deflate: true },
			{ name: 'win.txt', data: 'from Windows', unix: false },
		]);
		const entries = packaging.readZip(zip);
		assert.deepEqual(packaging.listZipEntries(zip), ['a.txt', 'bin/tool', 'win.txt']);
		assert.equal(entries[0].data().toString(), 'stored');
		assert.equal(entries[1].data().toString(), 'deflated '.repeat(20));
		assert.equal(entries[1].mode & 0o777, 0o755);
		assert.equal(entries[1].unix, true);
		assert.equal(entries[2].unix, false);
	});

	it('passes a VSIX that holds the extension, its daemon and manifest, and nothing else', () => {
		for (const target of Object.keys(packaging.TARGETS)) {
			assert.deepEqual(check(target, vsixFiles(target)), OK, target);
		}
	});

	it('carries exactly one daemon binary, at the extension\'s root where the installed extension reads it', () => {
		// The installed extension hands its own folder to packagedDaemon.
		const extension = fs.readFileSync(path.join(REPO, 'src', 'vscode', 'extension.ts'), 'utf8');
		assert.match(extension, /function packagedDaemonDir\(context: vscode\.ExtensionContext\): string \{\s*return context\.extensionPath;\s*\}/);

		const files = vsixFiles('linux-x64');
		const twice = [...files, { name: 'extension/native/bin/ev3-cockpitd', data: BINARY, mode: 0o755 }];
		const twiceChecked = check('linux-x64', twice);
		assert.deepEqual(twiceChecked.unexpected, ['extension/native/bin/ev3-cockpitd']);
		assert.ok(twiceChecked.problems.some((p) => /2 daemon binaries/.test(p)), twiceChecked.problems.join('\n'));
		const windowsToo = check('linux-x64', [...files, { name: 'extension/ev3-cockpitd.exe', data: BINARY }]);
		assert.ok(windowsToo.problems.some((p) => /2 daemon binaries/.test(p)));

		const none = check('linux-x64', files.filter((f) => f.name !== 'extension/ev3-cockpitd'));
		assert.deepEqual(none.missing, ['extension/ev3-cockpitd']);
		assert.ok(none.problems.some((p) => /0 daemon binaries/.test(p)));
		assert.deepEqual(check('win32-x64', vsixFiles('win32-x64').filter((f) => !f.name.endsWith('.manifest.json'))).missing,
			[`extension/${packaging.DAEMON_MANIFEST}`]);
	});

	it('refuses a daemon whose SHA-256 is not the one its manifest records', () => {
		for (const target of Object.keys(packaging.TARGETS)) {
			const name = `extension/${packaging.daemonBinary(target)}`;
			const { problems } = check(target, replace(vsixFiles(target), name, { data: Buffer.from('another build') }));
			assert.equal(problems.length, 1, problems.join('\n'));
			assert.match(problems[0], /SHA-256 .* records/);
		}
	});

	it('refuses a Linux daemon that would land without its executable bit', () => {
		const name = 'extension/ev3-cockpitd';
		const plain = check('linux-arm64', replace(vsixFiles('linux-arm64'), name, { mode: 0o644 }));
		assert.ok(plain.problems.some((p) => /not executable \(mode 644\)/.test(p)), plain.problems.join('\n'));
		// Packed on Windows: the zip carries no Unix mode at all.
		const windows = check('linux-x64', replace(vsixFiles('linux-x64'), name, { unix: false }));
		assert.ok(windows.problems.some((p) => /not packed on a Unix system/.test(p)), windows.problems.join('\n'));
		assert.deepEqual(check('win32-x64', vsixFiles('win32-x64')).problems, [], 'Windows has no executable bit');
	});

	it('refuses a manifest of another version, a development build, or another binary', () => {
		const target = 'win32-x64';
		const name = `extension/${packaging.DAEMON_MANIFEST}`;
		assert.ok(check(target, vsixFiles(target), '9.9.9').problems.some((p) => /version 1\.2\.3; the package is 9\.9\.9/.test(p)));
		assert.ok(check(target, replace(vsixFiles(target), name, { data: manifest(target, { buildKind: 'development' }) }))
			.problems.some((p) => /development build/.test(p)));
		assert.ok(check(target, replace(vsixFiles(target), name, { data: manifest(target, { binary: 'ev3-cockpitd' }) }))
			.problems.some((p) => /names ev3-cockpitd, not ev3-cockpitd\.exe/.test(p)));
		assert.ok(check(target, replace(vsixFiles(target), name, { data: 'not json' })).problems.some((p) => /not JSON/.test(p)));
	});

	it('carries no Node native module and no Node daemon', () => {
		const leaky = [...vsixFiles('linux-x64'),
			{ name: 'extension/out/daemon.js', data: '' },
			{ name: 'extension/node_modules/usb/prebuilds/linux-x64/node.napi.node', data: '' },
			{ name: 'extension/node_modules/node-hid/prebuilds/HID-linux-x64/node-napi-v3.node', data: '' },
			{ name: 'extension/node_modules/@serialport/bindings-cpp/package.json', data: '' },
			{ name: 'extension/node_modules/koffi/index.js', data: '' },
			{ name: 'extension/native/bin/bt-pairing-helper.exe', data: '' },
			{ name: 'extension/out/cli.js', data: '' }, { name: 'extension/wiki/INDEX.md', data: '' }];
		assert.deepEqual(check('linux-x64', leaky).unexpected.sort(), leaky.slice(vsixFiles('linux-x64').length).map((f) => f.name).sort());
		for (const module of packaging.NATIVE_MODULES) {
			const requiring = replace(vsixFiles('win32-x64'), 'extension/out/extension.js', { data: `require("vscode"); require("${module}");` });
			assert.deepEqual(check('win32-x64', requiring).problems, [`out/extension.js requires ${module}, which the VSIX does not carry.`]);
		}
		for (const target of Object.keys(packaging.TARGETS)) {
			assert.ok(!packaging.SHIPPED_FILES_FOR(target).includes('out/daemon.js'), target);
		}
		const ignore = fs.readFileSync(path.join(REPO, '.vscodeignore'), 'utf8').split(/\r?\n/);
		assert.ok(!ignore.some((line) => line.startsWith('!') && /daemon\.js|node_modules/.test(line)), 'a plain vsce package does not keep them either');
	});

	describe('the extension bundle', () => {
		const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ev3-cockpit-vsix-'));
		after(() => fs.rmSync(work, { recursive: true, force: true }));

		it('requires nothing but VS Code: the VSIX carries no node_modules', () => {
			// esbuild takes every core by default, while other test files time their daemons.
			process.env.GOMAXPROCS = '1';
			bundle({ names: ['extension'], outDir: work });
			assert.deepEqual(packaging.requiredModules(fs.readFileSync(path.join(work, 'extension.js'), 'utf8')), ['vscode']);
		});
	});

	it('ships the udev rule the daemon\'s USB permission message names, on Linux only', () => {
		const rule = rustConstant('usb/mod.rs', 'LINUX_UDEV_RULE_PATH');
		assert.ok(fs.existsSync(path.join(REPO, rule)), 'the rule is in the repository');
		assert.ok(packaging.SHIPPED_FILES_FOR('linux-arm64').includes(rule), 'staged for Linux');
		assert.ok(!packaging.SHIPPED_FILES_FOR('win32-x64').includes(rule), 'not staged for Windows');
		for (const target of ['linux-x64', 'linux-arm64']) {
			assert.ok(check(target, vsixFiles(target).filter((f) => f.name !== `extension/${rule}`)).missing.includes(`extension/${rule}`), target);
		}
		assert.ok(check('win32-x64', [...vsixFiles('win32-x64'), { name: `extension/${rule}`, data: '' }]).unexpected.includes(`extension/${rule}`));
	});

	it('the udev rule opens the brick without logind too: group plugdev beside uaccess', () => {
		// `uaccess` is granted by systemd-logind or elogind. On a runit system with neither the nodes
		// stayed root:root 0660 and the user got LIBUSB_ERROR_ACCESS with the rule installed.
		const text = fs.readFileSync(path.join(REPO, rustConstant('usb/mod.rs', 'LINUX_UDEV_RULE_PATH')), 'utf8');
		assert.ok(!text.includes('\r'), 'LF only: udev reads the file as it is shipped');
		const rules = text.split('\n').filter((line) => line.trim() !== '' && !line.startsWith('#'));
		assert.equal(rules.length, 2, 'one rule for the USB device, one for its hidraw node');
		for (const rule of rules) {
			assert.match(rule, /ATTRS\{idVendor\}=="0694", ATTRS\{idProduct\}=="0005"/);
			assert.match(rule, /MODE="0660"/);
			assert.match(rule, /GROUP="plugdev"/, `no logind: ${rule}`);
			assert.match(rule, /TAG\+="uaccess"/, `logind: ${rule}`);
		}
	});

	it('ships, on Linux only, the rule that lets the daemon restart a Bluetooth adapter that stopped answering', () => {
		const rulePath = rustConstant('bt_linux/radio_watch.rs', 'LINUX_BT_RESTART_RULE_PATH');
		const text = fs.readFileSync(path.join(REPO, rulePath), 'utf8');
		assert.ok(!text.includes('\r'), 'LF only: udev reads the file as it is shipped');
		const rules = text.split('\n').filter((line) => line.trim() !== '' && !line.startsWith('#'));
		assert.equal(rules.length, 1);
		// A USB Bluetooth interface (class e0/01/01); its device's authorized file, group plugdev.
		assert.match(rules[0], /ENV\{DEVTYPE\}=="usb_interface", ATTR\{bInterfaceClass\}=="e0", ATTR\{bInterfaceSubClass\}=="01", ATTR\{bInterfaceProtocol\}=="01"/);
		// The whole device goes off: only one that declares itself a wireless controller.
		assert.match(rules[0], /ATTRS\{bDeviceClass\}=="e0"/);
		assert.match(text, /Every function of that device goes\s*\n# off with it/);
		assert.match(rules[0], /RUN\+="\/bin\/chgrp plugdev \/sys%p\/\.\.\/authorized", RUN\+="\/bin\/chmod g\+w \/sys%p\/\.\.\/authorized"/);
		assert.ok(packaging.SHIPPED_FILES_FOR('linux-x64').includes(rulePath), 'staged for Linux');
		assert.ok(!packaging.SHIPPED_FILES_FOR('win32-x64').includes(rulePath), 'not staged for Windows');
		for (const target of ['linux-x64', 'linux-arm64']) {
			assert.ok(check(target, vsixFiles(target).filter((f) => f.name !== `extension/${rulePath}`)).missing.includes(`extension/${rulePath}`), target);
		}
	});
});
