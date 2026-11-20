/**
 * The cockpit client library: what the VS Code extension, the `ev3` command, MCP servers and
 * add-ons use to work with bricks through the daemon.
 *
 * - It finds this user's daemon or starts it, and proves both sides hold the user's key.
 * - It keeps the bricks, the settings and the access mode current from the daemon's notifications,
 *   so reading them needs no round trip.
 * - The active brick is this client's own; the daemon keeps none.
 * - When the daemon goes — a crash, a restart, a newer version taking over — it connects again and
 *   renews every subscription, each with a fresh snapshot first. The ids it gave its caller stay.
 * - Questions for a person go to the handler the caller set; without one it answers `keep`.
 */

import { WireErrorCode } from '../contract/errors';
import type { NotificationName, Notifications } from '../contract/events';
import type { HelloAccepted } from '../contract/hello';
import { LEASED_METHODS, type MethodName, type ParamsOf, type ResultOf } from '../contract/methods';
import type {
	AccessMode, ClientKind, ContractBrick, ContractChain, LaunchSpec, ProgramState, Question, QuestionAnswer,
	SettingValue, TelemetryRequest, TelemetryUpdate,
} from '../contract/models';
import { CONTRACT_VERSION } from '../contract/version';
import type { DaemonPaths } from '../daemon/paths';
import { ContractError, Endpoint, RequestOptions } from './connection';
import { connectToDaemon } from './ensureDaemon';
import { isDevelopmentChannel } from './channel';
import { clientPaths, installedLaunch } from './locate';
import { VersionNotice, contractNotice, isRepoClient, versionNotice } from './versions';

export { ContractError } from './connection';
export { clientPaths, installedLaunch } from './locate';
export type { VersionNotice } from './versions';
export * from '../contract';

export interface Disposable { dispose(): void }

export interface CockpitClientOptions {
	/** Shown in the daemon's log and in other clients' `brick_busy`: say where this client runs. */
	readonly name: string;
	readonly kind: ClientKind;
	/** This client's package version. */
	readonly version: string;
	/** How to start the daemon when none runs. */
	readonly launch?: LaunchSpec;
	readonly launchArgs?: readonly string[];
	/** A development or test channel; by default `EV3_COCKPIT_CHANNEL`, else the user's own daemon. */
	readonly channel?: string;
	readonly paths?: DaemonPaths;
	readonly readinessMs?: number;
	/** Reconnect when the daemon goes (default true). */
	readonly reconnect?: boolean;
}

interface Renewable {
	/** The daemon's id on the current connection. */
	wireId: string;
	readonly renew: () => Promise<string>;
}

type Listener<T> = (value: T) => void;

/** A caller's listener that throws must not break the subscription it listens to. */
function safely(call: () => void): void {
	try { call(); } catch { /* the listener's own failure */ }
}

class Emitter<T> {
	private readonly listeners = new Set<Listener<T>>();
	on(listener: Listener<T>): Disposable {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	}
	fire(value: T): void {
		for (const listener of [...this.listeners]) {
			try { listener(value); } catch { /* a listener's own failure */ }
		}
	}
}

export class CockpitClient {
	private endpoint!: Endpoint;
	private helloInfo!: HelloAccepted;
	private disposed = false;
	private brickList: ContractBrick[] = [];
	private settingList: SettingValue[] = [];
	private access: AccessMode = 'safe';
	private active: string | undefined;
	private questionHandler: ((question: Question) => Promise<QuestionAnswer> | QuestionAnswer) | undefined;
	private readonly renewables = new Map<string, Renewable>();
	/** Bricks this client connected for itself: connected again on a new daemon after a crash. */
	private readonly myBricks = new Set<string>();
	private readonly notificationHandlers = new Map<string, Set<(params: unknown) => void>>();
	private nextId = 0;
	private reconnecting: Promise<void> | undefined;

	private readonly bricksChanged = new Emitter<readonly ContractBrick[]>();
	private readonly reconnected = new Emitter<HelloAccepted>();
	private readonly notices = new Emitter<VersionNotice | { readonly text: string }>();
	private readonly lost = new Emitter<Error>();

	/** The bricks changed. */
	readonly onBricksChanged = (listener: Listener<readonly ContractBrick[]>): Disposable => this.bricksChanged.on(listener);
	/** Connected again to a daemon after the previous one went; subscriptions are renewed. */
	readonly onReconnected = (listener: Listener<HelloAccepted>): Disposable => this.reconnected.on(listener);
	/** A newer version exists, or the daemon cannot serve this add-on. */
	readonly onNotice = (listener: Listener<VersionNotice | { readonly text: string }>): Disposable => this.notices.on(listener);
	/** The daemon went and could not be reached again. */
	readonly onLost = (listener: Listener<Error>): Disposable => this.lost.on(listener);

	private constructor(private readonly options: CockpitClientOptions, private readonly paths: DaemonPaths) {}

	static async connect(options: CockpitClientOptions): Promise<CockpitClient> {
		const paths = options.paths ?? clientPaths(options.channel ? { channel: options.channel } : {});
		const client = new CockpitClient(options, paths);
		await client.open();
		return client;
	}

	/** How to start the daemon: the caller's launch, or for an add-on the installed cockpit's. */
	private launch(): LaunchSpec | undefined {
		return this.options.launch ?? (this.options.kind === 'addon' ? installedLaunch(this.paths) : undefined);
	}

	/** What the daemon said about itself when this client connected. */
	get daemon(): HelloAccepted { return this.helloInfo; }

	/** The bricks as last heard; no round trip. */
	bricks(): readonly ContractBrick[] { return this.brickList; }
	brick(ref: string): ContractBrick | undefined {
		// As the daemon names bricks: an id, or a name whatever its case.
		const wanted = ref.trim().toLowerCase();
		return this.brickList.find((b) => b.brickId === ref) ?? this.brickList.find((b) => b.name.trim().toLowerCase() === wanted);
	}
	settings(): readonly SettingValue[] { return this.settingList; }
	accessMode(): AccessMode { return this.access; }

	/** This client's active brick. */
	activeBrick(): string | undefined { return this.active; }
	/** Makes a brick this client's active one, and has the daemon read it in the foreground. */
	async setActiveBrick(brickId: string | undefined): Promise<void> {
		this.active = brickId;
		await this.request('telemetry/foreground', { brick: brickId ?? null });
	}

	/** Who answers the daemon's questions for a person; without a handler, `keep`. */
	onQuestion(handler: ((question: Question) => Promise<QuestionAnswer> | QuestionAnswer) | undefined): void {
		this.questionHandler = handler;
	}

	async request<M extends MethodName>(method: M, params: ParamsOf<M>, options?: RequestOptions): Promise<ResultOf<M>> {
		const sent = !this.endpoint.closed;
		let result: ResultOf<M>;
		try {
			result = await this.endpoint.request<ResultOf<M>>(method, params, options);
		} catch (error) {
			// A write cut off by the daemon going may or may not have happened; it is never retried.
			if (sent && error instanceof ContractError && error.code === WireErrorCode.DaemonUnavailable && LEASED_METHODS.includes(method)) {
				throw new ContractError(WireErrorCode.OutcomeUnknown,
					`The cockpit daemon went while ${method} ran, so whether it finished is not known. It was not retried.`,
					{ kind: 'OutcomeUnknownError' });
			}
			throw error;
		}
		if (method === 'bricks/connect') {
			const p = params as ParamsOf<'bricks/connect'>;
			if (!p.hold) { this.myBricks.add((result as ResultOf<'bricks/connect'>).brickId); }
		} else if (method === 'bricks/disconnect') {
			const p = params as ParamsOf<'bricks/disconnect'>;
			const id = p.brick ? this.brick(p.brick)?.brickId ?? p.brick : undefined;
			if (id && !p.releaseHold) { this.myBricks.delete(id); }
		}
		return result;
	}

	/** Hears one notification; survives reconnects. */
	on<N extends NotificationName>(name: N, handler: (params: Notifications[N]) => void): Disposable {
		let set = this.notificationHandlers.get(name);
		if (!set) { set = new Set(); this.notificationHandlers.set(name, set); }
		const wrapped = handler as (params: unknown) => void;
		set.add(wrapped);
		return { dispose: () => set.delete(wrapped) };
	}

	/** A brick's program state, now and on every change, across reconnects. */
	async subscribePrograms(brick: string, listener: Listener<ProgramState>): Promise<Disposable & { readonly state: ProgramState }> {
		const id = `s${++this.nextId}`;
		let state!: ProgramState;
		const renew = async (): Promise<string> => {
			const result = await this.request('programs/subscribe', { brick });
			state = result.state;
			if (this.renewables.has(id)) { safely(() => listener(result.state)); }
			return result.subscriptionId;
		};
		const off = this.on('programs/stateChanged', (p) => { if (p.subscriptionId === this.renewables.get(id)?.wireId) { listener(p.state); } });
		const wireId = await renew();
		this.renewables.set(id, { wireId, renew });
		return { state, dispose: () => { off.dispose(); this.cancel(id); } };
	}

	/** Telemetry of a brick: a snapshot first, then changes; again a snapshot after every reconnect. */
	async subscribeTelemetry(brick: string, request: TelemetryRequest, listener: Listener<TelemetryUpdate>): Promise<Disposable & { readonly grant: Readonly<Record<string, number | 'once'>> }> {
		const id = `s${++this.nextId}`;
		let grant: Readonly<Record<string, number | 'once'>> = {};
		const renew = async (): Promise<string> => {
			const result = await this.request('telemetry/subscribe', { brick, request });
			grant = result.grant;
			safely(() => listener({ subscriptionId: id, brickId: result.brickId, kind: 'snapshot', values: result.snapshot, removed: [] }));
			return result.subscriptionId;
		};
		const off = this.on('telemetry/update', (u) => {
			if (u.subscriptionId === this.renewables.get(id)?.wireId) { listener({ ...u, subscriptionId: id }); }
		});
		const wireId = await renew();
		this.renewables.set(id, { wireId, renew });
		return { grant, dispose: () => { off.dispose(); this.cancel(id); } };
	}

	/** The daisy chain below a brick, now and on every change. */
	async followChain(brick: string, listener: Listener<ContractChain>): Promise<Disposable> {
		const id = `s${++this.nextId}`;
		const renew = async (): Promise<string> => {
			const result = await this.request('chain/follow', { brick });
			safely(() => listener(result.chain));
			return result.subscriptionId;
		};
		const off = this.on('chain/changed', (c) => { if (c.subscriptionId === this.renewables.get(id)?.wireId) { listener(c.chain); } });
		const wireId = await renew();
		this.renewables.set(id, { wireId, renew });
		return { dispose: () => { off.dispose(); this.cancel(id); } };
	}

	dispose(): void {
		this.disposed = true;
		this.renewables.clear();
		this.endpoint?.close();
	}

	private cancel(id: string): void {
		const renewable = this.renewables.get(id);
		if (!renewable) { return; }
		this.renewables.delete(id);
		if (!this.endpoint.closed) {
			void this.request('subscriptions/cancel', { subscriptionId: renewable.wireId }).catch(() => undefined);
		}
	}

	private async open(): Promise<void> {
		const { endpoint, hello } = await connectToDaemon({
			client: { name: this.options.name, kind: this.options.kind, version: this.options.version },
			paths: this.paths,
			// An add-on carries no daemon: it starts the one the installed cockpit recorded.
			...(this.launch() ? { launch: this.launch()! } : {}),
			...(this.options.launchArgs ? { launchArgs: this.options.launchArgs } : {}),
			...(this.options.readinessMs ? { readinessMs: this.options.readinessMs } : {}),
		});
		// Disposed while this connection was being made (a window closed during a daemon restart):
		// the new connection must not stay open, or it keeps the daemon and this process alive.
		if (this.disposed) {
			endpoint.close();
			throw new ContractError(WireErrorCode.DaemonUnavailable, 'The client was disposed while it connected.');
		}
		this.endpoint = endpoint;
		this.helloInfo = hello;
		endpoint.onRequest('question/ask', async (params) => {
			const answer = this.questionHandler ? await this.questionHandler(params as Question) : 'keep';
			return { answer };
		});
		for (const name of ['bricks/changed', 'bricks/reconnected', 'bricks/pairingStarted', 'bricks/pairingEvent', 'bricks/pairingDone',
			'bricks/oneSidedRepair', 'programs/stateChanged', 'telemetry/update', 'chain/changed', 'settings/changed',
			'settings/accessModeChanged', 'daemon/versionNotice', 'daemon/handingOver', 'daemon/lent', 'question/withdrawn']) {
			endpoint.onNotification(name, (params) => this.dispatch(name, params));
		}
		endpoint.onClose(() => { void this.connectAgain(); });
		const [bricks, settings, access] = await Promise.all([
			this.request('bricks/list', {}), this.request('settings/list', {}), this.request('settings/accessMode', {}),
		]);
		this.brickList = [...bricks];
		this.settingList = [...settings];
		this.access = access;
		if (this.active) { await this.request('telemetry/foreground', { brick: this.active }).catch(() => undefined); }
		this.checkVersions(hello);
	}

	private dispatch(name: string, params: unknown): void {
		if (name === 'bricks/changed') {
			this.brickList = [...(params as Notifications['bricks/changed']).bricks];
			this.bricksChanged.fire(this.brickList);
		} else if (name === 'settings/changed') {
			const { setting } = params as Notifications['settings/changed'];
			this.settingList = this.settingList.map((s) => (s.spec.key === setting.spec.key ? setting : s));
		} else if (name === 'settings/accessModeChanged') {
			this.access = (params as Notifications['settings/accessModeChanged']).mode;
		} else if (name === 'daemon/versionNotice') {
			this.notices.fire(params as Notifications['daemon/versionNotice']);
		}
		for (const handler of [...(this.notificationHandlers.get(name) ?? [])]) {
			try { handler(params); } catch { /* the handler's own failure */ }
		}
	}

	private checkVersions(hello: HelloAccepted): void {
		if (isRepoClient(this.options.kind)) {
			const notice = versionNotice(this.options.version, hello.version);
			if (!notice) { return; }
			this.notices.fire(notice);
			// Inside a development channel any other version replaces the daemon (KTD17).
			if ((notice.newerIs === 'client' || isDevelopmentChannel(this.paths.channelName)) && this.options.launch) {
				void this.request('daemon/registerReplacement', { launch: this.options.launch }).catch(() => undefined);
			}
			return;
		}
		const text = contractNotice(CONTRACT_VERSION, hello.contractVersion);
		if (text) { this.notices.fire({ text }); }
	}

	private connectAgain(): Promise<void> {
		if (this.disposed || this.options.reconnect === false) { return Promise.resolve(); }
		this.reconnecting ??= (async () => {
			try {
				await this.open();
				// A daemon that crashed knew nothing of this client's bricks; one that handed over did.
				for (const brickId of [...this.myBricks]) {
					await this.endpoint.request('bricks/connect', { brick: brickId }).catch(() => undefined);
				}
				for (const renewable of this.renewables.values()) {
					try { renewable.wireId = await renewable.renew(); } catch { /* renewed when its brick is back */ }
				}
				this.reconnected.fire(this.helloInfo);
			} catch (error) {
				if (!this.disposed) { this.lost.fire(error instanceof Error ? error : new ContractError(WireErrorCode.DaemonUnavailable, String(error))); }
			} finally {
				this.reconnecting = undefined;
			}
		})();
		return this.reconnecting;
	}
}
