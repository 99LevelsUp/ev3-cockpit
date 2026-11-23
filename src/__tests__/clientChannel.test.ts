/**
 * The client's way to the native daemon: where its files are, how it tells a live daemon from a
 * stale record, how it reads the key, and the hello in which both sides prove they hold the key.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { Duplex } from 'node:stream';
import { after, describe, it } from 'node:test';
import { NativeChannelHost, openNativeChannel, readChannelRecord } from '../client/channel';
import { createEndpoint } from '../client/connection';
import { KEY_READ_ATTEMPTS, KeyUnreadableError, NativeClientIdentity, connectNativeDaemon, readNativeKey } from '../client/hello';
import { NativeChannelFiles, nativeChannelFiles, nativeStateRoot } from '../client/locate';
import { clientProof, daemonProof } from '../client/proofs';
import { CONTRACT_VERSION } from '../contract/generated';
import type { HelloAccepted, HelloStart } from '../contract/generated';
import { duplexPair } from './duplexPair';

interface Vectors {
	hello: { key: string; cases: Array<{ clientNonce: string; daemonNonce: string; daemonProof: string; clientProof: string }> };
	channelRecord: Array<{ file: string; path: string; pid: number }>;
	stateRoot: Array<{ comment: string; platform: NodeJS.Platform; env: Record<string, string>; home: string; root: string }>;
	channelName: { valid: string[]; invalid: string[] };
}
const vectors = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'contract', 'vectors', 'channel.json'), 'utf8')) as Vectors;
const vectorKey = Buffer.from(vectors.hello.key, 'hex');

const isWindows = process.platform === 'win32';
/** Windows only: libuv opens a file with no sharing when this flag is set, as the daemon holds its lock. */
const EXCLUSIVE = 0x10000000;

const roots: string[] = [];
const cleanups: Array<() => void> = [];
after(() => {
	for (const cleanup of cleanups.splice(0)) { try { cleanup(); } catch { /* best effort */ } }
	for (const root of roots) { fs.rmSync(root, { recursive: true, force: true }); }
});

function tempRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ev3-native-'));
	roots.push(root);
	return root;
}

/** A place a fake daemon can listen: a pipe on Windows, a socket in a private directory elsewhere. */
function listenPath(): string {
	const name = randomBytes(6).toString('hex');
	if (isWindows) { return `\\\\.\\pipe\\ev3-cockpit-test-${name}`; }
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ev3-sock-'));
	fs.chmodSync(dir, 0o700);
	roots.push(dir);
	return path.join(dir, 'd.sock');
}

function writeRecord(files: NativeChannelFiles, record: { path: string; pid: number }): string {
	fs.mkdirSync(files.dir, { recursive: true });
	const text = JSON.stringify(record);
	fs.writeFileSync(files.channelFile, text, { mode: 0o600 });
	return text;
}

/** What a live daemon holds for its whole life: on Windows the lock file open with no sharing. */
function holdLock(files: NativeChannelFiles): () => void {
	fs.mkdirSync(files.dir, { recursive: true });
	if (!isWindows) { return () => undefined; }
	const handle = fs.openSync(files.lockFile, fs.constants.O_RDWR | fs.constants.O_CREAT | EXCLUSIVE);
	let open = true;
	const release = (): void => { if (open) { open = false; fs.closeSync(handle); } };
	cleanups.push(release);
	return release;
}

function hmac(label: string, clientNonce: string, daemonNonce: string): string {
	return createHmac('sha256', vectorKey).update(`${label}\n${clientNonce}\n${daemonNonce}`).digest('hex');
}

interface FakeDaemonOptions {
	readonly wrongProof?: boolean;
	readonly contractVersion?: number;
	readonly silent?: boolean;
}

interface FakeDaemon {
	connections: number;
	starts: HelloStart[];
	finishes: number;
	close(): Promise<void>;
}

/** A net server speaking the framed JSON-RPC hello with the vector key. */
async function fakeDaemon(where: string, options: FakeDaemonOptions = {}): Promise<FakeDaemon> {
	const sockets = new Set<net.Socket>();
	const state: FakeDaemon = {
		connections: 0, starts: [], finishes: 0,
		close: () => new Promise((resolve) => {
			for (const socket of sockets) { socket.destroy(); }
			server.close(() => resolve());
		}),
	};
	const server = net.createServer((socket) => {
		state.connections++;
		sockets.add(socket);
		socket.on('close', () => sockets.delete(socket));
		const endpoint = createEndpoint(socket);
		const daemonNonce = vectors.hello.cases[0].daemonNonce;
		let clientNonce = '';
		endpoint.onRequest('hello/start', (params) => {
			const start = params as HelloStart;
			state.starts.push(start);
			clientNonce = start.clientNonce;
			if (options.silent) { return new Promise(() => undefined); }
			return {
				daemonNonce,
				daemonProof: options.wrongProof ? hmac('daemon', 'someone else', daemonNonce) : hmac('daemon', clientNonce, daemonNonce),
			};
		});
		endpoint.onRequest('hello/finish', (params) => {
			state.finishes++;
			if ((params as { clientProof?: string }).clientProof !== hmac('client', clientNonce, daemonNonce)) {
				endpoint.close();
				return new Promise(() => undefined);
			}
			const accepted: HelloAccepted = {
				version: '9.8.7', contractVersion: options.contractVersion ?? CONTRACT_VERSION, buildKind: 'development',
				buildId: 'ab'.repeat(32), mode: 'replay', pid: 4242, instanceId: 'fake', state: 'serving', transports: ['usb'],
				addedLater: true,
			};
			return accepted;
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(where, () => { server.off('error', reject); resolve(); });
	});
	// A failed test leaves its daemon open; this closes it so the run can still end.
	cleanups.push(() => { for (const socket of sockets) { socket.destroy(); } server.close(); });
	return state;
}

/** A root with the vector key in it, as the daemon would leave it. */
function rootWithKey(): { root: string; files: NativeChannelFiles } {
	const root = tempRoot();
	const files = nativeChannelFiles(root);
	fs.writeFileSync(files.keyFile, vectorKey, { mode: 0o600 });
	return { root, files };
}

const me: NativeClientIdentity = { name: 'test client', kind: 'cli', version: '1.2.3', buildKind: 'development' };

/** A host where every operation fails the test, overridable one at a time. */
function strictHost(overrides: Partial<NativeChannelHost>): NativeChannelHost {
	const fail = (what: string) => (): never => { throw new assert.AssertionError({ message: `${what} must not be called` }); };
	return {
		platform: 'linux',
		uid: 1000,
		openLockForWriting: fail('openLockForWriting'),
		processAlive: fail('processAlive'),
		lstat: fail('lstat'),
		connect: fail('connect'),
		...overrides,
	};
}

const privateDir = { isDirectory: () => true, isSymbolicLink: () => false, uid: 1000, mode: 0o40700 };

function osError(code: string): NodeJS.ErrnoException {
	return Object.assign(new Error(code), { code });
}

describe('the hello proofs', () => {
	it('match the cross-language vectors the Rust daemon is checked against', () => {
		assert.equal(vectorKey.length, 32);
		for (const c of vectors.hello.cases) {
			assert.equal(daemonProof(vectorKey, c.clientNonce, c.daemonNonce), c.daemonProof);
			assert.equal(clientProof(vectorKey, c.clientNonce, c.daemonNonce), c.clientProof);
		}
	});
});

describe('channel.json', () => {
	it('reads every vector record, ignoring properties it does not know', () => {
		for (const record of vectors.channelRecord) {
			assert.deepEqual(readChannelRecord(record.file), { path: record.path, pid: record.pid });
		}
	});

	it('refuses a record without a path or a whole pid', () => {
		assert.equal(readChannelRecord('{"pid":1}'), undefined);
		assert.equal(readChannelRecord('{"path":"x","pid":1.5}'), undefined);
		assert.equal(readChannelRecord('{"path":"","pid":1}'), undefined);
		assert.equal(readChannelRecord('{"path":"x","pid":0}'), undefined);
		assert.equal(readChannelRecord('{"path":"x"'), undefined);
		assert.equal(readChannelRecord('[]'), undefined);
	});
});

describe('the state root', () => {
	it('is the platform state directory with a native subfolder', () => {
		assert.equal(nativeStateRoot({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, homedir: 'C:\\Users\\u' }),
			'C:\\Users\\u\\AppData\\Local\\ev3-cockpit\\native');
		assert.equal(nativeStateRoot({ platform: 'win32', env: {}, homedir: 'C:\\Users\\u' }),
			'C:\\Users\\u\\AppData\\Local\\ev3-cockpit\\native');
		assert.equal(nativeStateRoot({ platform: 'linux', env: { XDG_STATE_HOME: '/srv/state' }, homedir: '/home/u' }),
			'/srv/state/ev3-cockpit/native');
		assert.equal(nativeStateRoot({ platform: 'linux', env: {}, homedir: '/home/u' }), '/home/u/.local/state/ev3-cockpit/native');
		assert.equal(nativeStateRoot({ platform: 'darwin', env: {}, homedir: '/Users/u' }),
			'/Users/u/Library/Application Support/ev3-cockpit/native');
	});

	it('matches the cross-language vectors the Rust daemon is checked against', () => {
		for (const c of vectors.stateRoot) {
			assert.equal(nativeStateRoot({ platform: c.platform, env: c.env, homedir: c.home }), c.root, c.comment);
		}
		for (const name of vectors.channelName.valid) {
			assert.doesNotThrow(() => nativeChannelFiles('/s', name), name);
		}
		for (const name of vectors.channelName.invalid) {
			assert.throws(() => nativeChannelFiles('/s', name), /not a usable channel name/, JSON.stringify(name));
		}
	});

	it('puts a test channel under channels/<name>/ and shares the key', () => {
		const root = tempRoot();
		const own = nativeChannelFiles(root);
		assert.equal(own.dir, root);
		assert.equal(own.lockFile, path.join(root, 'daemon.lock'));
		assert.equal(own.channelFile, path.join(root, 'channel.json'));
		const test = nativeChannelFiles(root, 'test-1');
		assert.equal(test.dir, path.join(root, 'channels', 'test-1'));
		assert.equal(test.lockFile, path.join(root, 'channels', 'test-1', 'daemon.lock'));
		assert.equal(test.keyFile, own.keyFile);
	});

	it('refuses a channel name that could leave its directory', () => {
		const root = tempRoot();
		for (const bad of ['..', '../x', 'a/b', 'A', '', 'a\\b']) {
			assert.throws(() => nativeChannelFiles(root, bad), /not a usable channel name/, bad);
		}
	});
});

describe('finding the daemon', () => {
	it('reads a missing channel.json as no daemon, without probing anything', async () => {
		const files = nativeChannelFiles(tempRoot());
		assert.deepEqual(await openNativeChannel(files, strictHost({})), { kind: 'none' });
		assert.deepEqual(await openNativeChannel(files, strictHost({ platform: 'win32' })), { kind: 'none' });
	});

	it('deletes a record whose daemon no longer holds the lock, and never contacts it (this platform)', async () => {
		const where = listenPath();
		const daemon = await fakeDaemon(where);
		const files = nativeChannelFiles(tempRoot());
		if (isWindows) {
			holdLock(files)();
			writeRecord(files, { path: where, pid: process.pid });
		} else {
			const dead = spawnSync(process.execPath, ['-e', '']).pid;
			writeRecord(files, { path: where, pid: dead });
		}
		assert.deepEqual(await openNativeChannel(files), { kind: 'none' });
		assert.equal(fs.existsSync(files.channelFile), false);
		assert.equal(daemon.connections, 0);
		await daemon.close();
	});

	it('Windows: a lock file nobody holds means no daemon; the record goes while the client holds the lock', async () => {
		const files = nativeChannelFiles(tempRoot());
		writeRecord(files, { path: '\\\\.\\pipe\\old', pid: 1 });
		let presentWhileHeld: boolean | undefined;
		const host = strictHost({
			platform: 'win32',
			openLockForWriting: (file) => {
				assert.equal(file, files.lockFile);
				return () => { presentWhileHeld = fs.existsSync(files.channelFile); };
			},
		});
		assert.deepEqual(await openNativeChannel(files, host), { kind: 'none' });
		assert.equal(presentWhileHeld, false);
		assert.equal(fs.existsSync(files.channelFile), false);
	});

	it('Windows: a missing lock file means no daemon', async () => {
		const files = nativeChannelFiles(tempRoot());
		writeRecord(files, { path: '\\\\.\\pipe\\old', pid: 1 });
		const host = strictHost({ platform: 'win32', openLockForWriting: () => { throw osError('ENOENT'); } });
		assert.deepEqual(await openNativeChannel(files, host), { kind: 'none' });
		assert.equal(fs.existsSync(files.channelFile), false);
	});

	for (const code of ['EBUSY', 'EPERM']) {
		it(`Windows: a sharing violation (${code}) on the lock means alive; the client connects to the recorded pipe`, async () => {
			const files = nativeChannelFiles(tempRoot());
			writeRecord(files, { path: '\\\\.\\pipe\\ev3-cockpit-0f1e2d3c4b5a6978', pid: 4242 });
			const [stream] = duplexPair();
			const connected: string[] = [];
			const host = strictHost({
				platform: 'win32',
				openLockForWriting: () => { throw osError(code); },
				connect: (where) => { connected.push(where); return Promise.resolve(stream); },
			});
			const channel = await openNativeChannel(files, host);
			assert.equal(channel.kind, 'open');
			assert.deepEqual(connected, ['\\\\.\\pipe\\ev3-cockpit-0f1e2d3c4b5a6978']);
			assert.equal(fs.existsSync(files.channelFile), true);
		});
	}

	it('Windows: a live daemon whose pipe is not there yet is reported, and its record kept', async () => {
		const files = nativeChannelFiles(tempRoot());
		writeRecord(files, { path: '\\\\.\\pipe\\gone', pid: 4242 });
		const host = strictHost({
			platform: 'win32',
			openLockForWriting: () => { throw osError('EBUSY'); },
			connect: () => Promise.reject(osError('ENOENT')),
		});
		await assert.rejects(openNativeChannel(files, host), /not answering/);
		assert.equal(fs.existsSync(files.channelFile), true);
	});

	it('Linux: a dead pid deletes the record without connecting', async () => {
		const files = nativeChannelFiles(tempRoot());
		writeRecord(files, { path: '/run/user/1000/ev3-cockpit/daemon.sock', pid: 31337 });
		const host = strictHost({ processAlive: (pid) => { assert.equal(pid, 31337); return false; } });
		assert.deepEqual(await openNativeChannel(files, host), { kind: 'none' });
		assert.equal(fs.existsSync(files.channelFile), false);
	});

	for (const code of ['ENOENT', 'ECONNREFUSED']) {
		it(`Linux: a connect that fails with ${code} means stale; the record goes`, async () => {
			const files = nativeChannelFiles(tempRoot());
			writeRecord(files, { path: '/run/user/1000/ev3-cockpit/daemon.sock', pid: 31337 });
			const host = strictHost({
				processAlive: () => true,
				lstat: () => privateDir,
				connect: () => Promise.reject(osError(code)),
			});
			assert.deepEqual(await openNativeChannel(files, host), { kind: 'none' });
			assert.equal(fs.existsSync(files.channelFile), false);
		});
	}

	it('Linux: a record a new daemon wrote meanwhile is not deleted', async () => {
		const files = nativeChannelFiles(tempRoot());
		writeRecord(files, { path: '/run/user/1000/ev3-cockpit/old.sock', pid: 31337 });
		const host = strictHost({
			processAlive: () => {
				writeRecord(files, { path: '/run/user/1000/ev3-cockpit/new.sock', pid: 31338 });
				return false;
			},
		});
		assert.deepEqual(await openNativeChannel(files, host), { kind: 'none' });
		assert.deepEqual(readChannelRecord(fs.readFileSync(files.channelFile, 'utf8')), { path: '/run/user/1000/ev3-cockpit/new.sock', pid: 31338 });
	});

	const unsafeDirs: Array<[string, typeof privateDir]> = [
		['open to others', { ...privateDir, mode: 0o40755 }],
		['owned by another user', { ...privateDir, uid: 1001 }],
		['a symbolic link', { ...privateDir, isSymbolicLink: () => true }],
		['not a directory', { ...privateDir, isDirectory: () => false }],
	];
	for (const [what, stat] of unsafeDirs) {
		it(`Linux: refuses a socket directory that is ${what}, without connecting`, async () => {
			const files = nativeChannelFiles(tempRoot());
			writeRecord(files, { path: '/run/user/1000/ev3-cockpit/daemon.sock', pid: 31337 });
			const looked: string[] = [];
			const host = strictHost({ processAlive: () => true, lstat: (dir) => { looked.push(dir); return stat; } });
			await assert.rejects(openNativeChannel(files, host), /socket directory/);
			assert.deepEqual(looked, ['/run/user/1000/ev3-cockpit']);
			assert.equal(fs.existsSync(files.channelFile), true);
		});
	}

	it('Linux: connects to the recorded socket when the pid lives and the directory is private', async () => {
		const files = nativeChannelFiles(tempRoot());
		writeRecord(files, { path: '/home/user/.local/state/ev3-cockpit/native/run/daemon-0a.sock', pid: 7 });
		const [stream] = duplexPair();
		const connected: string[] = [];
		const host = strictHost({
			processAlive: () => true,
			lstat: () => privateDir,
			connect: (where) => { connected.push(where); return Promise.resolve(stream); },
		});
		const channel = await openNativeChannel(files, host);
		assert.equal(channel.kind, 'open');
		assert.deepEqual(connected, ['/home/user/.local/state/ev3-cockpit/native/run/daemon-0a.sock']);
	});
});

describe('the key', () => {
	it('retries a short read and then uses the whole key', async () => {
		let reads = 0;
		const key = await readNativeKey('k', {
			readFile: () => (++reads === 1 ? vectorKey.subarray(0, 10) : vectorKey),
			sleep: () => Promise.resolve(),
		});
		assert.equal(reads, 2);
		assert.deepEqual(key, vectorKey);
	});

	it('reports a key that stays short as unreadable, without advice to delete it', async () => {
		let reads = 0;
		const reading = readNativeKey('k', { readFile: () => { reads++; return vectorKey.subarray(0, 10); }, sleep: () => Promise.resolve() });
		await assert.rejects(reading, (error: Error) => {
			assert.ok(error instanceof KeyUnreadableError);
			assert.match(error.message, /could not be read/);
			assert.doesNotMatch(error.message, /delete|remove/i);
			return true;
		});
		assert.equal(reads, KEY_READ_ATTEMPTS);
	});

	it('reports a missing key the same way after retrying', async () => {
		let reads = 0;
		const reading = readNativeKey('k', { readFile: () => { reads++; throw osError('ENOENT'); }, sleep: () => Promise.resolve() });
		await assert.rejects(reading, (error: Error) => error instanceof KeyUnreadableError && !/delete|remove/i.test(error.message));
		assert.equal(reads, KEY_READ_ATTEMPTS);
	});
});

describe('connecting and the hello', () => {
	it('finishes the hello with a daemon that proves the key, and says who the client is', async () => {
		const where = listenPath();
		const daemon = await fakeDaemon(where);
		const { files } = rootWithKey();
		holdLock(files);
		writeRecord(files, { path: where, pid: process.pid });
		const outcome = await connectNativeDaemon({ files, client: me });
		assert.equal(outcome.kind, 'connected');
		if (outcome.kind !== 'connected') { return; }
		assert.deepEqual(outcome.daemon, {
			version: '9.8.7', contractVersion: CONTRACT_VERSION, buildKind: 'development', buildId: 'ab'.repeat(32), mode: 'replay',
			pid: 4242, instanceId: 'fake', state: 'serving', transports: ['usb'],
		});
		assert.equal(daemon.finishes, 1);
		const start = daemon.starts[0];
		assert.match(start.clientNonce, /^[0-9a-f]{64}$/);
		assert.deepEqual({ ...start, clientNonce: '' }, {
			clientNonce: '', clientName: 'test client', clientKind: 'cli', version: '1.2.3', contractVersion: CONTRACT_VERSION,
			buildKind: 'development',
		});
		outcome.endpoint.close();
		await daemon.close();
	});

	it('connects to the recorded path even when the client resolves XDG_RUNTIME_DIR differently', async () => {
		const where = listenPath();
		const daemon = await fakeDaemon(where);
		const stateHome = tempRoot();
		const root = nativeStateRoot({
			platform: process.platform,
			env: { LOCALAPPDATA: stateHome, XDG_STATE_HOME: stateHome, XDG_RUNTIME_DIR: path.join(stateHome, 'elsewhere') },
			homedir: stateHome,
		});
		const files = nativeChannelFiles(root);
		fs.mkdirSync(root, { recursive: true });
		fs.writeFileSync(files.keyFile, vectorKey, { mode: 0o600 });
		holdLock(files);
		writeRecord(files, { path: where, pid: process.pid });
		const outcome = await connectNativeDaemon({ files, client: me });
		assert.equal(outcome.kind, 'connected');
		assert.equal(daemon.connections, 1);
		if (outcome.kind === 'connected') { assert.equal(outcome.record.path, where); outcome.endpoint.close(); }
		await daemon.close();
	});

	it('refuses a daemon whose proof is wrong and never sends it the client proof', async () => {
		const where = listenPath();
		const daemon = await fakeDaemon(where, { wrongProof: true });
		const { files } = rootWithKey();
		holdLock(files);
		writeRecord(files, { path: where, pid: process.pid });
		await assert.rejects(connectNativeDaemon({ files, client: me }), /could not prove/);
		assert.equal(daemon.starts.length, 1);
		assert.equal(daemon.finishes, 0);
		await daemon.close();
	});

	it('stops at a daemon with another contract version and says so', async () => {
		const where = listenPath();
		const daemon = await fakeDaemon(where, { contractVersion: CONTRACT_VERSION + 1 });
		const { files } = rootWithKey();
		holdLock(files);
		writeRecord(files, { path: where, pid: process.pid });
		await assert.rejects(connectNativeDaemon({ files, client: me }), new RegExp(`contract ${CONTRACT_VERSION + 1}`));
		await daemon.close();
	});

	it('gives up on a daemon that never answers the hello', async () => {
		const where = listenPath();
		const daemon = await fakeDaemon(where, { silent: true });
		const { files } = rootWithKey();
		holdLock(files);
		writeRecord(files, { path: where, pid: process.pid });
		await assert.rejects(connectNativeDaemon({ files, client: me, timeoutMs: 200 }), /did not finish the hello/);
		await daemon.close();
	});

	it('reports no daemon without reading the key when there is no record', async () => {
		const files = nativeChannelFiles(tempRoot());
		assert.deepEqual(await connectNativeDaemon({ files, client: me }), { kind: 'none' });
	});

	it('closes the channel when the key cannot be read', async () => {
		const files = nativeChannelFiles(tempRoot());
		writeRecord(files, { path: '/run/user/1000/ev3-cockpit/daemon.sock', pid: 7 });
		const [stream] = duplexPair();
		const host = strictHost({ processAlive: () => true, lstat: () => privateDir, connect: () => Promise.resolve(stream as Duplex) });
		await assert.rejects(
			connectNativeDaemon({ files, client: me, host, keyHost: { readFile: () => Buffer.alloc(3), sleep: () => Promise.resolve() } }),
			KeyUnreadableError,
		);
		assert.equal(stream.destroyed, true);
	});
});
