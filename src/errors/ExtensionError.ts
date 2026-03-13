/**
 * Base class for all typed errors originating from the EV3 Cockpit extension.
 *
 * @remarks
 * Every extension error carries a machine-readable {@link code} string and supports
 * optional cause chaining for root-cause analysis. Subclasses add domain-specific
 * metadata and recommended recovery actions.
 *
 * @see {@link TransportError} for USB/TCP/BT communication failures
 * @see {@link ProtocolError} for EV3 protocol violations
 * @see {@link SchedulerError} for command scheduling failures
 * @see {@link FilesystemError} for remote filesystem operation failures
 * @see {@link Ev3Error} for EV3 device command failures
 */
export class ExtensionError extends Error {
	/** Machine-readable error code identifying the failure category. */
	readonly code: string;
	/** Optional root-cause error that triggered this failure. */
	readonly cause?: unknown;

	/**
	 * @param code - A unique error code string (typically an enum member)
	 * @param message - Human-readable description of the failure
	 * @param cause - Optional underlying error for cause chaining
	 */
	constructor(code: string, message: string, cause?: unknown) {
		super(message);
		this.name = 'ExtensionError';
		this.code = code;
		this.cause = cause;
	}
}
