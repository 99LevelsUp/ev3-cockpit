/**
 * What the command flows share: the brick list as they read it, the log they write, and how they
 * tell one daemon failure from another.
 *
 * Free of `vscode`; the extension hands the flows the bridge to the daemon and its output channel.
 */

import type { ContractBrick, ErrorCode } from '../../contract/generated';
import type { Disposable } from '../events';
import type { BrickNames } from './brickLabels';

/** The daemon's brick list as the commands read it, current while a picker is open. */
export interface BrickList extends BrickNames {
	bricks(): readonly ContractBrick[];
	onListChanged(listener: () => void): Disposable;
}

/** The output channel, at the levels the commands write. */
export interface CommandLog {
	info(message: string): void;
	warn(message: string): void;
	error(message: string, error?: unknown): void;
}

/**
 * The contract code of a daemon failure: `data.code`, which every contract error carries. Never the
 * class name; a failure that is no contract error has none.
 */
export function errorCode(error: unknown): ErrorCode | undefined {
	if (typeof error !== 'object' || error === null) { return undefined; }
	const code = (error as { data?: { code?: unknown } }).data?.code;
	return typeof code === 'string' ? code as ErrorCode : undefined;
}

/** A failure as an Error, for messages and the log. */
export function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
