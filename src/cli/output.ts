/**
 * What the `ev3` command prints and how it exits.
 *
 * People get plain lines; programs pass `--json` and get the result object on stdout, or
 * `{ "error": { code, message, ... } }` on stdout when the command failed. The exit code tells a
 * script what happened without reading either:
 *
 * | code | meaning |
 * |---|---|
 * | 0 | done |
 * | 1 | failed; the message says why |
 * | 2 | the command line is wrong |
 * | 3 | another client is writing to the brick; the message names it |
 * | 4 | a program start whose answer was lost: do not start it again, check first |
 * | 5 | a person has to run and confirm this in a terminal |
 * | 6 | the cockpit daemon could not be reached or started |
 */

import type { Readable, Writable } from 'node:stream';
import { ContractError } from '../client/connection';
import { WireErrorCode } from '../contract/errors';

export const ExitCode = {
	Ok: 0,
	Failure: 1,
	Usage: 2,
	BrickBusy: 3,
	Uncertain: 4,
	NeedsPerson: 5,
	DaemonUnavailable: 6,
} as const;

/** Where the command reads and writes, and what it may ask of a person. */
export interface CliIo {
	readonly stdin: Readable;
	readonly stdout: Writable;
	readonly stderr: Writable;
	/** Both stdin and stdout are a terminal, so a person can be asked. */
	readonly isTTY: boolean;
	readonly env: NodeJS.ProcessEnv;
	readonly cwd: string;
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
}

export function exitCodeFor(error: unknown): number {
	if (error instanceof UsageError) { return ExitCode.Usage; }
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
			? { ...error.data, code: error.code, message }
			: { code: error instanceof UsageError ? 'usage' : WireErrorCode.Internal, message };
		line(io.stdout, JSON.stringify({ error: data }, null, 2));
		return code;
	}
	line(io.stderr, `ev3: ${message}`);
	if (error instanceof ContractError) {
		if (error.data.holder && !message.includes(error.data.holder)) { line(io.stderr, `Held by: ${error.data.holder}`); }
		for (const candidate of error.data.candidates ?? []) { line(io.stderr, `  ${candidate.name}  (id ${candidate.brickId})`); }
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
