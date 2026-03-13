/**
 * Logging infrastructure for the EV3 Cockpit extension.
 *
 * @remarks
 * Provides a level-filtered {@link Logger} interface with two implementations:
 * {@link NoopLogger} (silent) and {@link OutputChannelLogger} (writes to a VS
 * Code OutputChannel). Log levels are ordered from most to least severe:
 * `error` \> `warn` \> `info` \> `debug` \> `trace`.
 *
 * @packageDocumentation
 */

/** Supported log severity levels, ordered from most to least severe. */
export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';

/**
 * Structured logging interface used throughout the extension.
 *
 * @remarks
 * All methods accept an optional metadata record that is serialized to JSON
 * and appended to the log line. Implementations should filter messages based
 * on their configured minimum level.
 */
export interface Logger {
	error(message: string, meta?: Record<string, unknown>): void;
	warn(message: string, meta?: Record<string, unknown>): void;
	info(message: string, meta?: Record<string, unknown>): void;
	debug(message: string, meta?: Record<string, unknown>): void;
	trace(message: string, meta?: Record<string, unknown>): void;
}

/** Numeric ordering of log levels for threshold comparison. */
const LEVEL_ORDER: Record<LogLevel, number> = {
	error: 0,
	warn: 1,
	info: 2,
	debug: 3,
	trace: 4
};

/**
 * Formats a log entry as a single line: `[ISO timestamp] [level] message {metadata}`.
 */
function toLogLine(level: LogLevel, message: string, meta?: Record<string, unknown>): string {
	const timestamp = new Date().toISOString();
	if (!meta || Object.keys(meta).length === 0) {
		return `[${timestamp}] [${level}] ${message}`;
	}

	let serialized = '';
	try {
		serialized = JSON.stringify(meta);
	} catch {
		serialized = '{"meta":"unserializable"}';
	}
	return `[${timestamp}] [${level}] ${message} ${serialized}`;
}

/**
 * Logger implementation that silently discards all messages.
 *
 * @remarks
 * Used as a safe default when no output channel is available, or in test contexts.
 */
export class NoopLogger implements Logger {
	public error(_message: string, _meta?: Record<string, unknown>): void {}
	public warn(_message: string, _meta?: Record<string, unknown>): void {}
	public info(_message: string, _meta?: Record<string, unknown>): void {}
	public debug(_message: string, _meta?: Record<string, unknown>): void {}
	public trace(_message: string, _meta?: Record<string, unknown>): void {}
}

/**
 * Logger implementation that writes to a VS Code OutputChannel (or any `appendLine` sink).
 *
 * @remarks
 * Messages below the configured minimum level are silently discarded.
 * Metadata objects are JSON-serialized and appended to the log line.
 */
export class OutputChannelLogger implements Logger {
	/** Numeric threshold — messages with a level above this are dropped. */
	private readonly minLevel: number;
	/** Callback to write a formatted line (typically `OutputChannel.appendLine`). */
	private readonly appendLine: (line: string) => void;

	/**
	 * @param appendLine - Function that writes a single line (e.g. `channel.appendLine`)
	 * @param level - Minimum severity level to emit (default: `'info'`)
	 */
	public constructor(appendLine: (line: string) => void, level: LogLevel = 'info') {
		this.appendLine = appendLine;
		this.minLevel = LEVEL_ORDER[level];
	}

	public error(message: string, meta?: Record<string, unknown>): void {
		this.log('error', message, meta);
	}

	public warn(message: string, meta?: Record<string, unknown>): void {
		this.log('warn', message, meta);
	}

	public info(message: string, meta?: Record<string, unknown>): void {
		this.log('info', message, meta);
	}

	public debug(message: string, meta?: Record<string, unknown>): void {
		this.log('debug', message, meta);
	}

	public trace(message: string, meta?: Record<string, unknown>): void {
		this.log('trace', message, meta);
	}

	private log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
		if (LEVEL_ORDER[level] > this.minLevel) {
			return;
		}
		this.appendLine(toLogLine(level, message, meta));
	}
}

