/**
 * What the `ev3` command prints and how it exits.
 *
 * People get plain lines; programs pass `--json` and get the result object on stdout, or
 * `{ "error": { code, message, ... } }` on stdout when the command failed. A daemon that could not
 * be started adds `failure` to that object, one of `missing_binary`, `sha_mismatch`, `not_private`,
 * `smart_app_control`, `name_held`, `lock_held`, `contract_mismatch`, `failed`. The exit code tells
 * a script what happened without reading either:
 *
 * | code | meaning |
 * |---|---|
 * | 0 | done |
 * | 1 | failed; the message says why (a person who said no ends here too) |
 * | 2 | the command line is wrong, or names a setting the cockpit does not have |
 * | 3 | another client is writing to the brick; the message names it |
 * | 4 | a program start whose answer was lost: do not start it again, check first |
 * | 5 | a person has to run and confirm this in a terminal |
 * | 6 | the cockpit daemon could not be reached or started (`failed`, `lock_held`, `name_held`) |
 * | 7 | Windows Smart App Control blocks the cockpit's daemon: the cockpit cannot run on this computer while it is on |
 * | 8 | this installation's daemon cannot be started safely: missing, not matching its recorded SHA-256, or its folder is not the user's alone (`missing_binary`, `sha_mismatch`, `not_private`) |
 * | 9 | the running daemon speaks another contract than this command; update the older of the two |
 */

import type { Readable, Writable } from 'node:stream';
import { ContractError } from '../client/connection';
import { DaemonStartError } from '../client/nativeLaunch';
import { WireErrorCode } from '../contract/errors';

export const ExitCode = {
	Ok: 0,
	Failure: 1,
	Usage: 2,
	BrickBusy: 3,
	Uncertain: 4,
	NeedsPerson: 5,
	DaemonUnavailable: 6,
	SmartAppControl: 7,
	DaemonNotStartable: 8,
	ContractMismatch: 9,
} as const;

/** The exit codes as the help text lists them. */
export const EXIT_CODE_HELP: readonly string[] = [
	'Exit codes: 0 done, 1 failed, 2 wrong command line, 3 the brick is busy, 4 a start that may or may not have happened,',
	'5 a person has to run and confirm it in a terminal, 6 the cockpit daemon could not be reached or started,',
	'7 Windows Smart App Control blocks the cockpit\'s daemon, 8 the daemon of this installation is missing, does not',
	'match its recorded SHA-256 or its folder is not yours alone, 9 the running daemon speaks another contract.',
];

/** Where the command reads and writes, and what it may ask of a person. */
export interface CliIo {
	readonly stdin: Readable;
	readonly stdout: Writable;
	readonly stderr: Writable;
	/** Both stdin and stdout are a terminal, so a person can be asked. */
	readonly isTTY: boolean;
	readonly env: NodeJS.ProcessEnv;
	readonly cwd: string;
	/** Aborts when the person interrupts the command (Ctrl+C): a command that runs until stopped ends then. */
	readonly signal?: AbortSignal;
}

/** The command line itself is wrong. */
export class UsageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'UsageError';
	}
}

/** What a command produced: the object `--json` prints, the lines a person reads, and how it ends. */
export interface CommandResult {
	readonly value: unknown;
	readonly human: string | readonly string[];
	readonly exitCode?: number;
	/** The command wrote its output as it went (one line, or one JSON object, per change): nothing more is printed. */
	readonly streamed?: boolean;
}

export function exitCodeFor(error: unknown): number {
	if (error instanceof UsageError) { return ExitCode.Usage; }
	if (error instanceof DaemonStartError) {
		switch (error.failure) {
		case 'smart_app_control': return ExitCode.SmartAppControl;
		case 'missing_binary':
		case 'sha_mismatch':
		case 'not_private': return ExitCode.DaemonNotStartable;
		case 'contract_mismatch': return ExitCode.ContractMismatch;
		default: return ExitCode.DaemonUnavailable;
		}
	}
	if (error instanceof ContractError) {
		switch (error.code) {
		case WireErrorCode.BrickBusy: return ExitCode.BrickBusy;
		case WireErrorCode.NeedsPerson: return ExitCode.NeedsPerson;
		case WireErrorCode.DaemonUnavailable: return ExitCode.DaemonUnavailable;
		default: return ExitCode.Failure;
		}
	}
	return ExitCode.Failure;
}

function line(stream: Writable, text: string): void {
	stream.write(text.endsWith('\n') ? text : `${text}\n`);
}

export function printResult(io: CliIo, json: boolean, result: CommandResult): void {
	if (result.streamed) { return; }
	if (json) {
		line(io.stdout, JSON.stringify(result.value ?? null, null, 2));
		return;
	}
	const lines = typeof result.human === 'string' ? [result.human] : result.human;
	for (const text of lines) { line(io.stdout, text); }
}

/** Prints a failure and returns the exit code it maps to. */
export function printError(io: CliIo, json: boolean, error: unknown): number {
	const code = exitCodeFor(error);
	const message = error instanceof Error ? error.message : String(error);
	if (json) {
		const data = error instanceof ContractError
			? { ...error.data, code: error.code, message, ...(error instanceof DaemonStartError ? { failure: error.failure } : {}) }
			: { code: error instanceof UsageError ? 'usage' : WireErrorCode.Internal, message };
		line(io.stdout, JSON.stringify({ error: data }, null, 2));
		return code;
	}
	line(io.stderr, `ev3: ${message}`);
	if (error instanceof ContractError) {
		if (error.data.holder && !message.includes(error.data.holder)) { line(io.stderr, `Held by: ${error.data.holder}`); }
		for (const candidate of error.data.candidates ?? []) { line(io.stderr, `  ${candidate.name}  (id ${candidate.brickId})`); }
		if (error.code === WireErrorCode.NeedsPerson && error.data.command && !message.includes(error.data.command)) {
			line(io.stderr, `A person can run: ${error.data.command}`);
		}
	}
	if (error instanceof UsageError) { line(io.stderr, 'Run ev3 help for the commands.'); }
	return code;
}

/** Columns padded to their widest cell. */
export function table(rows: readonly (readonly string[])[]): string[] {
	const widths: number[] = [];
	for (const row of rows) { row.forEach((cell, i) => { widths[i] = Math.max(widths[i] ?? 0, cell.length); }); }
	return rows.map((row) => row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i]))).join('  ').trimEnd());
}
