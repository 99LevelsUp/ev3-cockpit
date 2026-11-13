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
	'extension/package.json', 'extension/readme.md', 'extension/LICENSE.txt', 'extension/out/extension.js',
	'extension/node_modules/usb/prebuilds/linux-arm64/node.napi.armv8.node',
	'extension/node_modules/node-hid/prebuilds/HID-linux-arm64/node-napi-v3.node',
	'extension/node_modules/node-hid/prebuilds/HID_hidraw-linux-arm64/node-napi-v3.node',
	'extension/node_modules/@serialport/bindings-cpp/prebuilds/linux-arm64/@serialport+bindings-cpp.armv8.node',
	'extension/node_modules/@koromix/koffi-linux-arm64/koffi.node',
	'extension/node_modules/koffi/index.js',
	'extension/node_modules/serialport/dist/index.js',
	'extension/native/linux/70-lego-ev3.rules',
];

describe('Platform VSIX packaging (0.2.5)', () => {
	it('builds Windows x64 with the pairing helper, and Linux x64 and arm64 without it', () => {
		assert.deepEqual(Object.keys(packaging.TARGETS).sort(), ['linux-arm64', 'linux-x64', 'win32-x64']);
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
	});

	it('reads the names in a zip', () => {
		assert.deepEqual(packaging.listZipEntries(ZIP),
			['extension.vsixmanifest', 'extension/out/extension.js', 'extension/node_modules/usb/prebuilds/linux-arm64/node.napi.node']);
	});

	it('passes a VSIX that holds what its platform needs and nothing else', () => {
		assert.deepEqual(packaging.checkVsix('linux-arm64', LINUX_ARM64), { missing: [], unexpected: [] });
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
		const { LINUX_UDEV_RULE_PATH } = require('../transports/usbLibusbAdapter') as { LINUX_UDEV_RULE_PATH: string };
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
});
