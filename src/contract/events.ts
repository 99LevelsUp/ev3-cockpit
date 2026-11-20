/**
 * What the daemon sends a client without being asked: notifications, plus the one request it makes
 * of a client, a question for a person.
 *
 * Within one connection notifications arrive in the order the daemon raised them.
 */

import type {
	AccessMode, ContractBrick, ContractChain, PairingDone, PairingEvent, ProgramState, Question, QuestionAnswer,
	SettingValue, TelemetryUpdate,
} from './models';

export interface Notifications {
	/** The whole brick list, whenever anything in it changes. */
	'bricks/changed': { readonly bricks: readonly ContractBrick[] };
	/** A brick has a route again: after it was lost, and also when it is first connected. Subscriptions on it carry on. */
	'bricks/reconnected': { readonly brickId: string };
	'bricks/pairingStarted': { readonly brickId: string };
	'bricks/pairingEvent': PairingEvent;
	'bricks/pairingDone': PairingDone;
	/** The brick paired one-sidedly and the cockpit repaired it; the message says what happened. */
	/** `repair` is the cockpit's own record, for clients built with the same cockpit. */
	'bricks/oneSidedRepair': { readonly brickId: string; readonly message: string; readonly repair?: unknown };
	'programs/stateChanged': { readonly subscriptionId: string; readonly state: ProgramState };
	'telemetry/update': TelemetryUpdate;
	'chain/changed': { readonly subscriptionId: string; readonly chain: ContractChain };
	'settings/changed': { readonly setting: SettingValue };
	'settings/accessModeChanged': { readonly mode: AccessMode };
	/** A newer daemon or client exists; the text is ready to show. Reserved: today the client library
	 * compares versions from the handshake itself, and the daemon does not send this. */
	'daemon/versionNotice': { readonly current: string; readonly newer: string; readonly newerIs: 'client' | 'daemon'; readonly text: string };
	/** The daemon is being replaced; reconnect and wait for its successor. */
	'daemon/handingOver': { readonly successorVersion: string };
	/** Bricks were lent to, or came back from, a development daemon. */
	'daemon/lent': { readonly all: boolean; readonly brickIds: readonly string[]; readonly lent: boolean };
	/** A question this client was asked is no longer open. */
	'question/withdrawn': { readonly questionId: string };
}

/** What a file request reports as progress. */
export interface TransferProgress {
	readonly transferred: number;
	readonly total?: number;
}

export type NotificationName = keyof Notifications;

/** The request the daemon sends a client: ask a person. */
export interface ClientRequests {
	'question/ask': { params: Question; result: { readonly answer: QuestionAnswer } };
}
