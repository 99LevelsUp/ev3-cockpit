/**
 * The rules of the platform VSIXes (IMPLEMENTATION_PLAN 0.2.5), kept apart from the build in
 * `package-vsix.cjs` so they can be tested (`src/__tests__/packaging.test.ts`).
 *
 * An installed build had no USB or Bluetooth: the VSIX carried none of the native modules the
 * bundle leaves external. And the package's deny-list would have shipped review scratch, notes,
 * logs and a junction to the firmware sources. So each platform gets its own VSIX, built from an
 * allow-list, with only its own native binaries, and checked after it is built.
 */
'use strict';

/** The platforms a release ships for (REQUIREMENTS §12: Windows and Linux). */
const TARGETS = {
	'win32-x64': { os: 'win32', cpu: 'x64', helper: true },
	'linux-x64': { os: 'linux', cpu: 'x64', helper: false },
	'linux-arm64': { os: 'linux', cpu: 'arm64', helper: false },
};

/**
 * The modules the bundle leaves external and loads at run time. `regkey` is a dependency nothing
 * requires, so it does not ship.
 */
const NATIVE_MODULES = ['usb', 'node-hid', 'serialport', 'koffi'];

/** The extension's own files, relative to the repository; nothing else of the repository ships. */
const SHIPPED_FILES = ['package.json', 'README.md', 'CHANGELOG.md', 'out/extension.js'];

/**
 * Whether a module's prebuilt binary folder is for this target. `node-hid` prefixes the platform
 * with its backend (`HID-`, `HID_hidraw-`); the others name it plainly. A folder may name several
 * architectures (`darwin-x64+arm64`) or a libc (`linux-x64-musl`, still Linux x64).
 */
function keepPrebuild(module, dir, target) {
	const { os, cpu } = TARGETS[target];
	const platform = module === 'node-hid' ? dir.slice(dir.indexOf('-') + 1) : dir;
	const [folderOs, folderArch = ''] = platform.split('-');
	return folderOs === os && folderArch.split('+').includes(cpu);
}

/** The names in a zip, read from its central directory. A VSIX is a zip. */
function listZipEntries(zip) {
	const view = Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength);
	let end = -1;
	for (let at = view.length - 22; at >= 0; at -= 1) {
		if (view.readUInt32LE(at) === 0x06054b50) { end = at; break; }
	}
	if (end < 0) { throw new Error('Not a zip: no end of central directory.'); }
	const count = view.readUInt16LE(end + 10);
	let at = view.readUInt32LE(end + 16);
	const names = [];
	for (let i = 0; i < count; i += 1) {
		if (view.readUInt32LE(at) !== 0x02014b50) { throw new Error(`Not a zip: a broken central directory at ${at}.`); }
		const nameLength = view.readUInt16LE(at + 28);
		const extraLength = view.readUInt16LE(at + 30);
		const commentLength = view.readUInt16LE(at + 32);
		names.push(view.toString('utf8', at + 46, at + 46 + nameLength));
		at += 46 + nameLength + extraLength + commentLength;
	}
	return names;
}

const PREBUILD = /^extension\/node_modules\/(.+?)\/prebuilds\/([^/]+)\//;
const KOFFI_PLATFORM = /^extension\/node_modules\/@koromix\/koffi-([^/]+)\//;

/** Whether an entry belongs in this target's VSIX. */
function allowed(target, entry) {
	if (!entry.startsWith('extension/')) { return true; }   // the VSIX's own manifest and content types
	const file = entry.slice('extension/'.length);
	if (['package.json', 'readme.md', 'changelog.md', 'out/extension.js'].includes(file.toLowerCase())) { return true; }
	if (file.startsWith('native/bin/')) { return TARGETS[target].helper && !file.endsWith('.pdb'); }
	if (!file.startsWith('node_modules/')) { return false; }
	const prebuild = PREBUILD.exec(entry);
	if (prebuild) { return keepPrebuild(prebuild[1], prebuild[2], target); }
	const koffi = KOFFI_PLATFORM.exec(entry);
	if (koffi) { return koffi[1] === target; }
	return true;
}

/** What a target's VSIX must hold: the extension, and each native module's binary for it. */
function required(target) {
	const needs = [
		'extension/package.json',
		'extension/out/extension.js',
		'extension/node_modules/koffi/',
		`extension/node_modules/@koromix/koffi-${target}/`,
		`extension/node_modules/usb/prebuilds/${target}/`,
		`extension/node_modules/node-hid/prebuilds/HID-${target}/`,
		`extension/node_modules/@serialport/bindings-cpp/prebuilds/${target}/`,
		'extension/node_modules/serialport/',
	];
	if (TARGETS[target].helper) { needs.push('extension/native/bin/bt-pairing-helper.exe'); }
	return needs;
}

/** Checks a built VSIX's entries: what it lacks, and what it carries that it should not. */
function checkVsix(target, entries) {
	const missing = required(target).filter((need) => !entries.some((entry) => entry === need || entry.startsWith(need)));
	const unexpected = entries.filter((entry) => !allowed(target, entry));
	return { missing, unexpected };
}

module.exports = { TARGETS, NATIVE_MODULES, SHIPPED_FILES, keepPrebuild, listZipEntries, checkVsix };
