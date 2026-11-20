/**
 * The daemon's methods over the real protocol connection, on simulated bricks: holders, program
 * state for every subscriber, stops from anyone, questions that keep things as they are, and
 * telemetry read in the foreground for each client's own brick.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { ContractError, Endpoint, createEndpoint } from '../client/connection';
import { WireErrorCode } from '../contract/errors';
import type { ClientKind, ContractBrick, DeployResult, ProgramState } from '../contract/models';
import { BrickId, Transport, makeBrickKey } from '../core/contracts';
import { ActivityMode } from '../core/contracts/enums';
import { ledgerFor } from '../core/fs/transferLedger';
import { MockTransportProvider } from '../core/mock';
import { createRuntime } from '../core/runtime/createRuntime';
import { defaultSettings, settingsSection } from '../core/settings/spec';
import { readProgramPresetSettings, readTelemetrySettings, readThrottleSettings } from '../core/telemetry/telemetrySettings';
import type { DaemonClient } from '../daemon/main';
import { DaemonLog } from '../daemon/log';
import { SettingsStore } from '../daemon/settingsStore';
import { Lifecycle } from '../daemon/stateMachine';
import { createSurface } from '../daemon/surface';
import { duplexPair } from './duplexPair';
import { waitFor } from './waitFor';

const DEMO = '/home/root/lms2012/prjs/Demo/Demo.rbf';

function world() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ev3-surface-'));
	const mock = new MockTransportProvider({
		transport: Transport.Mock,
		bricks: [
			{ id: 'M1', displayName: 'Robot', battery: { level: 80 }, motorPorts: [], sensorPorts: [], firmwareVersion: 'V1.09D', filesystem: [{ path: DEMO, content: 'LEGO-rbf-image' }] },
			{ id: 'M2', displayName: 'Other', battery: { level: 80 }, motorPorts: [], sensorPorts: [], firmwareVersion: 'V1.09D', filesystem: [] },
		],
	} as never);
	// Like real transports, the simulated brick does not recover a link by itself.
	(mock as { recover?: unknown }).recover = undefined;
	const values = defaultSettings();
	const warn = (): void => undefined;
	const log = new DaemonLog(path.join(dir, 'daemon.log'));
	const runtime = createRuntime({
		extensionPath: path.resolve(__dirname, '..', '..'), log, startPresence: false, providers: [mock],
		telemetrySettings: readTelemetrySettings(settingsSection(values), warn),
		throttleSettings: readThrottleSettings(settingsSection(values), warn),
		programPreset: readProgramPresetSettings(settingsSection(values), warn),
	});
	const settings = new SettingsStore(path.join(dir, 'settings.json'));
	const clients = new Map<string, DaemonClient>();
	const lifecycle = new Lifecycle({ graceMs: 60_000, onExit: () => undefined });
	lifecycle.serve();
	const surface = createSurface({
		status: () => ({ version: '0', contractVersion: 1, pid: 1, channel: 'test', startedAt: 0, runtime: { node: '0' }, clients: [], bricks: [], logPath: '' }),
		settings, log, clients, lifecycle,
	}, runtime, () => runtime.scheduler.scanOnce());

	let next = 0;
	/** A connected client; `answer` is what it says to questions. */
	const connect = (name: string, kind: ClientKind = 'vscode', answer: 'yes' | 'no' | 'keep' = 'keep'): Endpoint & { asked: string[] } => {
		const [a, b] = duplexPair();
		const daemonSide = createEndpoint(b);
		const clientSide = createEndpoint(a);
		const asked: string[] = [];
		clientSide.onRequest('question/ask', (params) => {
			asked.push((params as { kind: string }).kind);
			return { answer };
		});
		const client: DaemonClient = { id: `c${++next}`, identity: { name, kind, version: '0', contractVersion: 1 }, endpoint: daemonSide };
		clients.set(client.id, client);
		daemonSide.onClose(() => clients.delete(client.id));
		surface.attach(client);
		return Object.assign(clientSide, { asked });
	};
	return {
		runtime, surface, connect, mock,
		done: () => {
			for (const c of [...clients.values()]) { c.endpoint.close(); }
			lifecycle.dispose();
			surface.dispose();
			runtime.dispose();
			settings.dispose();
		},
	};
}

const brickIdOf = (bricks: readonly ContractBrick[], name: string): string => bricks.find((b) => b.name === name)!.brickId;

describe('the daemon surface', () => {
	it('keeps a brick connected while another holder has it, and says who', async () => {
		const w = world();
		const windowA = w.connect('VS Code (window A)');
		const terminal = w.connect('ev3 connect', 'cli');
		await w.runtime.scheduler.scanOnce();
		const id = brickIdOf(await windowA.request<ContractBrick[]>('bricks/list'), 'Robot');
		await windowA.request('bricks/connect', { brick: id });
		await terminal.request('bricks/connect', { brick: 'Robot', hold: true });
		const answer = await windowA.request<{ stillHeldBy: string[] }>('bricks/disconnect', { brick: id });
		assert.deepEqual(answer.stillHeldBy, ['ev3 connect']);
		assert.equal(w.runtime.bricks.isSignedIn(id as BrickId), true);
		await terminal.request('bricks/disconnect', { brick: id, releaseHold: true });
		assert.equal(w.runtime.bricks.isSignedIn(id as BrickId), false);
		w.done();
	});

	it('signs a brick out when the window that alone held it closes', async () => {
		const w = world();
		const windowA = w.connect('VS Code (window A)');
		const windowB = w.connect('VS Code (window B)');
		await w.runtime.scheduler.scanOnce();
		await windowA.request('bricks/connect', { brick: 'Robot' });
		await windowB.request('bricks/connect', { brick: 'Robot' });
		const id = brickIdOf(await windowB.request<ContractBrick[]>('bricks/list'), 'Robot');
		windowA.close();
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(w.runtime.bricks.isSignedIn(id as BrickId), true);
		windowB.close();
		await waitFor(() => !w.runtime.bricks.isSignedIn(id as BrickId), 2000);
		w.done();
	});

	it('tells every subscriber a program\'s state, with the stopper and the start number', async () => {
		const w = world();
		const terminal = w.connect('ev3 c run (terminal)', 'addon');
		const vscode = w.connect('VS Code');
		await w.runtime.scheduler.scanOnce();
		await terminal.request('bricks/connect', { brick: 'Robot' });
		const states: ProgramState[] = [];
		vscode.onNotification('programs/stateChanged', (p) => states.push((p as { state: ProgramState }).state));
		await vscode.request('programs/subscribe', { brick: 'Robot' });
		const run = await terminal.request<DeployResult>('programs/run', { brick: 'Robot', path: DEMO });
		assert.equal(run.runSeq, 1);
		assert.notEqual(run.outcome, 'uncertain');
		await waitFor(() => states.some((s) => s.running), 5000);
		const stopped = await vscode.request<ProgramState>('programs/stop', { brick: 'Robot' });
		assert.equal(stopped.running, false);
		await waitFor(() => states.some((s) => !s.running && s.stoppedBy === 'VS Code' && s.runSeq === 1), 5000);
		w.done();
	});

	it('refuses an ambiguous name with the candidates, and an MCP client that names no brick', async () => {
		const w = world();
		const agent = w.connect('agent', 'mcp');
		await assert.rejects(agent.request('bricks/info', {}), (e: unknown) => e instanceof ContractError && e.code === WireErrorCode.InvalidRequest);
		await assert.rejects(agent.request('bricks/info', { brick: 'Nobody' }), (e: unknown) => e instanceof ContractError && e.code === WireErrorCode.BrickNotFound);
		w.done();
	});

	it('lets a CLI client leave the brick out when exactly one is connected', async () => {
		const w = world();
		const cli = w.connect('ev3', 'cli');
		await w.runtime.scheduler.scanOnce();
		await cli.request('bricks/connect', { brick: 'Robot' });
		const info = await cli.request<{ name: string }>('bricks/info', {});
		assert.equal(info.name, 'Robot');
		w.done();
	});

	it('refuses a local path that is not absolute: the daemon\'s working directory is not the client\'s', async () => {
		const w = world();
		const cli = w.connect('ev3', 'cli');
		await w.runtime.scheduler.scanOnce();
		await cli.request('bricks/connect', { brick: 'Robot' });
		const relative = (e: unknown) => e instanceof ContractError && e.code === WireErrorCode.InvalidRequest && /absolute/.test(e.message);
		await assert.rejects(cli.request('files/write', { brick: 'Robot', path: '/home/root/lms2012/prjs/x.rbf', fromLocalPath: 'x.rbf' }), relative);
		await assert.rejects(cli.request('files/read', { brick: 'Robot', path: '/home/root/lms2012/prjs/x.rbf', toLocalPath: 'x.rbf' }), relative);
		w.done();
	});

	it('lets a transfer proceed and keeps the debt when nobody can answer the release question', async () => {
		const w = world();
		const agent = w.connect('agent', 'mcp', 'keep');
		await w.runtime.scheduler.scanOnce();
		await agent.request('bricks/connect', { brick: 'Robot' });
		const id = brickIdOf(await agent.request<ContractBrick[]>('bricks/list'), 'Robot');
		ledgerFor(w.runtime.bricks, makeBrickKey(Transport.Mock, 'M1')).owe({ kind: 'unknown' });
		const ledger = ledgerFor(w.runtime.bricks, id as never);
		ledger.owe({ kind: 'unknown' });
		await agent.request('files/write', { brick: 'Robot', path: '/home/root/lms2012/prjs/x/a.txt', content: Buffer.from('hi').toString('base64') });
		assert.deepEqual(agent.asked.filter((k) => k === 'sweep').length > 0, true);
		assert.ok(ledger.pending() >= 1, 'the debt was dropped');
		w.done();
	});

	it('refuses a forget without a person\'s yes, naming the command', async () => {
		const w = world();
		const agent = w.connect('agent', 'mcp', 'keep');
		await w.runtime.scheduler.scanOnce();
		await assert.rejects(agent.request('bricks/forget', { brick: 'Robot' }), (e: unknown) =>
			e instanceof ContractError && e.code === WireErrorCode.NeedsPerson && e.data.command === 'ev3 forget Robot');
		assert.deepEqual(agent.asked, ['forget']);
		w.done();
	});

	it('reads each client\'s shown brick in the foreground', async () => {
		const w = world();
		const a = w.connect('window A');
		const b = w.connect('window B');
		await w.runtime.scheduler.scanOnce();
		await a.request('bricks/connect', { brick: 'Robot' });
		await b.request('bricks/connect', { brick: 'Other' });
		const list = await a.request<ContractBrick[]>('bricks/list');
		await a.request('telemetry/foreground', { brick: 'Robot' });
		await b.request('telemetry/foreground', { brick: 'Other' });
		await waitFor(() => w.runtime.telemetry.modeOf(brickIdOf(list, 'Robot') as never) === ActivityMode.Foreground
			&& w.runtime.telemetry.modeOf(brickIdOf(list, 'Other') as never) === ActivityMode.Foreground, 3000);
		w.done();
	});

	it('reads a small file inline', async () => {
		const w = world();
		const cli = w.connect('ev3', 'cli');
		await w.runtime.scheduler.scanOnce();
		await cli.request('bricks/connect', { brick: 'Robot' });
		const read = await cli.request<{ bytes: number; content: string }>('files/read', { path: DEMO, inline: true });
		assert.equal(Buffer.from(read.content, 'base64').toString(), 'LEGO-rbf-image');
		w.done();
	});
});
