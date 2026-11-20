/**
 * Everything the daemon answers once a client has proved itself: the contract's methods, run on the
 * cockpit's core, with holders, write leases, questions for a person and one active brick per client.
 *
 * Program services, telemetry delivery and file access go through the core's API object, one for the
 * daemon, with one consumer per client: every client's stop reaches the same program service, and
 * each client's telemetry arrives in order.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { ContractError } from '../client/connection';
import { WireErrorCode } from '../contract/errors';
import type {
	BrickStatus, ContractBrick, ContractChain, DaemonStatus, DeployResult, ProgramState, StartOutcome, TelemetryValue,
} from '../contract/models';
import { BrickServices, ClientSession, PerBrickServices, ApiChain, createBrickServices } from '../core/api/cockpitApi';
import { assertAllowed, type AccessMode } from '../core/api/accessPolicy';
import { BrickEntry, BrickId, BrickRef, ChannelState, Transport, operationDeadline } from '../core/contracts';
import { setSweepConfirmation } from '../core/fs/transferLedger';
import { deployAndRun } from '../core/programs/deployAndRun';
import type { Runtime } from '../core/runtime/createRuntime';
import type { LoanResult } from '../contract/methods';
import type { ForgetReport } from '../core/runtime/forgetReport';
import { readProgramPresetSettings } from '../core/telemetry/telemetrySettings';
import { settingsSection } from '../core/settings/spec';
import { resolveBrick } from './brickResolver';
import { HolderSets, type HolderSnapshot } from './holders';
import { Leases } from './leases';
import type { Daemon, DaemonClient } from './main';
import { ask } from './questions';

/** Small files are read inline up to this size. */
export const MAX_INLINE_READ_BYTES = 64 * 1024;
/** Inline content written with a request, at most. */
export const MAX_INLINE_WRITE_BYTES = 4 * 1024;
/** Chunks of file content in a transfer handle: 48 KiB, 64 KiB as base64. */
export const TRANSFER_CHUNK_BYTES = 48 * 1024;
/** How long a predecessor's clients have to come back and take over their holds. */
export const RESTORE_MS = 30_000;
/** How often a held brick that has not come back since a handover is tried again. */
export const RECONNECT_RETRY_MS = 3000;

interface Handle {
	readonly clientId: string;
	data: Buffer;
	/** Upload: bytes filled; download: bytes handed out. */
	offset: number;
	readonly upload: boolean;
}

/** What one daemon's surface shares between its clients. */
export interface Surface {
	readonly holders: HolderSets;
	readonly leases: Leases;
	readonly api: BrickServices & PerBrickServices;
	attach(client: DaemonClient): void;
	/** Bricks reported as reconnecting after a restart. */
	readonly reconnecting: Set<string>;
	/** Bricks this daemon must not touch, and why. */
	readonly blocked: Map<string, { readonly by: string; readonly holder?: string }>;
	/**
	 * Takes over a predecessor's holders: the held bricks are reported as reconnecting and connected
	 * again as they show up; holds of clients that do not come back within `RESTORE_MS` are dropped.
	 */
	resume(snapshot: HolderSnapshot): void;
	/** Connects these held bricks again, retrying until each is back or nobody holds it. */
	reconnectHeld(brickIds: readonly string[]): void;
	/** Tells every client the brick list changed (a loan began or ended). */
	refreshBricks(): void;
	bricks(): ContractBrick[];
	brickStatus(): BrickStatus[];
	broadcast(method: string, params: unknown): void;
	dispose(): void;
}

const plainValue = (value: unknown): TelemetryValue['value'] => (value === undefined ? null : value as TelemetryValue['value']);

function forgetLines(report: ForgetReport): string[] {
	const lines = [`On the brick: ${JSON.stringify(report.brickSide)}`];
	for (const pairing of report.pairing) { lines.push(`Pairing ${pairing.status}${'reason' in pairing ? `: ${pairing.reason}` : ''}`); }
	lines.push(`Remembered bricks: ${report.memory.status}`);
	for (const residue of report.residue) { lines.push(`Left behind: ${JSON.stringify(residue)}`); }
	return lines;
}

/** A development daemon's side of its loans (KTD17). */
export interface SurfaceLoans {
	/** Borrows the brick when this daemon may not open it yet; throws when the loan is refused. */
	ensureOpenable(brickId: string): Promise<void>;
	/** Borrows every brick; absent on a daemon that does not borrow. */
	borrowAll?(): Promise<LoanResult>;
}

/** What the surface needs of the daemon. */
export type SurfaceHost = Pick<Daemon, 'status' | 'settings' | 'log' | 'clients' | 'lifecycle'>;

export function createSurface(daemon: SurfaceHost, runtime: Runtime, discoverySettled: () => Promise<void>, loans?: SurfaceLoans): Surface {
	const { settings, log, clients, lifecycle } = daemon;
	const accessMode = (): AccessMode => (settings.value('accessMode') === 'full' ? 'full' : 'safe');
	/** The client whose request is running, for questions the core asks in the middle of it. */
	const current = new AsyncLocalStorage<DaemonClient>();
	const runSeq = new Map<string, number>();
	const stoppedBy = new Map<string, string>();
	const foreground = new Map<string, string>();
	const handles = new Map<string, Handle>();
	const reconnecting = new Set<string>();
	const blocked = new Map<string, { readonly by: string; readonly holder?: string }>();
	/** Client ids from a predecessor whose holds a returning client of the same name takes over. */
	const restoredClients = new Set<string>();
	let disposed = false;

	const holders = new HolderSets({
		signOut: async (brickId) => {
			await runtime.bricks.signOut(brickId as BrickId);
		},
		onChange: () => {
			lifecycle.setHolds(holders.holdCount());
			scheduleBricksChanged();
		},
	});
	const leases = new Leases();

	const api = createBrickServices({
		bricks: runtime.bricks,
		aggregator: runtime.aggregator,
		telemetry: {
			rows: () => runtime.telemetry.rows(),
			claim: (brickId, request, owner) => runtime.telemetry.claim(brickId, request, owner),
			release: (handle) => runtime.telemetry.release(handle),
			onClaimsEnded: (listener) => runtime.telemetry.onClaimsEnded(listener),
			snapshot: (brickId, rowIds) => runtime.telemetryView.snapshot(brickId, rowIds),
			onChange: (listener) => runtime.telemetryView.onChange(listener),
			programStatusIntervalMs: () => readProgramPresetSettings(settingsSection(settings.all()), (m) => log.warn(m)).programStatusIntervalMs,
			onProgramStatusIntervalChange: (listener) => settings.onChange((e) => { if (e.key === 'programs.statusIntervalMs') { listener(); } }),
		},
		connect: (brickId) => runtime.bricks.signIn(brickId),
		accessMode,
		onAccessModeChange: (listener) => settings.onChange((e) => { if (e.key === 'accessMode') { listener(accessMode()); } }),
		log,
	});
	// Every client's own telemetry foreground; none until a client shows a brick.
	runtime.telemetry.setForegroundBricks(new Set());

	const toBrick = (entry: BrickEntry): ContractBrick => ({
		brickId: entry.brickId,
		name: entry.name.value,
		nameConfirmed: entry.name.confirmed,
		connected: runtime.bricks.isSignedIn(entry.brickId),
		paired: entry.paired,
		channels: entry.channels
			.filter((c) => c.state !== ChannelState.Absent)
			.map((c) => ({ transport: String(c.transport) as ContractBrick['channels'][number]['transport'], state: c.state as 'available' | 'connected' | 'lost' })),
		holders: holders.holdersOf(entry.brickId),
		...(reconnecting.has(entry.brickId) ? { reconnecting: true } : {}),
		...(blocked.has(entry.brickId) ? { blocked: blocked.get(entry.brickId)! } : {}),
	});
	const bricks = (): ContractBrick[] => runtime.aggregator.getDiscoveryList().map(toBrick);

	let changePending = false;
	const broadcast = (method: string, params: unknown): void => {
		for (const client of clients.values()) { client.endpoint.notify(method, params); }
	};
	function scheduleBricksChanged(): void {
		if (changePending) { return; }
		changePending = true;
		queueMicrotask(() => {
			changePending = false;
			broadcast('bricks/changed', { bricks: bricks() });
		});
	}
	const shared = [
		runtime.aggregator.onListChanged(() => scheduleBricksChanged()),
		runtime.bricks.onRouteChange((e) => {
			if (e.current && reconnecting.delete(e.brickId)) { scheduleBricksChanged(); }
			if (e.current && !e.previous) { broadcast('bricks/reconnected', { brickId: e.brickId }); }
		}),
		runtime.bricks.onPairingStarted((event) => {
			broadcast('bricks/pairingStarted', { brickId: event.brickId });
			// The phase is the event's type; the message carries the whole event as JSON.
			event.onEvent((e) => broadcast('bricks/pairingEvent', { brickId: event.brickId, phase: String((e as { type?: unknown }).type ?? 'event'), message: JSON.stringify(e) }));
			void event.done.then((result) => broadcast('bricks/pairingDone', {
				brickId: event.brickId, paired: result.ok, ...(result.reason ? { message: result.reason } : {}),
			}));
		}),
		runtime.bricks.onOneSidedRepair((repair) => broadcast('bricks/oneSidedRepair', {
			brickId: repair.brickId, message: `Found paired on ${repair.found === 'windows-only' ? 'this computer only' : 'the brick only'}; repaired.`,
			repair,
		})),
		settings.onChange((e) => {
			const entry = settings.list().find((s) => s.spec.key === e.key);
			if (entry) { broadcast('settings/changed', { setting: entry }); }
			if (e.key === 'accessMode') { broadcast('settings/accessModeChanged', { mode: accessMode() }); }
		}),
	];

	// A slot left open by a cut transfer: ask the person behind the transfer that is starting now.
	setSweepConfirmation(runtime.bricks, async (scope) => {
		const client = current.getStore();
		const answer = client ? await ask(client.endpoint, {
			kind: 'sweep',
			text: scope === 'all'
				? 'A file transfer to the brick was cut off before the brick said which file it opened, so its space may stay taken until the brick restarts. Release it now? This closes every file the brick has open, including a transfer another computer may be running.'
				: 'A file transfer to the brick was cut off just as it finished, so the cockpit cannot tell whether the brick already let go of its file. Release it now? If another computer is sending a file to this brick right now, this may cut its transfer off.',
		}) : 'keep';
		if (answer === 'keep') {
			log.write('WARN', 'A transfer slot left open on a brick was not released: nobody could be asked. A person can release it from VS Code or a terminal.', client?.identity.name);
			throw new Error('not answered');
		}
		return answer === 'yes';
	});

	const brickStatus = (): BrickStatus[] => {
		const leased = leases.snapshot();
		return holders.heldBricks().map((brickId) => ({
			brickId,
			name: runtime.aggregator.getBrick(brickId as BrickId)?.name.value ?? brickId,
			holders: holders.holdersOf(brickId),
			...(leased[brickId] ? { leaseHolder: leased[brickId] } : {}),
			...(reconnecting.has(brickId) ? { reconnecting: true } : {}),
		}));
	};

	const programState = (brickId: string, running: boolean): ProgramState => ({
		brickId, running, runSeq: runSeq.get(brickId) ?? 0,
		...(!running && stoppedBy.has(brickId) ? { stoppedBy: stoppedBy.get(brickId)! } : {}),
	});
	const nextRun = (brickId: string): number => {
		const next = (runSeq.get(brickId) ?? 0) + 1;
		runSeq.set(brickId, next);
		stoppedBy.delete(brickId);
		return next;
	};
	const chain = (c: ApiChain): ContractChain => ({ brickId: c.brickId, read: c.read, stale: c.stale, members: c.members.map((m) => ({ ...m })) });

	const attach = (client: DaemonClient): void => {
		const { endpoint, identity } = client;
		const owner = { clientId: client.id, name: identity.name };
		const consumer: ClientSession = api.openSession(identity.name);
		// A client back after a handover takes over the holds its old connection had.
		if (restoredClients.size > 0) { holders.reclaim(identity.name, client.id, restoredClients); }
		const subscriptions = new Map<string, { dispose(): void }>();
		const person = identity.kind === 'vscode' || identity.kind === 'cli';

		const on = (method: string, handler: (params: Record<string, unknown>, signal: AbortSignal) => unknown): void => {
			endpoint.onRequest(method, (params, context) =>
				current.run(client, () => handler((params ?? {}) as Record<string, unknown>, context.signal)));
		};
		const brickOf = async (params: Record<string, unknown>, allowBlocked = false): Promise<string> => {
			const id = await resolveBrick({
				bricks: () => bricks().map((b) => ({ brickId: b.brickId, name: b.name, connected: b.connected })),
				discoverySettled,
			}, typeof params.brick === 'string' ? params.brick : undefined, identity.kind);
			const block = blocked.get(id);
			if (block && !allowBlocked) {
				throw new ContractError(WireErrorCode.NotConnected, `Brick ${id} is ${block.by}${block.holder ? ` (${block.holder})` : ''}; this daemon does not touch it now.`);
			}
			return id;
		};
		const leased = async <T>(brickId: string, signal: AbortSignal, work: (signal: AbortSignal) => Promise<T>): Promise<T> => {
			try {
				return await leases.run(brickId, owner, work, signal);
			} catch (error) {
				// Cut off by a handover: whether the write happened is not known, and nobody retries it.
				if (lifecycle.state === 'handingOver' && !(error instanceof ContractError && error.code === WireErrorCode.BrickBusy)) {
					throw new ContractError(WireErrorCode.OutcomeUnknown,
						'The daemon was replaced while this ran, so whether it finished is not known. It was not retried.',
						{ kind: 'OutcomeUnknownError' });
				}
				throw error;
			}
		};
		const str = (value: unknown, name: string): string => {
			if (typeof value !== 'string' || value === '') { throw new ContractError(WireErrorCode.InvalidRequest, `${name} is missing.`); }
			return value;
		};
		const subscribe = (dispose: { dispose(): void }): string => {
			const id = randomBytes(6).toString('hex');
			subscriptions.set(id, dispose);
			return id;
		};

		// --- daemon -----------------------------------------------------------
		on('daemon/status', (): DaemonStatus => ({ ...daemon.status(), bricks: brickStatus() }));

		// --- bricks -----------------------------------------------------------
		on('bricks/list', async (params) => {
			if (params.waitForDiscovery) { await discoverySettled(); }
			return bricks();
		});
		on('bricks/connect', async (params) => {
			let brickId = await brickOf(params, Boolean(loans));
			// A development daemon borrows the brick first; a refusal ends the connect here.
			if (loans) {
				await loans.ensureOpenable(brickId);
				brickId = await brickOf(params);
			}
			// The person asked for this brick: a pairing they cancelled earlier may be asked again.
			runtime.bricks.resumePairing(brickId as BrickId);
			if (runtime.bricks.isSignedIn(brickId as BrickId)) {
				// Connected already: try every channel that is not connected yet.
				await runtime.bricks.connectAgain(brickId as BrickId);
			} else {
				// A brick only an inquiry has heard has nothing to connect over until it is paired; a
				// channel still listed as lost (a cable pulled since) does not count.
				const entry = runtime.aggregator.getBrick(brickId as BrickId);
				const bt = entry?.channels.find((c) => c.transport === Transport.BT);
				if (entry && !entry.paired && bt && entry.channels.every((c) => c === bt || c.state === ChannelState.Lost)) {
					const paired = await runtime.bricks.pair(brickId as BrickId);
					if (!paired.ok) {
						throw new ContractError(WireErrorCode.NotConnected, `Could not pair ${entry.name.value}: ${paired.reason ?? 'no reason given'}.`);
					}
				}
				await runtime.bricks.signIn(brickId as BrickId);
			}
			holders.add(brickId, params.hold ? { kind: 'hold' } : { kind: 'client', clientId: client.id, name: identity.name });
			log.info(`Connected ${brickId}${params.hold ? ' and held' : ''}`, identity.name);
			const entry = runtime.aggregator.getBrick(brickId as BrickId);
			if (!entry) { throw new ContractError(WireErrorCode.NotConnected, `Brick ${brickId} went away.`); }
			return toBrick(entry);
		});
		on('bricks/disconnect', async (params) => {
			const brickId = await brickOf(params);
			if (params.forEveryone) {
				await holders.dropAll(brickId);
			} else if (params.releaseHold) {
				await holders.drop(brickId, { kind: 'hold' });
			} else {
				await holders.drop(brickId, { kind: 'client', clientId: client.id, name: identity.name });
			}
			log.info(`Disconnect ${brickId}${params.forEveryone ? ' for everyone' : ''}`, identity.name);
			return { stillHeldBy: holders.holdersOf(brickId).map((h) => h.client ?? (h.kind === 'hold' ? 'ev3 connect' : 'remembered')) };
		});
		on('bricks/info', async (params) => consumer.getBrickInfo(await brickOf(params)));
		on('bricks/storage', async (params) => consumer.storage(await brickOf(params)));
		on('bricks/pair', async (params) => {
			const brickId = await brickOf(params);
			const result = await runtime.bricks.pair(brickId as BrickId);
			return { paired: result.ok, ...(result.reason ? { message: result.reason } : {}) };
		});
		on('bricks/forget', async (params, signal) => {
			const brickId = await brickOf(params);
			const name = runtime.aggregator.getBrick(brickId as BrickId)?.name.value ?? brickId;
			const answer = await ask(endpoint, {
				kind: 'forget', brickId,
				text: `Forget ${name}? This computer and the brick both drop their pairing; pairing again needs someone at the brick.`,
			});
			if (answer !== 'yes') {
				if (answer === 'no') { throw new ContractError(WireErrorCode.Cancelled, 'Not forgotten: the person said no.'); }
				throw new ContractError(WireErrorCode.NeedsPerson, `Forgetting ${name} needs a person's yes: run ev3 forget ${name} in a terminal, or use VS Code.`,
					{ command: `ev3 forget ${name}`, kind: 'NeedsPersonError' });
			}
			return leased(brickId, signal, async () => {
				const report = await runtime.bricks.forget(brickId as BrickId);
				holders.forget(brickId);
				return { forgotten: true, report: forgetLines(report), details: report };
			});
		});
		on('bricks/clearBluetoothList', async (params, signal) => {
			const brickId = await brickOf(params);
			const name = runtime.aggregator.getBrick(brickId as BrickId)?.name.value ?? brickId;
			let refused: 'no' | 'keep' | undefined;
			const report = await leased(brickId, signal, () => runtime.bricks.clearBluetoothList(brickId as BrickId, async (names, includesThisComputer, thisComputer) => {
				const answer = await ask(endpoint, {
					kind: 'clearBluetoothList', brickId,
					text: `Remove ${names.length} entr${names.length === 1 ? 'y' : 'ies'} from ${name}'s list of paired devices?${includesThisComputer ? ` This computer (${thisComputer ?? 'this one'}) is among them.` : ''}`,
					details: names,
					...(thisComputer ? { thisComputer } : {}),
					includesThisComputer,
				});
				if (answer !== 'yes') { refused = answer; }
				return answer === 'yes';
			}));
			if (refused === 'keep') {
				throw new ContractError(WireErrorCode.NeedsPerson, `Clearing ${name}'s Bluetooth list needs a person's yes: run ev3 bt-clear ${name} in a terminal, or use VS Code.`,
					{ command: `ev3 bt-clear ${name}`, kind: 'NeedsPersonError' });
			}
			const entries = report?.entries ?? [];
			return {
				removed: entries.filter((e) => e.status === 'confirmed' || e.status === 'sent').map((e) => e.name),
				kept: [...entries.filter((e) => e.status === 'failed' || e.status === 'not-removable').map((e) => e.name), ...(report?.left ?? [])],
				...(report ? { details: report } : {}),
			};
		});
		on('bricks/borrowAll', async () => {
			if (!loans?.borrowAll) { throw new ContractError(WireErrorCode.InvalidRequest, 'Only a development daemon borrows bricks; this is the user\'s own.'); }
			return loans.borrowAll();
		});
		on('bricks/inquiry', async () => {
			await runtime.btPresence?.runInquiry();
			return null;
		});

		// --- files ------------------------------------------------------------
		on('files/list', async (params) => consumer.list(await brickOf(params), str(params.path, 'path')));
		on('files/exists', async (params) => consumer.exists(await brickOf(params), str(params.path, 'path')));
		on('files/size', async (params) => consumer.size(await brickOf(params), str(params.path, 'path')));
		on('files/read', async (params, signal) => {
			const brickId = await brickOf(params);
			const data = Buffer.from(await consumer.readFile(brickId, str(params.path, 'path'), { signal, deadline: operationDeadline('transfer') }));
			if (typeof params.toLocalPath === 'string') {
				await fs.writeFile(params.toLocalPath, data);
				return { bytes: data.length };
			}
			if (params.inline) {
				if (data.length > MAX_INLINE_READ_BYTES) {
					throw new ContractError(WireErrorCode.InvalidRequest, `The file has ${data.length} bytes; inline reads take at most ${MAX_INLINE_READ_BYTES}. Read it to a local path or through a handle.`);
				}
				return { bytes: data.length, content: data.toString('base64') };
			}
			const handle = randomBytes(8).toString('hex');
			handles.set(handle, { clientId: client.id, data, offset: 0, upload: false });
			return { bytes: data.length, handle };
		});
		on('files/write', async (params, signal) => {
			const brickId = await brickOf(params);
			const path = str(params.path, 'path');
			let data: Buffer;
			if (typeof params.fromLocalPath === 'string') {
				data = await fs.readFile(params.fromLocalPath);
			} else if (typeof params.content === 'string') {
				data = Buffer.from(params.content, 'base64');
				if (data.length > MAX_INLINE_WRITE_BYTES) {
					throw new ContractError(WireErrorCode.InvalidRequest, `Inline content takes at most ${MAX_INLINE_WRITE_BYTES} bytes; send a local path or a handle.`);
				}
			} else if (typeof params.handle === 'string') {
				const handle = handles.get(params.handle);
				if (!handle || !handle.upload || handle.clientId !== client.id) { throw new ContractError(WireErrorCode.InvalidRequest, 'No such upload handle.'); }
				data = handle.data.subarray(0, handle.offset);
				handles.delete(params.handle);
			} else {
				throw new ContractError(WireErrorCode.InvalidRequest, 'files/write needs fromLocalPath, content or handle.');
			}
			await leased(brickId, signal, (leaseSignal) => consumer.writeFile(brickId, path, data, { signal: leaseSignal, deadline: operationDeadline('transfer') }));
			return { bytes: data.length };
		});
		on('files/makeDirectory', async (params, signal) => {
			const brickId = await brickOf(params);
			await leased(brickId, signal, () => consumer.makeDirectory(brickId, str(params.path, 'path')));
			return null;
		});
		on('files/remove', async (params, signal) => {
			const brickId = await brickOf(params);
			const path = str(params.path, 'path');
			assertAllowed(accessMode(), 'delete', path);
			const files = api.filesOf(brickId as BrickId).files;
			return leased(brickId, signal, async () => {
				if (params.recursive) { return files.removeTree(path); }
				await files.remove(path);
				return { leftBehind: [] };
			});
		});
		on('files/removePaths', async (params, signal) => {
			const brickId = await brickOf(params);
			const paths = Array.isArray(params.paths) ? params.paths.map((p) => str(p, 'paths')) : [];
			for (const path of paths) { assertAllowed(accessMode(), 'delete', path); }
			const files = api.filesOf(brickId as BrickId).files;
			return leased(brickId, signal, () => files.removePaths(paths, { recursive: params.recursive === true }));
		});
		on('files/move', async (params, signal) => {
			const brickId = await brickOf(params);
			await leased(brickId, signal, () => consumer.move(brickId, str(params.from, 'from'), str(params.to, 'to')));
			return null;
		});

		// --- transfer handles -------------------------------------------------
		on('transfer/begin', (params) => {
			const size = Number(params.size);
			if (!Number.isInteger(size) || size < 0 || size > 64 * 1024 * 1024) { throw new ContractError(WireErrorCode.InvalidRequest, 'transfer/begin needs a size up to 64 MiB.'); }
			const handle = randomBytes(8).toString('hex');
			handles.set(handle, { clientId: client.id, data: Buffer.alloc(size), offset: 0, upload: true });
			return { handle, chunkBytes: TRANSFER_CHUNK_BYTES };
		});
		on('transfer/write', (params) => {
			const handle = handles.get(str(params.handle, 'handle'));
			if (!handle || !handle.upload || handle.clientId !== client.id) { throw new ContractError(WireErrorCode.InvalidRequest, 'No such upload handle.'); }
			const chunk = Buffer.from(str(params.data, 'data'), 'base64');
			if (handle.offset + chunk.length > handle.data.length) { throw new ContractError(WireErrorCode.InvalidRequest, 'More data than the size begun.'); }
			chunk.copy(handle.data, handle.offset);
			handle.offset += chunk.length;
			return null;
		});
		on('transfer/read', (params) => {
			const id = str(params.handle, 'handle');
			const handle = handles.get(id);
			if (!handle || handle.upload || handle.clientId !== client.id) { throw new ContractError(WireErrorCode.InvalidRequest, 'No such download handle.'); }
			const chunk = handle.data.subarray(handle.offset, handle.offset + TRANSFER_CHUNK_BYTES);
			handle.offset += chunk.length;
			const done = handle.offset >= handle.data.length;
			if (done) { handles.delete(id); }
			return { data: chunk.toString('base64'), done };
		});
		on('transfer/close', (params) => {
			handles.delete(str(params.handle, 'handle'));
			return null;
		});

		// --- programs ---------------------------------------------------------
		on('programs/deployAndRun', async (params, signal): Promise<DeployResult> => {
			const brickId = await brickOf(params);
			const runPath = str(params.runPath, 'runPath');
			const files = Array.isArray(params.files) ? params.files as Record<string, unknown>[] : [];
			for (const file of files) { assertAllowed(accessMode(), 'write', str(file.remotePath, 'remotePath')); }
			assertAllowed(accessMode(), 'run', runPath);
			const services = api.filesOf(brickId as BrickId);
			return leased(brickId, signal, async (leaseSignal) => {
				const seq = nextRun(brickId);
				const result = await deployAndRun({ programs: api.programsOf(brickId as BrickId), files: services.files, transfer: services.transfer }, {
					files: files.map((f) => ({
						path: f.remotePath as string,
						...(typeof f.localPath === 'string' ? { localPath: f.localPath } : {}),
						...(typeof f.content === 'string' ? { content: new Uint8Array(Buffer.from(f.content, 'base64')) } : {}),
						...(f.skipIfSameMd5 ? { skipIfSame: true } : {}),
					})),
					program: runPath,
					signal: leaseSignal,
				});
				log.info(`Deployed ${result.uploaded.length} file(s), skipped ${result.skipped.length}, started ${runPath}: ${result.outcome}`, identity.name);
				return { brickId, outcome: result.outcome, runSeq: seq, uploaded: result.uploaded, skipped: result.skipped };
			});
		});
		on('programs/run', async (params, signal): Promise<DeployResult> => {
			const brickId = await brickOf(params);
			const path = str(params.path, 'path');
			assertAllowed(accessMode(), 'run', path);
			return leased(brickId, signal, async () => {
				const seq = nextRun(brickId);
				const outcome: StartOutcome = await api.programsOf(brickId as BrickId).start(path, {
					...(params.replace ? { replace: true } : {}), deadline: operationDeadline('command'),
				});
				return { brickId, outcome, runSeq: seq, uploaded: [], skipped: [] };
			});
		});
		const stop = async (params: Record<string, unknown>, emergency: boolean): Promise<ProgramState> => {
			const brickId = await brickOf(params);
			const programs = api.programsOf(brickId as BrickId);
			stoppedBy.set(brickId, identity.name);
			if (emergency) { await programs.emergencyStop(identity.name); } else { await programs.stop(identity.name); }
			log.info(`${emergency ? 'Emergency stop' : 'Stop'} on ${brickId}${leases.holder(brickId) ? ` (lease held by ${leases.holder(brickId)})` : ''}`, identity.name);
			return programState(brickId, await programs.isRunning());
		};
		// Never behind a lease: a stop reaches the brick at once from any client.
		on('programs/stop', (params) => stop(params, false));
		on('programs/emergencyStop', (params) => stop(params, true));
		on('programs/status', async (params, signal) => {
			const brickId = await brickOf(params);
			const programs = api.programsOf(brickId as BrickId);
			const waitMs = typeof params.waitMs === 'number' ? Math.min(params.waitMs, 120_000) : 0;
			const now = await programs.isRunning();
			if (waitMs <= 0) { return programState(brickId, now); }
			return new Promise<ProgramState>((resolve) => {
				const done = (running: boolean): void => { clearTimeout(timer); watch.dispose(); resolve(programState(brickId, running)); };
				const watch = programs.onStateChange((running) => { if (running !== now) { done(running); } });
				const timer = setTimeout(() => done(now), waitMs);
				signal.addEventListener('abort', () => done(now), { once: true });
			});
		});
		on('programs/subscribe', async (params) => {
			const brickId = await brickOf(params);
			const sub = consumer.onProgramStateChanged(brickId, (state) => {
				endpoint.notify('programs/stateChanged', { subscriptionId: id, state: programState(brickId, state.running) });
			});
			const id = subscribe(sub);
			return { subscriptionId: id, state: programState(brickId, await api.programsOf(brickId as BrickId).isRunning()) };
		});

		// --- shell --------------------------------------------------------------
		on('shell/run', async (params, signal) => {
			const brickId = await brickOf(params);
			const command = str(params.command, 'command');
			return leased(brickId, signal, () => consumer.runShell(brickId, command));
		});

		// --- telemetry and the chain ------------------------------------------
		on('telemetry/rows', () => consumer.listTelemetryRows());
		on('telemetry/subscribe', async (params) => {
			const brickId = await brickOf(params);
			const request = params.request as { rows?: unknown; intervalMs?: unknown; modes?: unknown } | undefined;
			if (!request || !Array.isArray(request.rows) || typeof request.intervalMs !== 'number') {
				throw new ContractError(WireErrorCode.InvalidRequest, 'telemetry/subscribe needs rows and intervalMs.');
			}
			let id = '';
			const sub = consumer.subscribeTelemetry(brickId, {
				rows: request.rows.map(String), intervalMs: request.intervalMs,
				...(request.modes ? { modes: request.modes as Record<string, number> } : {}),
			}, (update) => {
				endpoint.notify('telemetry/update', {
					subscriptionId: id, brickId: update.brickId, kind: update.kind, removed: update.removed,
					values: update.values.map((v) => ({ ...v, value: plainValue(v.value) })),
				});
			});
			id = subscribe(sub);
			return {
				subscriptionId: id, brickId: sub.brickId, grant: sub.grant,
				snapshot: sub.snapshot().map((v) => ({ ...v, value: plainValue(v.value) })),
			};
		});
		on('telemetry/foreground', async (params) => {
			if (params.brick === null || params.brick === undefined) { foreground.delete(client.id); } else { foreground.set(client.id, await brickOf(params)); }
			runtime.telemetry.setForegroundBricks(new Set(foreground.values()) as Set<BrickRef>);
			return null;
		});
		on('chain/get', async (params) => chain(consumer.getChain(await brickOf(params))));
		on('chain/follow', async (params) => {
			const brickId = await brickOf(params);
			let id = '';
			const sub = consumer.onChainChanged(brickId, (c) => endpoint.notify('chain/changed', { subscriptionId: id, chain: chain(c) }));
			id = subscribe(sub);
			return { subscriptionId: id, chain: chain(consumer.getChain(brickId)) };
		});
		on('subscriptions/cancel', (params) => {
			const id = str(params.subscriptionId, 'subscriptionId');
			subscriptions.get(id)?.dispose();
			subscriptions.delete(id);
			return null;
		});

		endpoint.onClose(() => {
			for (const sub of subscriptions.values()) { sub.dispose(); }
			subscriptions.clear();
			consumer.dispose();
			leases.clientLeft(client.id);
			for (const [id, handle] of handles) { if (handle.clientId === client.id) { handles.delete(id); } }
			if (foreground.delete(client.id)) { runtime.telemetry.setForegroundBricks(new Set(foreground.values()) as Set<BrickRef>); }
			// Handing over: the holds go to the successor as they are, and no brick is signed out here.
			if (lifecycle.state === 'handingOver') { return; }
			void holders.clientLeft(client.id).catch((error: unknown) => log.warn(`Releasing ${identity.name}'s bricks failed: ${String(error)}`));
		});
		if (!person) { log.debug(`${identity.name} cannot answer questions itself`); }
	};

	/** Connects the bricks a predecessor held, again and again until each is back or nobody holds it. */
	const reconnectRestored = async (): Promise<void> => {
		await discoverySettled();
		while (!disposed && reconnecting.size > 0) {
			for (const brickId of [...reconnecting]) {
				if (disposed) { return; }
				if (!holders.isHeld(brickId) || runtime.bricks.isSignedIn(brickId as BrickId)) {
					reconnecting.delete(brickId);
					scheduleBricksChanged();
					continue;
				}
				try {
					await runtime.bricks.signIn(brickId as BrickId);
					reconnecting.delete(brickId);
					scheduleBricksChanged();
					log.info(`Reconnected ${brickId} after the handover`);
				} catch (error) {
					log.debug(`Not back yet: ${brickId} (${error instanceof Error ? error.message : String(error)})`);
				}
			}
			if (reconnecting.size > 0) { await new Promise<void>((resolve) => { setTimeout(resolve, RECONNECT_RETRY_MS).unref?.(); }); }
		}
	};
	let reconnectLoop: Promise<void> | undefined;
	const reconnectHeld = (brickIds: readonly string[]): void => {
		for (const brickId of brickIds) { reconnecting.add(brickId); }
		scheduleBricksChanged();
		reconnectLoop ??= reconnectRestored()
			.catch((error: unknown) => log.warn(`Connecting held bricks again failed: ${String(error)}`))
			.finally(() => {
				reconnectLoop = undefined;
				// A brick added just as the loop ended is not left waiting.
				if (!disposed && reconnecting.size > 0) { reconnectHeld([]); }
			});
	};
	const resume = (snapshot: HolderSnapshot): void => {
		for (const set of Object.values(snapshot)) {
			for (const h of set) { if (h.kind === 'client') { restoredClients.add(h.clientId); } }
		}
		holders.restore(snapshot);
		reconnectHeld(Object.keys(snapshot));
		const timer = setTimeout(() => {
			if (disposed) { return; }
			restoredClients.clear();
			void holders.dropClientsExcept(new Set(clients.keys())).catch((error: unknown) => log.warn(`Dropping holds of clients that did not come back failed: ${String(error)}`));
		}, RESTORE_MS);
		timer.unref?.();
	};

	return {
		holders, leases, api, attach, reconnecting, blocked, resume, reconnectHeld, refreshBricks: scheduleBricksChanged, bricks, brickStatus, broadcast,
		dispose: () => {
			disposed = true;
			for (const d of shared) { d.dispose(); }
			api.dispose();
		},
	};
}
