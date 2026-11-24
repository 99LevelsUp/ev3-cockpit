/**
 * The client of the native daemon, on the generated contract: what the VS Code extension, the
 * `ev3` command, the MCP server and add-ons use once they move to the native daemon.
 *
 * - It finds this user's daemon, starts or replaces it as `nativeDaemon.ts` says, and proves both
 *   sides hold the user's key.
 * - It keeps the bricks, the settings and the access mode current from the daemon's notifications.
 * - When the daemon goes (a crash, a restart, a replacement) it connects again, to the successor
 *   when one is on its way, else to a daemon it starts. Nothing is handed over between daemons:
 *   it connects its own bricks again and renews its subscriptions, each with a fresh snapshot.
 *   Bricks held with `ev3 connect` the new daemon connects itself.
 * - Questions for a person go to the handler the caller set, with who asked; without a handler the
 *   answer is `keep`, which the daemon reads as unanswered.
 */

import { WireErrorCode } from '../contract/errors';
import { METHODS } from '../contract/generated';
import type {
	AccessMode, BuildKind, ClientKind, ContractBrick, ContractChain, LaunchSpec, MethodName, NotificationName, Notifications,
	ParamsOf, ProgramState, Question, QuestionAnswer, QuestionReply, ResultOf, SettingValue, TelemetryRequest,
	TelemetryUpdate,
} from '../contract/generated';
import type { NativeChannelHost } from './channel';
import { ContractError, RequestOptions } from './connection';
import type { DaemonIdentity, KeyReadHost } from './hello';
import { NativeDaemonConnection, ensureNativeDaemon } from './nativeDaemon';
import type { LaunchHost } from './nativeLaunch';

/** How often in a row a daemon may go away during the reconnect to it before the client gives up. */
const MAX_BOUNCES = 3;
/** The wait before the next of those reconnects, times how many came before it. */
const BOUNCE_DELAY_MS = 500;
/** After its daemon went, how long the client waits for a successor before it starts one itself. */
export const SUCCESSOR_WAIT_MS = 3_000;

export interface Disposable { dispose(): void }

/** What the question handler is told besides the question: the signal aborts when it is withdrawn. */
export interface QuestionContext {
	readonly signal: AbortSignal;
}

/** Answers a question for a person; `remember` applies a yes or no to this client's own later requests. */
export type QuestionHandler = (question: Question, context: QuestionContext) =>
	QuestionReply | QuestionAnswer | Promise<QuestionReply | QuestionAnswer>;

export interface CockpitClientOptions {
	/** Shown in the daemon's log, in other clients' `brick_busy` and in questions: say where this client runs. */
	readonly name: string;
	readonly kind: ClientKind;
	/** This client's package version. */
	readonly version: string;
	/** This client's build kind; by default its daemon's, else `release`. */
	readonly buildKind?: BuildKind;
	/** The daemon this client carries (`packagedDaemon`, `developmentDaemon`); an add-on carries none. */
	readonly daemon?: LaunchSpec;
	/** A test channel, and a state root of its own for it. */
	readonly channel?: string;
	readonly stateRoot?: string;
	/** More arguments for a daemon started on a test channel: replay and its recording. */
	readonly daemonArgs?: readonly string[];
	readonly readinessMs?: number;
	/** Reconnect when the daemon goes (default true). */
	readonly reconnect?: boolean;
	readonly host?: LaunchHost;
	readonly channelHost?: NativeChannelHost;
	readonly keyHost?: KeyReadHost;
}

interface Renewable {
	/** The daemon's id on the current connection. */
	wireId: string;
	readonly renew: () => Promise<string>;
}

type Listener<T> = (value: T) => void;

function safely(call: () => void): void {
	try { call(); } catch { /* a listener's own failure */ }
}

class Emitter<T> {
	private readonly listeners = new Set<Listener<T>>();
	on(listener: Listener<T>): Disposable {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	}
	fire(value: T): void {
		for (const listener of [...this.listeners]) { safely(() => listener(value)); }
	}
}

const NOTIFICATIONS: readonly NotificationName[] = [
	'bricks/changed', 'bricks/reconnected', 'bricks/pairingStarted', 'bricks/pairingEvent', 'bricks/pairingDone',
	'bricks/oneSidedRepair', 'programs/stateChanged', 'telemetry/update', 'chain/changed', 'settings/changed',
	'settings/accessModeChanged', 'question/withdrawn', 'daemon/showsChanged',
];

const ANSWERS: readonly QuestionAnswer[] = ['yes', 'no', 'keep'];

/** A handler's answer as the wire carries it; anything unusable reads as `keep`. */
function toReply(answer: QuestionReply | QuestionAnswer | undefined): QuestionReply {
	if (typeof answer === 'string') { return { answer: ANSWERS.includes(answer) ? answer : 'keep' }; }
	if (!answer || !ANSWERS.includes(answer.answer)) { return { answer: 'keep' }; }
	return answer.remember === undefined ? { answer: answer.answer } : { answer: answer.answer, remember: answer.remember };
}

export class CockpitClient {
	private connection!: NativeDaemonConnection;
	private disposed = false;
	private brickList: ContractBrick[] = [];
	private settingList: SettingValue[] = [];
	private access: AccessMode = 'safe';
	private active: string | undefined;
	private questionHandler: QuestionHandler | undefined;
	private readonly openQuestions = new Map<string, AbortController>();
	private readonly renewables = new Map<string, Renewable>();
	/** Subscriptions a reconnect could not renew, because their brick was not back yet. */
	private readonly unrenewed = new Set<string>();
	/** Bricks this client connected for itself, without a hold: connected again on a new daemon. */
	private readonly myBricks = new Set<string>();
	private readonly notificationHandlers = new Map<string, Set<(params: unknown) => void>>();
	private nextId = 0;
	private reconnecting: Promise<void> | undefined;
	private renewing = false;
	private bounces = 0;

	private readonly bricksChanged = new Emitter<readonly ContractBrick[]>();
	private readonly reconnected = new Emitter<DaemonIdentity>();
	private readonly notices = new Emitter<string>();
	private readonly lost = new Emitter<Error>();

	/** The bricks changed. */
	readonly onBricksChanged = (listener: Listener<readonly ContractBrick[]>): Disposable => this.bricksChanged.on(listener);
	/** Connected again after the previous daemon went; own bricks and subscriptions are back. */
	readonly onReconnected = (listener: Listener<DaemonIdentity>): Disposable => this.reconnected.on(listener);
	/** Something the user should know: a development daemon runs, an exit request was refused. */
	readonly onNotice = (listener: Listener<string>): Disposable => this.notices.on(listener);
	/** The daemon went and could not be reached again. */
	readonly onLost = (listener: Listener<Error>): Disposable => this.lost.on(listener);

	private constructor(private readonly options: CockpitClientOptions) {}

	/** Connects, starting or replacing the daemon as needed; a start failure is a `DaemonStartError`. */
	static async connect(options: CockpitClientOptions, onNotice?: Listener<string>): Promise<CockpitClient> {
		const client = new CockpitClient(options);
		if (onNotice) { client.onNotice(onNotice); }
		try {
			await client.open(0);
		} catch (error) {
			// The caller never gets this client: it must not stay connected, or reconnect on its own
			// when the daemon closes a connection whose first requests failed.
			client.dispose();
			throw error;
		}
		return client;
	}

	/** Who the daemon said it is when this client connected. */
	get daemon(): DaemonIdentity { return this.connection.daemon; }

	/** The bricks as last heard; no round trip. */
	bricks(): readonly ContractBrick[] { return this.brickList; }
	brick(ref: string): ContractBrick | undefined {
		const wanted = ref.trim().toLowerCase();
		return this.brickList.find((b) => b.brickId === ref) ?? this.brickList.find((b) => b.name.trim().toLowerCase() === wanted);
	}
	settings(): readonly SettingValue[] { return this.settingList; }
	accessMode(): AccessMode { return this.access; }

	/** This client's active brick, whose telemetry the daemon reads in the foreground. */
	activeBrick(): string | undefined { return this.active; }
	async setActiveBrick(brickId: string | undefined): Promise<void> {
		this.active = brickId;
		await this.request('telemetry/foreground', brickId === undefined ? {} : { brick: brickId });
	}

	/**
	 * Who answers the daemon's questions for a person. The question names who asked
	 * (`question.requester`, name and kind, where the kind has one). Without a handler every answer
	 * is `keep`, which the daemon reads as unanswered.
	 */
	onQuestion(handler: QuestionHandler | undefined): void {
		this.questionHandler = handler;
	}

	async request<M extends MethodName>(method: M, params: ParamsOf<M>, options?: RequestOptions): Promise<ResultOf<M>> {
		const endpoint = this.connection.endpoint;
		const sent = !endpoint.closed;
		let result: ResultOf<M>;
		try {
			result = await endpoint.request<ResultOf<M>>(method, params, options);
		} catch (error) {
			// A write cut off by the daemon going may or may not have happened; it is never retried.
			if (sent && error instanceof ContractError && error.code === WireErrorCode.DaemonUnavailable && METHODS[method].leased) {
				throw new ContractError(WireErrorCode.OutcomeUnknown,
					`The cockpit daemon went while ${method} ran, so whether it finished is not known. It was not retried.`);
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

	/**
	 * One subscription that survives reconnects: `open` makes it (again after a reconnect),
	 * `opened` hears its first answer each time, `changed` every notification for it after that.
	 * The daemon may send a notification for the new subscription before its answer arrives; those
	 * are held while it opens and handed on, in order, right after `opened`.
	 */
	private async follow<N extends 'programs/stateChanged' | 'telemetry/update' | 'chain/changed', R extends { readonly subscriptionId: string }>(
		name: N, open: () => Promise<R>,
		opened: (result: R, id: string, renewed: boolean) => void, changed: (params: Notifications[N], id: string) => void,
	): Promise<{ readonly first: R; readonly dispose: () => void }> {
		const id = `s${++this.nextId}`;
		let current: string | undefined;
		let held: Notifications[N][] | undefined;
		let first: R | undefined;
		const renew = async (): Promise<string> => {
			held = [];
			try {
				const result = await open();
				const renewed = first !== undefined;
				first ??= result;
				opened(result, id, renewed);
				current = result.subscriptionId;
				for (const params of held) { if (params.subscriptionId === current) { changed(params, id); } }
				return result.subscriptionId;
			} finally {
				held = undefined;
			}
		};
		const off = this.on(name, (params) => {
			if (held) { held.push(params); return; }
			if (params.subscriptionId === current) { changed(params, id); }
		});
		try {
			const wireId = await renew();
			this.renewables.set(id, { wireId, renew });
		} catch (error) {
			off.dispose();
			throw error;
		}
		return { first: first as R, dispose: () => { off.dispose(); this.cancel(id); } };
	}

	/** A brick's program state, now and on every change, across reconnects. */
	async subscribePrograms(brick: string, listener: Listener<ProgramState>): Promise<Disposable & { readonly state: ProgramState }> {
		const { first, dispose } = await this.follow('programs/stateChanged', () => this.request('programs/subscribe', { brick }),
			(result, _id, renewed) => { if (renewed) { safely(() => listener(result.state)); } },
			(p) => listener(p.state));
		return { state: first.state, dispose };
	}

	/** Telemetry of a brick: a snapshot first, then changes; again a snapshot after every reconnect. */
	async subscribeTelemetry(brick: string, request: TelemetryRequest, listener: Listener<TelemetryUpdate>): Promise<Disposable & { readonly grant: ResultOf<'telemetry/subscribe'>['grant'] }> {
		const { first, dispose } = await this.follow('telemetry/update', () => this.request('telemetry/subscribe', { brick, request }),
			(result, id) => safely(() => listener({ subscriptionId: id, brickId: result.brickId, kind: 'snapshot', values: result.snapshot, removed: [] })),
			(u, id) => listener({ ...u, subscriptionId: id }));
		return { grant: first.grant, dispose };
	}

	/** The daisy chain below a brick, now and on every change. */
	async followChain(brick: string, listener: Listener<ContractChain>): Promise<Disposable> {
		const { dispose } = await this.follow('chain/changed', () => this.request('chain/follow', { brick }),
			(result) => safely(() => listener(result.chain)), (c) => listener(c.chain));
		return { dispose };
	}

	dispose(): void {
		this.disposed = true;
		this.renewables.clear();
		this.unrenewed.clear();
		this.connection?.endpoint.close();
	}

	private cancel(id: string): void {
		const renewable = this.renewables.get(id);
		if (!renewable) { return; }
		this.renewables.delete(id);
		this.unrenewed.delete(id);
		if (!this.connection.endpoint.closed) {
			void this.request('subscriptions/cancel', { subscriptionId: renewable.wireId }).catch(() => undefined);
		}
	}

	private async open(successorWaitMs: number): Promise<void> {
		const o = this.options;
		const connection = await ensureNativeDaemon({
			name: o.name, kind: o.kind, version: o.version, successorWaitMs,
			onNotice: (text) => this.notices.fire(text),
			...(o.buildKind ? { buildKind: o.buildKind } : {}),
			...(o.daemon ? { daemon: o.daemon } : {}),
			...(o.channel ? { channel: o.channel } : {}),
			...(o.stateRoot !== undefined ? { stateRoot: o.stateRoot } : {}),
			...(o.daemonArgs ? { daemonArgs: o.daemonArgs } : {}),
			...(o.readinessMs ? { readinessMs: o.readinessMs } : {}),
			...(o.host ? { host: o.host } : {}),
			...(o.channelHost ? { channelHost: o.channelHost } : {}),
			...(o.keyHost ? { keyHost: o.keyHost } : {}),
		});
		// Disposed while this connection was being made: it must not stay open.
		if (this.disposed) {
			connection.endpoint.close();
			throw new ContractError(WireErrorCode.DaemonUnavailable, 'The client was disposed while it connected.');
		}
		this.connection = connection;
		const { endpoint } = connection;
		endpoint.onRequest('question/ask', async (params, context) => this.answer(params as Question, context.signal));
		for (const name of NOTIFICATIONS) { endpoint.onNotification(name, (params) => this.dispatch(name, params)); }
		// A connection that closes before its first lists came is a failed open, which the caller
		// hears about; only one that opened fully is reconnected when it closes.
		let opened = false;
		endpoint.onClose(() => {
			for (const controller of this.openQuestions.values()) { controller.abort(); }
			this.openQuestions.clear();
			if (opened) { void this.connectAgain(); }
		});
		const [bricks, settings, access] = await Promise.all([
			this.request('bricks/list', {}), this.request('settings/list', {}), this.request('settings/accessMode', {}),
		]);
		this.brickList = [...bricks.bricks];
		this.settingList = [...settings.settings];
		this.access = access.mode;
		opened = true;
		if (endpoint.closed) { void this.connectAgain(); }
		if (this.active) { await this.request('telemetry/foreground', { brick: this.active }).catch(() => undefined); }
	}

	private async answer(question: Question, signal: AbortSignal): Promise<QuestionReply> {
		const handler = this.questionHandler;
		if (!handler) { return { answer: 'keep' }; }
		const controller = new AbortController();
		const abort = (): void => controller.abort();
		signal.addEventListener('abort', abort, { once: true });
		this.openQuestions.set(question.questionId, controller);
		try {
			return toReply(await handler(question, { signal: controller.signal }));
		} catch {
			return { answer: 'keep' };
		} finally {
			signal.removeEventListener('abort', abort);
			this.openQuestions.delete(question.questionId);
		}
	}

	/** Tries the subscriptions a reconnect could not renew again, one round at a time. */
	private async renewPending(): Promise<void> {
		if (this.renewing || this.reconnecting || this.unrenewed.size === 0 || this.connection.endpoint.closed) { return; }
		this.renewing = true;
		try {
			for (const id of [...this.unrenewed]) {
				const renewable = this.renewables.get(id);
				if (!renewable) { this.unrenewed.delete(id); continue; }
				try {
					renewable.wireId = await renewable.renew();
					this.unrenewed.delete(id);
				} catch { /* still not back: the next change of the bricks tries again */ }
			}
		} finally {
			this.renewing = false;
		}
	}

	private dispatch(name: NotificationName, params: unknown): void {
		if (name === 'bricks/reconnected') { void this.renewPending(); }
		if (name === 'bricks/changed') {
			void this.renewPending();
			this.brickList = [...(params as Notifications['bricks/changed']).bricks];
			this.bricksChanged.fire(this.brickList);
		} else if (name === 'settings/changed') {
			const { setting } = params as Notifications['settings/changed'];
			this.settingList = this.settingList.map((s) => (s.spec.key === setting.spec.key ? setting : s));
		} else if (name === 'settings/accessModeChanged') {
			this.access = (params as Notifications['settings/accessModeChanged']).mode;
		} else if (name === 'question/withdrawn') {
			this.openQuestions.get((params as Notifications['question/withdrawn']).questionId)?.abort();
		}
		for (const handler of [...(this.notificationHandlers.get(name) ?? [])]) { safely(() => handler(params)); }
	}

	private connectAgain(): Promise<void> {
		if (this.disposed || this.options.reconnect === false) { return Promise.resolve(); }
		this.reconnecting ??= (async () => {
			const before = this.connection;
			try {
				// A replacement's successor is on its way: wait for it before starting a daemon here.
				await this.open(SUCCESSOR_WAIT_MS);
				// No daemon hands anything to the next: this client's own bricks are connected again.
				for (const brickId of [...this.myBricks]) {
					await this.connection.endpoint.request('bricks/connect', { brick: brickId, reuse: true }).catch(() => undefined);
				}
				for (const [id, renewable] of this.renewables) {
					try {
						renewable.wireId = await renewable.renew();
						this.unrenewed.delete(id);
					} catch { this.unrenewed.add(id); }
				}
				if (!this.connection.endpoint.closed) { this.reconnected.fire(this.connection.daemon); }
			} catch (error) {
				if (!this.disposed) { this.lost.fire(error instanceof Error ? error : new ContractError(WireErrorCode.DaemonUnavailable, String(error))); }
			} finally {
				this.reconnecting = undefined;
			}
			// The daemon just reached went again during the reconnect: go round once more, a few times only.
			if (!this.disposed && this.connection !== before && this.connection.endpoint.closed) {
				if (++this.bounces > MAX_BOUNCES) {
					this.bounces = 0;
					this.lost.fire(new ContractError(WireErrorCode.DaemonUnavailable, 'The cockpit daemon kept going away right after this client reached it.'));
					return;
				}
				await new Promise((resolve) => setTimeout(resolve, BOUNCE_DELAY_MS * this.bounces));
				await this.connectAgain();
				return;
			}
			this.bounces = 0;
			if (!this.disposed && !this.connection.endpoint.closed) { void this.renewPending(); }
		})();
		return this.reconnecting;
	}
}
