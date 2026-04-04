export const ErrorCode = {
	// Transport
	TransportFailed: 'transport_failed',
	ConnectionFailed: 'connection_failed',
	Timeout: 'timeout',
	// Session
	SessionFailed: 'session_failed',
	HeartbeatFailed: 'heartbeat_failed',
	// API
	ConsumerFailed: 'consumer_failed',
	SubscriptionFailed: 'subscription_failed',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export class CockpitError extends Error {
	constructor(
        readonly code: ErrorCode,
        message: string,
        readonly cause?: unknown,
	) {
		super(message);
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
	constructor(message: string, cause?: unknown) {
		super(ErrorCode.SessionFailed, message, cause);
		this.name = 'SessionError';
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
