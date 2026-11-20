/**
 * The daemon's side of the handshake: until a client has proved it holds the user's key, the
 * daemon answers nothing but the first step of the handshake, and any other request, a wrong proof
 * or silence for too long closes the connection.
 */

import type { Endpoint } from '../client/connection';
import {
	HELLO_FINISH, HELLO_START, HelloAccepted, HelloChallenge, HelloStart, clientProof, daemonProof, newNonce,
	proofsMatch,
} from '../contract/hello';
import { CLIENT_KINDS, type ClientKind } from '../contract/models';

/** How long a client has to finish the handshake. */
export const HELLO_TIMEOUT_MS = 10_000;

export interface ClientIdentity {
	readonly name: string;
	readonly kind: ClientKind;
	readonly version: string;
	readonly contractVersion: number;
}

export interface HelloOptions {
	readonly key: Buffer;
	/** What the daemon tells an accepted client about itself; read at acceptance. */
	accepted(): HelloAccepted;
	readonly timeoutMs?: number;
}

function isHelloStart(value: unknown): value is HelloStart {
	const v = value as Partial<HelloStart> | undefined;
	return typeof v?.clientNonce === 'string' && v.clientNonce.length >= 32
		&& typeof v.clientName === 'string' && v.clientName.length > 0 && v.clientName.length <= 200
		&& (CLIENT_KINDS as readonly string[]).includes(v.clientKind as ClientKind)
		&& typeof v.version === 'string' && typeof v.contractVersion === 'number';
}

/**
 * Runs the handshake on a new connection. Resolves with the client once it has proved itself;
 * rejects, having closed the connection, otherwise. Register the daemon's own handlers only after
 * it resolves.
 */
export function acceptHello(endpoint: Endpoint, options: HelloOptions): Promise<ClientIdentity> {
	return new Promise((resolve, reject) => {
		let start: HelloStart | undefined;
		let daemonNonce: string | undefined;
		let done = false;
		const fail = (why: string): never => {
			if (!done) {
				done = true;
				clearTimeout(timer);
				endpoint.close();
				reject(new Error(why));
			}
			throw new Error(why);
		};
		const timer = setTimeout(() => {
			try { fail('the client did not finish the handshake in time'); } catch { /* rejected */ }
		}, options.timeoutMs ?? HELLO_TIMEOUT_MS);
		timer.unref?.();
		endpoint.onClose(() => {
			if (!done) { done = true; clearTimeout(timer); reject(new Error('the client left during the handshake')); }
		});

		endpoint.onRequest(HELLO_START, (params): HelloChallenge => {
			if (done || start) { return fail('the handshake was started twice'); }
			if (!isHelloStart(params)) { return fail('the handshake was malformed'); }
			start = params;
			daemonNonce = newNonce();
			return { daemonNonce, daemonProof: daemonProof(options.key, params.clientNonce, daemonNonce) };
		});
		endpoint.onRequest(HELLO_FINISH, (params): HelloAccepted => {
			if (done || !start || !daemonNonce) { return fail('the handshake was finished before it started'); }
			const expected = clientProof(options.key, start.clientNonce, daemonNonce);
			if (!proofsMatch(expected, (params as { clientProof?: unknown } | undefined)?.clientProof)) {
				return fail('the client could not prove it holds the key');
			}
			done = true;
			clearTimeout(timer);
			const identity: ClientIdentity = {
				name: start.clientName, kind: start.clientKind, version: start.version, contractVersion: start.contractVersion,
			};
			queueMicrotask(() => resolve(identity));
			return options.accepted();
		});
		endpoint.onAnyRequest((method) => {
			if (!done) { return fail(`${method} came before the handshake finished`); }
			throw Object.assign(new Error(`The daemon has no method ${method}.`), { code: 'invalid_request' });
		});
	});
}
