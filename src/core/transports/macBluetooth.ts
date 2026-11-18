/**
 * Bluetooth on macOS, through the cockpit's IOBluetooth helper (`native/macos/ev3-bt-helper.swift`).
 *
 * Measured on the Mac visit (M4, macOS 27, 18.11.2026): a paired brick gets a serial port, but
 * opening it never brings up the RFCOMM link, so the serial-port backend reaches nothing. IOBluetooth
 * opens the channel, and Node has no binding to it, so a small helper does: `list` prints the paired
 * devices with their names, `connect <mac>` carries raw bytes between its stdin/stdout and the brick.
 *
 * Bluetooth on macOS needs the user's consent, which the system asks for in the name of the app that
 * started the helper (VS Code). Until it is given the helper says so (`denied`) instead of listing
 * nothing, so the cockpit can tell the user where to allow it.
 *
 * Pairing stays in the system settings for now; this module neither pairs nor unpairs.
 */

import * as childProcess from 'child_process';
import * as fs from 'fs';
import { TransportAdapter, SendOptions, OpenOptions } from './transportAdapter';
import { BtDiscoveryDevice } from './btTransportProvider';
import { formatMac } from './btSppDiscovery';
import { BT } from './transportConstants';
import { TransportError, TimeoutError } from '../errors/CockpitError';
import {
	PendingReply, drainPendingReply, rejectPendingReply, extractLengthPrefixedPacket, createPendingReply,
} from './pendingReply';

/** Where the helper lives in the extension's folder. */
export const MAC_BT_HELPER_PATH = 'native/bin/ev3-bt-helper';

/** What a user who refused Bluetooth reads, and where to change it. */
export const MAC_BT_DENIED = 'Bluetooth access is not allowed for VS Code. Allow it in System Settings → '
	+ 'Privacy & Security → Bluetooth, then reload the window.';

const LEGO_OUI = BT.LEGO_OUI.replace(/[:-]/g, '').toLowerCase();

/** The part of a child process the helper's users need; a fake one stands in for it in tests. */
export interface HelperProcess {
	readonly stdin: NodeJS.WritableStream | null;
	readonly stdout: NodeJS.ReadableStream | null;
	readonly stderr: NodeJS.ReadableStream | null;
	kill(signal?: NodeJS.Signals): boolean;
	on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
	on(event: 'error', listener: (error: Error) => void): this;
}

export type SpawnHelper = (args: readonly string[]) => HelperProcess;

/**
 * A VSIX is a zip, and VS Code unpacks it without the executable bit; the extension's folder is the
 * user's, so the bit can be set back before the first start.
 */
export function ensureExecutable(file: string): void {
	try {
		const { mode } = fs.statSync(file);
		if ((mode & 0o111) === 0) { fs.chmodSync(file, mode | 0o755); }
	} catch {
		// A missing helper fails at spawn, with its own message.
	}
}

function spawnerFor(helperPath: string): SpawnHelper {
	let checked = false;
	return (args) => {
		if (!checked) { ensureExecutable(helperPath); checked = true; }
		return childProcess.spawn(helperPath, [...args], { stdio: ['pipe', 'pipe', 'pipe'] });
	};
}

/** The helper's `list` answer, as the provider's discovery wants it: paired EV3s only. */
export function parsePairedList(text: string): BtDiscoveryDevice[] {
	const answer = JSON.parse(text) as { devices?: Array<{ mac?: string; name?: string; connected?: boolean }>; error?: string };
	if (answer.error === 'denied') { throw new TransportError(MAC_BT_DENIED); }
	if (answer.error) { throw new TransportError(`The Bluetooth helper failed: ${answer.error}`); }
	return (answer.devices ?? [])
		.filter((device) => typeof device.mac === 'string' && device.mac.length === 12 && device.mac.startsWith(LEGO_OUI))
		.map((device) => ({
			mac: formatMac(device.mac!),
			name: device.name ?? '',
			connected: device.connected === true,
			remembered: true,
			authenticated: true,
		}));
}

/** Options for {@link createMacPairedScan}. */
export interface MacPairedScanOptions {
	helperPath: string;
	/** For tests: runs the helper and gives back its stdout. */
	run?: (args: readonly string[]) => Promise<string>;
	/** How long a `list` may take; the first one waits for the user's answer to the consent prompt. */
	timeoutMs?: number;
}

/**
 * The paired bricks, asked of the helper. One `list` at a time: discovery scans every few seconds,
 * and the first `list` can wait minutes for the user to answer the consent prompt, so a scan that
 * comes meanwhile shares the running one rather than starting another.
 */
export function createMacPairedScan(options: MacPairedScanOptions): () => Promise<BtDiscoveryDevice[]> {
	const timeoutMs = options.timeoutMs ?? 150_000;
	let executableChecked = false;
	const run = options.run ?? ((args: readonly string[]) => new Promise<string>((resolve, reject) => {
		if (!executableChecked) { ensureExecutable(options.helperPath); executableChecked = true; }
		childProcess.execFile(options.helperPath, [...args], { timeout: timeoutMs }, (error, stdout) => {
			// `denied` comes with exit code 3 and its own JSON; the parse below says what it means.
			if (stdout.trim().startsWith('{')) { resolve(stdout); return; }
			reject(new TransportError(`The Bluetooth helper failed: ${error instanceof Error ? error.message : 'no answer'}`));
		});
	}));
	let running: Promise<BtDiscoveryDevice[]> | undefined;
	return () => {
		running ??= run(['list']).then(parsePairedList).finally(() => { running = undefined; });
		return running;
	};
}

/** Options for {@link BtMacAdapter}. */
export interface BtMacAdapterOptions {
	mac: string;
	helperPath: string;
	/** Deadline for the channel to open (default `BT.CONNECT_TIMEOUT_MS`). */
	connectTimeoutMs?: number;
	/** For tests: starts the helper. */
	spawnHelper?: SpawnHelper;
}

/** Grace for the helper to close the channel and leave after its stdin ends (ms). */
const HELPER_EXIT_GRACE_MS = 1500;

/**
 * An RFCOMM link to one brick, through the helper's `connect`. The helper's stdout is the brick's
 * byte stream; replies are framed by their length prefix, as on the other Bluetooth backends.
 */
export class BtMacAdapter implements TransportAdapter {
	private readonly mac: string;
	private readonly connectTimeoutMs: number;
	private readonly spawnHelper: SpawnHelper;

	private helper?: HelperProcess;
	private _isOpen = false;
	private closing = false;
	private receiveBuffer: Buffer = Buffer.alloc(0);
	private pendingReply?: PendingReply;

	constructor(options: BtMacAdapterOptions) {
		this.mac = options.mac;
		this.connectTimeoutMs = options.connectTimeoutMs ?? BT.CONNECT_TIMEOUT_MS;
		this.spawnHelper = options.spawnHelper ?? spawnerFor(options.helperPath);
	}

	get isOpen(): boolean { return this._isOpen; }

	/** One attempt, as on the other backends: pacing belongs to the connection queue. */
	async open(options?: OpenOptions): Promise<void> {
		if (this._isOpen) { return; }
		const signal = options?.signal;
		if (signal?.aborted) { throw signal.reason ?? new TransportError('BT open aborted.'); }

		const helper = this.spawnHelper(['connect', this.mac.replace(/[^0-9a-fA-F]/g, '').toLowerCase()]);
		this.helper = helper;
		let statusText = '';
		await new Promise<void>((resolve, reject) => {
			let settled = false;
			const settle = (error?: unknown) => {
				if (settled) { return; }
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener('abort', onAbort);
				if (error === undefined) { resolve(); } else { reject(error); }
			};
			const timer = setTimeout(() => settle(new TimeoutError(
				`BT connect to ${this.mac} timed out after ${this.connectTimeoutMs} ms.`)), this.connectTimeoutMs);
			timer.unref?.();
			const onAbort = () => settle(signal?.reason ?? new TransportError('BT open aborted.'));
			signal?.addEventListener('abort', onAbort, { once: true });
			helper.on('error', (error) => settle(new TransportError(`The Bluetooth helper did not start: ${error.message}`, error)));
			helper.on('exit', (code) => {
				const reason = /error (.*)/.exec(statusText)?.[1]
					?? (code === 3 ? MAC_BT_DENIED : `the helper ended (${code})`);
				if (!settled) { settle(new TransportError(`BT connect to ${this.mac} failed: ${reason}`)); return; }
				this.handleFailure(new TransportError(`BT link to ${this.mac} closed: ${/closed/.test(statusText) ? 'by the brick or the radio' : reason}`));
			});
			helper.stderr?.on('data', (chunk: Buffer) => {
				statusText += chunk.toString('utf8');
				if (/^open \d+/m.test(statusText)) { settle(); }
			});
		}).catch((error: unknown) => {
			this.stopHelper(helper);
			this.helper = undefined;
			throw error;
		});

		this.receiveBuffer = Buffer.alloc(0);
		this._isOpen = true;
		helper.stdout?.on('data', (data: Buffer) => {
			this.receiveBuffer = Buffer.concat([this.receiveBuffer, data]);
			this.pendingReply = drainPendingReply(this.pendingReply, () => this.extractNextPacket());
		});
	}

	async close(): Promise<void> {
		this._isOpen = false;
		this.closing = true;
		this.pendingReply = rejectPendingReply(this.pendingReply, new TransportError('BT adapter closed while waiting for reply.'));
		this.receiveBuffer = Buffer.alloc(0);
		const helper = this.helper;
		this.helper = undefined;
		if (helper) {
			await new Promise<void>((resolve) => {
				const timer = setTimeout(() => { helper.kill('SIGKILL'); resolve(); }, HELPER_EXIT_GRACE_MS);
				timer.unref?.();
				helper.on('exit', () => { clearTimeout(timer); resolve(); });
				// EOF on its stdin: the helper closes the channel itself, which frees the brick at once.
				helper.stdin?.end();
			});
		}
		this.closing = false;
	}

	async send(packet: Uint8Array, options?: SendOptions): Promise<Uint8Array> {
		const stdin = this.helper?.stdin;
		if (!this._isOpen || !stdin) { throw new TransportError('BT adapter is not open.'); }
		if (this.pendingReply) { throw new TransportError('BT adapter already has in-flight send request.'); }
		if (options?.signal?.aborted) { throw new TransportError('BT send aborted before dispatch.'); }
		// Strictly request-reply: whatever is buffered now is a late fragment of an abandoned exchange.
		this.receiveBuffer = Buffer.alloc(0);
		return new Promise<Uint8Array>((resolve, reject) => {
			this.pendingReply = createPendingReply({
				resolve,
				reject,
				fail: (error) => {
					this.receiveBuffer = Buffer.alloc(0);
					this.pendingReply = rejectPendingReply(this.pendingReply, error);
				},
				timeoutMs: options?.timeoutMs ?? BT.SEND_TIMEOUT_MS,
				signal: options?.signal,
				expectedMessageCounter: options?.expectedMessageCounter,
				transport: 'BT',
			});
			stdin.write(Buffer.from(packet), (error?: Error | null) => {
				if (error) { this.pendingReply = rejectPendingReply(this.pendingReply, error); }
			});
		});
	}

	private extractNextPacket(): Uint8Array | undefined {
		const result = extractLengthPrefixedPacket(this.receiveBuffer);
		if (!result) { return undefined; }
		this.receiveBuffer = result.remaining;
		return result.packet;
	}

	private handleFailure(error: unknown): void {
		if (this.closing) { return; }
		this._isOpen = false;
		this.helper = undefined;
		this.pendingReply = rejectPendingReply(this.pendingReply, error);
	}

	private stopHelper(helper: HelperProcess): void {
		try { helper.stdin?.end(); } catch { /* already gone */ }
		const timer = setTimeout(() => helper.kill('SIGKILL'), HELPER_EXIT_GRACE_MS);
		timer.unref?.();
		helper.on('exit', () => clearTimeout(timer));
	}
}
