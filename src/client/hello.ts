/**
 * The client's side of the handshake: it sends its nonce, checks the daemon's proof before it says
 * anything more, and only then proves itself. A daemon that cannot prove it holds the user's key is
 * someone else's pipe; the client closes the connection and tells nothing.
 */

import { CONTRACT_VERSION } from '../contract/version';
import { WireErrorCode } from '../contract/errors';
import {
	HELLO_FINISH, HELLO_START, HelloAccepted, HelloChallenge, clientProof, daemonProof, newNonce, proofsMatch,
} from '../contract/hello';
import type { ClientKind } from '../contract/models';
import { ContractError, Endpoint } from './connection';

export interface ClientIdentity {
	readonly name: string;
	readonly kind: ClientKind;
	readonly version: string;
}

export async function performHello(endpoint: Endpoint, key: Buffer, client: ClientIdentity): Promise<HelloAccepted> {
	const clientNonce = newNonce();
	const challenge = await endpoint.request<HelloChallenge>(HELLO_START, {
		clientNonce, clientName: client.name, clientKind: client.kind, version: client.version,
		contractVersion: CONTRACT_VERSION,
	});
	const expected = daemonProof(key, clientNonce, challenge?.daemonNonce ?? '');
	if (typeof challenge?.daemonNonce !== 'string' || !proofsMatch(expected, challenge.daemonProof)) {
		endpoint.close();
		throw new ContractError(WireErrorCode.DaemonUnavailable,
			'The process on the cockpit channel could not prove it is your cockpit daemon; nothing was sent to it.');
	}
	return endpoint.request<HelloAccepted>(HELLO_FINISH, {
		clientProof: clientProof(key, clientNonce, challenge.daemonNonce),
	});
}
