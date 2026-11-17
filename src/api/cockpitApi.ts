/**
 * The cockpit's public API: what `activate()` returns to other extensions (step-5 plan, U6;
 * IMPLEMENTATION_PLAN 4.2–4.4, 4.7, 4.9; DESIGN §10).
 *
 * Consumers today are VS Code extensions (ev3-c, ev3-explorer; later ev3-python, ev3-blockly);
 * an MCP server may wrap the same object later. So everything that crosses it is plain,
 * serialisable data and promises, apart from the `dispose` handles of subscriptions (KTD6), and
 * every error carries a stable `code`.
 *
 * - A brick is named by its id or by `'active'`, resolved when the call is made; an id the cockpit
 *   does not know is refused. Program, shell and brick-info answers and every event name the brick
 *   by id; file answers are the file data asked for, so a consumer that needs to know which brick
 *   answered takes `getActiveBrickId()` first and passes that id, not `'active'` (KD1).
 * - The access mode is checked here, for every write, removal, run and shell command (KD2, KD3),
 *   so no consumer routes around it.
 * - Connecting and disconnecting go through the brick layer's own paths — sign-in with pairing and
 *   the brick's dialog as consent, sign-out — so the connection lifecycle keeps one owner (KD4).
 * - A consumer's subscriptions end when it unregisters (R8).
 * - Telemetry (step-6 U8): a consumer subscribes to rows of a brick at an interval and gets back what
 *   each row was granted, then a snapshot, then only the rows that changed, each value with when it
 *   was sampled, the interval it runs at now and whether it is stale (D2, D10). Disposing the handle
 *   releases exactly that claim; a brick that goes ends its subscriptions with an `ended` update.
 * - The daisy chain (step-8 U6): the bricks below a brick, each with what it can do, derived from
 *   the telemetry's depth row and never stored. A member has no id of its own; its ports are rows.
 */

import {
	BrickCommand, BrickEntry, BrickId, BrickResponse, ChannelState, FsEntry, SendCommandOptions,
} from '../contracts';
import { CockpitError, ConsumerError, NotConnectedError, ProtocolError, SubscriptionError } from '../errors/CockpitError';
import { createBrickFilesystem, BrickSender } from '../fs/brickFilesystem';
import { TransferOptions } from '../fs/fileTransferService';
import { FileSize, StorageUsage } from '../fs/filesystemService';
import { ProgramService, ProgramServiceOptions, followProgramRow } from '../programs/programService';
import type { ChainMember } from '../contracts/models';
import { chainOf } from '../telemetry/chainModel';
import { CHAIN_DEPTH_ROW } from '../telemetry/ev3Rows';
import type { RowDescriptor } from '../telemetry/rowRegistry';
import type { ClaimRequest, Grant } from '../telemetry/telemetryClaims';
import type { ReadModelChange, ReadValue } from '../telemetry/telemetryReadModel';
import { AccessMode, assertAllowed } from './accessPolicy';
import { TelemetryDelivery, toTelemetryValue } from './telemetryDelivery';

export const API_VERSION = 1;

/**
 * A brick by its id, or `'active'` for the active brick at the time of the call (KD1). A plain
 * string, so a consumer need not import the cockpit's branded id type.
 */
export type BrickTarget = string;

/** A subscription handle. */
export interface Subscription {
	dispose(): void;
}

/** One brick as the API shows it: plain data. */
export interface ApiBrick {
	readonly brickId: string;
	readonly name: string;
	/** The brick itself reported the name (not a cached or a fallback one). */
	readonly nameConfirmed: boolean;
	readonly signedIn: boolean;
	readonly active: boolean;
	/** Paired with this computer over Bluetooth. */
	readonly paired: boolean;
	readonly channels: readonly { readonly transport: string; readonly state: string }[];
}

export interface ProgramState {
	readonly brickId: string;
	readonly running: boolean;
}

/** A row a consumer can subscribe to (4.5.1). */
export type TelemetryRowInfo = RowDescriptor;

/** What a consumer asks for: rows by id, how often, and a mode per sensor port (D6). */
export interface TelemetryRequest {
	readonly rows: readonly string[];
	/** How often the rows are wanted, in milliseconds; the grant says what each row got. */
	readonly intervalMs: number;
	/** The mode to read a sensor port in, by port: `{ '1': 2 }`. The first claim on a port holds it (D7). */
	readonly modes?: Readonly<Record<string, number>>;
}

/** One row's value: plain data. */
export interface TelemetryValue {
	readonly rowId: string;
	readonly value: number | string | boolean | undefined;
	readonly unit?: string;
	readonly mode?: number;
	/** When the reply carrying the value arrived, in ms since the epoch. */
	readonly sampledAt: number;
	/** How often the row is read now — slower than granted under throttling (D2); `'once'` for a static row. */
	readonly effectiveIntervalMs?: number | 'once';
	/** No newer reading came for a while, or the row is no longer read (D9). */
	readonly stale: boolean;
}

/** What a subscription hears: a snapshot first, then changes, and `ended` when its brick goes. */
export interface TelemetryUpdate {
	readonly brickId: string;
	readonly kind: 'snapshot' | 'change' | 'ended';
	readonly values: readonly TelemetryValue[];
	/** Rows whose values were dropped (stale long enough, D9). */
	readonly removed: readonly string[];
}

/** A telemetry subscription (4.5.1): dispose it to release exactly this claim (4.5.3). */
export interface TelemetrySubscription extends Subscription {
	readonly brickId: string;
	/** What each row was granted: at least this often, in ms, or `'once'` for a static row. */
	readonly grant: Readonly<Record<string, number | 'once'>>;
	/** The subscribed rows' values now. */
	snapshot(): TelemetryValue[];
}

/**
 * The bricks below a brick in a USB daisy chain, as last read: plain data.
 *
 * A member is reached only through the brick above it and has no id of its own; its ports are
 * telemetry rows under `chain.<layer>`. What it can do is in `capabilities`, and a firmware that
 * carries more across the chain turns more on there without a change of shape.
 */
export interface ApiChain {
	readonly brickId: string;
	/** False until the chain has been read; then `members` is empty only for a brick with nothing below it. */
	readonly read: boolean;
	/** No newer reading of the chain came for a while. */
	readonly stale: boolean;
	/** Layer 1 first. An empty last member cannot be told from no brick and is not listed. */
	readonly members: readonly ChainMember[];
}

export interface ShellResult {
	readonly brickId: string;
	/** The return value of `system()` on the brick. */
	readonly status: number;
}

/** What one registered extension works with. */
export interface CockpitConsumer extends Subscription {
	readonly name: string;
	// Bricks (KD4)
	listBricks(): ApiBrick[];
	getActiveBrickId(): string | undefined;
	setActiveBrick(brick: BrickTarget): void;
	/** "Connect a Brick" for this brick: every channel, pairing on the way with the brick's dialog as consent. */
	connect(brick: BrickTarget): Promise<void>;
	disconnect(brick: BrickTarget): Promise<void>;
	/** The brick's own name, firmware and OS versions, asked from the brick. */
	getBrickInfo(brick: BrickTarget): Promise<{ brickId: string; name: string; firmwareVersion?: string; osVersion?: string }>;
	onBricksChanged(listener: (bricks: ApiBrick[]) => void): Subscription;
	onActiveBrickChanged(listener: (brickId: string | undefined) => void): Subscription;
	// Files (R1)
	list(brick: BrickTarget, path: string): Promise<FsEntry[]>;
	exists(brick: BrickTarget, path: string): Promise<boolean>;
	size(brick: BrickTarget, path: string): Promise<FileSize>;
	storage(brick: BrickTarget): Promise<StorageUsage>;
	readFile(brick: BrickTarget, path: string, options?: TransferOptions): Promise<Uint8Array>;
	writeFile(brick: BrickTarget, path: string, content: Uint8Array, options?: TransferOptions): Promise<void>;
	makeDirectory(brick: BrickTarget, path: string): Promise<void>;
	/** Removes a file or an empty folder; `recursive` removes a folder with what it holds. */
	remove(brick: BrickTarget, path: string, options?: { recursive?: boolean }): Promise<void>;
	/** A copy then a removal on the brick: not atomic. */
	move(brick: BrickTarget, from: string, to: string): Promise<void>;
	// Programs (R2, R3)
	runProgram(brick: BrickTarget, path: string, options?: { replace?: boolean }): Promise<ProgramState>;
	stopProgram(brick: BrickTarget): Promise<ProgramState>;
	emergencyStop(brick: BrickTarget): Promise<ProgramState>;
	isProgramRunning(brick: BrickTarget): Promise<ProgramState>;
	onProgramStateChanged(brick: BrickTarget, listener: (state: ProgramState) => void): Subscription;
	// Shell (R4) and the access mode (R5)
	runShell(brick: BrickTarget, command: string): Promise<ShellResult>;
	getAccessMode(): AccessMode;
	onAccessModeChanged(listener: (mode: AccessMode) => void): Subscription;
	// Telemetry (step-6 U8)
	listTelemetryRows(): TelemetryRowInfo[];
	subscribeTelemetry(brick: BrickTarget, request: TelemetryRequest, listener: (update: TelemetryUpdate) => void): TelemetrySubscription;
	// The daisy chain (step-8 U6)
	/** The chain below a brick as last read; not read yet unless something reads that brick's telemetry. */
	getChain(brick: BrickTarget): ApiChain;
	/** Reads the chain below a brick and calls `listener` when its members or their abilities change. */
	onChainChanged(brick: BrickTarget, listener: (chain: ApiChain) => void): Subscription;
}

/** How often a followed chain is read: a chain changes when a cable or a device does. */
const CHAIN_FOLLOW_INTERVAL_MS = 1000;

export interface CockpitApi {
	readonly apiVersion: typeof API_VERSION;
	registerConsumer(name: string): CockpitConsumer;
}

/** What the API needs of the runtime. Narrow, so a test can stand in for it. */
export interface CockpitApiDeps {
	readonly bricks: {
		send(brickId: BrickId, command: BrickCommand, options?: SendCommandOptions): Promise<BrickResponse>;
		getActiveBrickId(): BrickId | undefined;
		setActiveBrick(brickId: BrickId): void;
		signOut(brickId: BrickId): Promise<void>;
		isSignedIn(brickId: BrickId): boolean;
		onActiveBrickChange(listener: (event: { current: BrickId | undefined }) => void): Subscription;
	} & Partial<Pick<BrickSender, 'maxPacketBytes' | 'pin'>>;
	readonly aggregator: {
		getDiscoveryList(): ReadonlyArray<BrickEntry>;
		onListChanged(listener: () => void): Subscription;
	};
	/** Runs "Connect a Brick" on a brick, with its progress and messages. */
	connect(brickId: BrickId): Promise<void>;
	accessMode(): AccessMode;
	onAccessModeChange(listener: (mode: AccessMode) => void): Subscription;
	readonly log?: { info(message: string): void; warn(message: string): void };
	readonly programOptions?: ProgramServiceOptions;
	/** The telemetry service and its read model; absent, telemetry is refused. */
	readonly telemetry?: {
		rows(): RowDescriptor[];
		claim(brickId: BrickId, request: ClaimRequest, owner: string): { readonly handle: string; readonly grant: Grant };
		release(handle: string): void;
		onClaimsEnded(listener: (event: { readonly brickKey: string; readonly handles: readonly string[] }) => void): Subscription;
		snapshot(brickId: BrickId, rowIds?: readonly string[]): ReadValue[];
		onChange(listener: (change: ReadModelChange) => void): Subscription;
		/** How often a followed program's state is read (the user's setting, U9). */
		programStatusIntervalMs(): number;
		/** The user changed that setting: every followed program is followed again at it (U9 review 1). */
		onProgramStatusIntervalChange?(listener: () => void): Subscription;
	};
}

/** Builds the API object; `dispose` ends every consumer and every program service. */
export function createCockpitApi(deps: CockpitApiDeps): CockpitApi & Subscription {
	const programs = new Map<BrickId, ProgramService>();
	const consumers = new Set<CockpitConsumer>();
	/** Set before anything is disposed, so nothing registered on the way out escapes it (review 4). */
	let disposed = false;

	const resolve = (brick: BrickTarget): BrickId => {
		if (brick !== 'active') {
			// An id the cockpit never saw is refused before any command, and gets no program service
			// of its own, so the services stay one per known brick (review round 2, 11.11.2026).
			if (!deps.aggregator.getDiscoveryList().some((entry) => entry.brickId === brick)) {
				throw new NotConnectedError(`The cockpit does not know a brick ${brick}: list the bricks for their ids.`);
			}
			return brick as BrickId;
		}
		const active = deps.bricks.getActiveBrickId();
		if (!active) { throw new NotConnectedError('No brick is active: connect one, or name a brick by its id.'); }
		return active;
	};
	const programsOf = (brickId: BrickId): ProgramService => {
		let service = programs.get(brickId);
		if (!service) {
			// Its run state follows the telemetry row (U9); without telemetry it cannot be followed.
			const telemetry = deps.telemetry;
			service = new ProgramService((command) => deps.bricks.send(brickId, command), deps.programOptions,
				telemetry ? followProgramRow(telemetry, brickId, () => telemetry.programStatusIntervalMs()) : undefined);
			programs.set(brickId, service);
		}
		return service;
	};
	const filesOf = (brickId: BrickId) => createBrickFilesystem(deps.bricks as unknown as BrickSender, brickId);
	// One delivery order for every consumer's subscriptions (review round 3).
	const delivery = deps.telemetry
		? new TelemetryDelivery(deps.telemetry, (message) => deps.log?.warn(message))
		: undefined;
	// A changed status interval applies to programs already followed, not only the next (U9 review 1).
	const intervalWatch = deps.telemetry?.onProgramStatusIntervalChange?.(() => {
		for (const service of programs.values()) { service.followAgain(); }
	});
	const telemetryOf = (): { telemetry: NonNullable<CockpitApiDeps['telemetry']>; delivery: TelemetryDelivery } => {
		if (!deps.telemetry || !delivery) { throw new SubscriptionError('Telemetry is not available in this cockpit.'); }
		return { telemetry: deps.telemetry, delivery };
	};
	const toApiBrick = (entry: BrickEntry): ApiBrick => ({
		brickId: entry.brickId,
		name: entry.name.value,
		nameConfirmed: entry.name.confirmed,
		signedIn: deps.bricks.isSignedIn(entry.brickId),
		active: deps.bricks.getActiveBrickId() === entry.brickId,
		paired: entry.paired,
		channels: entry.channels
			.filter((channel) => channel.state !== ChannelState.Absent)
			.map((channel) => ({ transport: String(channel.transport), state: String(channel.state) })),
	});
	/** A brick's chain from what its telemetry last read; not read without a telemetry service. */
	const chainNow = (brickId: BrickId): ApiChain => {
		const chain = chainOf(deps.telemetry?.snapshot(brickId, [CHAIN_DEPTH_ROW]) ?? []);
		return {
			brickId,
			read: chain !== undefined,
			stale: chain?.stale ?? false,
			members: (chain?.members ?? []).map((member) => ({ layer: member.layer, capabilities: { ...member.capabilities } })),
		};
	};
	/** Access mode first, so a refused call sends nothing. */
	const allowed = (operation: Parameters<typeof assertAllowed>[1], path?: string): void => {
		assertAllowed(deps.accessMode(), operation, path);
	};
	/** Runs `work` for the brick `brick` names, resolved now; a refusal inside `work` sends nothing. */
	const on =async <T>(brick: BrickTarget, work: (brickId: BrickId) => Promise<T>): Promise<T> => work(resolve(brick));

	const registerConsumer = (name: string): CockpitConsumer => {
		if (disposed) { throw new ConsumerError(`The cockpit's API has been disposed; ${name} cannot register.`); }
		const subscriptions = new Set<Subscription>();
		let closed = false;
		/** Refused once the consumer is gone: nothing could dispose it any more (review 11.11.2026). */
		const open = (): void => {
			if (closed) { throw new ConsumerError(`Consumer ${name} has unregistered; register again.`); }
		};
		const keep = (subscription: Subscription): Subscription => {
			if (closed) { subscription.dispose(); open(); }
			subscriptions.add(subscription);
			return { dispose: () => { subscription.dispose(); subscriptions.delete(subscription); } };
		};
		const programState = (brickId: BrickId, running: boolean): ProgramState => ({ brickId, running });

		const consumer: CockpitConsumer = {
			name,
			listBricks: () => deps.aggregator.getDiscoveryList().map(toApiBrick),
			getActiveBrickId: () => deps.bricks.getActiveBrickId(),
			setActiveBrick: (brick) => { deps.bricks.setActiveBrick(resolve(brick)); },
			connect: (brick) => on(brick, (brickId) => deps.connect(brickId)),
			disconnect: (brick) => on(brick, (brickId) => deps.bricks.signOut(brickId)),
			getBrickInfo: (brick) => on(brick, async (brickId) => {
				const reply = await deps.bricks.send(brickId, { kind: 'info' });
				if (reply.kind !== 'info') { throw new ProtocolError(`Expected info from brick ${brickId}, got ${reply.kind}.`); }
				return {
					brickId, name: reply.displayName,
					...(reply.firmwareVersion ? { firmwareVersion: reply.firmwareVersion } : {}),
					...(reply.osVersion ? { osVersion: reply.osVersion } : {}),
				};
			}),
			onBricksChanged: (listener) => keep(deps.aggregator.onListChanged(() => {
				listener(deps.aggregator.getDiscoveryList().map(toApiBrick));
			})),
			onActiveBrickChanged: (listener) => keep(deps.bricks.onActiveBrickChange((event) => { listener(event.current); })),

			list: (brick, path) => on(brick, (brickId) => filesOf(brickId).files.list(path)),
			exists: (brick, path) => on(brick, (brickId) => filesOf(brickId).files.exists(path)),
			size: (brick, path) => on(brick, (brickId) => filesOf(brickId).files.size(path)),
			storage: (brick) => on(brick, (brickId) => filesOf(brickId).files.storage()),
			readFile: (brick, path, options) => on(brick, (brickId) => filesOf(brickId).transfer.readFile(path, options)),
			writeFile: (brick, path, content, options) => on(brick, (brickId) => {
				allowed('write', path);
				return filesOf(brickId).transfer.writeFile(path, content, options);
			}),
			makeDirectory: (brick, path) => on(brick, (brickId) => {
				allowed('write', path);
				return filesOf(brickId).files.makeDirectory(path);
			}),
			remove: (brick, path, options) => on(brick, (brickId) => {
				allowed('delete', path);
				return options?.recursive ? filesOf(brickId).files.removeTree(path) : filesOf(brickId).files.remove(path);
			}),
			move: (brick, from, to) => on(brick, (brickId) => {
				allowed('delete', from);
				allowed('write', to);
				return filesOf(brickId).files.move(from, to);
			}),

			runProgram: (brick, path, options) => on(brick, async (brickId) => {
				allowed('run', path);
				return programState(brickId, await programsOf(brickId).run(path, options));
			}),
			stopProgram: (brick) => on(brick, async (brickId) => {
				await programsOf(brickId).stop();
				return programState(brickId, await programsOf(brickId).isRunning());
			}),
			emergencyStop: (brick) => on(brick, async (brickId) => {
				await programsOf(brickId).emergencyStop();
				return programState(brickId, await programsOf(brickId).isRunning());
			}),
			isProgramRunning: (brick) => on(brick, async (brickId) => programState(brickId, await programsOf(brickId).isRunning())),
			onProgramStateChanged: (brick, listener) => {
				const brickId = resolve(brick);
				return keep(programsOf(brickId).onStateChange((running) => { listener(programState(brickId, running)); }));
			},

			runShell: (brick, command) => on(brick, async (brickId) => {
				allowed('shell');
				const reply = await deps.bricks.send(brickId, { kind: 'system:run', command });
				if (reply.kind !== 'system:run') { throw new ProtocolError(`Expected system:run from brick ${brickId}, got ${reply.kind}.`); }
				deps.log?.info(`Shell on ${brickId} for ${name}: ${command} → ${reply.status}`);
				return { brickId, status: reply.status };
			}),
			getAccessMode: () => deps.accessMode(),
			onAccessModeChanged: (listener) => keep(deps.onAccessModeChange(listener)),

			listTelemetryRows: () => telemetryOf().telemetry.rows().map((row) => ({ ...row })),
			subscribeTelemetry: (brick, request, listener) => {
				open();
				const { telemetry, delivery } = telemetryOf();
				const brickId = resolve(brick);
				let claim: { readonly handle: string; readonly grant: Grant };
				try {
					claim = telemetry.claim(brickId, {
						rowIds: [...request.rows], intervalMs: request.intervalMs,
						...(request.modes ? { modes: { ...request.modes } } : {}),
					}, name);
				} catch (error) {
					// Every refusal carries a stable code: a mode held by another claim keeps its own.
					if (error instanceof CockpitError) { throw error; }
					throw new SubscriptionError(error instanceof Error ? error.message : String(error), error);
				}
				// Whatever ran inside the claim may have unregistered this consumer: give the claim back (review 4).
				if (closed) { telemetry.release(claim.handle); open(); }
				const rows = new Set(request.rows);
				const snapshot = (): TelemetryValue[] => telemetry.snapshot(brickId, [...rows]).map(toTelemetryValue);
				// The snapshot is the state at the claim and the subscription joins the delivery right there,
				// with nothing told in between: what changed before is in the snapshot, what changes after
				// comes in order behind it (D10, reviews 1-3).
				const boundary = snapshot();
				// `onEnded` runs only from the delivery's drain, after this call has returned.
				const place = delivery.open({
					brickId, handle: claim.handle, rows, listener, owner: name,
					onEnded: () => { subscriptions.delete(record); },
				}, boundary);
				const record: Subscription = {
					dispose: () => {
						subscriptions.delete(record);
						// A claim that ended with its brick is gone: releasing it again is not done.
						if (place.close()) { telemetry.release(claim.handle); }
					},
				};
				subscriptions.add(record);
				return { brickId, grant: { ...claim.grant }, snapshot, dispose: () => record.dispose() };
			},

			getChain: (brick) => chainNow(resolve(brick)),
			onChainChanged: (brick, listener) => {
				open();
				const { telemetry } = telemetryOf();
				const brickId = resolve(brick);
				let live = true;
				let handle: string | undefined;
				let last = JSON.stringify(chainNow(brickId));
				// Claims that ended before `claim()` returned the handle: a brick that went inside the claim itself.
				const endedEarly = new Set<string>();
				const ending = telemetry.onClaimsEnded((event) => {
					if (event.brickKey !== brickId) { return; }
					if (handle === undefined) { for (const ended of event.handles) { endedEarly.add(ended); } return; }
					// Its brick went: the claim is gone with it, and nothing more is told.
					if (event.handles.includes(handle)) { close(false); }
				});
				const listening = telemetry.onChange((change) => {
					if (change.brickKey !== brickId) { return; }
					if (!change.rows.some((row) => row.rowId === CHAIN_DEPTH_ROW) && !change.removed.includes(CHAIN_DEPTH_ROW)) { return; }
					const chain = chainNow(brickId);
					const now = JSON.stringify(chain);
					if (now === last) { return; }
					last = now;
					// Told after the read model's dispatch, as a followed program is (review of step-6 U8, round 4).
					queueMicrotask(() => {
						if (!live) { return; }
						try { listener(chain); } catch { /* the consumer's own error */ }
					});
				});
				const close = (release: boolean): void => {
					if (!live) { return; }
					live = false;
					listening.dispose();
					ending.dispose();
					if (release && handle !== undefined) { telemetry.release(handle); }
				};
				try {
					handle = telemetry.claim(brickId, { rowIds: [CHAIN_DEPTH_ROW], intervalMs: CHAIN_FOLLOW_INTERVAL_MS }, name).handle;
				} catch (error) {
					close(false);
					if (error instanceof CockpitError) { throw error; }
					throw new SubscriptionError(error instanceof Error ? error.message : String(error), error);
				}
				if (endedEarly.has(handle)) {
					close(false);
					throw new SubscriptionError(`Brick ${brickId} went while its chain was being followed.`);
				}
				if (closed) { close(true); open(); }
				return keep({ dispose: () => close(true) });
			},

			dispose: () => {
				closed = true;
				for (const subscription of [...subscriptions]) { subscription.dispose(); }
				subscriptions.clear();
				consumers.delete(consumer);
			},
		};
		consumers.add(consumer);
		return consumer;
	};

	return {
		apiVersion: API_VERSION,
		registerConsumer,
		dispose: () => {
			disposed = true;
			for (const consumer of [...consumers]) { consumer.dispose(); }
			for (const service of programs.values()) { service.dispose(); }
			programs.clear();
			intervalWatch?.dispose();
			delivery?.dispose();
		},
	};
}
