/**
 * The TypeScript client against the native daemon binary, on private test channels with their own
 * state: the hello, a wrong key, the first methods, and a crashed daemon's record that the client
 * must judge stale without contacting a pipe squatted under the old name.
 *
 * Needs `daemon/target/debug/ev3-cockpitd(.exe)`; build it with
 * `cargo build -p ev3-cockpitd` in `daemon/`. Without it the tests are skipped and say so.
 */

import assert from 'node:assert/strict';
import { ChildProcess, spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import { openNativeChannel, readChannelRecord } from '../client/channel';
import { ContractError, createEndpoint } from '../client/connection';
import { NativeClientIdentity, connectNativeDaemon } from '../client/hello';
import { NativeChannelFiles, nativeChannelFiles } from '../client/locate';
import { newNonce } from '../contract/hello';
import { CONTRACT_VERSION } from '../contract/generated';
import type {
	AccessModeState, BrickList, ChannelRecord, ContractBrick, DaemonStatus, HelloChallenge, Question, SettingList, SettingValue,
	TelemetryRowList, TransferBeginResult,
} from '../contract/generated';

const isWindows = process.platform === 'win32';
const binary = path.join(__dirname, '..', '..', 'daemon', 'target', 'debug', isWindows ? 'ev3-cockpitd.exe' : 'ev3-cockpitd');
const missing = fs.existsSync(binary)
	? false
	: `the daemon binary ${binary} is missing; run cargo build -p ev3-cockpitd in daemon/ to run these tests`;

const roots: string[] = [];
const children = new Set<ChildProcess>();
const cleanups: Array<() => void> = [];
after(() => {
	for (const cleanup of cleanups.splice(0)) { try { cleanup(); } catch { /* best effort */ } }
	for (const child of children) { child.kill(); }
	for (const root of roots) { fs.rmSync(root, { recursive: true, force: true }); }
});

const me: NativeClientIdentity = { name: 'wire test', kind: 'cli', version: '0.0.1', buildKind: 'development' };

interface RunningDaemon {
	readonly child: ChildProcess;
	readonly record: ChannelRecord;
	readonly exited: Promise<number | null>;
	stderr(): string;
}

function tempRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ev3-wire-'));
	roots.push(root);
	return root;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A recorded scenario of a real brick, under daemon/fixtures/link. */
const fixture = (name: string): string => path.join(__dirname, '..', '..', 'daemon', 'fixtures', 'link', name);

/** Starts the daemon on a test channel and waits until it has recorded its channel. */
async function startDaemon(root: string, channel: string, extra: readonly string[] = []): Promise<RunningDaemon> {
	const files = nativeChannelFiles(root, channel);
	const child = spawn(binary, ['--channel', channel, '--state-root', root, ...extra], { stdio: ['ignore', 'ignore', 'pipe'] });
	children.add(child);
	let stderr = '';
	child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
	const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => { children.delete(child); resolve(code); }));
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) { break; }
		try {
			const record = readChannelRecord(fs.readFileSync(files.channelFile, 'utf8'));
			if (record && record.pid === child.pid) { return { child, record, exited, stderr: () => stderr }; }
		} catch { /* not there yet */ }
		await sleep(50);
	}
	child.kill();
	throw new Error(`the daemon did not record its channel: exit ${String(child.exitCode)}, ${stderr}`);
}

function hmac(key: Buffer, label: string, clientNonce: string, daemonNonce: string): string {
	return createHmac('sha256', key).update(`${label}\n${clientNonce}\n${daemonNonce}`).digest('hex');
}

async function connect(files: NativeChannelFiles, client: NativeClientIdentity = me) {
	const connection = await connectNativeDaemon({ files, client });
	assert.equal(connection.kind, 'connected');
	if (connection.kind !== 'connected') { throw new Error('unreachable'); }
	cleanups.push(() => connection.endpoint.close());
	// A development client asking a development daemon to exit is a restart: the person says yes.
	// Every other question is left as it is.
	connection.endpoint.onRequest('question/ask', (params) => ({ answer: (params as Question).kind === 'restart' ? 'yes' : 'keep' }));
	return connection;
}

describe('the native daemon over the wire', { skip: missing }, () => {
	it('finishes the hello and answers daemon/status and settings/list on a test channel', async () => {
		const root = tempRoot();
		const daemon = await startDaemon(root, 'wire-hello');
		const files = nativeChannelFiles(root, 'wire-hello');
		const { endpoint, daemon: identity, record } = await connect(files);

		assert.equal(identity.contractVersion, CONTRACT_VERSION);
		assert.equal(identity.mode, 'replay', 'a test channel never opens real hardware');
		assert.equal(identity.pid, daemon.child.pid);
		assert.match(identity.buildId, /^[0-9a-f]{64}$/);
		assert.equal(identity.state, 'serving');
		assert.equal(fs.readFileSync(files.keyFile).length, 32);

		const status = await endpoint.request<DaemonStatus>('daemon/status', {});
		assert.equal(status.channel, record.path);
		assert.equal(status.pid, daemon.child.pid);
		assert.deepEqual(status.clients.map((c) => [c.name, c.kind, c.buildKind]), [['wire test', 'cli', 'development']]);

		const settings = await endpoint.request<SettingList>('settings/list', {});
		const access = settings.settings.find((s) => s.spec.key === 'accessMode');
		assert.equal(access?.value, 'safe');
		assert.equal(access?.spec.stored, false);

		await assert.rejects(endpoint.request('settings/set', { key: 'access-mode', value: 'full' }), (error: unknown) => {
			assert.ok(error instanceof ContractError);
			assert.equal(error.code, 'needs_person');
			assert.equal(error.data.command, 'ev3 config set access-mode full');
			return true;
		});
		const list = await endpoint.request<BrickList>('bricks/list', { waitForDiscovery: true });
		assert.deepEqual(list.bricks, [], 'a replay daemon without a recording has no brick');

		const exit = await endpoint.request<{ accepted: boolean }>('daemon/exit', {});
		assert.equal(exit.accepted, true);
		assert.equal(await daemon.exited, 0);
		assert.equal(fs.existsSync(files.channelFile), false, 'a clean exit removes channel.json');
	});

	it('answers the methods that need no brick, and refuses a brick it does not have', async () => {
		const root = tempRoot();
		const daemon = await startDaemon(root, 'wire-nobrick');
		const files = nativeChannelFiles(root, 'wire-nobrick');
		const { endpoint } = await connect(files);

		const rows = await endpoint.request<TelemetryRowList>('telemetry/rows', {});
		assert.ok(rows.rows.length > 0, 'every row a client can subscribe to');
		assert.deepEqual(await endpoint.request<AccessModeState>('settings/accessMode', {}), { mode: 'safe' });
		assert.equal(await endpoint.request('log/notice', { level: 'info', text: 'shown to a person' }), null);
		assert.equal(await endpoint.request('bricks/inquiry', {}), null);
		assert.equal(await endpoint.request('subscriptions/cancel', { subscriptionId: 'none' }), null);
		const begun = await endpoint.request<TransferBeginResult>('transfer/begin', { size: 3 });
		assert.equal(begun.chunkBytes, 48 * 1024);
		assert.equal(await endpoint.request('transfer/write', { handle: begun.handle, data: 'AQID' }), null);
		await assert.rejects(endpoint.request('transfer/write', { handle: begun.handle, data: 'AQID' }),
			(error: unknown) => error instanceof ContractError && error.code === 'invalid_request');
		assert.equal(await endpoint.request('transfer/close', { handle: begun.handle }), null);
		const set = await endpoint.request<SettingValue>('settings/set', { key: 'remember-bricks', value: 'auto' });
		assert.equal(set.value, 'auto');
		await assert.rejects(endpoint.request('bricks/info', { brick: 'AAA' }),
			(error: unknown) => error instanceof ContractError && error.code === 'brick_not_found');
		// A path into the cockpit's own files is refused before the brick is even looked up.
		await assert.rejects(endpoint.request('files/read', { brick: 'AAA', path: '/x', toLocalPath: path.join(files.dir, 'stolen') }),
			(error: unknown) => error instanceof ContractError && error.code === 'access_denied');

		await endpoint.request('daemon/exit', {});
		assert.equal(await daemon.exited, 0);
	});

	it('asks the VS Code client about an agent\'s switch to full, naming the agent', async () => {
		const root = tempRoot();
		const daemon = await startDaemon(root, 'wire-ask');
		const files = nativeChannelFiles(root, 'wire-ask');
		const { endpoint: vscode } = await connect(files, { name: 'VS Code', kind: 'vscode', version: '0.0.1', buildKind: 'development' });
		const asked: Question[] = [];
		vscode.onRequest('question/ask', (params) => {
			asked.push(params as Question);
			return { answer: 'yes' };
		});
		const { endpoint: agent } = await connect(files, { name: 'an agent', kind: 'mcp', version: '0.0.1', buildKind: 'development' });
		const changed = await agent.request<SettingValue>('settings/set', { key: 'access-mode', value: 'full' });
		assert.equal(changed.value, 'full');
		assert.equal(asked.length, 1);
		const question = asked[0];
		assert.equal(question.kind, 'setting');
		assert.ok('requester' in question);
		assert.deepEqual(question.requester, { name: 'an agent', kind: 'mcp' });

		await vscode.request('daemon/exit', {});
		assert.equal(await daemon.exited, 0);
	});

	it('connects and holds a brick from recorded USB exchanges, and lets it go', async () => {
		const root = tempRoot();
		const daemon = await startDaemon(root, 'wire-replay', ['--fixtures', fixture('usb-connect-commands-aaa')]);
		const files = nativeChannelFiles(root, 'wire-replay');
		const { endpoint } = await connect(files);

		const list = await endpoint.request<BrickList>('bricks/list', { waitForDiscovery: true });
		assert.deepEqual(list.bricks.map((b) => [b.brickId, b.name, b.connected]), [['001653F00A0A', 'AAA', false]]);
		const brick = await endpoint.request<ContractBrick>('bricks/connect', { brick: 'AAA', hold: true });
		assert.equal(brick.connected, true);
		assert.deepEqual(brick.holders, [{ kind: 'hold' }]);
		const held = JSON.parse(fs.readFileSync(path.join(files.dir, 'held.json'), 'utf8')) as { bricks: string[] };
		assert.deepEqual(held.bricks, ['001653F00A0A']);
		const status = await endpoint.request<DaemonStatus>('daemon/status', {});
		assert.deepEqual(status.bricks.map((b) => b.brickId), ['001653F00A0A']);
		const released = await endpoint.request<{ stillHeldBy: string[] }>('bricks/disconnect', { releaseHold: true });
		assert.deepEqual(released.stillHeldBy, []);
		const after = JSON.parse(fs.readFileSync(path.join(files.dir, 'held.json'), 'utf8')) as { bricks: string[] };
		assert.deepEqual(after.bricks, []);

		await endpoint.request('daemon/exit', {});
		assert.equal(await daemon.exited, 0);
	});

	it('fails both proofs with a wrong key: the client refuses the daemon, the daemon closes on the client', async () => {
		const root = tempRoot();
		const daemon = await startDaemon(root, 'wire-key');
		const files = nativeChannelFiles(root, 'wire-key');
		const realKey = fs.readFileSync(files.keyFile);
		const wrongKey = Buffer.from(realKey.map((b) => b ^ 0xff));

		await assert.rejects(
			connectNativeDaemon({ files, client: me, keyHost: { readFile: () => wrongKey, sleep } }),
			(error: unknown) => {
				assert.ok(error instanceof ContractError);
				assert.equal(error.code, 'daemon_unavailable');
				assert.match(error.message, /could not prove/);
				return true;
			},
		);

		const channel = await openNativeChannel(files);
		assert.equal(channel.kind, 'open');
		if (channel.kind !== 'open') { return; }
		const endpoint = createEndpoint(channel.stream);
		cleanups.push(() => endpoint.close());
		const clientNonce = newNonce();
		const challenge = await endpoint.request<HelloChallenge>('hello/start', {
			clientNonce, clientName: 'wrong key', clientKind: 'cli', version: '0', contractVersion: CONTRACT_VERSION, buildKind: 'release',
		});
		assert.notEqual(challenge.daemonProof, hmac(wrongKey, 'daemon', clientNonce, challenge.daemonNonce));
		assert.equal(challenge.daemonProof, hmac(realKey, 'daemon', clientNonce, challenge.daemonNonce));
		await assert.rejects(
			endpoint.request('hello/finish', { clientProof: hmac(wrongKey, 'client', clientNonce, challenge.daemonNonce) }),
			(error: unknown) => error instanceof ContractError && error.code === 'daemon_unavailable',
		);
		assert.equal(endpoint.closed, true, 'the daemon closed the connection');

		const { endpoint: good } = await connect(files);
		await good.request('daemon/exit', {});
		assert.equal(await daemon.exited, 0);
	});

	it('after a crash the record is stale, a pipe squatted under the old name is never contacted, and a fresh daemon takes a new name', async () => {
		const root = tempRoot();
		const files = nativeChannelFiles(root, 'wire-crash');
		const first = await startDaemon(root, 'wire-crash');
		const oldPath = first.record.path;
		first.child.kill('SIGKILL');
		await first.exited;
		assert.equal(fs.existsSync(files.channelFile), true, 'a crash leaves channel.json behind');

		if (!isWindows) { fs.rmSync(oldPath, { force: true }); }
		let squatted = 0;
		const squatter = net.createServer((socket) => { squatted++; socket.destroy(); });
		await new Promise<void>((resolve, reject) => {
			squatter.once('error', reject);
			squatter.listen(oldPath, () => resolve());
		});
		cleanups.push(() => squatter.close());

		const none = await connectNativeDaemon({ files, client: me });
		assert.equal(none.kind, 'none', 'the client judged the record stale');
		assert.equal(fs.existsSync(files.channelFile), false, 'and removed it');

		const second = await startDaemon(root, 'wire-crash');
		assert.notEqual(second.record.path, oldPath);
		const { endpoint } = await connect(files);
		await endpoint.request('daemon/exit', {});
		assert.equal(await second.exited, 0);
		assert.equal(squatted, 0, 'nothing ever connected to the squatted name');
		await new Promise<void>((resolve) => squatter.close(() => resolve()));
	});
});
