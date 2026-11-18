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

/**
 * The platforms a release ships for (REQUIREMENTS §12: Windows and Linux; macOS on Apple Silicon
 * from the Mac visit, IMPLEMENTATION_PLAN item 8, 18.11.2026).
 */
const TARGETS = {
	'win32-x64': { os: 'win32', cpu: 'x64', helper: true, udevRule: false },
	'linux-x64': { os: 'linux', cpu: 'x64', helper: false, udevRule: true },
	'linux-arm64': { os: 'linux', cpu: 'arm64', helper: false, udevRule: true },
	'darwin-arm64': { os: 'darwin', cpu: 'arm64', helper: false, udevRule: false },
};

/** The modules that ship prebuilt binaries in a `prebuilds/` folder, one of which a target needs. */
const PREBUILT_MODULES = ['usb', 'node-hid', '@serialport/bindings-cpp'];

/** The modules the bundle leaves external and loads at run time. */
const NATIVE_MODULES = ['usb', 'node-hid', 'serialport', 'koffi'];

/** The extension's own files, relative to the repository; nothing else of the repository ships. */
const SHIPPED_FILES = ['package.json', 'README.md', 'CHANGELOG.md', 'LICENSE', 'out/extension.js'];

/**
 * The udev rule a Linux user installs once for USB; the permission message names it at this path in
 * the extension's folder (`LINUX_UDEV_RULE_PATH`), so a Linux VSIX must carry it (13.11.2026).
 */
const UDEV_RULE = 'native/linux/70-lego-ev3.rules';
/**
 * The udev rule that lets the cockpit restart a USB Bluetooth adapter that stopped answering
 * (`LINUX_BT_RESTART_RULE_PATH`); the message about such an adapter names it (HOSTD, 15.11.2026).
 */
const BT_RESTART_RULE = 'native/linux/71-ev3-cockpit-bluetooth-restart.rules';
const UDEV_RULES = [UDEV_RULE, BT_RESTART_RULE];

/** The repository files a target's VSIX carries. */
function SHIPPED_FILES_FOR(target) {
	return TARGETS[target].udevRule ? [...SHIPPED_FILES, ...UDEV_RULES] : [...SHIPPED_FILES];
}

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
	if (['package.json', 'readme.md', 'changelog.md', 'license', 'license.txt', 'out/extension.js'].includes(file.toLowerCase())) { return true; }
	if (file.startsWith('native/bin/')) { return TARGETS[target].helper && !file.endsWith('.pdb'); }
	if (UDEV_RULES.includes(file)) { return TARGETS[target].udevRule; }
	if (!file.startsWith('node_modules/')) { return false; }
	const prebuild = PREBUILD.exec(entry);
	if (prebuild) { return keepPrebuild(prebuild[1], prebuild[2], target); }
	const koffi = KOFFI_PLATFORM.exec(entry);
	if (koffi) { return koffi[1] === target; }
	return true;
}

/**
 * What a target's VSIX must hold: the extension, and each native module's binary for it. Each need
 * is a path prefix, or a module's `prebuilds/` folder, met by any folder of it for this target: on
 * macOS `usb` and `@serialport/bindings-cpp` ship one folder for both architectures
 * (`darwin-x64+arm64`), so the folder is not always named after the target.
 */
function required(target) {
	const needs = [
		'extension/package.json',
		'extension/LICENSE',
		'extension/out/extension.js',
		'extension/node_modules/koffi/',
		`extension/node_modules/@koromix/koffi-${target}/`,
		...PREBUILT_MODULES.map((module) => ({ module })),
		'extension/node_modules/serialport/',
	];
	if (TARGETS[target].helper) { needs.push('extension/native/bin/bt-pairing-helper.exe'); }
	if (TARGETS[target].udevRule) { needs.push(...UDEV_RULES.map((rule) => `extension/${rule}`)); }
	return needs;
}

/** Whether an entry meets a need of {@link required}. */
function meets(target, need, entry) {
	if (typeof need === 'string') { return entry === need || entry.startsWith(need); }
	const prebuild = PREBUILD.exec(entry);
	return prebuild !== null && prebuild[1] === need.module && keepPrebuild(need.module, prebuild[2], target);
}

/** Checks a built VSIX's entries: what it lacks, and what it carries that it should not. */
function checkVsix(target, entries) {
	const missing = required(target)
		.filter((need) => !entries.some((entry) => meets(target, need, entry)))
		.map((need) => (typeof need === 'string' ? need : `extension/node_modules/${need.module}/prebuilds/<${target}>/`));
	const unexpected = entries.filter((entry) => !allowed(target, entry));
	return { missing, unexpected };
}

module.exports = { TARGETS, NATIVE_MODULES, SHIPPED_FILES, SHIPPED_FILES_FOR, keepPrebuild, listZipEntries, checkVsix };
