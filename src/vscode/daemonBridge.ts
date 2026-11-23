/**
 * The extension's commands run on the native daemon through the client library. The bridge gives
 * them the daemon's brick list, which changes while a picker is open, and a brick layer whose every
 * call is a request to the daemon; failures keep their contract code, which the commands decide on.
 *
 * Free of `vscode`, so it can be tested over a real daemon.
 *
 * The daemon asks a person before every dangerous action, and it asks the window whose request it
 * is. A forget, a clearing, a dangerous setting or a restart the person already confirmed in VS Code
 * is not asked about twice: the daemon's question about that same request, raised by this window,
 * is answered from the confirmation already given. A question another client's request raised is
 * never answered that way; it goes to `askPerson`, like every other question.
 */

import type { CockpitClient, QuestionContext } from '../client/nativeClient';
import type {
	ClearListReport, ContractBrick, ForgetResult, OneSidedRepair, PairingProgress, PairingResult, Question, QuestionAnswer,
	QuestionReply, Requester, SettingScalar, SettingValue,
} from '../contract/generated';
import { Disposable, EventEmitter } from './events';
import type { ClearListConfirm } from './ui/clearBluetoothList';
import { errorCode } from './ui/commandTypes';
import type { PairingStartedEvent } from './ui/connectBrick';

/** The part of the client the bridge uses. */
export type BridgeClient = Pick<CockpitClient,
	'bricks' | 'settings' | 'request' | 'on' | 'onBricksChanged' | 'onReconnected' | 'onQuestion' | 'setActiveBrick'>;

/** A pairing found broken on one side, and whether the daemon is pairing the brick again. */
export interface OneSidedRepairEvent {
	readonly repair: OneSidedRepair;
	readonly pairingAgain: boolean;
}

export type AskPerson = (question: Question, context: QuestionContext) =>
	QuestionReply | QuestionAnswer | Promise<QuestionReply | QuestionAnswer>;

export interface DaemonBridgeOptions {
	/** This window as its hello named it: the requester of the questions its own requests raise. */
	readonly me: Requester;
	/** Every question the bridge does not answer itself; without it, `keep`. */
	readonly askPerson?: AskPerson;
}

/** A question this window's own request is about to raise, and how to answer it. */
interface Expected {
	matches(question: Question): boolean;
	answer(question: Question): boolean | PromiseLike<boolean>;
}

const sameClient = (a: Requester, b: Requester): boolean => a.name === b.name && a.kind === b.kind;

/** A start failure or a lost daemon as the person reads it, by the failure the client library names. */
export function startFailureMessage(error: unknown): string {
	const message = (error instanceof Error ? error.message : String(error)).split('\n')[0];
	const failure = (error as { failure?: unknown } | null)?.failure;
	switch (failure) {
	// These say what happened and what to do in their own words: Smart App Control blocking the
	// unsigned daemon, a daemon that speaks another contract, a daemon that is not there.
	case 'smart_app_control':
	case 'contract_mismatch':
	case 'missing_binary':
	case 'sha_mismatch':
		return `EVƎ Cockpit: ${message}`;
	default:
		return `EVƎ Cockpit: the cockpit daemon could not be started — ${message}`;
	}
}

/**
 * The connection to the daemon, made once. A start failure is shown once, and nothing tries again:
 * a daemon Smart App Control blocks stays blocked, and starting it over and over only repeats the
 * message.
 */
export class CockpitStart<T> {
	private attempt: Promise<T> | undefined;

	constructor(private readonly connect: () => Promise<T>, private readonly showFailure: (message: string, error: unknown) => void) {}

	/** The connection, made on the first call; every later call has the same outcome. */
	ready(): Promise<T> {
		this.attempt ??= Promise.resolve().then(() => this.connect()).catch((error: unknown) => {
			this.showFailure(startFailureMessage(error), error);
			throw error;
		});
		return this.attempt;
	}
}

export class DaemonBridge implements Disposable {
	private readonly listChanged = new EventEmitter<void>();
	private readonly pairingStarted = new EventEmitter<PairingStartedEvent>();
	private readonly repaired = new EventEmitter<OneSidedRepairEvent>();
	/** Questions this window's own confirmed requests are about to raise. */
	private readonly expected = new Set<Expected>();
	/** Pairings the daemon runs now, by brick. */
	private readonly pairings = new Map<string, { progress: EventEmitter<PairingProgress>; settle: (result: PairingResult) => void }>();
	private readonly subscriptions: Disposable[] = [];

	constructor(private readonly client: BridgeClient, private readonly options: DaemonBridgeOptions) {
		client.onQuestion((question, context) => this.answer(question, context));
		this.subscriptions.push(client.onBricksChanged(() => this.listChanged.fire()));
		this.subscriptions.push(client.onReconnected(() => {
			// A pairing the previous daemon ran ended with it; its progress must not stay up.
			for (const brickId of [...this.pairings.keys()]) {
				this.endPairing({ brickId, outcome: 'failed', message: 'The cockpit daemon went while it ran.' });
			}
			this.listChanged.fire();
		}));
		this.followPairings();
		this.subscriptions.push(client.on('bricks/oneSidedRepair', ({ brickId, repair }) => {
			// The daemon announces a pairing it starts after a repair just before the repair itself.
			this.repaired.fire({ repair, pairingAgain: this.pairings.has(brickId) });
		}));
	}

	dispose(): void {
		for (const s of this.subscriptions.splice(0)) { s.dispose(); }
		this.client.onQuestion(undefined);
		this.listChanged.dispose();
		this.pairingStarted.dispose();
		this.repaired.dispose();
	}

	/** The brick list as the pickers read it. */
	readonly list = {
		bricks: (): readonly ContractBrick[] => this.client.bricks(),
		brick: (brickId: string): ContractBrick | undefined => this.client.bricks().find((b) => b.brickId === brickId),
		onListChanged: (listener: () => void): Disposable => this.listChanged.event(listener),
	};

	/** The brick layer as the commands use it, each call a request to the daemon. */
	readonly bricks = {
		/** Connects the brick for this window and makes it the active brick. */
		connect: async (brickId: string): Promise<ContractBrick> => {
			const brick = await this.client.request('bricks/connect', { brick: brickId });
			await this.client.setActiveBrick(brick.brickId);
			return brick;
		},
		pair: (brickId: string): Promise<PairingResult> => this.client.request('bricks/pair', { brick: brickId }),
		/** Forgets a brick the person confirmed forgetting in VS Code. */
		forget: (brickId: string): Promise<ForgetResult> => this.expecting({
			matches: (q) => q.kind === 'forget' && q.brickId === brickId,
			answer: () => true,
		}, () => this.client.request('bricks/forget', { brick: brickId })),
		/** Clears the brick's list once `confirm` says yes to the names the daemon read; undefined when declined. */
		clearBluetoothList: async (brickId: string, confirm: ClearListConfirm): Promise<ClearListReport | undefined> => {
			let declined = false;
			try {
				const result = await this.expecting({
					matches: (q) => q.kind === 'clearBluetoothList' && q.brickId === brickId,
					answer: async (q) => {
						if (q.kind !== 'clearBluetoothList') { return false; }
						const yes = await confirm(q.details ?? [], q.includesThisComputer, q.thisComputer);
						declined = !yes;
						return yes;
					},
				}, () => this.client.request('bricks/clearBluetoothList', { brick: brickId }));
				return result.report;
			} catch (error) {
				// The person said no: the daemon refuses with `cancelled`, and nothing happened.
				if (declined && errorCode(error) === 'cancelled') { return undefined; }
				throw error;
			}
		},
		onPairingStarted: (listener: (event: PairingStartedEvent) => void): Disposable => this.pairingStarted.event(listener),
		onOneSidedRepair: (listener: (event: OneSidedRepairEvent) => void): Disposable => this.repaired.event(listener),
	};

	/** The daemon's settings as `EVƎ: Settings` changes them. */
	readonly settings = {
		settings: (): readonly SettingValue[] => this.client.settings(),
		set: (key: string, value: SettingScalar, confirmedHere: boolean): Promise<SettingValue> => {
			const set = (): Promise<SettingValue> => this.client.request('settings/set', { key, value });
			return confirmedHere
				? this.expecting({ matches: (q) => q.kind === 'setting' && q.key === key && q.value === value, answer: () => true }, set)
				: set();
		},
	};

	/** Asks the daemon to end and be started again, which the person confirmed in VS Code. */
	restart(): Promise<{ readonly accepted: boolean; readonly reason?: string }> {
		return this.expecting({ matches: (q) => q.kind === 'restart', answer: () => true },
			() => this.client.request('daemon/exit', {}));
	}

	private async expecting<T>(expected: Expected, work: () => Promise<T>): Promise<T> {
		this.expected.add(expected);
		try {
			return await work();
		} finally {
			this.expected.delete(expected);
		}
	}

	private async answer(question: Question, context: QuestionContext): Promise<QuestionReply | QuestionAnswer> {
		const own = 'requester' in question && sameClient(question.requester, this.options.me);
		const expected = own ? [...this.expected].find((e) => e.matches(question)) : undefined;
		if (expected) { return (await expected.answer(question)) ? 'yes' : 'no'; }
		return this.options.askPerson ? this.options.askPerson(question, context) : 'keep';
	}

	private endPairing(result: PairingResult): void {
		const running = this.pairings.get(result.brickId);
		if (!running) { return; }
		this.pairings.delete(result.brickId);
		running.settle(result);
		running.progress.dispose();
	}

	/** Every pairing the daemon runs, whoever started it, as the event the progress follows. */
	private followPairings(): void {
		this.subscriptions.push(this.client.on('bricks/pairingStarted', ({ brickId }) => {
			// A start for a brick whose last pairing never reported its end: that one is over.
			this.endPairing({ brickId, outcome: 'cancelled' });
			const progress = new EventEmitter<PairingProgress>();
			let settle: (result: PairingResult) => void = () => undefined;
			const done = new Promise<PairingResult>((resolve) => { settle = resolve; });
			this.pairings.set(brickId, { progress, settle });
			this.pairingStarted.fire({ brickId, done, onProgress: (listener) => { progress.event(listener); } });
		}));
		this.subscriptions.push(this.client.on('bricks/pairingEvent', ({ brickId, progress }) => {
			this.pairings.get(brickId)?.progress.fire(progress);
		}));
		this.subscriptions.push(this.client.on('bricks/pairingDone', (result) => this.endPairing(result)));
	}
}
