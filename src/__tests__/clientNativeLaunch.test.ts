/**
 * How a client starts the native daemon, without the daemon itself: the verified copy and its
 * private folder, where the binary comes from, the install record, how a failed start is
 * classified (Smart App Control above all), and what the client decides about a daemon it meets.
 */

import { daemonRefusesThisProcess } from './elevation';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Duplex } from 'node:stream';
import { after, describe, it } from 'node:test';
import type { NativeChannelHost } from '../client/channel';
import { ContractError, createEndpoint } from '../client/connection';
import { nativeChannelFiles } from '../client/locate';
import { NativeCockpitClient } from '../client/nativeClient';
import { LaunchingClient, askToExit, decideOnDaemon, ensureNativeDaemon } from '../client/nativeDaemon';
import {
	DAEMON_MANIFEST, DaemonStartError, LaunchHost, SpawnOutcome, checkPrivateDir, daemonBinaryName, developmentDaemon,
	ensurePrivateDir, installedNativeLaunch, nativeInstallFile, othersInSddl, packagedDaemon, readLaunchSpec, recordNativeInstall,
	removeOldCopies, systemLaunchHost, verifiedCopy,
} from '../client/nativeLaunch';
import { daemonProof, newNonce } from '../contract/hello';
import { CONTRACT_VERSION } from '../contract/generated';
import type { BuildKind, DaemonExitResult, HelloAccepted, HelloStart, LaunchSpec } from '../contract/generated';
import { duplexPair } from './duplexPair';

const isWindows = process.platform === 'win32';
/** Windows only: libuv opens a file with no sharing when this flag is set, as a running image is held. */
const EXCLUSIVE = 0x10000000;

const roots: string[] = [];
const cleanups: Array<() => void> = [];
after(() => {
	for (const cleanup of cleanups.splice(0)) { try { cleanup(); } catch { /* best effort */ } }
	for (const root of roots) { fs.rmSync(root, { recursive: true, force: true }); }
});

function tempDir(prefix = 'ev3-launch-'): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	roots.push(dir);
	return dir;
}

const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');

/** A package directory with a small stand-in for the binary and the manifest beside it. */
function fakePackage(content = 'a stand-in for the daemon', manifest: Record<string, unknown> = {}): { dir: string; launch: LaunchSpec } {
	const dir = tempDir('ev3-pkg-');
	const name = daemonBinaryName();
	fs.writeFileSync(path.join(dir, name), content);
	const written = { binary: name, sha256: sha256(content), version: '1.0.0', buildKind: 'release', ...manifest };
	fs.writeFileSync(path.join(dir, DAEMON_MANIFEST), JSON.stringify(written));
	return { dir, launch: { binary: path.join(dir, name), sha256: written.sha256 as string, version: '1.0.0', buildKind: written.buildKind as BuildKind } };
}

interface FakeHost extends LaunchHost {
	readonly spawns: Array<{ file: string; args: readonly string[]; cwd: string }>;
	policyReads: number;
}

/**
 * A host on `platform` whose directories pass as private and whose spawned daemon ends at once
 * with `outcome`; the Smart App Control policy reads `policy`.
 */
function fakeHost(outcome: SpawnOutcome | undefined, policy: number | undefined, platform: NodeJS.Platform = 'win32', overrides: Partial<LaunchHost> = {}): FakeHost {
	const host: FakeHost = {
		platform,
		uid: 1000,
		spawns: [],
		policyReads: 0,
		lstat: (target) => {
			const stat = fs.lstatSync(target);
			return { isDirectory: () => stat.isDirectory(), isSymbolicLink: () => stat.isSymbolicLink(), uid: 1000, mode: 0o40700 };
		},
		restrictToUser: () => undefined,
		othersWithAccess: () => [],
		spawn(file, args, cwd) {
			host.spawns.push({ file, args, cwd });
			return { pid: 999_999, outcome: () => outcome };
		},
		smartAppControlPolicy() {
			host.policyReads++;
			return policy;
		},
		...overrides,
	};
	return host;
}

function spawnError(code: string, errno: number, message = `spawn ${code}`): SpawnOutcome {
	return { kind: 'error', error: Object.assign(new Error(message), { code, errno }) };
}

function failure(kind: DaemonStartError['failure']) {
	return (error: unknown): boolean => {
		assert.ok(error instanceof DaemonStartError, `expected a DaemonStartError, got ${String(error)}`);
		assert.equal(error.failure, kind, error.message);
		assert.equal(error.code, 'daemon_unavailable');
		return true;
	};
}

describe('the verified copy', () => {
	it('refuses a packaged binary whose SHA-256 differs from the package\'s, names both, and starts nothing', async () => {
		const { launch } = fakePackage('the real daemon');
		const recorded = sha256('what the package promised');
		const host = fakeHost(undefined, 0);
		const root = tempDir();
		await assert.rejects(ensureNativeDaemon({
			name: 'test', kind: 'vscode', version: '1.0.0', daemon: { ...launch, sha256: recorded },
			stateRoot: root, channel: 'sha', host, readinessMs: 500,
		}), (error: unknown) => {
			failure('sha_mismatch')(error);
			const message = (error as Error).message;
			assert.ok(message.includes(launch.binary), message);
			assert.ok(message.includes(recorded), message);
			assert.ok(message.includes(sha256('the real daemon')), message);
			return true;
		});
		assert.equal(host.spawns.length, 0, 'nothing was started');
		assert.deepEqual(fs.readdirSync(path.join(root, 'bin', recorded)), [], 'no copy and no temporary file stays behind');
	});

	it('replaces a stale copy instead of refusing it, and starts exactly the verified path from the state root', async () => {
		const { launch } = fakePackage('version two');
		const root = tempDir();
		const target = path.join(root, 'bin', launch.sha256, daemonBinaryName('win32'));
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, 'version one, or a damaged copy');
		const host = fakeHost({ kind: 'exit', code: 1, signal: null }, 0);
		await assert.rejects(ensureNativeDaemon({
			name: 'test', kind: 'vscode', version: '1.0.0', daemon: launch, stateRoot: root, channel: 'stale', host, readinessMs: 500,
		}), failure('failed'));
		assert.equal(fs.readFileSync(target, 'utf8'), 'version two');
		assert.deepEqual(host.spawns.map((s) => [s.file, s.cwd]), [[target, root]]);
		assert.deepEqual(host.spawns[0].args.slice(0, 4), ['--channel', 'stale', '--state-root', root]);
	});

	it('reuses a copy that verifies without reading the source again', async () => {
		const { launch } = fakePackage('stays');
		const root = tempDir();
		const host = fakeHost(undefined, 0, process.platform);
		const first = await verifiedCopy(launch, root, host);
		fs.rmSync(launch.binary);
		assert.equal(await verifiedCopy(launch, root, host), first);
		assert.deepEqual(fs.readdirSync(path.dirname(first)), [daemonBinaryName()], 'the folder holds only the binary');
	});

	it('produces no false mismatch when several clients copy at once', async () => {
		const { launch } = fakePackage(randomBytes(512 * 1024).toString('hex'));
		const root = tempDir();
		const host = fakeHost(undefined, 0, process.platform);
		const copies = await Promise.all(Array.from({ length: 5 }, () => verifiedCopy(launch, root, host)));
		assert.equal(new Set(copies).size, 1);
		assert.equal(sha256(fs.readFileSync(copies[0])), launch.sha256);
		assert.deepEqual(fs.readdirSync(path.dirname(copies[0])), [daemonBinaryName()]);
	});

	/** A copy folder last used `ageMs` ago. */
	function copyFolder(root: string, sha: string, ageMs = 0): string {
		const dir = path.join(root, 'bin', sha);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, daemonBinaryName()), sha);
		const at = new Date(Date.now() - ageMs);
		fs.utimesSync(dir, at, at);
		return dir;
	}

	it('removes copies other than the current and the running one, but not one used in the last minutes', () => {
		const root = tempDir();
		const [current, running, old, recent] = ['c', 'r', 'o', 'n'].map((s) => sha256(s));
		const hour = 60 * 60_000;
		copyFolder(root, current, hour);
		copyFolder(root, running, hour);
		copyFolder(root, old, hour);
		copyFolder(root, recent, 60_000);
		removeOldCopies(root, [current, running]);
		assert.deepEqual(fs.readdirSync(path.join(root, 'bin')).sort(), [current, running, recent].sort());
	});

	it('a copy that verifies counts as just used, so another client\'s clean-up leaves it until it starts', async () => {
		const { launch } = fakePackage('in use');
		const root = tempDir();
		const host = fakeHost(undefined, 0, process.platform);
		const copy = await verifiedCopy(launch, root, host);
		const long = new Date(Date.now() - 60 * 60_000);
		fs.utimesSync(path.dirname(copy), long, long);
		assert.equal(await verifiedCopy(launch, root, host), copy);
		removeOldCopies(root, []);
		assert.equal(fs.existsSync(copy), true);
	});

	it('Windows: skips a copy that is locked, as a running daemon\'s is', { skip: !isWindows }, () => {
		const root = tempDir();
		const file = path.join(copyFolder(root, sha256('old'), 60 * 60_000), daemonBinaryName());
		const handle = fs.openSync(file, fs.constants.O_RDONLY | EXCLUSIVE);
		try {
			assert.doesNotThrow(() => removeOldCopies(root, []));
			assert.equal(fs.existsSync(file), true);
		} finally {
			fs.closeSync(handle);
		}
		removeOldCopies(root, []);
		assert.equal(fs.existsSync(path.dirname(file)), false, 'gone once nothing holds it');
	});
});

describe('the folder of the verified copies', { skip: daemonRefusesThisProcess }, () => {
	const stat = (over: Partial<{ dir: boolean; link: boolean; uid: number; mode: number }> = {}) => ({
		isDirectory: () => over.dir ?? true, isSymbolicLink: () => over.link ?? false, uid: over.uid ?? 1000, mode: over.mode ?? 0o40700,
	});
	const unix = (s: ReturnType<typeof stat>): LaunchHost => fakeHost(undefined, undefined, 'linux', { lstat: () => s });

	it('passes a plain folder of the user\'s that nobody else can open', () => {
		assert.doesNotThrow(() => checkPrivateDir('/state/bin', unix(stat())));
	});

	for (const [what, s] of [
		['open to the group', stat({ mode: 0o40750 })],
		['open to others', stat({ mode: 0o40705 })],
		['another user\'s', stat({ uid: 1001 })],
		['a link', stat({ link: true })],
		['a file', stat({ dir: false })],
	] as const) {
		it(`Linux and macOS: refuses a folder that is ${what}`, () => {
			assert.throws(() => checkPrivateDir('/state/bin', unix(s)), failure('not_private'));
		});
	}

	it('Windows: refuses a folder whose access list lets someone else in, naming them', () => {
		const host = fakeHost(undefined, undefined, 'win32', { othersWithAccess: () => ['S-1-5-32-545'] });
		assert.throws(() => checkPrivateDir(tempDir(), host), (error: unknown) => failure('not_private')(error) && /S-1-5-32-545/.test((error as Error).message));
	});

	it('reads the SIDs an SDDL access list lets in, leaving out the user, SYSTEM and the Administrators', () => {
		const me = 'S-1-5-21-1-2-3-1001';
		assert.deepEqual(othersInSddl(`D:PAI(A;OICI;FA;;;${me})`, me), []);
		assert.deepEqual(othersInSddl(`D:AI(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)(A;OICIID;FA;;;${me})`, me), []);
		assert.deepEqual(othersInSddl(`D:AI(A;OICIID;0x1301bf;;;S-1-5-21-1-2-3-1002)(D;;FA;;;S-1-1-0)(A;OICIID;FA;;;${me})(A;OICIIOID;GA;;;CO)`, me),
			['S-1-5-21-1-2-3-1002', 'CO']);
	});

	it('Windows, for real: makes the folders owner-only and refuses one others can write to', { skip: !isWindows }, () => {
		const host = systemLaunchHost();
		const root = tempDir();
		const mine = path.join(root, 'bin');
		ensurePrivateDir(mine, host);
		assert.deepEqual(host.othersWithAccess(mine), []);
		const shared = path.join(root, 'shared');
		fs.mkdirSync(shared);
		const icacls = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe');
		assert.equal(spawnSync(icacls, [shared, '/grant', '*S-1-5-32-545:(OI)(CI)M', '/q']).status, 0);
		assert.throws(() => ensurePrivateDir(shared, host), failure('not_private'));
	});

	it('Linux and macOS, for real: the folders are made with no group or other permissions', { skip: isWindows }, () => {
		const root = tempDir();
		ensurePrivateDir(path.join(root, 'bin'), systemLaunchHost());
		assert.equal(fs.statSync(path.join(root, 'bin')).mode & 0o077, 0);
	});
});

describe('where the binary comes from', () => {
	it('a packaged client reads its package\'s manifest, and nothing in the environment moves it', () => {
		const { dir, launch } = fakePackage();
		const elsewhere = fakePackage('another daemon').dir;
		const saved = { ...process.env };
		try {
			for (const name of ['EV3_COCKPIT_DAEMON', 'EV3_COCKPIT_DAEMON_BINARY', 'EV3_COCKPIT_BINARY', 'EV3_COCKPITD', 'EV3_COCKPIT_DAEMON_DIR', 'EV3_COCKPIT_DEV']) {
				process.env[name] = path.join(elsewhere, daemonBinaryName());
			}
			process.env.EV3_COCKPIT_CHANNEL = 'dev';
			assert.deepEqual(packagedDaemon(dir), launch);
		} finally {
			for (const name of Object.keys(process.env)) { if (!(name in saved)) { delete process.env[name]; } }
			Object.assign(process.env, saved);
		}
	});

	it('refuses a manifest that is missing, invalid, or names a file outside its folder', () => {
		const empty = tempDir();
		assert.throws(() => packagedDaemon(empty), (e: unknown) => failure('missing_binary')(e) && /Reinstall/.test((e as Error).message));
		const { dir } = fakePackage('x', { binary: `..${path.sep}${daemonBinaryName()}` });
		assert.throws(() => packagedDaemon(dir), failure('missing_binary'));
		const bad = fakePackage('x', { sha256: 'not a hash' }).dir;
		assert.throws(() => packagedDaemon(bad), failure('missing_binary'));
		const gone = fakePackage('x');
		fs.rmSync(gone.launch.binary);
		assert.throws(() => packagedDaemon(gone.dir), failure('missing_binary'));
	});

	it('a development client takes the build whose manifest was written last, and says how to build one', () => {
		const repo = tempDir('ev3-repo-');
		assert.throws(() => developmentDaemon(repo), (e: unknown) => failure('missing_binary')(e) && /npm run daemon:build/.test((e as Error).message));
		const write = (profile: string, content: string, at: Date): void => {
			const dir = path.join(repo, 'daemon', 'target', profile);
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, daemonBinaryName()), content);
			const manifest = path.join(dir, DAEMON_MANIFEST);
			fs.writeFileSync(manifest, JSON.stringify({ binary: daemonBinaryName(), sha256: sha256(content), version: '0.0.0', buildKind: 'development' }));
			fs.utimesSync(manifest, at, at);
		};
		write('debug', 'debug build', new Date(Date.now() - 60_000));
		write('release', 'optimised build', new Date());
		assert.equal(developmentDaemon(repo).sha256, sha256('optimised build'));
		assert.equal(developmentDaemon(repo, 'debug').sha256, sha256('debug build'));
		assert.equal(developmentDaemon(repo).buildKind, 'development');
	});

	it('a development build changed after its manifest is refused with how to rebuild it', async () => {
		const { launch } = fakePackage('built');
		fs.writeFileSync(launch.binary, 'built again, manifest not written');
		await assert.rejects(verifiedCopy({ ...launch, buildKind: 'development' }, tempDir(), fakeHost(undefined, 0, process.platform)),
			(e: unknown) => failure('sha_mismatch')(e) && /npm run daemon:build/.test((e as Error).message));
	});
});

describe('the install record', () => {
	it('records the installed daemon for add-ons and reads it back, whole', () => {
		const { launch } = fakePackage();
		const files = nativeChannelFiles(tempDir());
		assert.equal(installedNativeLaunch(files), undefined);
		recordNativeInstall(files, launch);
		assert.deepEqual(installedNativeLaunch(files), launch);
		assert.deepEqual(JSON.parse(fs.readFileSync(nativeInstallFile(files), 'utf8')), launch);
		assert.deepEqual(fs.readdirSync(files.dir), ['install.json'], 'no temporary file stays behind');
	});

	it('refuses a record that is not a launch, or whose binary is gone', () => {
		const files = nativeChannelFiles(tempDir());
		const good = fakePackage().launch;
		for (const bad of [
			{ ...good, sha256: 'ABC' }, { ...good, binary: 'relative/ev3-cockpitd' }, { ...good, buildKind: 'nightly' }, { ...good, version: '' },
			{ runtime: process.execPath, entry: 'daemon.js', installRoot: '/', version: '1' },
		]) {
			assert.equal(readLaunchSpec(bad), undefined, JSON.stringify(bad));
		}
		fs.writeFileSync(nativeInstallFile(files), JSON.stringify({ ...good, binary: path.join(tempDir(), 'gone') }));
		assert.equal(installedNativeLaunch(files), undefined);
	});

	it('an add-on with no record and no daemon running says the cockpit is not installed', async () => {
		await assert.rejects(ensureNativeDaemon({ name: 'add-on', kind: 'addon', version: '3.0.0', stateRoot: tempDir(), channel: 'addon', host: fakeHost(undefined, 0) }),
			(e: unknown) => failure('missing_binary')(e) && /install EVƎ Cockpit/.test((e as Error).message));
	});
});

describe('a start that fails', () => {
	const start = (host: FakeHost, readinessMs = 500) => ensureNativeDaemon({
		name: 'test', kind: 'vscode', version: '1.0.0', daemon: fakePackage().launch, stateRoot: tempDir(), channel: 'sac', host, readinessMs,
	});

	it('Windows: a generic spawn error while Smart App Control is on is read as Smart App Control and not retried', async () => {
		const host = fakeHost(spawnError('UNKNOWN', -4094), 1);
		await assert.rejects(start(host), (e: unknown) => failure('smart_app_control')(e) && /Smart App Control/.test((e as Error).message)
			&& !/turn .* off|switch .* off|disable/i.test((e as Error).message));
		assert.equal(host.spawns.length, 1);
		assert.equal(host.policyReads, 1);
	});

	it('Windows: the same in evaluation mode, and for a daemon that ends before the hello', async () => {
		await assert.rejects(start(fakeHost(spawnError('EACCES', -4092), 2)), failure('smart_app_control'));
		const exited = fakeHost({ kind: 'exit', code: 3221226536, signal: null }, 1);
		await assert.rejects(start(exited), failure('smart_app_control'));
		assert.equal(exited.spawns.length, 1);
	});

	it('Windows: a daemon that exited with one of its own codes ran, so it is never Smart App Control', async () => {
		for (const code of [0, 1, 64]) {
			for (const policy of [1, 2]) {
				const host = fakeHost({ kind: 'exit', code, signal: null }, policy);
				await assert.rejects(start(host), (e: unknown) => failure('failed')(e) && new RegExp(`code ${code}\\b`).test((e as Error).message),
					`exit ${code} under policy ${policy}`);
				assert.equal(host.spawns.length, 1);
			}
		}
		await assert.rejects(start(fakeHost({ kind: 'exit', code: 3, signal: null }, 2)), failure('name_held'));
	});

	it('Windows: an exit before the hello with a code the daemon never uses is Smart App Control while the policy reads on', async () => {
		const host = fakeHost({ kind: 'exit', code: 5, signal: null }, 1);
		await assert.rejects(start(host), failure('smart_app_control'));
		assert.equal(host.spawns.length, 1);
		await assert.rejects(start(fakeHost({ kind: 'exit', code: 5, signal: null }, 0)), failure('failed'));
	});

	it('Windows: error 4551, the code-integrity violation itself, is Smart App Control whatever the policy reads', async () => {
		const host = fakeHost(spawnError('UNKNOWN', 4551, 'spawn UNKNOWN (4551)'), 0);
		await assert.rejects(start(host), failure('smart_app_control'));
		assert.equal(host.spawns.length, 1);
		await assert.rejects(start(fakeHost(spawnError('UNKNOWN', -4551), undefined)), failure('smart_app_control'));
		await assert.rejects(start(fakeHost({ kind: 'exit', code: 4551, signal: null }, 0)), failure('smart_app_control'));
	});

	it('Windows: with Smart App Control off a failed spawn is a plain failure naming the error', async () => {
		await assert.rejects(start(fakeHost(spawnError('UNKNOWN', -4094), 0)), (e: unknown) => failure('failed')(e) && /UNKNOWN/.test((e as Error).message));
		await assert.rejects(start(fakeHost(spawnError('UNKNOWN', -4094), undefined)), failure('failed'));
	});

	it('Linux: never asks about Smart App Control', async () => {
		const host = fakeHost(spawnError('EACCES', -13), 1, 'linux');
		await assert.rejects(start(host), failure('failed'));
		assert.equal(host.policyReads, 0);
	});

	it('exit code 3 is a refusal to run, with the daemon\'s log; never Smart App Control', async () => {
		const host = fakeHost({ kind: 'exit', code: 3, signal: null }, 1);
		await assert.rejects(start(host), failure('name_held'));
		assert.equal(host.spawns.length, 1);
	});

	it('exit code 2 means another daemon holds the lock: the client waits, starts again briefly, then says so', async () => {
		const host = fakeHost({ kind: 'exit', code: 2, signal: null }, 1);
		await assert.rejects(start(host, 1800), failure('lock_held'));
		assert.ok(host.spawns.length >= 2, `started ${host.spawns.length} times`);
		assert.equal(host.policyReads, 0, 'a daemon that ran is never Smart App Control');
	});
});

describe('what a client does about a daemon it meets', () => {
	const client = (kind: LaunchingClient['kind'], buildKind: BuildKind, version = '1.0.0', canStart = true): LaunchingClient =>
		({ kind, buildKind, version, contractVersion: CONTRACT_VERSION, canStart });
	const daemon = (buildKind: BuildKind, version = '1.0.0', contractVersion = CONTRACT_VERSION) => ({ buildKind, version, contractVersion });

	it('follows the launch rules', () => {
		assert.deepEqual(decideOnDaemon(client('vscode', 'development'), daemon('release')), { action: 'replace' });
		assert.deepEqual(decideOnDaemon(client('cli', 'development'), daemon('release', '9.0.0', CONTRACT_VERSION + 1)), { action: 'replace' });
		assert.deepEqual(decideOnDaemon(client('vscode', 'development'), daemon('development', '0.1.0')), { action: 'use' });
		assert.equal(decideOnDaemon(client('vscode', 'development'), daemon('development', '1.0.0', CONTRACT_VERSION + 1)).action, 'stop');
		const dev = decideOnDaemon(client('vscode', 'release'), daemon('development'));
		assert.equal(dev.action, 'use');
		assert.match((dev as { notice: string }).notice, /development build/);
		assert.equal(decideOnDaemon(client('vscode', 'release'), daemon('development', '1.0.0', CONTRACT_VERSION + 1)).action, 'stop');
		assert.deepEqual(decideOnDaemon(client('cli', 'release', '1.2.0'), daemon('release', '1.1.9')), { action: 'replace' });
		assert.deepEqual(decideOnDaemon(client('cli', 'release', '1.1.0'), daemon('release', '1.1.0')), { action: 'use' });
		assert.deepEqual(decideOnDaemon(client('cli', 'release', '1.0.0'), daemon('release', '1.1.0')), { action: 'use' });
		assert.equal(decideOnDaemon(client('cli', 'release', '1.0.0'), daemon('release', '1.1.0', CONTRACT_VERSION + 1)).action, 'stop');
	});

	it('an add-on, the MCP server, and a client with no daemon of its own never ask a daemon to exit', () => {
		for (const c of [client('addon', 'development', '9.0.0'), client('mcp', 'development', '9.0.0'), client('vscode', 'development', '9.0.0', false)]) {
			assert.deepEqual(decideOnDaemon(c, daemon('release', '1.0.0')), { action: 'use' }, c.kind);
			assert.equal(decideOnDaemon(c, daemon('release', '1.0.0', CONTRACT_VERSION + 1)).action, 'stop', c.kind);
		}
	});
});

describe('a daemon on another contract', () => {
	const key = randomBytes(32);

	/** One fake daemon behind the channel: it proves the key, says who it is, and answers daemon/exit. */
	function fakeDaemon(accepted: Partial<HelloAccepted>, exit: DaemonExitResult) {
		const root = tempDir();
		const files = nativeChannelFiles(root, 'contract');
		fs.mkdirSync(files.dir, { recursive: true });
		fs.writeFileSync(files.channelFile, JSON.stringify({ path: isWindows ? '\\\\.\\pipe\\ev3-cockpit-fake' : '/run/ev3/daemon-fake.sock', pid: 4242 }));
		const seen = { exits: 0, starts: [] as HelloStart[] };
		const channelHost: NativeChannelHost = {
			platform: process.platform,
			uid: 1000,
			openLockForWriting: () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); },
			processAlive: () => true,
			lstat: () => ({ isDirectory: () => true, isSymbolicLink: () => false, uid: 1000, mode: 0o40700 }),
			connect: () => {
				const [a, b] = duplexPair();
				const daemon = createEndpoint(b);
				cleanups.push(() => daemon.close());
				const daemonNonce = newNonce();
				daemon.onRequest('hello/start', (params) => {
					const start = params as HelloStart;
					seen.starts.push(start);
					return { daemonNonce, daemonProof: daemonProof(key, start.clientNonce, daemonNonce) };
				});
				daemon.onRequest('hello/finish', () => ({
					version: '1.0.0', contractVersion: CONTRACT_VERSION + 1, buildKind: 'release', buildId: 'ab'.repeat(32), mode: 'hardware',
					pid: 4242, instanceId: 'fake', state: 'serving', ...accepted,
				}));
				daemon.onRequest('daemon/exit', () => { seen.exits++; return exit; });
				return Promise.resolve(a as Duplex);
			},
		};
		return { root, seen, channelHost };
	}

	it('a development client asks a release daemon to exit; refused, it says so with the reason and stops', async () => {
		const { root, seen, channelHost } = fakeDaemon({}, { accepted: false, reason: 'The daemon keeps running: a write to AAA is still running after 60 s.' });
		const notices: string[] = [];
		await assert.rejects(ensureNativeDaemon({
			name: 'dev window', kind: 'vscode', version: '1.0.0', daemon: { ...fakePackage().launch, buildKind: 'development' },
			stateRoot: root, channel: 'contract', host: fakeHost(undefined, 0), channelHost,
			keyHost: { readFile: () => key, sleep: () => Promise.resolve() }, onNotice: (text) => notices.push(text),
		}), (e: unknown) => failure('contract_mismatch')(e) && /still running after 60 s/.test((e as Error).message)
			&& new RegExp(`contract ${CONTRACT_VERSION + 1}`).test((e as Error).message));
		assert.equal(seen.exits, 1);
		assert.equal(seen.starts[0].buildKind, 'development');
		assert.match(notices.join('\n'), /still running after 60 s/);
	});

	it('a release client of the same version and a development client meeting a development daemon stop without asking', async () => {
		const release = fakeDaemon({}, { accepted: true });
		await assert.rejects(ensureNativeDaemon({
			name: 'ev3', kind: 'cli', version: '1.0.0', daemon: fakePackage().launch, stateRoot: release.root, channel: 'contract',
			host: fakeHost(undefined, 0), channelHost: release.channelHost, keyHost: { readFile: () => key, sleep: () => Promise.resolve() },
		}), failure('contract_mismatch'));
		assert.equal(release.seen.exits, 0);
		const dev = fakeDaemon({ buildKind: 'development' }, { accepted: true });
		await assert.rejects(ensureNativeDaemon({
			name: 'dev window', kind: 'vscode', version: '1.0.0', daemon: { ...fakePackage().launch, buildKind: 'development' },
			stateRoot: dev.root, channel: 'contract', host: fakeHost(undefined, 0), channelHost: dev.channelHost,
			keyHost: { readFile: () => key, sleep: () => Promise.resolve() },
		}), (e: unknown) => failure('contract_mismatch')(e) && /development build/.test((e as Error).message));
		assert.equal(dev.seen.exits, 0);
	});
});

describe('a client whose first requests fail', () => {
	it('is let go and does not connect again on its own', async () => {
		const key = randomBytes(32);
		const root = tempDir();
		const files = nativeChannelFiles(root, 'first');
		fs.mkdirSync(files.dir, { recursive: true });
		fs.writeFileSync(files.channelFile, JSON.stringify({ path: isWindows ? '\\\\.\\pipe\\ev3-cockpit-fake' : '/run/ev3/daemon-fake.sock', pid: 4242 }));
		let connects = 0;
		const channelHost: NativeChannelHost = {
			platform: process.platform,
			uid: 1000,
			openLockForWriting: () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); },
			processAlive: () => true,
			lstat: () => ({ isDirectory: () => true, isSymbolicLink: () => false, uid: 1000, mode: 0o40700 }),
			connect: () => {
				connects++;
				const [a, b] = duplexPair();
				const daemon = createEndpoint(b);
				cleanups.push(() => daemon.close());
				const daemonNonce = newNonce();
				daemon.onRequest('hello/start', (params) => {
					const start = params as HelloStart;
					return { daemonNonce, daemonProof: daemonProof(key, start.clientNonce, daemonNonce) };
				});
				daemon.onRequest('hello/finish', () => ({
					version: '1.0.0', contractVersion: CONTRACT_VERSION, buildKind: 'release', buildId: 'ab'.repeat(32), mode: 'hardware',
					pid: 4242, instanceId: 'fake', state: 'serving',
				}));
				// The daemon goes while the client asks for its first lists.
				daemon.onRequest('bricks/list', () => { setImmediate(() => daemon.close()); return new Promise(() => undefined); });
				return Promise.resolve(a as Duplex);
			},
		};
		await assert.rejects(NativeCockpitClient.connect({
			name: 'ev3 list (terminal)', kind: 'vscode', version: '1.0.0', buildKind: 'release', daemon: fakePackage().launch,
			stateRoot: root, channel: 'first', host: fakeHost(undefined, 0), channelHost,
			keyHost: { readFile: () => key, sleep: () => Promise.resolve() },
		}));
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.equal(connects, 1, 'the rejected client connected again behind the caller');
	});
});

describe('asking a daemon to exit', () => {
	function daemonAnswering(handler: () => unknown) {
		const [a, b] = duplexPair();
		const daemon = createEndpoint(b);
		const client = createEndpoint(a);
		cleanups.push(() => { daemon.close(); client.close(); });
		daemon.onRequest('daemon/exit', handler);
		return client;
	}

	it('counts an exit request the ending daemon cancelled as ending, not as a refusal', async () => {
		// Two clients asked at once: the daemon took the first and cancels the second as it shuts down.
		const client = daemonAnswering(() => { throw new ContractError('cancelled', 'daemon/exit was cancelled.'); });
		assert.deepEqual(await askToExit(client, 5000), { accepted: true });
	});

	it('passes a refusal on with its reason', async () => {
		const client = daemonAnswering(() => ({ accepted: false, reason: 'A write to AAA is still running.' }));
		assert.deepEqual(await askToExit(client, 5000), { accepted: false, reason: 'A write to AAA is still running.' });
	});
});

describe('a subscription whose first change comes before its answer', () => {
	it('hands the change on after the snapshot instead of dropping it', async () => {
		const key = randomBytes(32);
		const root = tempDir();
		const files = nativeChannelFiles(root, 'early');
		fs.mkdirSync(files.dir, { recursive: true });
		fs.writeFileSync(files.channelFile, JSON.stringify({ path: isWindows ? '\\\\.\\pipe\\ev3-cockpit-fake' : '/run/ev3/daemon-fake.sock', pid: 4242 }));
		const channelHost: NativeChannelHost = {
			platform: process.platform,
			uid: 1000,
			openLockForWriting: () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); },
			processAlive: () => true,
			lstat: () => ({ isDirectory: () => true, isSymbolicLink: () => false, uid: 1000, mode: 0o40700 }),
			connect: () => {
				const [a, b] = duplexPair();
				const daemon = createEndpoint(b);
				cleanups.push(() => daemon.close());
				const daemonNonce = newNonce();
				daemon.onRequest('hello/start', (params) => {
					const start = params as HelloStart;
					return { daemonNonce, daemonProof: daemonProof(key, start.clientNonce, daemonNonce) };
				});
				daemon.onRequest('hello/finish', () => ({
					version: '1.0.0', contractVersion: CONTRACT_VERSION, buildKind: 'release', buildId: 'ab'.repeat(32), mode: 'hardware',
					pid: 4242, instanceId: 'fake', state: 'serving',
				}));
				daemon.onRequest('bricks/list', () => ({ bricks: [] }));
				daemon.onRequest('settings/list', () => ({ settings: [] }));
				daemon.onRequest('settings/accessMode', () => ({ mode: 'safe' }));
				daemon.onRequest('telemetry/subscribe', async () => {
					// A change reaches the client before the answer does.
					await daemon.notify('telemetry/update', { subscriptionId: 'w1', brickId: 'b1', kind: 'change', values: [{ rowId: 'r', value: 2, sampledAt: 2, stale: false }], removed: [] });
					await new Promise((resolve) => setTimeout(resolve, 20));
					return { subscriptionId: 'w1', brickId: 'b1', grant: {}, snapshot: [{ rowId: 'r', value: 1, sampledAt: 1, stale: false }] };
				});
				return Promise.resolve(a as Duplex);
			},
		};
		const client = await NativeCockpitClient.connect({
			name: 'test', kind: 'vscode', version: '1.0.0', buildKind: 'release', daemon: fakePackage().launch,
			stateRoot: root, channel: 'early', host: fakeHost(undefined, 0), channelHost,
			keyHost: { readFile: () => key, sleep: () => Promise.resolve() }, reconnect: false,
		});
		cleanups.push(() => client.dispose());
		const heard: string[] = [];
		await client.subscribeTelemetry('b1', { rows: ['r'], intervalMs: 1000 }, (u) => { heard.push(`${u.kind}:${u.values.map((v) => v.value).join(',')}`); });
		assert.deepEqual(heard, ['snapshot:1', 'change:2']);
	});
});