/**
 * Errors as they cross the wire.
 *
 * A JSON-RPC error carries a numeric `code` and a `data` object. The number tells a client only
 * which family the error belongs to; what a client decides on is `data.code`, a stable string, and
 * `data.kind`, the name of the error class the daemon raised. Clients choose their messages by kind
 * the way the cockpit used to choose them by class, so a link that dropped and a brick that never
 * answered stay distinguishable although both are transport failures.
 */

import { ERROR_FAMILY, ERROR_FAMILY_NUMBER } from './generated';
import type { ErrorCode } from './generated';

/**
 * Every code a client may see in `data.code`: one name for each code of the contract's generated
 * `ErrorCode`, which the compiler holds this table to, plus `program_cancelled`, which only the
 * Node daemon raises and which goes with it (U17).
 */
export const WireErrorCode = {
	TransportFailed: 'transport_failed',
	ConnectionFailed: 'connection_failed',
	Timeout: 'timeout',
	ProtocolFailed: 'protocol_failed',
	InvalidBrickKey: 'invalid_brick_key',
	SessionFailed: 'session_failed',
	HeartbeatFailed: 'heartbeat_failed',
	AlreadyConnected: 'already_connected',
	NotConnected: 'not_connected',
	NoProvider: 'no_provider',
	InvalidTransition: 'invalid_transition',
	ChannelChanged: 'channel_changed',
	ConnectionAbandoned: 'connection_abandoned',
	QueueUnavailable: 'queue_unavailable',
	ConsumerFailed: 'consumer_failed',
	SubscriptionFailed: 'subscription_failed',
	ProgramRunning: 'program_running',
	ProgramNotFound: 'program_not_found',
	ModeConflict: 'mode_conflict',
	AccessDenied: 'access_denied',
	/** A brick name matched several bricks; `data.candidates` lists them. */
	BrickAmbiguous: 'brick_ambiguous',
	/** No brick matches the name or id. */
	BrickNotFound: 'brick_not_found',
	/** The brick did not answer where it was expected. */
	BrickUnreachable: 'brick_unreachable',
	/** The link to the brick dropped during the operation. */
	LinkLost: 'link_lost',
	/** The operating system's USB or Bluetooth stack is not there or not working. */
	BackendUnavailable: 'backend_unavailable',
	/** The operating system refused the daemon the device. */
	DevicePermission: 'device_permission',
	/** Another client holds the brick's write lease; the message names it. */
	BrickBusy: 'brick_busy',
	/** The operation needs a person's answer, and the client could not ask one. */
	NeedsPerson: 'needs_person',
	/** The daemon is not reachable, could not start, or went away during the call. */
	DaemonUnavailable: 'daemon_unavailable',
	/** The daemon went away during a call that changes a brick; whether it took effect is unknown. Do not retry blindly. */
	OutcomeUnknown: 'outcome_unknown',
	/** A replay daemon has no recorded reply left for the request: the recording is stale. */
	ReplayUnmatched: 'replay_unmatched',
	/** The caller, a stop or the daemon cancelled the operation. */
	Cancelled: 'cancelled',
	/** The request was malformed or named something the daemon does not have. */
	InvalidRequest: 'invalid_request',
	/** Anything else; the message says what. */
	Internal: 'internal',
	/** Raised only by the Node daemon, which goes in U17; the native daemon ends a stopped run with `cancelled`. */
	ProgramCancelled: 'program_cancelled',
} as const satisfies Record<string, ErrorCode | 'program_cancelled'>;

export type WireErrorCode = (typeof WireErrorCode)[keyof typeof WireErrorCode];

/** Fails to compile when the contract gains an error code this table has no name for. */
type UnnamedErrorCode = Exclude<ErrorCode, WireErrorCode>;
const everyCodeNamed: [UnnamedErrorCode] extends [never] ? true : UnnamedErrorCode = true;
void everyCodeNamed;

/**
 * The error classes a daemon may name in `data.kind`, one per class the cockpit raises. A class
 * the client does not know reads as `Unknown`; the code still applies.
 */
export const ERROR_KINDS = [
	'CockpitError',
	'TransportError',
	'BackendUnavailableError',
	'BrickUnreachableError',
	'LinkLostError',
	'ConnectionError',
	'ProtocolError',
	'InvalidBrickKeyError',
	'TimeoutError',
	'SessionError',
	'AlreadyConnectedError',
	'ChannelChangedError',
	'ConnectionAbandonedError',
	'NotConnectedError',
	'NoProviderError',
	'InvalidTransitionError',
	'QueueUnavailableError',
	'HeartbeatError',
	'ConsumerError',
	'SubscriptionError',
	'ModeConflictError',
	'ProgramError',
	'AccessDeniedError',
	'DevicePermissionError',
	'BrickBusyError',
	'NeedsPersonError',
	'CancelledError',
	'OutcomeUnknownError',
	'BrickResolveError',
	'DaemonUnavailableError',
	'Unknown',
] as const;

export type ErrorKind = (typeof ERROR_KINDS)[number];

/** The kind a class name reads as on the wire. */
export function errorKindOf(className: string | undefined): ErrorKind {
	return (ERROR_KINDS as readonly string[]).includes(className ?? '') ? className as ErrorKind : 'Unknown';
}

/**
 * The numeric JSON-RPC code for each family, as the contract defines it. JSON-RPC reserves
 * -32768..-32000 for itself and for the library underneath, so the contract's own codes are
 * positive.
 */
export const WIRE_ERROR_NUMBER = ERROR_FAMILY_NUMBER;

/** The numeric family a string code belongs to, from the contract's family table. */
export function wireErrorNumber(code: WireErrorCode): number {
	const family = code === WireErrorCode.ProgramCancelled ? 'brick' : ERROR_FAMILY[code];
	return ERROR_FAMILY_NUMBER[family];
}

/** What `data` carries on every contract error. */
export interface WireErrorData {
	readonly code: WireErrorCode;
	readonly kind: ErrorKind;
	/** For `brick_busy`: who holds the lease. */
	readonly holder?: string;
	/** For `brick_ambiguous`: the bricks the name matched. */
	readonly candidates?: readonly { readonly brickId: string; readonly name: string }[];
	/** For `needs_person` and refusals an agent cannot act on: the command a person should run. */
	readonly command?: string;
}
