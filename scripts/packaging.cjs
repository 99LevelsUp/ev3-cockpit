/**
 * The rules of the platform packages, kept apart from the builds in `package-vsix.cjs` and
 * `package-npm.cjs` so they can be tested (`src/__tests__/packaging.test.ts`).
 *
 * Each platform's VSIX carries the native daemon `ev3-cockpitd` built for it, with the manifest
 * that records its SHA-256, version and build kind; the extension starts a verified copy of it and
 * refuses one whose hash does not match. Nothing else of the repository ships: the package is
 * built from an allow-list and checked after it is built, because a deny-list once shipped review
 * scratch, notes, logs and a junction to the firmware sources, and a VSIX without its binaries
 * installed cleanly and then could not reach a brick.
 */
'use strict';

const crypto = require('crypto');
const zlib = require('zlib');
const { builtinModules } = require('module');

/**
 * The platforms a release ships for, each with the Rust target its daemon is built for. Linux
 * binaries are built against glibc 2.35, so they run on Debian 12 and Raspberry Pi OS.
 */
const TARGETS = {
	'win32-x64': { os: 'win32', cpu: 'x64', triple: 'x86_64-pc-windows-msvc', udevRule: false },
	'linux-x64': { os: 'linux', cpu: 'x64', triple: 'x86_64-unknown-linux-gnu', udevRule: true },
	'linux-arm64': { os: 'linux', cpu: 'arm64', triple: 'aarch64-unknown-linux-gnu', udevRule: true },
};

/** The file beside the daemon that records its SHA-256, version and build kind (`DAEMON_MANIFEST` of the client). */
const DAEMON_MANIFEST = 'ev3-cockpitd.manifest.json';
const DAEMON_NAMES = ['ev3-cockpitd', 'ev3-cockpitd.exe'];

/** The daemon's file name on a target. */
function daemonBinary(target) {
	return TARGETS[target].os === 'win32' ? 'ev3-cockpitd.exe' : 'ev3-cockpitd';
}

/**
 * The Node native modules the old Node daemon loaded. Nothing packaged carries or requires them
 * any more: the bundles still leave them external, so an import of one that crept back shows as a
 * `require` the checks here refuse, instead of being inlined without its binary.
 */
const NATIVE_MODULES = ['usb', 'node-hid', 'serialport', 'koffi'];

/**
 * The extension's own files, relative to the repository. The daemon and its manifest lie in the
 * extension's root, the folder an installed extension reads them from (`context.extensionPath`).
 * The `ev3` command and the MCP server ship in the npm package, not here.
 */
const SHIPPED_FILES = ['package.json', 'README.md', 'CHANGELOG.md', 'LICENSE', 'out/extension.js'];

/**
 * The udev rule a Linux user installs once for USB; the daemon's permission message names it at
 * this path in the extension's folder, so a Linux VSIX must carry it.
 */
const UDEV_RULE = 'native/linux/70-lego-ev3.rules';
/**
 * The udev rule that lets the daemon restart a USB Bluetooth adapter that stopped answering; the
 * message about such an adapter names it.
 */
const BT_RESTART_RULE = 'native/linux/71-ev3-cockpit-bluetooth-restart.rules';
const UDEV_RULES = [UDEV_RULE, BT_RESTART_RULE];

/** The repository files a target's VSIX carries, besides the daemon. */
function SHIPPED_FILES_FOR(target) {
	return TARGETS[target].udevRule ? [...SHIPPED_FILES, ...UDEV_RULES] : [...SHIPPED_FILES];
}

/**
 * The packages a piece of bundled or compiled code requires, by package name, leaving out Node's own
 * modules and relative files. A `require("…")` inside a string is code another library generates
 * (ajv in the MCP bundle), not a call, and does not count.
 */
function requiredModules(source) {
	const found = new Set();
	const call = /(?<![\w$.'"`])(?:__)?require\(\s*["']([^"']+)["']\s*\)/g;
	for (let match = call.exec(source); match; match = call.exec(source)) {
		const id = match[1];
		if (id.startsWith('.') || id.startsWith('node:') || builtinModules.includes(id.split('/')[0])) { continue; }
		const parts = id.split('/');
		found.add(id.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]);
	}
	return [...found].sort();
}

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

/**
 * The entries of a zip, read from its central directory: each with its name, whether a Unix system
 * made it, its Unix mode (what an extractor gives the file on Linux), and its contents on demand.
 * A VSIX is a zip.
 */
function readZip(zip) {
	const view = Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength);
	let end = -1;
	for (let at = view.length - 22; at >= 0; at -= 1) {
		if (view.readUInt32LE(at) === 0x06054b50) { end = at; break; }
	}
	if (end < 0) { throw new Error('Not a zip: no end of central directory.'); }
	const count = view.readUInt16LE(end + 10);
	let at = view.readUInt32LE(end + 16);
	const entries = [];
	for (let i = 0; i < count; i += 1) {
		if (view.readUInt32LE(at) !== 0x02014b50) { throw new Error(`Not a zip: a broken central directory at ${at}.`); }
		const madeBy = view.readUInt16LE(at + 4) >> 8;
		const method = view.readUInt16LE(at + 10);
		const compressedSize = view.readUInt32LE(at + 20);
		const nameLength = view.readUInt16LE(at + 28);
		const extraLength = view.readUInt16LE(at + 30);
		const commentLength = view.readUInt16LE(at + 32);
		const external = view.readUInt32LE(at + 38);
		const local = view.readUInt32LE(at + 42);
		const name = view.toString('utf8', at + 46, at + 46 + nameLength);
		entries.push({
			name,
			unix: madeBy === 3,
			mode: madeBy === 3 ? external >>> 16 : 0,
			data() {
				if (compressedSize === 0xffffffff || local === 0xffffffff) { throw new Error(`${name}: zip64 entries are not read.`); }
				if (view.readUInt32LE(local) !== 0x04034b50) { throw new Error(`${name}: a broken local header at ${local}.`); }
				const start = local + 30 + view.readUInt16LE(local + 26) + view.readUInt16LE(local + 28);
				const raw = view.subarray(start, start + compressedSize);
				if (method === 0) { return Buffer.from(raw); }
				if (method === 8) { return zlib.inflateRawSync(raw); }
				throw new Error(`${name}: compression method ${method} is not read.`);
			},
		});
		at += 46 + nameLength + extraLength + commentLength;
	}
	return entries;
}

/** The names in a zip. */
function listZipEntries(zip) {
	return readZip(zip).map((entry) => entry.name);
}

/** The repository files a VSIX may carry, lowercased as vsce may rename them, relative to `extension/`. */
function allowedFiles(target) {
	return new Set(['package.json', 'readme.md', 'changelog.md', 'license', 'license.txt', 'out/extension.js',
		daemonBinary(target), DAEMON_MANIFEST, ...(TARGETS[target].udevRule ? UDEV_RULES : [])].map((file) => file.toLowerCase()));
}

/** What a target's VSIX must hold, as entry names (vsce may add `.txt` to the license). */
function required(target) {
	return [
		'extension/package.json',
		'extension/LICENSE',
		'extension/out/extension.js',
		`extension/${daemonBinary(target)}`,
		`extension/${DAEMON_MANIFEST}`,
		...(TARGETS[target].udevRule ? UDEV_RULES.map((rule) => `extension/${rule}`) : []),
	];
}

/**
 * The problems of a daemon binary and the manifest beside it, wherever they lie (a VSIX, an npm
 * platform package): the manifest names the binary, records its SHA-256, the package's version and
 * the release build kind, and on Linux the binary is executable.
 *
 * @param target  the platform it is for
 * @param binary  `{ data: Buffer, mode?: number }`, mode as Unix permissions where they are known
 * @param manifestText  the manifest's text
 * @param version  the version of the package carrying it
 */
function daemonProblems(target, binary, manifestText, version) {
	const problems = [];
	let manifest;
	try {
		manifest = JSON.parse(manifestText);
	} catch {
		return [`${DAEMON_MANIFEST} is not JSON.`];
	}
	const name = daemonBinary(target);
	if (manifest.binary !== name) { problems.push(`${DAEMON_MANIFEST} names ${manifest.binary}, not ${name}.`); }
	const actual = sha256(binary.data);
	if (manifest.sha256 !== actual) { problems.push(`${name} has SHA-256 ${actual}; ${DAEMON_MANIFEST} records ${manifest.sha256}, so the client would refuse it.`); }
	if (manifest.version !== version) { problems.push(`${DAEMON_MANIFEST} records version ${manifest.version}; the package is ${version}.`); }
	// A development build in a published package makes every installed client a development one's peer.
	if (manifest.buildKind !== 'release') { problems.push(`${DAEMON_MANIFEST} records a ${manifest.buildKind} build; a package carries a release build (EV3_COCKPIT_RELEASE_BUILD=1).`); }
	if (TARGETS[target].os !== 'win32' && binary.mode !== undefined && (binary.mode & 0o111) !== 0o111) {
		problems.push(`${name} is not executable (mode ${(binary.mode & 0o777).toString(8)}); a Linux package is built on Linux, where the build keeps the mode.`);
	}
	return problems;
}

/**
 * Checks a built VSIX: what it lacks, what it carries that it should not, and whether its daemon
 * is the one its manifest records. `entries` are {@link readZip}'s; `version` is the package's.
 */
function checkVsix(target, entries, version) {
	const names = entries.map((entry) => entry.name);
	const missing = required(target).filter((need) => !names.some((name) => name === need || (need === 'extension/LICENSE' && name === `${need}.txt`)));
	const allowed = allowedFiles(target);
	const unexpected = names.filter((name) => name.startsWith('extension/') && !allowed.has(name.slice('extension/'.length).toLowerCase()));
	const problems = [];

	const daemons = entries.filter((entry) => DAEMON_NAMES.includes(entry.name.split('/').pop()));
	if (daemons.length !== 1) { problems.push(`The VSIX carries ${daemons.length} daemon binaries; it carries exactly one.`); }
	const binary = entries.find((entry) => entry.name === `extension/${daemonBinary(target)}`);
	const manifest = entries.find((entry) => entry.name === `extension/${DAEMON_MANIFEST}`);
	if (binary && manifest) {
		if (TARGETS[target].os !== 'win32' && !binary.unix) {
			problems.push(`${daemonBinary(target)} was not packed on a Unix system, so it lands without an executable bit; build a Linux VSIX on Linux.`);
		}
		problems.push(...daemonProblems(target, { data: binary.data(), mode: binary.unix ? binary.mode : undefined }, manifest.data().toString('utf8'), version));
	}
	const extension = entries.find((entry) => entry.name === 'extension/out/extension.js');
	if (extension) {
		// The VSIX carries no node_modules: anything the bundle requires besides VS Code is missing once installed.
		const stray = requiredModules(extension.data().toString('utf8')).filter((module) => module !== 'vscode');
		if (stray.length) { problems.push(`out/extension.js requires ${stray.join(', ')}, which the VSIX does not carry.`); }
	}
	return { missing, unexpected, problems };
}

module.exports = {
	TARGETS, DAEMON_MANIFEST, NATIVE_MODULES, SHIPPED_FILES, SHIPPED_FILES_FOR, UDEV_RULES,
	daemonBinary, requiredModules, readZip, listZipEntries, daemonProblems, checkVsix,
};
