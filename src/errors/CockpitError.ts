export const ErrorCode = {
	// Transport
	TransportFailed: 'transport_failed',
	ConnectionFailed: 'connection_failed',
	Timeout: 'timeout',
	// Session
	SessionFailed: 'session_failed',
	HeartbeatFailed: 'heartbeat_failed',
	AlreadyConnected: 'already_connected',
	NotConnected: 'not_connected',
	NoProvider: 'no_provider',
	InvalidTransition: 'invalid_transition',
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

export class ConnectionError extends CockpitError {
	constructor(message: string, cause?: unknown) {
		super(ErrorCode.ConnectionFailed, message, cause);
		this.name = 'ConnectionError';
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
