/**
 * A momentary loss of a brick's route does not fail an operation by itself: a command not yet
 * sent waits for the route within the operation's budget, and an upload whose pinned channel
 * drops starts again once the route is back. Once the budget is spent, the operation fails with
 * the route's reason.
 *
 * The shipped session manager and brick layer over the mock brick, with the mock's `recover()`
 * taken away: no real transport has one, and a link that comes back has to be opened again.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BrickCommand, BrickResponse, makeBrickKey, SendCommandOptions, Transport } from '../core/contracts';
import { CancelledError, ErrorCode, NotConnectedError } from '../core/errors/CockpitError';
import { createBrickFilesystem } from '../core/fs/brickFilesystem';
import { ledgerFor } from '../core/fs/transferLedger';
import { MockTransportProvider } from '../core/mock/mockTransportProvider';
import { ProgramService } from '../core/programs/programService';
import { BrickManager } from '../core/runtime/brickManager';
import { DiscoveryScheduler } from '../core/runtime/discoveryScheduler';
import { PresenceAggregator } from '../core/runtime/presenceAggregator';
import { SessionManager } from '../core/runtime/sessionManager';
import { ProviderRegistry } from '../core/transports/providerRegistry';
import { waitFor } from './waitFor';

const KEY = makeBrickKey(Transport.Mock, 'M1');
const PRG = '/home/root/lms2012/prjs/Robot/Robot.rbf';
const REFUSAL = 'BT connect failed (WSA error 10060).';

async function world() {
	const mock = new MockTransportProvider({
		transport: Transport.Mock,
		bricks: [{
			id: 'M1', displayName: 'M1', battery: { level: 80 }, motorPorts: [], sensorPorts: [],
			filesystem: [{ path: PRG, content: 'LEGO-rbf-image' }],
		}],
	} as never);
	const registry = new ProviderRegistry();
	registry.register(mock);
	const scheduler = new DiscoveryScheduler(registry, { unavailableAfterMisses: 1, removedAfterMisses: 5 });
	const aggregator = new PresenceAggregator(scheduler, registry);
	const sessionManager = new SessionManager({
		providerRegistry: registry, heartbeatIntervalMs: 60_000, reconnectBaseMs: 20, reconnectMaxMs: 40,
	});
	const bricks = new BrickManager({ sessionManager, aggregator, providerRegistry: registry });
	await scheduler.scanOnce();
	const brickId = aggregator.getDiscoveryList()[0].brickId;
	await bricks.signIn(brickId);

	// As the real transports: no `recover`, and a link that went is opened again with `connect`.
	(mock as { recover?: unknown }).recover = undefined;
	mock.disconnect = () => Promise.resolve();
	const connect = mock.connect.bind(mock);
	const state = { down: false };
	mock.connect = (key) => (state.down ? Promise.reject(new Error(REFUSAL)) : connect(key));

	/** The link goes: the heartbeat finds it gone, and it stays gone while `state.down`. */
	const dropLink = (): void => {
		state.down = true;
		sessionManager['handleHeartbeatFailure'](KEY, new Error('link went away'));
	};
	return {
		mock, bricks, brickId, sessionManager, state, dropLink,
		done: () => {
			bricks.dispose(); sessionManager.dispose(); aggregator.dispose(); scheduler.dispose(); registry.dispose(); mock.dispose();
		},
	};
}

const codeOf = (error: unknown): unknown => (error as { code?: unknown }).code;
const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('A command waits for a lost route within its budget', () => {
	it('lets a command not yet sent through once the route drops and comes back within the budget', async () => {
		const w = await world();
		w.dropLink();
		assert.equal(w.bricks.routeOf(w.brickId), undefined, 'the route did not go');

		const reply = w.bricks.send(w.brickId, { kind: 'battery' }, { deadline: Date.now() + 3000 });
		await settle(100);
		w.state.down = false;

		assert.equal((await reply).kind, 'battery');
		w.done();
	});

	it('fails with the route\'s reason once a route that stays down outlasts the budget', async () => {
		const w = await world();
		w.dropLink();
		const startedAt = Date.now();

		await assert.rejects(w.bricks.send(w.brickId, { kind: 'battery' }, { deadline: startedAt + 300 }), (error) => {
			assert.ok(error instanceof NotConnectedError, `not a missing route: ${String(error)}`);
			assert.match((error as Error).message, /WSA error 10060/);
			return true;
		});
		assert.ok(Date.now() - startedAt >= 250, 'it did not wait for the budget');
		w.done();
	});

	it('fails at once without a budget, as a command always has', async () => {
		const w = await world();
		w.dropLink();
		const startedAt = Date.now();

		await assert.rejects(w.bricks.send(w.brickId, { kind: 'battery' }), (error) => codeOf(error) === ErrorCode.NotConnected);
		assert.ok(Date.now() - startedAt < 100, 'it waited without being given a budget');
		w.done();
	});
});

describe('A start that waits for a lost route', () => {
	it('starts nothing when the brick is stopped while the start waits, once the route is back', async () => {
		const w = await world();
		const programs = new ProgramService(
			(command, options) => w.bricks.send(w.brickId, command, options),
			{ confirmTimeoutMs: 300, confirmStepMs: 10, waitForRoute: (options) => w.bricks.waitForRoute(w.brickId, options) },
		);
		const sent: BrickCommand['kind'][] = [];
		const execute = w.mock.executeCommand.bind(w.mock);
		let dropped = false;
		w.mock.executeCommand = async (key, command: BrickCommand, options?: SendCommandOptions): Promise<BrickResponse> => {
			sent.push(command.kind);
			const reply = await execute(key, command, options);
			// The start's check that nothing runs is answered, then the link goes before the start.
			if (command.kind === 'program:status' && !dropped) { dropped = true; w.dropLink(); }
			return reply;
		};

		const starting = programs.start(PRG, { deadline: Date.now() + 3000 });
		await waitFor(() => dropped && w.bricks.routeOf(w.brickId) === undefined, 1000);
		// The stop has no route to go over and fails; the brick was stopped all the same.
		await programs.stop('VS Code').catch(() => undefined);
		w.state.down = false;

		await assert.rejects(starting, (error) => {
			assert.ok(error instanceof CancelledError, `not cancelled: ${String(error)}`);
			assert.equal(error.stoppedBy, 'VS Code');
			return true;
		});
		assert.equal(sent.filter((k) => k === 'program:run').length, 0, 'the start went out after the stop');
		programs.dispose();
		w.done();
	});
});

describe('An upload whose pinned channel drops starts again once the route is back', () => {
	it('completes within its budget instead of failing because its channel changed', async () => {
		const w = await world();
		const sent: BrickCommand['kind'][] = [];
		const execute = w.mock.executeCommand.bind(w.mock);
		let dropped = false;
		w.mock.executeCommand = async (key, command: BrickCommand, options?: SendCommandOptions): Promise<BrickResponse> => {
			sent.push(command.kind);
			const reply = await execute(key, command, options);
			// The first chunk arrives, then the link goes before the next one is sent.
			if (command.kind === 'fs:beginWrite' && !dropped) {
				dropped = true;
				w.dropLink();
				setTimeout(() => { w.state.down = false; }, 100);
			}
			return reply;
		};
		const path = '/home/root/lms2012/prjs/Robot/big.rbf';
		const content = new Uint8Array(1500).fill(0x41);   // more than one packet: a second chunk follows

		await createBrickFilesystem(w.bricks, w.brickId).transfer.writeFile(path, content, { deadline: Date.now() + 3000 });

		assert.equal(sent.filter((k) => k === 'fs:beginWrite').length, 2, `not started again from its first chunk: ${sent.join(', ')}`);
		assert.equal(sent.filter((k) => k === 'fs:continueWrite').length, 1, 'a chunk went over the lost channel');
		assert.ok(w.mock.getFilesystem(KEY)?.exists(path), 'the file is not on the brick');
		assert.equal(ledgerFor(w.bricks, w.brickId).pending(), 0, 'the abandoned slot is still owed');
		w.done();
	});
});
