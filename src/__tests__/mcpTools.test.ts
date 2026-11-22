/**
 * The cockpit's MCP server, driven by the MCP SDK's own client over a linked in-memory transport
 * and served the way stdio serves it: tools that start nothing until a brick is needed, introduce
 * the agent to the daemon by its MCP client's name, leave every dangerous action to a person in
 * VS Code or a terminal, and keep local paths inside the roots the host declares.
 *
 * The native daemon in matched replay of brick AAA over USB where the daemon's own answer matters
 * (skipped without `daemon/target/debug/ev3-cockpitd(.exe)`); a stand-in client where the test has
 * to see exactly what reaches the daemon, or an outcome the recording cannot produce (a start whose
 * reply was lost).
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, describe, it } from 'node:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { ClientCapabilities } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { ContractError } from '../client/connection';
import { NativeCockpitClient } from '../client/nativeClient';
import { DaemonStartError } from '../client/nativeLaunch';
import { WireErrorCode } from '../contract/errors';
import type { DeployResult, Question } from '../contract/generated';
import { CockpitMcp, CockpitConnection, MCP_CLIENT_NAME, clientNameOf } from '../mcp/tools';
import { NativeTestChannel, nativeBinaryMissing, nativeTestChannel, sleep } from './clientDaemonHelpers';

const HOST_NAME = 'test host';

interface HostOptions {
	readonly roots?: readonly string[];
	readonly modern?: boolean;
	readonly name?: string;
}

interface ToolResult {
	readonly content: readonly { readonly type: string; readonly text?: string }[];
	readonly structuredContent?: Record<string, unknown>;
	readonly isError?: boolean;
}

const opened: { close(): Promise<void> }[] = [];
const channels: NativeTestChannel[] = [];
const temps: string[] = [];
after(async () => {
	for (const o of opened) { await o.close().catch(() => undefined); }
	for (const channel of channels) { await channel.stop(); }
	await sleep(200);
	// Each home holds its own verified copy of the daemon: removed again, a few tries while it lets go.
	for (const dir of temps) {
		for (let attempt = 0; attempt < 10; attempt++) {
			try { fs.rmSync(dir, { recursive: true, force: true }); break; } catch { await sleep(200); }
		}
	}
});

/** A temporary folder the run removes at its end. */
function temp(prefix: string): string {
	const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
	temps.push(dir);
	return dir;
}

/** An MCP host connected to a cockpit MCP server, as an agent's host would be. */
async function host(cockpit: CockpitMcp, options: HostOptions = {}): Promise<{ client: Client; call(name: string, args?: Record<string, unknown>): Promise<ToolResult> }> {
	const [hostSide, serverSide] = InMemoryTransport.createLinkedPair();
	const served = serveStdio(() => cockpit.createServer(), { transport: serverSide });
	const capabilities: ClientCapabilities = options.roots ? { roots: {} } : {};
	const client = new Client({ name: options.name ?? HOST_NAME, version: '1.0.0' }, {
		capabilities,
		...(options.modern ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {}),
	});
	if (options.roots) {
		const roots = options.roots;
		client.setRequestHandler('roots/list', () => Promise.resolve({ roots: roots.map((r) => ({ uri: pathToFileURL(r).href })) }));
	}
	await client.connect(hostSide);
	opened.push({ close: async () => { await client.close(); await served.close(); } });
	return {
		client,
		call: async (name, args = {}) => await client.callTool({ name, arguments: args }) as unknown as ToolResult,
	};
}

const textOf = (result: ToolResult): string => result.content.map((c) => c.text ?? '').join('\n');
const errorOf = (result: ToolResult): { code?: string; command?: string } => (result.structuredContent?.error ?? {}) as { code?: string; command?: string };

/** A fresh test channel whose daemon replays AAA over USB. */
function freshChannel(): NativeTestChannel {
	const channel = nativeTestChannel(temp('ev3-mcp-'));
	channels.push(channel);
	return channel;
}

/** A cockpit MCP server on `channel`; it records the names it connected as. */
function onDaemon(channel: NativeTestChannel = freshChannel()) {
	const names: string[] = [];
	const cockpit = new CockpitMcp({
		version: '0.0.1',
		connect: (clientName, onNotice) => {
			names.push(clientName);
			return NativeCockpitClient.connect(channel.client('mcp', 'development', { name: clientName }), onNotice);
		},
	});
	opened.push({ close: () => { cockpit.dispose(); return Promise.resolve(); } });
	return { channel, cockpit, names };
}

/** A stand-in for the client library that records what would reach the daemon. */
class StandIn {
	readonly requests: { method: string; params: Record<string, unknown> }[] = [];
	noticeListener: ((text: string) => void) | undefined;
	daemonVersion = '0.0.1';
	constructor(private readonly respond: (method: string, params: Record<string, unknown>) => unknown) {}
	get daemon(): { version: string } { return { version: this.daemonVersion }; }
	request(method: string, params: Record<string, unknown>): Promise<unknown> {
		this.requests.push({ method, params });
		try { return Promise.resolve(this.respond(method, params)); } catch (error) { return Promise.reject(error); }
	}
	onNotice(listener: (text: string) => void): { dispose(): void } { this.noticeListener = listener; return { dispose: () => undefined }; }
	onLost(): { dispose(): void } { return { dispose: () => undefined }; }
	dispose(): void { /* nothing held */ }
	/** Telemetry: the snapshot `telemetry` holds, at once; how many subscriptions ended. */
	telemetry: { rowId: string; value: number | null; sampledAt: number; stale: boolean; unit?: string }[] = [];
	subscriptionsEnded = 0;
	subscribeTelemetry(brick: string, request: { rows: string[] }, listener: (update: unknown) => void): Promise<{ grant: Record<string, number>; dispose(): void }> {
		this.requests.push({ method: 'telemetry/subscribe', params: { brick, request } });
		listener({ subscriptionId: 's1', brickId: '001653F00A0C', kind: 'snapshot', values: this.telemetry.filter((v) => request.rows.includes(v.rowId)), removed: [] });
		return Promise.resolve({ grant: {}, dispose: () => { this.subscriptionsEnded++; } });
	}
}

function withStandIn(respond: (method: string, params: Record<string, unknown>) => unknown, cwd?: string) {
	const standIn = new StandIn(respond);
	let connects = 0;
	const names: string[] = [];
	const cockpit = new CockpitMcp({
		version: '0.0.1', ...(cwd ? { cwd } : {}),
		connect: (clientName, onNotice) => {
			connects++;
			names.push(clientName);
			standIn.noticeListener = onNotice;
			return Promise.resolve(standIn as unknown as CockpitConnection);
		},
	});
	return { standIn, cockpit, connects: () => connects, names };
}

describe('the cockpit MCP server on the native daemon', { skip: nativeBinaryMissing }, () => {
	it('starts no daemon when it starts and lists its tools', async () => {
		const { channel, cockpit, names } = onDaemon();
		const { client } = await host(cockpit);
		const { tools } = await client.listTools();
		assert.ok(tools.length > 0);
		assert.equal(names.length, 0);
		assert.equal(fs.existsSync(channel.files.channelFile), false);
	});

	it('starts the daemon on the first list_bricks as its MCP client\'s name, and lists the bricks', async () => {
		const { channel, cockpit, names } = onDaemon();
		const { call } = await host(cockpit);
		const result = await call('list_bricks');
		assert.notEqual(result.isError, true, textOf(result));
		const bricks = (result.structuredContent?.bricks ?? []) as { name: string }[];
		assert.deepEqual(bricks.map((b) => b.name), ['AAA'], textOf(result));
		assert.deepEqual(names, [HOST_NAME]);
		assert.equal(fs.existsSync(channel.files.channelFile), true);
		await call('list_bricks');
		assert.equal(names.length, 1, 'a second call connected again');
	});

	it('with nobody to ask, refuses access mode full with the exact ev3 config command, and the mode stays safe', async () => {
		const { cockpit } = onDaemon();
		const { call } = await host(cockpit);
		const result = await call('set_setting', { key: 'accessMode', value: 'full' });
		assert.equal(result.isError, true);
		assert.match(textOf(result), /ev3 config set access-mode full/);
		assert.equal(errorOf(result).code, 'needs_person');
		const settings = await call('get_settings');
		const access = (settings.structuredContent?.settings as { key: string; value: unknown }[]).find((s) => s.key === 'accessMode');
		assert.equal(access?.value, 'safe');
	});

	it('changes a setting that widens no right', async () => {
		const { cockpit } = onDaemon();
		const { call } = await host(cockpit);
		const result = await call('set_setting', { key: 'telemetry.staleFactor', value: 5 });
		assert.notEqual(result.isError, true, textOf(result));
		const settings = await call('get_settings');
		const factor = (settings.structuredContent?.settings as { key: string; value: unknown }[]).find((s) => s.key === 'telemetry.staleFactor');
		assert.equal(factor?.value, 5);
	});

	it('has no daemon restart or exit and no way to send a person\'s confirmation', async () => {
		const { cockpit } = onDaemon();
		const { client } = await host(cockpit);
		const { tools } = await client.listTools();
		assert.equal(tools.some((t) => /restart|exit/i.test(t.name)), false);
		for (const tool of tools) {
			assert.equal(JSON.stringify(tool.inputSchema).includes('confirmedByPerson'), false, `${tool.name} takes a confirmation`);
		}
	});

	it('with nobody to ask, refuses forget naming the exact ev3 command, and forgets nothing', async () => {
		const { cockpit } = onDaemon();
		const { call } = await host(cockpit);
		const result = await call('forget', { brick: 'AAA' });
		assert.equal(result.isError, true);
		assert.equal(errorOf(result).code, 'needs_person');
		assert.equal(errorOf(result).command, 'ev3 forget AAA');
		assert.match(textOf(result), /ev3 forget AAA/);
		const listed = await call('list_bricks');
		assert.deepEqual((listed.structuredContent?.bricks as { name: string }[]).map((b) => b.name), ['AAA']);
	});

	it('a forget puts the question to the person in VS Code, naming the MCP client, and their no stands', async () => {
		const channel = freshChannel();
		const window = await NativeCockpitClient.connect(channel.client('vscode', 'development', { name: 'VS Code (test)', reconnect: false }));
		opened.push({ close: () => { window.dispose(); return Promise.resolve(); } });
		const asked: Question[] = [];
		window.onQuestion((q) => { asked.push(q); return 'no'; });
		const { cockpit } = onDaemon(channel);
		const { call } = await host(cockpit, { name: 'Some Agent Host' });
		const result = await call('forget', { brick: 'AAA' });
		assert.equal(result.isError, true, textOf(result));
		assert.equal(errorOf(result).code, 'cancelled');
		assert.equal(asked.length, 1);
		assert.equal(asked[0].kind, 'forget');
		assert.ok('requester' in asked[0]);
		assert.deepEqual(asked[0].requester, { name: 'Some Agent Host', kind: 'mcp' });
	});

	it('serves a host on the 2026-07-28 protocol under its name', async () => {
		const { cockpit, names } = onDaemon();
		const { call } = await host(cockpit, { modern: true, name: 'modern host' });
		const result = await call('list_bricks');
		assert.notEqual(result.isError, true, textOf(result));
		assert.deepEqual(names, ['modern host']);
	});
});

describe('what reaches the daemon', () => {
	it('reads telemetry once on a subscription of its own, ends it, and names the rows that had no value', async () => {
		const { standIn, cockpit } = withStandIn((method) => {
			assert.equal(method, 'telemetry/rows');
			return { rows: [{ id: 'system.battery.voltage', tier: 'live', unit: 'V' }, { id: 'program.user.running', tier: 'live' }] };
		});
		standIn.telemetry = [{ rowId: 'system.battery.voltage', value: 7.9, unit: 'V', sampledAt: 0, stale: false }];
		const { call } = await host(cockpit);
		const listed = await call('list_telemetry_rows');
		assert.match(textOf(listed), /system\.battery\.voltage \(V\)/);
		const read = await call('read_telemetry', { brick: 'CCC', waitMs: 50 });
		assert.match(textOf(read), /system\.battery\.voltage = 7\.9 V/);
		assert.match(textOf(read), /No value yet for program\.user\.running\./);
		assert.deepEqual(standIn.requests.find((r) => r.method === 'telemetry/subscribe')?.params,
			{ brick: 'CCC', request: { rows: ['system.battery.voltage', 'program.user.running'], intervalMs: 1000 } });
		assert.equal(standIn.subscriptionsEnded, 1);
	});

	it('asks for the bricks after discovery has settled', async () => {
		const { standIn, cockpit } = withStandIn(() => ({ bricks: [] }));
		const { call } = await host(cockpit);
		await call('list_bricks');
		assert.deepEqual(standIn.requests[0], { method: 'bricks/list', params: { waitForDiscovery: true } });
	});

	it('introduces itself by a name the daemon accepts, whatever its MCP client called itself', async () => {
		assert.equal(clientNameOf('  Agent  '), 'Agent');
		assert.equal(clientNameOf(''), MCP_CLIENT_NAME);
		assert.equal(clientNameOf(undefined), MCP_CLIENT_NAME);
		assert.equal(clientNameOf('x'.repeat(500)).length, 200);
		const { cockpit, names } = withStandIn(() => ({ bricks: [] }));
		const { call } = await host(cockpit, { name: '   ' });
		await call('list_bricks');
		assert.deepEqual(names, [MCP_CLIENT_NAME]);
	});

	it('returns a start whose reply was lost as uncertain, with what to do next, not as an error', async () => {
		const dir = temp('ev3-mcp-');
		fs.writeFileSync(path.join(dir, 'Demo.rbf'), 'LEGO');
		const lost: DeployResult = { brickId: '001653F00A0A', outcome: 'uncertain', runSeq: 3, uploaded: ['/home/root/lms2012/prjs/Demo/Demo.rbf'], skipped: [] };
		const { cockpit } = withStandIn(() => lost, dir);
		const { call } = await host(cockpit);
		const result = await call('deploy_and_run', {
			brick: 'AAA', runPath: '/home/root/lms2012/prjs/Demo/Demo.rbf',
			files: [{ localPath: path.join(dir, 'Demo.rbf'), remotePath: '/home/root/lms2012/prjs/Demo/Demo.rbf' }],
		});
		assert.notEqual(result.isError, true);
		assert.equal(result.structuredContent?.outcome, 'uncertain');
		assert.match(textOf(result), /Do not run it again; check program_status first/);
	});

	it('sends a forget as the brick alone, and passes a person\'s refusal on with the command', async () => {
		const { standIn, cockpit } = withStandIn(() => {
			throw new ContractError(WireErrorCode.NeedsPerson, 'Forgetting AAA needs a person.', { command: 'ev3 forget AAA' });
		});
		const { call } = await host(cockpit);
		const result = await call('forget', { brick: 'AAA', confirmedByPerson: true });
		assert.deepEqual(standIn.requests, [{ method: 'bricks/forget', params: { brick: 'AAA' } }]);
		assert.match(textOf(result), /Ask them to run: ev3 forget AAA/);
	});

	it('sends a setting change as key and value only, never as a person\'s confirmation', async () => {
		const { standIn, cockpit } = withStandIn((_m, params) => ({ spec: { key: params.key }, value: params.value }));
		const { call } = await host(cockpit);
		await call('set_setting', { key: 'accessMode', value: 'full', confirmedByPerson: true });
		assert.deepEqual(standIn.requests, [{ method: 'settings/set', params: { key: 'accessMode', value: 'full' } }]);
	});

	it('says who holds a busy brick, and not to run again when the outcome is unknown', async () => {
		let next: ContractError = new ContractError(WireErrorCode.BrickBusy, 'AAA is busy: EVƎ C (VS Code) holds its write lease.', { holder: 'EVƎ C (VS Code)' });
		const { cockpit } = withStandIn(() => { throw next; });
		const { call } = await host(cockpit);
		const busy = await call('make_directory', { brick: 'AAA', path: '/home/root/lms2012/prjs/x' });
		assert.equal(busy.isError, true);
		assert.equal((busy.structuredContent?.error as { holder?: string }).holder, 'EVƎ C (VS Code)');
		assert.match(textOf(busy), /EVƎ C \(VS Code\) is working with the brick now/);
		next = new ContractError(WireErrorCode.OutcomeUnknown, 'The daemon went away during programs/run.');
		const unknown = await call('run_program', { brick: 'AAA', path: '/home/root/lms2012/prjs/Demo/Demo.rbf' });
		assert.match(textOf(unknown), /Do not run it again; check program_status first/);
	});

	it('carries a notice in the next tool result, once, including one raised while it connected', async () => {
		const { standIn, cockpit } = withStandIn(() => ({ bricks: [] }));
		const { call } = await host(cockpit);
		const quiet = await call('list_bricks');
		assert.equal(quiet.structuredContent?.notices, undefined, 'no notice of its own');
		const text = 'A development build of the EVƎ Cockpit daemon (version 0.1.0) runs; this client uses it.';
		standIn.noticeListener?.(text);
		const first = await call('list_bricks');
		assert.deepEqual(first.structuredContent?.notices, [text]);
		assert.match(textOf(first), /Notice: A development build/);
		standIn.noticeListener?.(text);
		const second = await call('list_bricks');
		assert.equal(second.structuredContent?.notices, undefined, 'a notice is shown once');
	});

	it('returns a daemon that cannot start as a tool error naming why, and starts a blocked one only once', async () => {
		let connects = 0;
		const cockpit = new CockpitMcp({
			version: '0.0.1',
			connect: () => { connects++; return Promise.reject(new DaemonStartError('smart_app_control', 'Windows Smart App Control blocked the EVƎ Cockpit daemon.')); },
		});
		const { call } = await host(cockpit);
		const first = await call('list_bricks');
		assert.equal(first.isError, true);
		assert.deepEqual(first.structuredContent?.error, { code: 'daemon_unavailable', message: 'Windows Smart App Control blocked the EVƎ Cockpit daemon.', failure: 'smart_app_control' });
		assert.match(textOf(first), /cannot run on this computer while Windows Smart App Control is on/);
		const second = await call('brick_info', { brick: 'AAA' });
		assert.equal((second.structuredContent?.error as { failure?: string }).failure, 'smart_app_control');
		assert.equal(connects, 1, 'the blocked binary was started again');

		let tries = 0;
		const missing = new CockpitMcp({
			version: '0.0.1',
			connect: () => { tries++; return Promise.reject(new DaemonStartError('missing_binary', 'The cockpit daemon is missing.')); },
		});
		const other = await host(missing);
		const gone = await other.call('list_bricks');
		assert.equal((gone.structuredContent?.error as { failure?: string }).failure, 'missing_binary');
		assert.match(textOf(gone), /reinstall/);
		await other.call('list_bricks');
		assert.equal(tries, 2, 'a missing daemon is looked for again: it may have been installed meanwhile');
	});

	describe('local paths', () => {
		const root = temp('ev3-mcp-root-');
		const outside = temp('ev3-mcp-outside-');
		fs.writeFileSync(path.join(root, 'in.txt'), 'in');
		fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');

		it('refuses a ../ path outside the declared roots, and sends nothing', async () => {
			const { standIn, cockpit, connects } = withStandIn(() => ({ bytes: 1 }));
			const { call } = await host(cockpit, { roots: [root] });
			const result = await call('write_file', { brick: 'AAA', path: '/home/root/lms2012/prjs/x/secret.txt', localPath: path.join(root, '..', path.basename(outside), 'secret.txt') });
			assert.equal(result.isError, true);
			assert.equal((result.structuredContent?.error as { code?: string }).code, 'path_outside_roots');
			assert.equal(connects(), 0);
			assert.equal(standIn.requests.length, 0);
		});

		it('refuses a link inside the roots that points outside them', async (t) => {
			const link = path.join(root, `link-${process.pid}`);
			try {
				fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
			} catch (error) {
				t.skip(`cannot create a directory link here: ${(error as Error).message}`);
				return;
			}
			const { standIn, cockpit } = withStandIn(() => ({ bytes: 1 }));
			const { call } = await host(cockpit, { roots: [root] });
			const read = await call('read_file', { brick: 'AAA', path: '/home/root/lms2012/prjs/x/a.txt', localPath: path.join(link, 'stolen.txt') });
			assert.equal(read.isError, true, textOf(read));
			const write = await call('write_file', { brick: 'AAA', path: '/home/root/lms2012/prjs/x/a.txt', localPath: path.join(link, 'secret.txt') });
			assert.equal(write.isError, true, textOf(write));
			assert.equal(standIn.requests.length, 0);
		});

		it('refuses a link inside the roots that points to nothing yet, outside them', async (t) => {
			const link = path.join(root, `dangling-${process.pid}`);
			try {
				fs.symlinkSync(path.join(outside, `not-yet-${process.pid}`), link, process.platform === 'win32' ? 'junction' : 'file');
			} catch (error) {
				t.skip(`cannot create a link here: ${(error as Error).message}`);
				return;
			}
			t.after(() => { try { fs.unlinkSync(link); } catch { /* gone */ } });
			const { standIn, cockpit } = withStandIn(() => ({ bytes: 1 }));
			const { call } = await host(cockpit, { roots: [root] });
			const read = await call('read_file', { brick: 'AAA', path: '/home/root/lms2012/prjs/x/a.txt', localPath: link });
			assert.equal(read.isError, true, textOf(read));
			assert.equal(standIn.requests.length, 0);
		});

		it('sends a path inside the roots as its absolute real path', async () => {
			const { standIn, cockpit } = withStandIn(() => ({ bytes: 2 }));
			const { call } = await host(cockpit, { roots: [root] });
			const result = await call('write_file', { brick: 'AAA', path: '/home/root/lms2012/prjs/x/in.txt', localPath: path.join(root, 'in.txt') });
			assert.notEqual(result.isError, true, textOf(result));
			assert.deepEqual(standIn.requests.at(-1), { method: 'files/write', params: { brick: 'AAA', path: '/home/root/lms2012/prjs/x/in.txt', fromLocalPath: path.join(root, 'in.txt') } });
		});

		it('keeps paths to the working directory when the host declares no roots', async () => {
			const { standIn, cockpit } = withStandIn(() => ({ bytes: 2 }), root);
			const { call } = await host(cockpit);
			const refused = await call('read_file', { brick: 'AAA', path: '/home/root/lms2012/prjs/x/a.txt', localPath: path.join(outside, 'copy.txt') });
			assert.equal(refused.isError, true);
			assert.equal(standIn.requests.length, 0);
			const allowed = await call('read_file', { brick: 'AAA', path: '/home/root/lms2012/prjs/x/a.txt', localPath: 'copy.txt' });
			assert.notEqual(allowed.isError, true, textOf(allowed));
			assert.equal(standIn.requests.at(-1)?.params.toLocalPath, path.join(root, 'copy.txt'));
		});
	});
});
