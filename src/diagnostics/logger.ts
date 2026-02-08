export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';

export interface Logger {
	error(message: string, meta?: Record<string, unknown>): void;
	warn(message: string, meta?: Record<string, unknown>): void;
	info(message: string, meta?: Record<string, unknown>): void;
	debug(message: string, meta?: Record<string, unknown>): void;
	trace(message: string, meta?: Record<string, unknown>): void;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
	error: 0,
	warn: 1,
	info: 2,
	debug: 3,
	trace: 4
};

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

export class NoopLogger implements Logger {
	public error(_message: string, _meta?: Record<string, unknown>): void {}
	public warn(_message: string, _meta?: Record<string, unknown>): void {}
	public info(_message: string, _meta?: Record<string, unknown>): void {}
	public debug(_message: string, _meta?: Record<string, unknown>): void {}
	public trace(_message: string, _meta?: Record<string, unknown>): void {}
}

export class OutputChannelLogger implements Logger {
	private readonly minLevel: number;
	private readonly appendLine: (line: string) => void;

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

