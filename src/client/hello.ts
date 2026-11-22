/**
 * The client's side of the handshake: it sends its nonce, checks the daemon's proof before it says
 * anything more, and only then proves itself. A daemon that cannot prove it holds the user's key is
 * someone else's pipe; the client closes the connection and tells nothing.
 *
 * `performHello` speaks to the Node daemon; `connectNativeDaemon` finds the native daemon, reads
 * the key it created and runs the same proofs with the generated contract's hello messages.
 */

import { CONTRACT_VERSION } from '../contract/version';
import { WireErrorCode } from '../contract/errors';
import {
	HELLO_FINISH, HELLO_START, HelloAccepted, HelloChallenge, clientProof, daemonProof, newNonce, proofsMatch,
} from '../contract/hello';
import type { ClientKind } from '../contract/models';
import {
	CONTRACT_VERSION as NATIVE_CONTRACT_VERSION, HELLO_FINISH as NATIVE_HELLO_FINISH, HELLO_START as NATIVE_HELLO_START,
	readBuildKind, readDaemonMode,
} from '../contract/generated';
import type {
	BuildKind, ChannelRecord, DaemonMode, HelloAccepted as NativeHelloAccepted, HelloChallenge as NativeHelloChallenge,
	HelloFinish as NativeHelloFinish, HelloStart as NativeHelloStart,
} from '../contract/generated';
import * as fs from 'node:fs';
import { NativeChannelHost, openNativeChannel, systemChannelHost } from './channel';
import { ContractError, Endpoint, createEndpoint } from './connection';
import type { NativeChannelFiles } from './locate';

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

/** The native key is exactly this long. */
export const NATIVE_KEY_BYTES = 32;
/** How often a short or missing key is read before it counts as unreadable. */
export const KEY_READ_ATTEMPTS = 5;
const KEY_RETRY_MS = 20;

/** A key that stayed short, missing or unreadable. Only the daemon creates the key; a client never touches it. */
export class KeyUnreadableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'KeyUnreadableError';
	}
}

/** What reading the key needs; replaceable in tests. */
export interface KeyReadHost {
	readFile(file: string): Buffer;
	sleep(ms: number): Promise<void>;
}

const systemKeyReadHost: KeyReadHost = {
	readFile: (file) => fs.readFileSync(file),
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Reads the per-user key the native daemon created. The daemon writes it through a temporary file
 * and a link, so a short or missing read is momentary: it is read again a few times, then reported
 * as unreadable.
 */
export async function readNativeKey(file: string, host: KeyReadHost = systemKeyReadHost): Promise<Buffer> {
	let problem = '';
	for (let attempt = 1; attempt <= KEY_READ_ATTEMPTS; attempt++) {
		try {
			const key = host.readFile(file);
			if (key.length === NATIVE_KEY_BYTES) { return key; }
			problem = `it has ${key.length} bytes instead of ${NATIVE_KEY_BYTES}`;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== 'ENOENT') {
				throw new KeyUnreadableError(`The cockpit key ${file} could not be read (${code ?? String(error)}).`);
			}
			problem = 'it is not there';
		}
		if (attempt < KEY_READ_ATTEMPTS) { await host.sleep(KEY_RETRY_MS); }
	}
	throw new KeyUnreadableError(`The cockpit key ${file} could not be read: ${problem}.`);
}

/** Who a client is in the native daemon's hello. */
export interface NativeClientIdentity {
	/** Where the client runs, as people read it in the daemon's log and in its messages. */
	readonly name: string;
	/** One of ClientKind, carried as a plain string. */
	readonly kind: string;
	/** The client's package version. */
	readonly version: string;
	/** One of BuildKind. */
	readonly buildKind: string;
}

/** Who the native daemon is, once it has proved it holds the key. */
export interface DaemonIdentity {
	readonly version: string;
	readonly contractVersion: number;
	readonly buildKind: BuildKind;
	/** SHA-256 of the daemon's executable, lowercase hex. */
	readonly buildId: string;
	readonly mode: DaemonMode;
	readonly pid: number;
	readonly instanceId: string;
	readonly state?: string;
	readonly transports?: readonly string[];
}

/**
 * The hello with the native daemon. The daemon's proof is checked before anything it says is
 * trusted, and before the client proves itself; a daemon on another contract version stops the
 * client instead of misbehaving.
 */
export async function performNativeHello(
	endpoint: Endpoint, key: Buffer, client: NativeClientIdentity, options: { readonly acceptOtherContract?: boolean } = {},
): Promise<DaemonIdentity> {
	const clientNonce = newNonce();
	const start: NativeHelloStart = {
		clientNonce, clientName: client.name, clientKind: client.kind, version: client.version,
		contractVersion: NATIVE_CONTRACT_VERSION, buildKind: client.buildKind,
	};
	const challenge = await endpoint.request<Partial<NativeHelloChallenge> | null>(NATIVE_HELLO_START, start);
	const daemonNonce = challenge?.daemonNonce;
	if (typeof daemonNonce !== 'string' || !proofsMatch(daemonProof(key, clientNonce, daemonNonce), challenge?.daemonProof)) {
		endpoint.close();
		throw new ContractError(WireErrorCode.DaemonUnavailable,
			'The process on the cockpit channel could not prove it is your cockpit daemon; nothing was sent to it.');
	}
	const finish: NativeHelloFinish = { clientProof: clientProof(key, clientNonce, daemonNonce) };
	const accepted = await endpoint.request<NativeHelloAccepted>(NATIVE_HELLO_FINISH, finish);
	if (typeof accepted?.contractVersion !== 'number' || typeof accepted.version !== 'string') {
		endpoint.close();
		throw new ContractError(WireErrorCode.DaemonUnavailable, 'The cockpit daemon did not say which version it is; the connection was closed.');
	}
	// A daemon on another contract still serves daemon/exit; the launch decides whether to ask it.
	if (accepted.contractVersion !== NATIVE_CONTRACT_VERSION && !options.acceptOtherContract) {
		endpoint.close();
		throw new ContractError(WireErrorCode.DaemonUnavailable,
			`The running cockpit daemon speaks contract ${String(accepted?.contractVersion)} and this client contract ${NATIVE_CONTRACT_VERSION}; update the older of the two.`);
	}
	return {
		version: accepted.version,
		contractVersion: accepted.contractVersion,
		buildKind: readBuildKind(accepted.buildKind),
		buildId: accepted.buildId,
		mode: readDaemonMode(accepted.mode),
		pid: accepted.pid,
		instanceId: accepted.instanceId,
		...(accepted.state !== undefined ? { state: accepted.state } : {}),
		...(accepted.transports !== undefined ? { transports: accepted.transports } : {}),
	};
}

/** How long finding, opening and the hello may take before the client gives up. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

export interface NativeConnectOptions {
	readonly files: NativeChannelFiles;
	readonly client: NativeClientIdentity;
	readonly host?: NativeChannelHost;
	readonly keyHost?: KeyReadHost;
	readonly timeoutMs?: number;
	/** Return a daemon on another contract version instead of refusing it, for the launch to decide. */
	readonly acceptOtherContract?: boolean;
}

export type NativeConnection =
	| { readonly kind: 'none' }
	| { readonly kind: 'connected'; readonly endpoint: Endpoint; readonly daemon: DaemonIdentity; readonly record: ChannelRecord };

/**
 * Finds the native daemon, opens its channel and finishes the hello; or reports that no daemon
 * runs. Starting one is the caller's business. A daemon that does not finish the hello in time is
 * given up on and its connection closed, so a stuck daemon cannot hang the client.
 */
export async function connectNativeDaemon(options: NativeConnectOptions): Promise<NativeConnection> {
	const host = options.host ?? systemChannelHost();
	const timeoutMs = options.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
	let timedOut = false;
	let endpoint: Endpoint | undefined;
	let stream: { destroy(): void } | undefined;
	let timer: NodeJS.Timeout | undefined;
	const deadline = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			timedOut = true;
			endpoint?.close();
			stream?.destroy();
			reject(new ContractError(WireErrorCode.DaemonUnavailable,
				`The cockpit daemon did not finish the hello within ${timeoutMs} ms; the connection was closed.`));
		}, timeoutMs);
	});
	const attempt = async (): Promise<NativeConnection> => {
		const channel = await openNativeChannel(options.files, host);
		if (channel.kind === 'none') { return channel; }
		stream = channel.stream;
		if (timedOut) { channel.stream.destroy(); return { kind: 'none' }; }
		let key: Buffer;
		try {
			key = await readNativeKey(options.files.keyFile, options.keyHost);
		} catch (error) {
			channel.stream.destroy();
			throw error;
		}
		endpoint = createEndpoint(channel.stream);
		const daemon = await performNativeHello(endpoint, key, options.client,
			options.acceptOtherContract ? { acceptOtherContract: true } : {});
		return { kind: 'connected', endpoint, daemon, record: channel.record };
	};
	try {
		return await Promise.race([attempt(), deadline]);
	} catch (error) {
		endpoint?.close();
		stream?.destroy();
		throw error;
	} finally {
		clearTimeout(timer);
	}
}