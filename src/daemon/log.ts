/**
 * The daemon's log file: one line per event, with time, level and — when a client caused it — the
 * client's name. It rotates at 5 MB and keeps three files, `daemon.log` the newest.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { format } from 'node:util';
import type { RuntimeLog } from '../core/runtime/createRuntime';

export const LOG_MAX_BYTES = 5 * 1024 * 1024;
export const LOG_FILES = 3;

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export interface DaemonLogOptions {
	readonly maxBytes?: number;
	readonly files?: number;
	/** Write DEBUG lines too. */
	readonly debug?: boolean;
	/** Also print each line, for a daemon run by hand. */
	readonly echo?: (line: string) => void;
}

export class DaemonLog implements RuntimeLog {
	private readonly maxBytes: number;
	private readonly files: number;
	private size: number;

	constructor(readonly file: string, private readonly options: DaemonLogOptions = {}) {
		this.maxBytes = options.maxBytes ?? LOG_MAX_BYTES;
		this.files = options.files ?? LOG_FILES;
		fs.mkdirSync(path.dirname(file), { recursive: true });
		this.size = fs.existsSync(file) ? fs.statSync(file).size : 0;
	}

	write(level: LogLevel, message: string, client?: string): void {
		if (level === 'DEBUG' && !this.options.debug) { return; }
		const who = client ? ` [${client}]` : '';
		const line = `${new Date().toISOString()} ${level}${who} ${message}\n`;
		const bytes = Buffer.byteLength(line);
		if (this.size + bytes > this.maxBytes && this.size > 0) { this.rotate(); }
		try {
			fs.appendFileSync(this.file, line);
			this.size += bytes;
		} catch {
			// A log that cannot be written must not stop the daemon.
		}
		this.options.echo?.(line.trimEnd());
	}

	info(message: string, ...args: unknown[]): void { this.write('INFO', format(message, ...args)); }
	warn(message: string): void { this.write('WARN', message); }
	error(message: string, error?: Error): void { this.write('ERROR', error ? `${message}: ${error.message}` : message); }
	debug(message: string, ...args: unknown[]): void { this.write('DEBUG', format(message, ...args)); }

	/** The same log, naming a client on every line. */
	forClient(client: string): RuntimeLog {
		return {
			info: (message, ...args) => this.write('INFO', format(message, ...args), client),
			warn: (message) => this.write('WARN', message, client),
			error: (message, error) => this.write('ERROR', error ? `${message}: ${error.message}` : message, client),
			debug: (message, ...args) => this.write('DEBUG', format(message, ...args), client),
		};
	}

	private rotate(): void {
		try {
			for (let i = this.files - 1; i >= 1; i--) {
				const from = i === 1 ? this.file : `${this.file}.${i - 1}`;
				const to = `${this.file}.${i}`;
				if (fs.existsSync(from)) {
					if (fs.existsSync(to)) { fs.unlinkSync(to); }
					fs.renameSync(from, to);
				}
			}
		} catch {
			// Rotation is best effort; appending continues either way.
		}
		this.size = fs.existsSync(this.file) ? fs.statSync(this.file).size : 0;
	}
}
