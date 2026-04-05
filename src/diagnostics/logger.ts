import * as vscode from 'vscode';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';

const LOG_LEVEL_RANK: Record<LogLevel, number> = {
	error: 0,
	warn:  1,
	info:  2,
	debug: 3,
	trace: 4,
};

export interface Logger {
	error(message: string, ...args: unknown[]): void;
	warn (message: string, ...args: unknown[]): void;
	info (message: string, ...args: unknown[]): void;
	debug(message: string, ...args: unknown[]): void;
	trace(message: string, ...args: unknown[]): void;
}

export class NoopLogger implements Logger {
	// eslint-disable-next-line @typescript-eslint/no-empty-function
	error(_message: string, ..._args: unknown[]): void {}
	// eslint-disable-next-line @typescript-eslint/no-empty-function
	warn (_message: string, ..._args: unknown[]): void {}
	// eslint-disable-next-line @typescript-eslint/no-empty-function
	info (_message: string, ..._args: unknown[]): void {}
	// eslint-disable-next-line @typescript-eslint/no-empty-function
	debug(_message: string, ..._args: unknown[]): void {}
	// eslint-disable-next-line @typescript-eslint/no-empty-function
	trace(_message: string, ..._args: unknown[]): void {}
}

export class OutputChannelLogger implements Logger, vscode.Disposable {
	constructor(
		private readonly channel: vscode.OutputChannel,
		private readonly minLevel: LogLevel = 'info',
	) {}

	error(message: string, ...args: unknown[]): void { this.log('error', message, args); }
	warn (message: string, ...args: unknown[]): void { this.log('warn',  message, args); }
	info (message: string, ...args: unknown[]): void { this.log('info',  message, args); }
	debug(message: string, ...args: unknown[]): void { this.log('debug', message, args); }
	trace(message: string, ...args: unknown[]): void { this.log('trace', message, args); }

	dispose(): void {
		this.channel.dispose();
	}

	private log(level: LogLevel, message: string, args: unknown[]): void {
		if (LOG_LEVEL_RANK[level] > LOG_LEVEL_RANK[this.minLevel]) { return; }
		const ts = new Date().toISOString().slice(11, 19); // HH:MM:SS
		const suffix = args.length > 0 ? ' ' + args.map(formatArg).join(' ') : '';
		this.channel.appendLine(`[${ts}] [${level.toUpperCase().padEnd(5)}] ${message}${suffix}`);
	}
}

function formatArg(a: unknown): string {
	if (a instanceof Error) { return a.message; }
	if (typeof a === 'object' && a !== null) { return JSON.stringify(a); }
	return String(a);
}
