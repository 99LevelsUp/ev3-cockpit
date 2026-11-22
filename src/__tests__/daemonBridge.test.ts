/**
 * The extension's commands over the native daemon: the bridge gives them the daemon's brick list
 * and a brick layer, answers the daemon's question about a request this window's person already
 * confirmed, and hands every other question, naming who asked, to the person. A start failure is
 * shown once and never retried.
 *
 * The first groups run the native daemon on a test channel in matched replay of a recorded brick;
 * the rest drive the bridge over a stand-in for the client library.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import { NativeCockpitClient } from '../client/nativeClient';
import { classifyStartFailure, systemLaunchHost } from '../client/nativeLaunch';
import type { LaunchHost } from '../client/nativeLaunch';
import type { ContractBrick, Notifications, Question, QuestionReply, Requester } from '../contract/generated';
import { BridgeClient, CockpitStart, DaemonBridge, startFailureMessage } from '../vscode/daemonBridge';
import { brickPickRows } from '../vscode/ui/brickPickRows';
import type { PairingStartedEvent } from '../vscode/ui/connectBrick';
import { answerQuestion } from '../vscode/ui/questions';
import { NativeTestChannel, nativeBinaryMissing, nativeTestChannel, privateHome } from './clientDaemonHelpers';
import { waitFor } from './waitFor';

const home = privateHome();
const channels: NativeTestChannel[] = [];
const clients: NativeCockpitClient[] = [];
after(async () => {
	for (const c of clients.splice(0)) { c.dispose(); }
	for (const c of channels.splice(0)) { await c.stop(); }
	fs.rmSync(home, { recursive: true, force: true });
});

const WINDOW: Requester = { name: 'VS Code (test window)', kind: 'vscode' };

/** A window's client and bridge on a fresh replay channel; its person answers with `choose`. */
async function windowOnDaemon(choose: (actions: string[]) => string | undefined = () => undefined) {
	const channel = nativeTestChannel(home);
	channels.push(channel);
	const client = await NativeCockpitClient.connect(channel.client('vscode', 'development', { name: WINDOW.name }));
	clients.push(client);
	const asked: Question[] = [];
	const shown: string[] = [];
	const bridge = new DaemonBridge(client, {
		me: WINDOW,
		askPerson: (question) => {
			asked.push(question);
			return answerQuestion(question, {
				notify: (message, ...actions) => { shown.push(message); return Promise.resolve(choose(actions)); },
				modal: (message, _detail, ...actions) => { shown.push(message); return Promise.resolve(choose(actions)); },
			}, WINDOW);
		},
	});
	const agent = async (): Promise<NativeCockpitClient> => {
		const c = await NativeCockpitClient.connect({ ...channel.client('mcp', 'development', { name: 'an agent' }), reconnect: false });
		clients.push(c);
		return c;
	};
	return { channel, client, bridge, asked, shown, agent };
}

describe('the extension\'s commands over the native daemon', { skip: nativeBinaryMissing }, () => {
	it('lists the recorded brick as the picker reads it, and connects it as the active brick', async () => {
		const w = await windowOnDaemon();
		await w.client.request('bricks/list', { waitForDiscovery: true });
		await waitFor(() => w.bridge.list.bricks().length === 1, 5000);
		assert.deepEqual(brickPickRows(w.bridge.list.bricks()).map((r) => r.label), ['AAA']);
		const aaa = w.bridge.list.bricks()[0];
		const changed = new Promise<void>((resolve) => { const l = w.bridge.list.onListChanged(() => { l.dispose(); resolve(); }); });
		const brick = await w.bridge.bricks.connect(aaa.brickId);
		await changed;
		assert.equal(brick.connected, true);
		assert.ok(brick.channels.some((c) => c.transport === 'usb' && c.state === 'connected'));
		assert.equal(w.client.activeBrick(), aaa.brickId);
		await waitFor(() => w.bridge.list.brick(aaa.brickId)?.connected === true, 5000);
	});

	it('shows a question an MCP request raised with the MCP client as the requester', async () => {
		const w = await windowOnDaemon((actions) => actions[0]);
		const agent = await w.agent();
		const changed = await agent.request('settings/set', { key: 'access-mode', value: 'full' });
		assert.equal(changed.value, 'full');
		assert.equal(w.asked.length, 1);
		assert.deepEqual('requester' in w.asked[0] ? w.asked[0].requester : undefined, { name: 'an agent', kind: 'mcp' });
		assert.match(w.shown[0], /^an agent \(an AI agent over MCP\) asks: /);
		await agent.request('settings/set', { key: 'access-mode', value: 'safe' });
	});

	it('answers the daemon\'s question about a change the person confirmed in this window, and asks nobody', async () => {
		const w = await windowOnDaemon(() => undefined);
		const changed = await w.bridge.settings.set('accessMode', 'full', true);
		assert.equal(changed.value, 'full');
		assert.deepEqual(w.asked, [], 'the person was asked twice');
		await w.bridge.settings.set('accessMode', 'safe', false);
	});

	it('puts this window\'s own unconfirmed request to the person, who can say no', async () => {
		const w = await windowOnDaemon(() => undefined);
		await assert.rejects(w.bridge.settings.set('accessMode', 'full', false),
			(error: unknown) => (error as { data?: { code?: string } }).data?.code === 'cancelled');
		assert.equal(w.asked.length, 1);
		assert.equal(w.shown[0].startsWith('an agent'), false);
		assert.equal(w.client.accessMode(), 'safe');
	});
});

/** The client library as the bridge uses it, scripted by the test. */
function fakeClient(script: { request?: (method: string, params: unknown) => Promise<unknown> } = {}) {
	const handlers = new Map<string, Set<(params: unknown) => void>>();
	const reconnected = new Set<() => void>();
	let questionHandler: ((q: Question, c: { signal: AbortSignal }) => unknown) | undefined;
	const client = {
		bricks: (): readonly ContractBrick[] => [],
		settings: () => [],
		request: (method: string, params: unknown) => (script.request ?? (() => Promise.resolve({})))(method, params),
		on: (name: string, handler: (params: unknown) => void) => {
			const set = handlers.get(name) ?? new Set();
			handlers.set(name, set);
			set.add(handler);
			return { dispose: () => set.delete(handler) };
		},
		onBricksChanged: () => ({ dispose: () => undefined }),
		onReconnected: (listener: () => void) => { reconnected.add(listener); return { dispose: () => reconnected.delete(listener) }; },
		onQuestion: (handler: typeof questionHandler) => { questionHandler = handler; },
		setActiveBrick: () => Promise.resolve(),
	};
	return {
		client: client as unknown as BridgeClient,
		notify: <N extends keyof Notifications>(name: N, params: Notifications[N]) => { for (const h of [...(handlers.get(name) ?? [])]) { h(params); } },
		reconnect: () => { for (const l of [...reconnected]) { l(); } },
		ask: (q: Question) => Promise.resolve(questionHandler?.(q, { signal: new AbortController().signal })),
	};
}

const failure = (code: string, message: string): Error => Object.assign(new Error(message), { data: { code } });
const forgetQuestion = (requester: Requester): Question => ({ kind: 'forget', questionId: 'q1', text: 'Forget CCC?', timeoutMs: 60_000, requester, brickId: 'CCC' });

describe('the bridge answers only this window\'s own confirmed requests', () => {
	it('answers the forget this window confirmed, and passes another client\'s forget of the same brick to the person', async () => {
		const passed: Question[] = [];
		let ask!: (q: Question) => Promise<unknown>;
		const answers: unknown[] = [];
		const f = fakeClient({
			request: async () => {
				// While this window's forget runs, a terminal asks to forget the same brick.
				answers.push(await ask(forgetQuestion({ name: 'ev3 forget (terminal)', kind: 'cli' })));
				answers.push(await ask(forgetQuestion(WINDOW)));
				return { forgotten: true, lines: [] };
			},
		});
		ask = f.ask;
		const bridge = new DaemonBridge(f.client, { me: WINDOW, askPerson: (q) => { passed.push(q); return 'no'; } });
		await bridge.bricks.forget('CCC');
		assert.deepEqual(answers, ['no', 'yes']);
		assert.equal(passed.length, 1);
		assert.deepEqual('requester' in passed[0] ? passed[0].requester : undefined, { name: 'ev3 forget (terminal)', kind: 'cli' });
		// Once the forget is done, the same question from this window is the person's again.
		assert.equal(await f.ask(forgetQuestion(WINDOW)), 'no');
	});

	it('hands a person\'s remembered answer to the client library unchanged', async () => {
		const f = fakeClient();
		const reply: QuestionReply = { answer: 'yes', remember: true };
		new DaemonBridge(f.client, { me: WINDOW, askPerson: () => reply });
		assert.deepEqual(await f.ask(forgetQuestion(WINDOW)), reply);
	});

	it('answers keep without a person to ask', async () => {
		const f = fakeClient();
		new DaemonBridge(f.client, { me: WINDOW });
		assert.equal(await f.ask(forgetQuestion(WINDOW)), 'keep');
	});

	it('a clearing declined at the command\'s own confirmation returns no report; any other failure is thrown', async () => {
		let ask!: (q: Question) => Promise<unknown>;
		const clearQuestion: Question = {
			kind: 'clearBluetoothList', questionId: 'q2', text: 'Clear?', timeoutMs: 60_000, requester: WINDOW, brickId: 'CCC',
			details: ['HOSTA', 'HOSTB'], includesThisComputer: true, thisComputer: 'HOSTA',
		};
		const f = fakeClient({
			request: async () => {
				if ((await ask(clearQuestion)) === 'no') { throw failure('cancelled', 'Clearing CCC\'s Bluetooth list: the person said no.'); }
				throw failure('brick_unreachable', 'no answer');
			},
		});
		ask = f.ask;
		const bridge = new DaemonBridge(f.client, { me: WINDOW });
		const seen: unknown[] = [];
		assert.equal(await bridge.bricks.clearBluetoothList('CCC', (names, includes, me) => { seen.push([names, includes, me]); return Promise.resolve(false); }), undefined);
		assert.deepEqual(seen, [[['HOSTA', 'HOSTB'], true, 'HOSTA']]);
		await assert.rejects(bridge.bricks.clearBluetoothList('CCC', () => Promise.resolve(true)), /no answer/);
	});
});

describe('the bridge follows the daemon\'s pairings and repairs', () => {
	it('announces a pairing, passes its steps on, and ends it with its result', async () => {
		const f = fakeClient();
		const bridge = new DaemonBridge(f.client, { me: WINDOW });
		const started: PairingStartedEvent[] = [];
		bridge.bricks.onPairingStarted((e) => started.push(e));
		f.notify('bricks/pairingStarted', { brickId: 'CCC' });
		const phases: string[] = [];
		started[0].onProgress((p) => phases.push(p.phase));
		f.notify('bricks/pairingEvent', { brickId: 'CCC', progress: { phase: 'found', name: 'CCC', alreadyPaired: false } });
		f.notify('bricks/pairingDone', { brickId: 'CCC', outcome: 'failed', message: 'the brick did not confirm' });
		assert.deepEqual(phases, ['found']);
		assert.deepEqual(await started[0].done, { brickId: 'CCC', outcome: 'failed', message: 'the brick did not confirm' });
	});

	it('says a repair is pairing again when the daemon started a pairing for that brick just before it', () => {
		const f = fakeClient();
		const bridge = new DaemonBridge(f.client, { me: WINDOW });
		const repairs: boolean[] = [];
		bridge.bricks.onOneSidedRepair((e) => repairs.push(e.pairingAgain));
		const repair = { brickId: 'CCC', found: 'computer-only' as const, removal: { status: 'removed' as const, channel: 'bt:CCC' }, others: [] };
		f.notify('bricks/oneSidedRepair', { brickId: 'CCC', message: '', repair });
		f.notify('bricks/pairingStarted', { brickId: 'CCC' });
		f.notify('bricks/oneSidedRepair', { brickId: 'CCC', message: '', repair });
		assert.deepEqual(repairs, [false, true]);
	});

	it('ends a pairing the previous daemon ran once the client is connected to the next one', async () => {
		const f = fakeClient();
		const bridge = new DaemonBridge(f.client, { me: WINDOW });
		const started: PairingStartedEvent[] = [];
		bridge.bricks.onPairingStarted((e) => started.push(e));
		f.notify('bricks/pairingStarted', { brickId: 'CCC' });
		f.reconnect();
		assert.equal((await started[0].done).outcome, 'failed');
	});
});

describe('starting the daemon', () => {
	it('shows a Smart App Control block once, says the cockpit cannot run while it is on, and never starts the daemon again', {
		// The launch's directory checks follow the host's platform: Smart App Control exists only on Windows.
		skip: process.platform !== 'win32' ? 'Smart App Control exists only on Windows' : nativeBinaryMissing,
	}, async () => {
		const channel = nativeTestChannel(home);
		channels.push(channel);
		const real = systemLaunchHost();
		let spawns = 0;
		// Windows refuses the unsigned binary: Node reports a bare spawn error, and the policy reads on.
		const host: LaunchHost = {
			...real,
			platform: 'win32',
			smartAppControlPolicy: () => 1,
			spawn: () => {
				spawns += 1;
				return { pid: undefined, outcome: () => ({ kind: 'error', error: Object.assign(new Error('spawn UNKNOWN'), { code: 'UNKNOWN', errno: -4094 }) }) };
			},
		};
		const shown: string[] = [];
		const start = new CockpitStart(() => NativeCockpitClient.connect({ ...channel.client('vscode', 'development'), host }), (message) => shown.push(message));
		for (let attempt = 0; attempt < 3; attempt++) {
			await assert.rejects(start.ready());
		}
		assert.equal(spawns, 1, 'the blocked daemon was started again');
		assert.equal(shown.length, 1, 'the message was shown more than once');
		assert.match(shown[0], /^EVƎ Cockpit: Windows Smart App Control blocked the EVƎ Cockpit daemon/);
		assert.match(shown[0], /cannot run on this computer while Smart App Control is on/);
	});

	it('names each start failure the way the client library classified it', () => {
		const host = { platform: 'win32', smartAppControlPolicy: () => 2 } as unknown as LaunchHost;
		const blocked = classifyStartFailure({ kind: 'exit', code: 4551, signal: null }, path.join('bin', 'ev3-cockpitd.exe'), host, '');
		assert.match(startFailureMessage(blocked), /^EVƎ Cockpit: Windows Smart App Control blocked/);
		assert.match(startFailureMessage(new Error('pipe closed')), /^EVƎ Cockpit: the cockpit daemon could not be started — pipe closed$/);
	});

	it('shows a daemon the extension does not carry as a start failure, from the first call', async () => {
		const shown: string[] = [];
		let calls = 0;
		const start = new CockpitStart<never>(() => {
			calls += 1;
			throw Object.assign(new Error('No development build of the cockpit daemon. Build it with npm run daemon:build.'), { failure: 'missing_binary' });
		}, (message) => shown.push(message));
		await assert.rejects(start.ready());
		await assert.rejects(start.ready());
		assert.equal(calls, 1);
		assert.deepEqual(shown, ['EVƎ Cockpit: No development build of the cockpit daemon. Build it with npm run daemon:build.']);
	});
});
