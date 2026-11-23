/**
 * Errors as they cross the wire.
 *
 * A JSON-RPC error carries a numeric `code` and a `data` object, the contract's `ErrorData`. The
 * number tells a client only which family the error belongs to; what a client decides on is
 * `data.code`, a stable string, with `data.family` beside it.
 */

import { ERROR_FAMILY, ERROR_FAMILY_NUMBER } from './generated';
import type { ErrorCode, ErrorData } from './generated';

/**
 * Every code a client may see in `data.code`, by name: exactly the contract's generated
 * `ErrorCode`, which the compiler holds this table to both ways.
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
	/** Another client holds the brick's write lease; `data.holder` names it. */
	BrickBusy: 'brick_busy',
	/** The operation needs a person's answer, and the client could not ask one; `data.command` is what they can run. */
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
} as const satisfies Record<string, ErrorCode>;

export type WireErrorCode = (typeof WireErrorCode)[keyof typeof WireErrorCode];

/** Fails to compile when the contract gains an error code this table has no name for. */
type UnnamedErrorCode = Exclude<ErrorCode, WireErrorCode>;
const everyCodeNamed: [UnnamedErrorCode] extends [never] ? true : UnnamedErrorCode = true;
void everyCodeNamed;

/**
 * The numeric JSON-RPC code for each family, as the contract defines it. JSON-RPC reserves
 * -32768..-32000 for itself and for the library underneath, so the contract's own codes are
 * positive.
 */
export const WIRE_ERROR_NUMBER = ERROR_FAMILY_NUMBER;

/** The numeric family a string code belongs to, from the contract's family table. */
export function wireErrorNumber(code: WireErrorCode): number {
	return ERROR_FAMILY_NUMBER[ERROR_FAMILY[code]];
}

/** What `data` carries on every contract error: the contract's `ErrorData`. */
export type WireErrorData = ErrorData;
