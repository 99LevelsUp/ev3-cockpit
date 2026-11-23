/**
 * The proofs of the hello: each side shows it holds the user's key with an HMAC over both nonces,
 * labelled by who proves. `docs/channel.md` is the written rule; the daemon computes the same.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

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
