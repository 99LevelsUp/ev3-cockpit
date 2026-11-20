/**
 * Errors as they cross the wire.
 *
 * A JSON-RPC error carries a numeric `code` and a `data` object. The number tells a client only
 * which family the error belongs to; what a client decides on is `data.code`, a stable string, and
 * `data.kind`, the name of the error class the daemon raised. Clients choose their messages by kind
 * the way the cockpit used to choose them by class, so a link that dropped and a brick that never
 * answered stay distinguishable although both are transport failures.
 */

/** Every code a client may see in `data.code`. */
export const WireErrorCode = {
	// Carried over from the cockpit's own errors.
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
	ProgramCancelled: 'program_cancelled',
	ModeConflict: 'mode_conflict',
	AccessDenied: 'access_denied',
	// New with the daemon.
	/** Another client holds the brick's write lease; the message names it. */
	BrickBusy: 'brick_busy',
	/** A brick name matched several bricks; `data.candidates` lists them. */
	BrickAmbiguous: 'brick_ambiguous',
	/** No brick matches the name or id. */
	BrickNotFound: 'brick_not_found',
	/** The operation needs a person's answer, and the client could not ask one. */
	NeedsPerson: 'needs_person',
	/** The daemon is not reachable, could not start, or went away during the call. */
	DaemonUnavailable: 'daemon_unavailable',
	/** The daemon went away during a call that changes a brick; whether it took effect is unknown. Do not retry blindly. */
	OutcomeUnknown: 'outcome_unknown',
	/** The caller, a stop or the daemon cancelled the operation. */
	Cancelled: 'cancelled',
	/** The request was malformed or named something the daemon does not have. */
	InvalidRequest: 'invalid_request',
	/** Anything else; the message says what. */
	Internal: 'internal',
} as const;

export type WireErrorCode = (typeof WireErrorCode)[keyof typeof WireErrorCode];

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
 * The numeric JSON-RPC code for each family. JSON-RPC reserves -32768..-32000 for itself and for
 * the library underneath, so the contract's own codes are positive.
 */
export const WIRE_ERROR_NUMBER = {
	brick: 1000,
	lease: 1100,
	person: 1200,
	daemon: 1300,
	cancelled: 1400,
	request: 1500,
	internal: 1900,
} as const;

/** The numeric family a string code belongs to. */
export function wireErrorNumber(code: WireErrorCode): number {
	switch (code) {
	case WireErrorCode.BrickBusy: return WIRE_ERROR_NUMBER.lease;
	case WireErrorCode.NeedsPerson: return WIRE_ERROR_NUMBER.person;
	case WireErrorCode.DaemonUnavailable:
	case WireErrorCode.OutcomeUnknown: return WIRE_ERROR_NUMBER.daemon;
	case WireErrorCode.Cancelled: return WIRE_ERROR_NUMBER.cancelled;
	case WireErrorCode.InvalidRequest: return WIRE_ERROR_NUMBER.request;
	case WireErrorCode.Internal: return WIRE_ERROR_NUMBER.internal;
	default: return WIRE_ERROR_NUMBER.brick;
	}
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
