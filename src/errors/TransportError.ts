import { ExtensionError } from './ExtensionError';

/**
 * Error codes for transport layer failures.
 */
export enum TransportErrorCode {
	/** Connection failed to establish */
	CONNECT_FAILED = 'CONNECT_FAILED',
	/** Connection was lost during operation */
	CONNECTION_LOST = 'CONNECTION_LOST',
	/** Connection timed out */
	TIMEOUT = 'TIMEOUT',
	/** Adapter is not open or available */
	ADAPTER_NOT_OPEN = 'ADAPTER_NOT_OPEN',
	/** Device was disconnected */
	DEVICE_DISCONNECTED = 'DEVICE_DISCONNECTED',
	/** Failed to send data */
	SEND_FAILED = 'SEND_FAILED',
	/** Failed to receive data */
	RECEIVE_FAILED = 'RECEIVE_FAILED',
	/** Send operation was aborted */
	SEND_ABORTED = 'SEND_ABORTED',
	/** Access denied (port in use or permission issue) */
	ACCESS_DENIED = 'ACCESS_DENIED',
	/** Device not found */
	DEVICE_NOT_FOUND = 'DEVICE_NOT_FOUND',
	/** Invalid transport configuration */
	INVALID_CONFIG = 'INVALID_CONFIG',
	/** HID read/write error */
	HID_ERROR = 'HID_ERROR',
	/** Unknown transport error */
	UNKNOWN = 'UNKNOWN'
}

/**
 * Transport type for error context.
 */
export type TransportType = 'usb' | 'tcp' | 'serial' | 'mock';

/**
 * Recovery action recommendation for transport errors.
 */
export type TransportRecoveryAction =
	| 'retry'
	| 'reconnect'
	| 'check-connection'
	| 'check-permissions'
	| 'restart-adapter'
	| 'none';

/**
 * Specialized error for transport layer failures.
 * Used for USB, TCP, and serial communication issues.
 */
export class TransportError extends ExtensionError {
	public readonly transportType: TransportType;
	public readonly deviceId?: string;
	public readonly recommendedAction: TransportRecoveryAction;
	public readonly isTransient: boolean;

	public constructor(options: {
		code: TransportErrorCode;
		message: string;
		transportType: TransportType;
		deviceId?: string;
		recommendedAction?: TransportRecoveryAction;
		isTransient?: boolean;
		cause?: unknown;
	}) {
		super(options.code, options.message, options.cause);
		this.name = 'TransportError';
		this.transportType = options.transportType;
		this.deviceId = options.deviceId;
		this.recommendedAction = options.recommendedAction ?? inferRecoveryAction(options.code);
		this.isTransient = options.isTransient ?? isTransientErrorCode(options.code);
	}
}

/**
 * Infer recovery action from error code.
 */
function inferRecoveryAction(code: TransportErrorCode): TransportRecoveryAction {
	switch (code) {
		case TransportErrorCode.CONNECT_FAILED:
		case TransportErrorCode.CONNECTION_LOST:
		case TransportErrorCode.DEVICE_DISCONNECTED:
			return 'reconnect';
		case TransportErrorCode.TIMEOUT:
		case TransportErrorCode.SEND_ABORTED:
			return 'retry';
		case TransportErrorCode.ADAPTER_NOT_OPEN:
			return 'restart-adapter';
		case TransportErrorCode.ACCESS_DENIED:
			return 'check-permissions';
		case TransportErrorCode.DEVICE_NOT_FOUND:
			return 'check-connection';
		default:
			return 'none';
	}
}

/**
 * Determine if error code represents a transient condition that may succeed on retry.
 */
function isTransientErrorCode(code: TransportErrorCode): boolean {
	return [
		TransportErrorCode.TIMEOUT,
		TransportErrorCode.SEND_ABORTED,
		TransportErrorCode.CONNECTION_LOST,
		TransportErrorCode.ADAPTER_NOT_OPEN,
		TransportErrorCode.HID_ERROR
	].includes(code);
}

/**
 * User-facing error messages for transport errors.
 */
export const TRANSPORT_ERROR_MESSAGES: Record<TransportErrorCode, string> = {
	[TransportErrorCode.CONNECT_FAILED]: 'Failed to connect to the device.',
	[TransportErrorCode.CONNECTION_LOST]: 'Connection to the device was lost.',
	[TransportErrorCode.TIMEOUT]: 'Connection timed out.',
	[TransportErrorCode.ADAPTER_NOT_OPEN]: 'Transport adapter is not open.',
	[TransportErrorCode.DEVICE_DISCONNECTED]: 'Device was disconnected.',
	[TransportErrorCode.SEND_FAILED]: 'Failed to send data to the device.',
	[TransportErrorCode.RECEIVE_FAILED]: 'Failed to receive data from the device.',
	[TransportErrorCode.SEND_ABORTED]: 'Send operation was aborted.',
	[TransportErrorCode.ACCESS_DENIED]: 'Access denied. The port may be in use or you may lack permissions.',
	[TransportErrorCode.DEVICE_NOT_FOUND]: 'Device not found.',
	[TransportErrorCode.INVALID_CONFIG]: 'Invalid transport configuration.',
	[TransportErrorCode.HID_ERROR]: 'HID communication error.',
	[TransportErrorCode.UNKNOWN]: 'Unknown transport error occurred.'
};
