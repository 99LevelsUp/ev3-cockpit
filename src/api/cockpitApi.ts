/**
 * The cockpit's public API: what `activate()` returns to other extensions (step-5 plan, U6;
 * IMPLEMENTATION_PLAN 4.2–4.4, 4.7, 4.9; DESIGN §10).
 *
 * Consumers today are VS Code extensions (ev3-c, ev3-explorer; later ev3-python, ev3-blockly);
 * an MCP server may wrap the same object later. So everything that crosses it is plain,
 * serialisable data and promises, apart from the `dispose` handles of subscriptions (KTD6), and
 * every error carries a stable `code`.
 *
 * - A brick is named by its id or by `'active'`, resolved when the call is made; every answer and
 *   event names it by id (KD1).
 * - The access mode is checked here, for every write, removal, run and shell command (KD2, KD3),
 *   so no consumer routes around it.
 * - Connecting and disconnecting go through the brick layer's own paths — sign-in with pairing and
 *   the brick's dialog as consent, sign-out — so the connection lifecycle keeps one owner (KD4).
 * - A consumer's subscriptions end when it unregisters (R8).
 */

import {
	BrickCommand, BrickEntry, BrickId, BrickResponse, ChannelState, FsEntry, SendCommandOptions,
} from '../contracts';
import { ConsumerError, NotConnectedError, ProtocolError } from '../errors/CockpitError';
import { createBrickFilesystem, BrickSender } from '../fs/brickFilesystem';
import { TransferOptions } from '../fs/fileTransferService';
import { FileSize, StorageUsage } from '../fs/filesystemService';
import { ProgramService, ProgramServiceOptions } from '../programs/programService';
import { AccessMode, assertAllowed } from './accessPolicy';

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
}

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
}

/** Builds the API object; `dispose` ends every consumer and every program service. */
export function createCockpitApi(deps: CockpitApiDeps): CockpitApi & Subscription {
	const programs = new Map<BrickId, ProgramService>();
	const consumers = new Set<CockpitConsumer>();

	const resolve = (brick: BrickTarget): BrickId => {
		if (brick !== 'active') { return brick as BrickId; }
		const active = deps.bricks.getActiveBrickId();
		if (!active) { throw new NotConnectedError('No brick is active: connect one, or name a brick by its id.'); }
		return active;
	};
	const programsOf = (brickId: BrickId): ProgramService => {
		let service = programs.get(brickId);
		if (!service) {
			service = new ProgramService((command) => deps.bricks.send(brickId, command), deps.programOptions);
			programs.set(brickId, service);
		}
		return service;
	};
	const filesOf = (brickId: BrickId) => createBrickFilesystem(deps.bricks as unknown as BrickSender, brickId);
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
	/** Access mode first, so a refused call sends nothing. */
	const allowed = (operation: Parameters<typeof assertAllowed>[1], path?: string): void => {
		assertAllowed(deps.accessMode(), operation, path);
	};
	/** Runs `work` for the brick `brick` names, resolved now; a refusal inside `work` sends nothing. */
	const on =async <T>(brick: BrickTarget, work: (brickId: BrickId) => Promise<T>): Promise<T> => work(resolve(brick));

	const registerConsumer = (name: string): CockpitConsumer => {
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
			for (const consumer of [...consumers]) { consumer.dispose(); }
			for (const service of programs.values()) { service.dispose(); }
			programs.clear();
		},
	};
}
