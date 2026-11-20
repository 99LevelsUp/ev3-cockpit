/**
 * Platform VSIX packaging (IMPLEMENTATION_PLAN 0.2.5): the rules of `scripts/packaging.cjs`.
 *
 * An installed build had no USB or Bluetooth because the VSIX carried none of the native modules,
 * and the package's deny-list would have shipped review scratch, notes, logs and a junction to the
 * firmware sources. So a VSIX is built per platform from an allow-list, and checked after: every
 * native binary its platform needs is in it, and nothing else is — no other platform's binaries.
 */

import assert from 'node:assert/strict';
import * as path from 'node:path';
import { describe, it } from 'node:test';

interface Packaging {
	TARGETS: Record<string, { os: string; cpu: string; helper: boolean }>;
	keepPrebuild(module: string, dir: string, target: string): boolean;
	listZipEntries(zip: Uint8Array): string[];
	checkVsix(target: string, entries: readonly string[]): { missing: string[]; unexpected: string[] };
	SHIPPED_FILES_FOR(target: string): string[];
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const packaging = require(path.join(__dirname, '..', '..', 'scripts', 'packaging.cjs')) as Packaging;

/** A three-entry zip: extension.vsixmanifest, extension/out/extension.js and one usb prebuild. */
const ZIP = Buffer.from('UEsDBBQAAAAAAOFybV1o8gHhAQAAAAEAAAAWAAAAZXh0ZW5zaW9uLnZzaXhtYW5pZmVzdG1QSwMEFAAAAAAA4XJtXYMW3IwBAAAAAQAAABoAAABleHRlbnNpb24vb3V0L2V4dGVuc2lvbi5qc3hQSwMEFAAAAAAA4XJtXdKjCHgBAAAAAQAAAD8AAABleHRlbnNpb24vbm9kZV9tb2R1bGVzL3VzYi9wcmVidWlsZHMvbGludXgtYXJtNjQvbm9kZS5uYXBpLm5vZGVuUEsBAhQAFAAAAAAA4XJtXWjyAeEBAAAAAQAAABYAAAAAAAAAAAAAAIABAAAAAGV4dGVuc2lvbi52c2l4bWFuaWZlc3RQSwECFAAUAAAAAADhcm1dgxbcjAEAAAABAAAAGgAAAAAAAAAAAAAAgAE1AAAAZXh0ZW5zaW9uL291dC9leHRlbnNpb24uanNQSwECFAAUAAAAAADhcm1d0qMIeAEAAAABAAAAPwAAAAAAAAAAAAAAgAFuAAAAZXh0ZW5zaW9uL25vZGVfbW9kdWxlcy91c2IvcHJlYnVpbGRzL2xpbnV4LWFybTY0L25vZGUubmFwaS5ub2RlUEsFBgAAAAADAAMA+QAAAMwAAAAAAA==', 'base64');

/** What a correct linux-arm64 VSIX holds, at the paths the checks look for. */
const LINUX_ARM64 = [
	'extension.vsixmanifest', '[Content_Types].xml',
	'extension/package.json', 'extension/readme.md', 'extension/LICENSE.txt', 'extension/out/extension.js', 'extension/out/daemon.js',
	'extension/node_modules/usb/prebuilds/linux-arm64/node.napi.armv8.node',
	'extension/node_modules/node-hid/prebuilds/HID-linux-arm64/node-napi-v3.node',
	'extension/node_modules/node-hid/prebuilds/HID_hidraw-linux-arm64/node-napi-v3.node',
	'extension/node_modules/@serialport/bindings-cpp/prebuilds/linux-arm64/@serialport+bindings-cpp.armv8.node',
	'extension/node_modules/@koromix/koffi-linux-arm64/koffi.node',
	'extension/node_modules/koffi/index.js',
	'extension/node_modules/serialport/dist/index.js',
	'extension/native/linux/70-lego-ev3.rules',
	'extension/native/linux/71-ev3-cockpit-bluetooth-restart.rules',
];

/**
 * What a correct darwin-arm64 VSIX holds: `usb` and `@serialport/bindings-cpp` ship one folder for
 * both Mac architectures, `node-hid` one per architecture (as installed on the Mac, 18.11.2026).
 */
const DARWIN_ARM64 = [
	'extension.vsixmanifest', '[Content_Types].xml',
	'extension/package.json', 'extension/readme.md', 'extension/LICENSE.txt', 'extension/out/extension.js', 'extension/out/daemon.js',
	'extension/node_modules/usb/prebuilds/darwin-x64+arm64/node.napi.node',
	'extension/node_modules/node-hid/prebuilds/HID-darwin-arm64/node-napi-v3.node',
	'extension/node_modules/@serialport/bindings-cpp/prebuilds/darwin-x64+arm64/@serialport+bindings-cpp.node',
	'extension/node_modules/@koromix/koffi-darwin-arm64/koffi.node',
	'extension/node_modules/koffi/index.js',
	'extension/node_modules/serialport/dist/index.js',
	'extension/native/bin/ev3-bt-helper',
];

describe('Platform VSIX packaging (0.2.5)', () => {
	it('builds Windows x64 with the pairing helper, and Linux x64 and arm64 and macOS arm64 without it', () => {
		assert.deepEqual(Object.keys(packaging.TARGETS).sort(), ['darwin-arm64', 'linux-arm64', 'linux-x64', 'win32-x64']);
		assert.equal(packaging.TARGETS['darwin-arm64'].helper, false);
		assert.equal(packaging.TARGETS['win32-x64'].helper, true);
		assert.equal(packaging.TARGETS['linux-arm64'].helper, false);
		assert.deepEqual([packaging.TARGETS['linux-arm64'].os, packaging.TARGETS['linux-arm64'].cpu], ['linux', 'arm64']);
	});

	it('keeps only its own platform\'s prebuilt binaries, in each module\'s own naming', () => {
		const keep = (module: string, dir: string, target: string) => packaging.keepPrebuild(module, dir, target);
		assert.equal(keep('usb', 'linux-arm64', 'linux-arm64'), true);
		assert.equal(keep('usb', 'linux-arm', 'linux-arm64'), false, 'arm is not arm64');
		assert.equal(keep('usb', 'linux-x64', 'linux-arm64'), false);
		assert.equal(keep('usb', 'win32-x64', 'win32-x64'), true);
		assert.equal(keep('usb', 'darwin-x64+arm64', 'linux-arm64'), false);
		assert.equal(keep('node-hid', 'HID-linux-arm64', 'linux-arm64'), true);
		assert.equal(keep('node-hid', 'HID_hidraw-linux-arm64', 'linux-arm64'), true);
		assert.equal(keep('node-hid', 'HID-linux-x64-musl', 'linux-x64'), true, 'musl Linux is Linux x64 too');
		assert.equal(keep('node-hid', 'HID-win32-ia32', 'win32-x64'), false);
		assert.equal(keep('@serialport/bindings-cpp', 'android-arm64', 'linux-arm64'), false, 'Android is not Linux');
		assert.equal(keep('usb', 'darwin-x64+arm64', 'darwin-arm64'), true, 'one folder for both Mac architectures');
		assert.equal(keep('node-hid', 'HID-darwin-arm64', 'darwin-arm64'), true);
		assert.equal(keep('node-hid', 'HID-darwin-x64', 'darwin-arm64'), false);
	});

	it('passes a macOS VSIX whose binaries sit in a folder shared by both Mac architectures (Mac visit, 18.11.2026)', () => {
		assert.deepEqual(packaging.checkVsix('darwin-arm64', DARWIN_ARM64), { missing: [], unexpected: [] });
		const withoutUsb = DARWIN_ARM64.filter((entry) => !entry.includes('/usb/prebuilds/'));
		assert.deepEqual(packaging.checkVsix('darwin-arm64', withoutUsb).missing, ['extension/node_modules/usb/prebuilds/<darwin-arm64>/']);
		const intelOnly = DARWIN_ARM64.map((entry) => entry.replace('HID-darwin-arm64', 'HID-darwin-x64'));
		const { missing, unexpected } = packaging.checkVsix('darwin-arm64', intelOnly);
		assert.deepEqual(missing, ['extension/node_modules/node-hid/prebuilds/<darwin-arm64>/']);
		assert.deepEqual(unexpected, ['extension/node_modules/node-hid/prebuilds/HID-darwin-x64/node-napi-v3.node']);
	});

	it('ships the macOS Bluetooth helper on macOS only, and asks for it there (Mac visit, 18.11.2026)', () => {
		const withoutHelper = DARWIN_ARM64.filter((entry) => !entry.endsWith('ev3-bt-helper'));
		assert.deepEqual(packaging.checkVsix('darwin-arm64', withoutHelper).missing, ['extension/native/bin/ev3-bt-helper']);
		assert.deepEqual(packaging.checkVsix('linux-arm64', [...LINUX_ARM64, 'extension/native/bin/ev3-bt-helper']).unexpected,
			['extension/native/bin/ev3-bt-helper']);
		assert.deepEqual(packaging.checkVsix('darwin-arm64', [...DARWIN_ARM64, 'extension/native/bin/bt-pairing-helper.exe']).unexpected,
			['extension/native/bin/bt-pairing-helper.exe']);
	});

	it('reads the names in a zip', () => {
		assert.deepEqual(packaging.listZipEntries(ZIP),
			['extension.vsixmanifest', 'extension/out/extension.js', 'extension/node_modules/usb/prebuilds/linux-arm64/node.napi.node']);
	});

	it('passes a VSIX that holds what its platform needs and nothing else', () => {
		assert.deepEqual(packaging.checkVsix('linux-arm64', LINUX_ARM64), { missing: [], unexpected: [] });
	});

	it('carries the daemon beside the extension, and refuses a VSIX without it (KTD16)', () => {
		// The extension starts its daemon from out/daemon.js; a VSIX without it installs, activates and
		// then has nothing to start.
		assert.ok(packaging.SHIPPED_FILES_FOR('win32-x64').includes('out/daemon.js'), 'staged');
		const ignore = require('node:fs').readFileSync(path.join(__dirname, '..', '..', '.vscodeignore'), 'utf8') as string;
		assert.ok(ignore.split(/\r?\n/).includes('!out/daemon.js'), 'a plain vsce package keeps it too');
		for (const [target, entries] of [['linux-arm64', LINUX_ARM64], ['darwin-arm64', DARWIN_ARM64]] as const) {
			const without = entries.filter((entry) => entry !== 'extension/out/daemon.js');
			assert.deepEqual(packaging.checkVsix(target, without), { missing: ['extension/out/daemon.js'], unexpected: [] }, target);
		}
	});

	it('leaves the ev3 command and the MCP server to the npm package (KTD16)', () => {
		const withClients = [...LINUX_ARM64, 'extension/out/cli.js', 'extension/out/mcp.js'];
		assert.deepEqual(packaging.checkVsix('linux-arm64', withClients).unexpected, ['extension/out/cli.js', 'extension/out/mcp.js']);
		assert.ok(!packaging.SHIPPED_FILES_FOR('win32-x64').includes('out/cli.js'));
	});

	it('names what is missing: a native binary the platform needs', () => {
		const without = LINUX_ARM64.filter((entry) => !entry.includes('koffi-linux-arm64'));
		assert.ok(packaging.checkVsix('linux-arm64', without).missing.some((m) => m.includes('koffi-linux-arm64')));
		assert.ok(packaging.checkVsix('win32-x64', LINUX_ARM64).missing.some((m) => m.includes('bt-pairing-helper.exe')));
	});

	it('names what should not be there: other platforms, the repo\'s scratch, debug files', () => {
		const leaky = [...LINUX_ARM64,
			'extension/node_modules/usb/prebuilds/win32-x64/node.napi.node',
			'extension/.review-out/packet.md', 'extension/ev3-resources/lms2012/c_com.c', 'extension/wiki/INDEX.md',
			'extension/out/extension.js.map', 'extension/native/bin/bt-pairing-helper.exe',
			'extension/node_modules/@koromix/koffi-win32-x64/koffi.node'];
		const { unexpected } = packaging.checkVsix('linux-arm64', leaky);
		assert.deepEqual(unexpected.sort(), leaky.slice(LINUX_ARM64.length).sort());
		assert.ok(packaging.checkVsix('win32-x64', ['extension/native/bin/bt-pairing-helper.pdb']).unexpected.length === 1,
			'debug symbols do not ship');
	});

	it('ships the udev rule the Linux permission message points at, on Linux only (merge review, 13.11.2026)', () => {
		// The message told a Linux user to copy a file that no VSIX carried.
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { LINUX_UDEV_RULE_PATH } = require('../core/transports/usbLibusbAdapter') as { LINUX_UDEV_RULE_PATH: string };
		const entry = `extension/${LINUX_UDEV_RULE_PATH}`;
		const repoRoot = path.join(__dirname, '..', '..');
		assert.ok(require('node:fs').existsSync(path.join(repoRoot, LINUX_UDEV_RULE_PATH)), 'the rule is in the repository');
		assert.ok(packaging.SHIPPED_FILES_FOR('linux-arm64').includes(LINUX_UDEV_RULE_PATH), 'staged for Linux');
		assert.ok(!packaging.SHIPPED_FILES_FOR('win32-x64').includes(LINUX_UDEV_RULE_PATH), 'not staged for Windows');
		for (const target of ['linux-x64', 'linux-arm64']) {
			const without = LINUX_ARM64.filter((e) => e !== entry);
			assert.ok(packaging.checkVsix(target, without).missing.includes(entry), `${target} must carry ${entry}`);
		}
		assert.ok(packaging.checkVsix('win32-x64', [entry]).unexpected.includes(entry), 'Windows does not carry it');
	});

	it('the udev rule opens the brick without logind too: group plugdev beside uaccess (HOSTD, 14.11.2026)', () => {
		// `uaccess` is granted by systemd-logind or elogind. On a runit system with neither the nodes
		// stayed root:root 0660 and the user got LIBUSB_ERROR_ACCESS with the rule installed.
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { LINUX_UDEV_RULE_PATH } = require('../core/transports/usbLibusbAdapter') as { LINUX_UDEV_RULE_PATH: string };
		const text = require('node:fs').readFileSync(path.join(__dirname, '..', '..', LINUX_UDEV_RULE_PATH), 'utf8') as string;
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

	it('ships, on Linux only, the rule that lets the cockpit restart a Bluetooth adapter that stopped answering (HOSTD, 15.11.2026)', () => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { LINUX_BT_RESTART_RULE_PATH } = require('../core/transports/bluezRadioWatch') as { LINUX_BT_RESTART_RULE_PATH: string };
		const entry = `extension/${LINUX_BT_RESTART_RULE_PATH}`;
		const text = require('node:fs').readFileSync(path.join(__dirname, '..', '..', LINUX_BT_RESTART_RULE_PATH), 'utf8') as string;
		assert.ok(!text.includes('\r'), 'LF only: udev reads the file as it is shipped');
		const rules = text.split('\n').filter((line) => line.trim() !== '' && !line.startsWith('#'));
		assert.equal(rules.length, 1);
		// A USB Bluetooth interface (class e0/01/01, as on HOSTD); its device's authorized file, group plugdev.
		assert.match(rules[0], /ENV\{DEVTYPE\}=="usb_interface", ATTR\{bInterfaceClass\}=="e0", ATTR\{bInterfaceSubClass\}=="01", ATTR\{bInterfaceProtocol\}=="01"/);
		// The whole device goes off: only one that declares itself a wireless controller (codex review).
		assert.match(rules[0], /ATTRS\{bDeviceClass\}=="e0"/);
		assert.match(text, /Every function of that device goes\s*\n# off with it/);
		assert.match(rules[0], /RUN\+="\/bin\/chgrp plugdev \/sys%p\/\.\.\/authorized", RUN\+="\/bin\/chmod g\+w \/sys%p\/\.\.\/authorized"/);
		assert.ok(packaging.SHIPPED_FILES_FOR('linux-x64').includes(LINUX_BT_RESTART_RULE_PATH), 'staged for Linux');
		assert.ok(!packaging.SHIPPED_FILES_FOR('win32-x64').includes(LINUX_BT_RESTART_RULE_PATH), 'not staged for Windows');
		for (const target of ['linux-x64', 'linux-arm64']) {
			const without = LINUX_ARM64.filter((e) => e !== entry);
			assert.ok(packaging.checkVsix(target, without).missing.includes(entry), `${target} must carry ${entry}`);
		}
		assert.ok(packaging.checkVsix('win32-x64', [entry]).unexpected.includes(entry), 'Windows does not carry it');
	});
});
