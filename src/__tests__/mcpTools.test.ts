/**
 * The cockpit's MCP server, driven by the MCP SDK's own client over a linked in-memory transport
 * and served the way stdio serves it: tools that start nothing until a brick is needed, refuse to
 * widen the agent's rights, ask the user before forgetting or clearing, and keep local paths inside
 * the roots the host declares.
 *
 * Real daemons on simulated bricks where the daemon's own answer matters; a stand-in client where
 * the test has to see exactly what reaches the daemon, or an outcome the simulated brick cannot
 * produce (a start whose reply was lost).
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, describe, it } from 'node:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { ClientCapabilities, ElicitRequest } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { CockpitClient, ContractError } from '../client';
import { WireErrorCode } from '../contract/errors';
import type { ContractBrick, DeployResult, Question, QuestionAnswer } from '../contract/models';
import { CockpitMcp, CockpitConnection, MCP_CLIENT_NAME } from '../mcp/tools';
import { privateHome, testDaemon } from './clientDaemonHelpers';

const home = privateHome();

type Elicit = (params: ElicitRequest['params']) => { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, string | number | boolean> };

interface HostOptions {
	readonly elicit?: Elicit;
	readonly roots?: readonly string[];
	readonly modern?: boolean;
}

interface ToolResult {
	readonly content: readonly { readonly type: string; readonly text?: string }[];
	readonly structuredContent?: Record<string, unknown>;
	readonly isError?: boolean;
}

const opened: { close(): Promise<void> }[] = [];
after(async () => { for (const o of opened) { await o.close().catch(() => undefined); } });

/** An MCP host connected to a cockpit MCP server, as an agent's host would be. */
async function host(cockpit: CockpitMcp, options: HostOptions = {}): Promise<{ client: Client; asked: ElicitRequest['params'][]; call(name: string, args?: Record<string, unknown>): Promise<ToolResult> }> {
	const [hostSide, serverSide] = InMemoryTransport.createLinkedPair();
	const served = serveStdio(() => cockpit.createServer(), { transport: serverSide });
	const capabilities: ClientCapabilities = {
		...(options.elicit ? { elicitation: { form: {} } } : {}),
		...(options.roots ? { roots: {} } : {}),
	};
	const client = new Client({ name: 'test host', version: '1.0.0' }, {
		capabilities,
		...(options.modern ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {}),
	});
	const asked: ElicitRequest['params'][] = [];
	if (options.elicit) {
		const elicit = options.elicit;
		client.setRequestHandler('elicitation/create', (request) => {
			asked.push(request.params);
			return Promise.resolve(elicit(request.params));
		});
	}
	if (options.roots) {
		const roots = options.roots;
		client.setRequestHandler('roots/list', () => Promise.resolve({ roots: roots.map((r) => ({ uri: pathToFileURL(r).href })) }));
	}
	await client.connect(hostSide);
	opened.push({ close: async () => { await client.close(); await served.close(); } });
	return {
		client, asked,
		call: async (name, args = {}) => await client.callTool({ name, arguments: args }) as unknown as ToolResult,
	};
}

const textOf = (result: ToolResult): string => result.content.map((c) => c.text ?? '').join('\n');

/** A cockpit MCP server on a fresh private daemon channel; `connects` counts how often it reached for the daemon. */
function onDaemon(extraArgs: readonly string[] = []) {
	const d = testDaemon(home);
	let connects = 0;
	const cockpit = new CockpitMcp({
		version: '0.0.1',
		connect: () => {
			connects++;
			return CockpitClient.connect({ name: MCP_CLIENT_NAME, kind: 'mcp', version: '0.0.1', paths: d.paths, launch: d.launch, launchArgs: [...d.launchArgs, ...extraArgs] });
		},
	});
	opened.push({ close: () => { cockpit.dispose(); return Promise.resolve(); } });
	return { d, cockpit, connects: () => connects };
}

/** Whether a daemon serves the channel, asked without starting one. */
async function daemonRuns(d: ReturnType<typeof testDaemon>): Promise<boolean> {
	try {
		const probe = await CockpitClient.connect({ name: 'probe', kind: 'cli', version: '0.0.1', paths: d.paths, readinessMs: 500, reconnect: false });
		probe.dispose();
		return true;
	} catch (error) {
		if (error instanceof ContractError && error.code === WireErrorCode.DaemonUnavailable) { return false; }
		throw error;
	}
}

/** A workspace whose simulated brick AAA remembers two Bluetooth peers. */
function workspaceWithPeers(): string {
	const ws = fs.mkdtempSync(path.join(home, 'ws-'));
	fs.mkdirSync(path.join(ws, '.vscode'));
	fs.writeFileSync(path.join(ws, '.vscode', 'ev3-cockpit-mock.json'), JSON.stringify({
		transport: 'mock',
		bricks: [{ id: 'aaa', displayName: 'AAA', battery: { level: 80 }, motorPorts: [], sensorPorts: [], firmwareVersion: 'V1.09D', filesystem: [], bluetoothPeers: ['HOSTA', 'BBB'] }],
	}));
	return ws;
}

/** A stand-in for the client library that records what would reach the daemon. */
class StandIn {
	readonly requests: { method: string; params: Record<string, unknown> }[] = [];
	readonly answers: QuestionAnswer[] = [];
	private handler: ((q: Question) => Promise<QuestionAnswer> | QuestionAnswer) | undefined;
	noticeListener: ((notice: { text: string }) => void) | undefined;
	daemonVersion = '0.0.1';
	constructor(private readonly respond: (method: string, params: Record<string, unknown>, standIn: StandIn) => unknown) {}
	get daemon(): { version: string } { return { version: this.daemonVersion }; }
	request(method: string, params: Record<string, unknown>): Promise<unknown> {
		this.requests.push({ method, params });
		try { return Promise.resolve(this.respond(method, params, this)); } catch (error) { return Promise.reject(error); }
	}
	onQuestion(handler: ((q: Question) => Promise<QuestionAnswer> | QuestionAnswer) | undefined): void { this.handler = handler; }
	async ask(question: Question): Promise<QuestionAnswer> {
		const answer = this.handler ? await this.handler(question) : 'keep';
		this.answers.push(answer);
		return answer;
	}
	onNotice(listener: (notice: { text: string }) => void): { dispose(): void } { this.noticeListener = listener; return { dispose: () => undefined }; }
	onLost(): { dispose(): void } { return { dispose: () => undefined }; }
	dispose(): void { /* nothing held */ }
	bricks(): readonly ContractBrick[] {
		return [{ brickId: 'mock:marvin', name: 'Marvin', nameConfirmed: true, connected: true, paired: false, channels: [], holders: [] }];
	}
}

function withStandIn(respond: (method: string, params: Record<string, unknown>, standIn: StandIn) => unknown, cwd?: string) {
	const standIn = new StandIn(respond);
	let connects = 0;
	const cockpit = new CockpitMcp({
		version: '0.0.1', ...(cwd ? { cwd } : {}),
		connect: () => { connects++; return Promise.resolve(standIn as unknown as CockpitConnection); },
	});
	return { standIn, cockpit, connects: () => connects };
}

describe('the cockpit MCP server on a daemon', () => {
	it('starts no daemon when it starts and lists its tools', async () => {
		const { d, cockpit, connects } = onDaemon();
		const { client } = await host(cockpit);
		const { tools } = await client.listTools();
		assert.ok(tools.length > 0);
		assert.equal(connects(), 0);
		assert.equal(await daemonRuns(d), false);
	});

	it('starts and connects to the daemon on the first list_bricks, and lists its bricks', async () => {
		const { d, cockpit, connects } = onDaemon();
		const { call } = await host(cockpit);
		const result = await call('list_bricks');
		assert.notEqual(result.isError, true, textOf(result));
		const bricks = (result.structuredContent?.bricks ?? []) as ContractBrick[];
		assert.ok(bricks.some((b) => b.name === 'Marvin'), textOf(result));
		assert.equal(connects(), 1);
		assert.equal(await daemonRuns(d), true);
		await call('list_bricks');
		assert.equal(connects(), 1, 'a second call connected again');
	});

	it('refuses access mode full with the exact ev3 config command, and the mode stays safe', async () => {
		const { cockpit } = onDaemon();
		const { call } = await host(cockpit);
		const result = await call('set_setting', { key: 'accessMode', value: 'full' });
		assert.equal(result.isError, true);
		assert.match(textOf(result), /ev3 config set access-mode full/);
		assert.equal((result.structuredContent?.error as { code?: string } | undefined)?.code, 'needs_person');
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

	it('has no daemon restart and no way to send a person\'s confirmation', async () => {
		const { cockpit } = onDaemon();
		const { client } = await host(cockpit);
		const { tools } = await client.listTools();
		assert.equal(tools.some((t) => /restart/i.test(t.name)), false);
		for (const tool of tools) {
			assert.equal(JSON.stringify(tool.inputSchema).includes('confirmedByPerson'), false, `${tool.name} takes a confirmation`);
		}
	});

	it('forgets a brick when the user says yes in the host\'s prompt', async () => {
		const { cockpit } = onDaemon();
		const { call, asked } = await host(cockpit, { elicit: () => ({ action: 'accept', content: { confirm: true } }) });
		await call('list_bricks');
		const result = await call('forget', { brick: 'Marvin' });
		assert.notEqual(result.isError, true, textOf(result));
		assert.equal(result.structuredContent?.forgotten, true);
		assert.equal(asked.length, 1);
		assert.match(asked[0]!.message, /Forget Marvin\?/);
	});

	for (const [label, reply] of [['says no', { action: 'decline' }], ['dismisses the prompt', { action: 'cancel' }], ['leaves the box unticked', { action: 'accept', content: { confirm: false } }]] as const) {
		it(`leaves a brick paired when the user ${label}`, async () => {
			const { cockpit } = onDaemon();
			const { call, asked } = await host(cockpit, { elicit: () => reply });
			const result = await call('forget', { brick: 'Marvin' });
			assert.equal(asked.length, 1);
			assert.notEqual(result.structuredContent?.forgotten, true, textOf(result));
			assert.match(textOf(result), /not forgotten/i);
		});
	}

	it('refuses forget without elicitation, naming the exact ev3 command', async () => {
		const { cockpit } = onDaemon();
		const { call } = await host(cockpit);
		const result = await call('forget', { brick: 'Marvin' });
		assert.equal(result.isError, true);
		assert.match(textOf(result), /ev3 forget Marvin/);
		assert.equal((result.structuredContent?.error as { command?: string }).command, 'ev3 forget Marvin');
	});

	it('refuses clear_bluetooth_list without elicitation, naming the exact ev3 command, and keeps the list', async () => {
		const ws = workspaceWithPeers();
		const { cockpit } = onDaemon(['--mock-workspace', ws]);
		const { call } = await host(cockpit);
		await call('connect_brick', { brick: 'AAA' });
		const result = await call('clear_bluetooth_list', { brick: 'AAA' });
		assert.equal(result.isError, true);
		assert.match(textOf(result), /ev3 bt-clear AAA/);
		// The same daemon, asked through a host that can prompt: the list it shows is still whole.
		const prompting = await host(cockpit, { elicit: () => ({ action: 'decline' }) });
		await prompting.call('clear_bluetooth_list', { brick: 'AAA' });
		assert.equal(prompting.asked.length, 1);
		assert.match(prompting.asked[0]!.message, /HOSTA/);
		assert.match(prompting.asked[0]!.message, /BBB/);
	});

	it('clears a Bluetooth list after the user says yes to the entries shown', async () => {
		const ws = workspaceWithPeers();
		const { cockpit } = onDaemon(['--mock-workspace', ws]);
		const { call, asked } = await host(cockpit, { elicit: () => ({ action: 'accept', content: { confirm: true } }) });
		await call('connect_brick', { brick: 'AAA' });
		const result = await call('clear_bluetooth_list', { brick: 'AAA' });
		assert.notEqual(result.isError, true, textOf(result));
		assert.deepEqual(result.structuredContent?.removed, ['HOSTA', 'BBB']);
		assert.equal(asked.length, 1);
	});

	it('pairs without a prompt and returns the brick\'s answer', async () => {
		const { cockpit } = onDaemon();
		const { call, asked } = await host(cockpit, { elicit: () => ({ action: 'accept', content: { confirm: true } }) });
		const result = await call('pair', { brick: 'Marvin' });
		assert.equal(asked.length, 0);
		assert.equal(result.structuredContent?.paired, false);
		assert.match(textOf(result), /no Bluetooth channel/);
	});

	it('serves a host on the 2026-07-28 protocol: forget asks there too', async () => {
		const { cockpit } = onDaemon();
		const { call, asked } = await host(cockpit, { modern: true, elicit: () => ({ action: 'accept', content: { confirm: true } }) });
		const result = await call('forget', { brick: 'Marvin' });
		assert.notEqual(result.isError, true, textOf(result));
		assert.equal(result.structuredContent?.forgotten, true);
		assert.equal(asked.length, 1);
	});
});

describe('what reaches the daemon', () => {
	it('asks for the bricks after discovery has settled', async () => {
		const { standIn, cockpit } = withStandIn(() => []);
		const { call } = await host(cockpit);
		await call('list_bricks');
		assert.deepEqual(standIn.requests[0], { method: 'bricks/list', params: { waitForDiscovery: true } });
	});

	it('returns a start whose reply was lost as uncertain, with what to do next, not as an error', async () => {
		const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ev3-mcp-')));
		fs.writeFileSync(path.join(dir, 'Demo.rbf'), 'LEGO');
		const lost: DeployResult = { brickId: 'mock:marvin', outcome: 'uncertain', runSeq: 3, uploaded: ['/home/root/lms2012/prjs/Demo/Demo.rbf'], skipped: [] };
		const { cockpit } = withStandIn(() => lost, dir);
		const { call } = await host(cockpit);
		const result = await call('deploy_and_run', {
			brick: 'Marvin', runPath: '/home/root/lms2012/prjs/Demo/Demo.rbf',
			files: [{ localPath: path.join(dir, 'Demo.rbf'), remotePath: '/home/root/lms2012/prjs/Demo/Demo.rbf' }],
		});
		assert.notEqual(result.isError, true);
		assert.equal(result.structuredContent?.outcome, 'uncertain');
		assert.match(textOf(result), /Do not run it again; check program_status first/);
	});

	it('answers keep and then yes to the daemon\'s forget question, only after the user said yes', async () => {
		const forget = (_m: string, params: Record<string, unknown>, standIn: StandIn): Promise<unknown> =>
			standIn.ask({ questionId: 'q', kind: 'forget', brickId: 'mock:marvin', text: `Forget ${String(params.brick)}?`, timeoutMs: 60_000 }).then((answer) => {
				if (answer === 'yes') { return { forgotten: true, report: [] }; }
				throw new ContractError(WireErrorCode.NeedsPerson, 'needs a person', { command: 'ev3 forget Marvin' });
			});
		const yes = withStandIn(forget);
		await (await host(yes.cockpit, { elicit: () => ({ action: 'accept', content: { confirm: true } }) })).call('forget', { brick: 'Marvin' });
		assert.deepEqual(yes.standIn.answers, ['keep', 'yes']);
		const no = withStandIn(forget);
		await (await host(no.cockpit, { elicit: () => ({ action: 'decline' }) })).call('forget', { brick: 'Marvin' });
		assert.deepEqual(no.standIn.answers, ['keep'], 'a declined prompt still reached the daemon');
		assert.equal(no.standIn.requests.length, 1);
	});

	it('asks again when the daemon\'s question changed after the user said yes to the first one', async () => {
		let calls = 0;
		const { standIn, cockpit } = withStandIn((_m, _p, s) => {
			const details = ++calls === 1 ? ['HOSTA'] : ['HOSTA', 'BBB'];
			return s.ask({ questionId: `q${calls}`, kind: 'clearBluetoothList', brickId: 'mock:marvin', text: `Remove ${details.length} entries?`, details, timeoutMs: 60_000 })
				.then((answer) => {
					if (answer === 'yes') { return { removed: details, kept: [] }; }
					throw new ContractError(WireErrorCode.NeedsPerson, 'needs a person', { command: 'ev3 bt-clear Marvin' });
				});
		});
		const { call, asked } = await host(cockpit, { elicit: () => ({ action: 'accept', content: { confirm: true } }) });
		const result = await call('clear_bluetooth_list', { brick: 'Marvin' });
		assert.deepEqual(standIn.answers, ['keep', 'keep', 'yes']);
		assert.equal(asked.length, 2);
		assert.match(asked[1]!.message, /BBB/);
		assert.deepEqual(result.structuredContent?.removed, ['HOSTA', 'BBB']);
	});

	it('recognises the question about a brick the agent spelled differently from its listed name', async () => {
		const { standIn, cockpit } = withStandIn((_m, _p, s) =>
			s.ask({ questionId: 'q', kind: 'forget', brickId: 'mock:marvin', text: 'Forget Marvin?', timeoutMs: 60_000 }).then((answer) => {
				if (answer === 'yes') { return { forgotten: true, report: [] }; }
				throw new ContractError(WireErrorCode.NeedsPerson, 'needs a person', { command: 'ev3 forget Marvin' });
			}));
		const { call, asked } = await host(cockpit, { elicit: () => ({ action: 'accept', content: { confirm: true } }) });
		const result = await call('forget', { brick: ' marvin' });
		assert.equal(asked.length, 1, textOf(result));
		assert.deepEqual(standIn.answers, ['keep', 'yes']);
	});

	it('sends a setting change as key and value only, never as a person\'s confirmation', async () => {
		const { standIn, cockpit } = withStandIn((_m, params) => ({ spec: { key: params.key }, value: params.value }));
		const { call } = await host(cockpit);
		await call('set_setting', { key: 'accessMode', value: 'full', confirmedByPerson: true });
		assert.deepEqual(standIn.requests, [{ method: 'settings/set', params: { key: 'accessMode', value: 'full' } }]);
	});

	it('says who holds a busy brick, and not to run again when the outcome is unknown', async () => {
		let next: ContractError = new ContractError(WireErrorCode.BrickBusy, 'Brick mock:marvin is busy: EVƎ C (VS Code) holds its write lease.', { holder: 'EVƎ C (VS Code)' });
		const { cockpit } = withStandIn(() => { throw next; });
		const { call } = await host(cockpit);
		const busy = await call('make_directory', { brick: 'Marvin', path: '/home/root/lms2012/prjs/x' });
		assert.equal(busy.isError, true);
		assert.equal((busy.structuredContent?.error as { holder?: string }).holder, 'EVƎ C (VS Code)');
		assert.match(textOf(busy), /EVƎ C \(VS Code\) is working with the brick now/);
		next = new ContractError(WireErrorCode.OutcomeUnknown, 'The daemon went away during programs/run.');
		const unknown = await call('run_program', { brick: 'Marvin', path: '/home/root/lms2012/prjs/Demo/Demo.rbf' });
		assert.match(textOf(unknown), /Do not run it again; check program_status first/);
	});

	it('carries a version notice in the next tool result, once', async () => {
		const { standIn, cockpit } = withStandIn(() => []);
		standIn.daemonVersion = '0.0.2';
		const { call } = await host(cockpit);
		const first = await call('list_bricks');
		assert.match(textOf(first), /Notice: .*0\.0\.2/);
		assert.equal((first.structuredContent?.notices as string[]).length, 1);
		const second = await call('list_bricks');
		assert.equal(second.structuredContent?.notices, undefined);
		standIn.noticeListener?.({ text: 'A newer EVƎ Cockpit runs.' });
		const third = await call('list_bricks');
		assert.deepEqual(third.structuredContent?.notices, ['A newer EVƎ Cockpit runs.']);
	});

	it('answers keep to questions about anything it was not asked to do', async () => {
		const { standIn, cockpit } = withStandIn((_m, _p, s) => s.ask({ questionId: 'q', kind: 'sweep', text: 'Release?', timeoutMs: 60_000 }).then(() => []));
		const { call } = await host(cockpit, { elicit: () => ({ action: 'accept', content: { confirm: true } }) });
		await call('list_bricks');
		assert.deepEqual(standIn.answers, ['keep']);
	});

	describe('local paths', () => {
		const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ev3-mcp-root-')));
		const outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ev3-mcp-outside-')));
		fs.writeFileSync(path.join(root, 'in.txt'), 'in');
		fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');

		it('refuses a ../ path outside the declared roots, and sends nothing', async () => {
			const { standIn, cockpit, connects } = withStandIn(() => ({ bytes: 1 }));
			const { call } = await host(cockpit, { roots: [root] });
			const result = await call('write_file', { brick: 'Marvin', path: '/home/root/lms2012/prjs/x/secret.txt', localPath: path.join(root, '..', path.basename(outside), 'secret.txt') });
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
			const read = await call('read_file', { brick: 'Marvin', path: '/home/root/lms2012/prjs/x/a.txt', localPath: path.join(link, 'stolen.txt') });
			assert.equal(read.isError, true, textOf(read));
			const write = await call('write_file', { brick: 'Marvin', path: '/home/root/lms2012/prjs/x/a.txt', localPath: path.join(link, 'secret.txt') });
			assert.equal(write.isError, true, textOf(write));
			assert.equal(standIn.requests.length, 0);
		});

		it('sends a path inside the roots as its absolute real path', async () => {
			const { standIn, cockpit } = withStandIn(() => ({ bytes: 2 }));
			const { call } = await host(cockpit, { roots: [root] });
			const result = await call('write_file', { brick: 'Marvin', path: '/home/root/lms2012/prjs/x/in.txt', localPath: path.join(root, 'in.txt') });
			assert.notEqual(result.isError, true, textOf(result));
			assert.deepEqual(standIn.requests.at(-1), { method: 'files/write', params: { brick: 'Marvin', path: '/home/root/lms2012/prjs/x/in.txt', fromLocalPath: path.join(root, 'in.txt') } });
		});

		it('keeps paths to the working directory when the host declares no roots', async () => {
			const { standIn, cockpit } = withStandIn(() => ({ bytes: 2 }), root);
			const { call } = await host(cockpit);
			const refused = await call('read_file', { brick: 'Marvin', path: '/home/root/lms2012/prjs/x/a.txt', localPath: path.join(outside, 'copy.txt') });
			assert.equal(refused.isError, true);
			assert.equal(standIn.requests.length, 0);
			const allowed = await call('read_file', { brick: 'Marvin', path: '/home/root/lms2012/prjs/x/a.txt', localPath: 'copy.txt' });
			assert.notEqual(allowed.isError, true, textOf(allowed));
			assert.equal(standIn.requests.at(-1)?.params.toLocalPath, path.join(root, 'copy.txt'));
		});
	});
});
