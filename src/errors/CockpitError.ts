export const ErrorCode = {
	// Transport
	TransportFailed: 'transport_failed',
	ConnectionFailed: 'connection_failed',
	Timeout: 'timeout',
	/** The brick answered, but not in a shape we can parse. The link is alive. */
	ProtocolFailed: 'protocol_failed',
	InvalidBrickKey: 'invalid_brick_key',
	// Session
	SessionFailed: 'session_failed',
	HeartbeatFailed: 'heartbeat_failed',
	AlreadyConnected: 'already_connected',
	NotConnected: 'not_connected',
	NoProvider: 'no_provider',
	InvalidTransition: 'invalid_transition',
	ChannelChanged: 'channel_changed',
	ConnectionAbandoned: 'connection_abandoned',
	QueueUnavailable: 'queue_unavailable',
	// API
	ConsumerFailed: 'consumer_failed',
	SubscriptionFailed: 'subscription_failed',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export class CockpitError extends Error {
	constructor(
		readonly code: ErrorCode,
		message: string,
		cause?: unknown,
	) {
		// Hand the cause to Error rather than shadowing it with an own property, so
		// debuggers and util.inspect follow the chain the standard way.
		super(message, { cause });
		this.name = 'CockpitError';
	}
}

export class TransportError extends CockpitError {
	constructor(message: string, cause?: unknown) {
		super(ErrorCode.TransportFailed, message, cause);
		this.name = 'TransportError';
	}
}

/**
 * This backend cannot run on this host, and nothing was attempted.
 *
 * The distinction matters to whoever is choosing between backends. A backend that is
 * unavailable — wrong platform, an FFI that will not load, a socket the OS refused to
 * hand out — never touched the radio, so trying the next one immediately costs nothing.
 * An ordinary {@link TransportError} from a connect attempt did touch it, and on Windows
 * that leaves the single RFCOMM channel settling for tens of seconds; following it with
 * another attempt spends the recovery rather than shortening it.
 */
export class BackendUnavailableError extends TransportError {
	constructor(message: string, cause?: unknown) {
		super(message, cause);
		this.name = 'BackendUnavailableError';
	}
}

/**
 * The brick did not answer the connect: off, out of range, or busy elsewhere.
 *
 * Still an ordinary transport failure to everything below the extension. It exists so that
 * what a user reads is "it did not answer, check it is on and in range" rather than the
 * Winsock code behind it, which stays in the message for the log.
 */
export class BrickUnreachableError extends TransportError {
	constructor(message: string, cause?: unknown) {
		super(message, cause);
		this.name = 'BrickUnreachableError';
	}
}

export class ConnectionError extends CockpitError {
	constructor(message: string, cause?: unknown) {
		super(ErrorCode.ConnectionFailed, message, cause);
		this.name = 'ConnectionError';
	}
}

/**
 * The brick replied, but the reply could not be parsed or framed.
 *
 * Distinct from `TransportError` on purpose: this one proves the link works. The
 * heartbeat relies on the difference — see `HeartbeatMonitorOptions.isLinkFailure`.
 */
export class ProtocolError extends CockpitError {
	constructor(message: string, cause?: unknown) {
		super(ErrorCode.ProtocolFailed, message, cause);
		this.name = 'ProtocolError';
	}
}

/** An identifier that cannot form a brick key. */
export class InvalidBrickKeyError extends CockpitError {
	constructor(message: string, cause?: unknown) {
		super(ErrorCode.InvalidBrickKey, message, cause);
		this.name = 'InvalidBrickKeyError';
	}
}

export class TimeoutError extends CockpitError {
	constructor(message: string, cause?: unknown) {
		super(ErrorCode.Timeout, message, cause);
		this.name = 'TimeoutError';
	}
}

export class SessionError extends CockpitError {
	constructor(message: string, cause?: unknown, code: ErrorCode = ErrorCode.SessionFailed) {
		super(code, message, cause);
		this.name = 'SessionError';
	}
}

/** A brick already has a live session. */
export class AlreadyConnectedError extends SessionError {
	constructor(message: string, cause?: unknown) {
		super(message, cause, ErrorCode.AlreadyConnected);
		this.name = 'AlreadyConnectedError';
	}
}

/**
 * The channel an operation was pinned to is gone, though the brick may still be reachable.
 *
 * A file transfer keeps the channel it started on (step-2 plan, KD9). When that channel is
 * lost mid-transfer the transfer fails with this, rather than hopping to another channel with
 * chunks sized for the old one; the caller may start it again, and it will take whichever
 * channel carries traffic then.
 */
export class ChannelChangedError extends SessionError {
	constructor(message: string, cause?: unknown) {
		super(message, cause, ErrorCode.ChannelChanged);
		this.name = 'ChannelChangedError';
	}
}

/**
 * A connect gave up because the brick was disconnected while it was still opening.
 *
 * Not a fault of the link: the user asked for the brick to be closed. It is an error rather
 * than a quiet return so that nobody waiting on the connect takes it for one that succeeded.
 */
export class ConnectionAbandonedError extends SessionError {
	constructor(message: string, cause?: unknown) {
		super(message, cause, ErrorCode.ConnectionAbandoned);
		this.name = 'ConnectionAbandonedError';
	}
}

/** The operation needs a live session and there is none. */
export class NotConnectedError extends SessionError {
	constructor(message: string, cause?: unknown) {
		super(message, cause, ErrorCode.NotConnected);
		this.name = 'NotConnectedError';
	}
}

/** No provider is registered for the requested transport. */
export class NoProviderError extends SessionError {
	constructor(message: string, cause?: unknown) {
		super(message, cause, ErrorCode.NoProvider);
		this.name = 'NoProviderError';
	}
}

/** The session state machine rejected a transition. */
export class InvalidTransitionError extends SessionError {
	constructor(message: string, cause?: unknown) {
		super(message, cause, ErrorCode.InvalidTransition);
		this.name = 'InvalidTransitionError';
	}
}

/** The per-brick command queue is disposed or has no executor. */
export class QueueUnavailableError extends SessionError {
	constructor(message: string, cause?: unknown) {
		super(message, cause, ErrorCode.QueueUnavailable);
		this.name = 'QueueUnavailableError';
	}
}

export class HeartbeatError extends CockpitError {
	constructor(message: string, cause?: unknown) {
		super(ErrorCode.HeartbeatFailed, message, cause);
		this.name = 'HeartbeatError';
	}
}

export class ConsumerError extends CockpitError {
	constructor(message: string, cause?: unknown) {
		super(ErrorCode.ConsumerFailed, message, cause);
		this.name = 'ConsumerError';
	}
}

export class SubscriptionError extends CockpitError {
	constructor(message: string, cause?: unknown) {
		super(ErrorCode.SubscriptionFailed, message, cause);
		this.name = 'SubscriptionError';
	}
}
