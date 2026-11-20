/**
 * The handshake that opens every connection: both sides prove they hold the user's key.
 *
 * On Windows another user can open the daemon's pipe for reading, or create a pipe of the same
 * name first. So nothing useful is said before both sides have proved themselves:
 *
 * 1. The client sends `hello/start` with a fresh nonce and who it is.
 * 2. The daemon answers with its own nonce and its proof over both nonces. A client that cannot
 *    verify that proof is talking to something else and closes.
 * 3. The client sends `hello/finish` with its proof. The daemon accepts, or closes the connection.
 *
 * Every other request before step 3 closes the connection. The proofs are HMAC-SHA256 over a label
 * and both nonces, so one side's proof can never be replayed as the other's.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ClientKind } from './models';

export const HELLO_START = 'hello/start';
export const HELLO_FINISH = 'hello/finish';

export interface HelloStart {
	readonly clientNonce: string;
	/** Shown in the daemon's log and in `brick_busy` messages. */
	readonly clientName: string;
	readonly clientKind: ClientKind;
	/** The client's package version. */
	readonly version: string;
	readonly contractVersion: number;
}

export interface HelloChallenge {
	readonly daemonNonce: string;
	readonly daemonProof: string;
}

export interface HelloFinish {
	readonly clientProof: string;
}

export interface HelloAccepted {
	readonly version: string;
	readonly contractVersion: number;
	/** Unique to this daemon process. */
	readonly instanceId: string;
	readonly pid: number;
	/** The daemon is exiting or being replaced: wait, then connect again. */
	readonly state?: 'serving' | 'exiting' | 'handingOver';
	/** Transports this daemon loaded, for a client to notice a degraded one. */
	readonly transports: readonly string[];
}

/** A fresh nonce, hex. */
export function newNonce(): string {
	return randomBytes(32).toString('hex');
}

function proof(key: Buffer, label: 'daemon' | 'client', clientNonce: string, daemonNonce: string): string {
	return createHmac('sha256', key).update(`${label}\n${clientNonce}\n${daemonNonce}`).digest('hex');
}

export function daemonProof(key: Buffer, clientNonce: string, daemonNonce: string): string {
	return proof(key, 'daemon', clientNonce, daemonNonce);
}

export function clientProof(key: Buffer, clientNonce: string, daemonNonce: string): string {
	return proof(key, 'client', clientNonce, daemonNonce);
}

/** Compares two hex proofs in constant time. */
export function proofsMatch(expected: string, given: unknown): boolean {
	if (typeof given !== 'string' || given.length !== expected.length) { return false; }
	return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(given, 'utf8'));
}
