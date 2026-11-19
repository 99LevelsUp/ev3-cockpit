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
 * Since the second day of the visit (19.11.2026) the helper also pairs (`pair`), forgets a pairing
 * (`forget`), checks a paired brick is in range (`check`) and runs an inquiry (`inquire`), so the
 * cockpit pairs, forgets and follows presence on macOS as it does on Windows and Linux.
 */

import * as childProcess from 'child_process';
import * as fs from 'fs';
import { TransportAdapter, SendOptions, OpenOptions } from './transportAdapter';
import { BtDiscoveryDevice, UnpairResult } from './btTransportProvider';
import { formatMac } from './btSppDiscovery';
import { BT } from './transportConstants';
import { BackendUnavailableError, TransportError, TimeoutError } from '../errors/CockpitError';
import type { BtPairingEvent, HelperPairingResult, ScannedBrick } from './btPairingHelper';
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
	/**
	 * After the process has exited *and* its pipes are drained: `exit` can come while stdout still
	 * holds the last reply and stderr the reason it failed (review of the Mac visit).
	 */
	on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
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
	const run = options.run ?? runnerFor(options.helperPath, options.timeoutMs ?? 150_000);
	let running: Promise<BtDiscoveryDevice[]> | undefined;
	return () => {
		running ??= run(['list']).then(parsePairedList).finally(() => { running = undefined; });
		return running;
	};
}

/**
 * Runs one helper command and gives back its stdout, which is JSON for every command but `connect`.
 * A refusal comes with its own JSON and a non-zero exit, so stdout is taken whenever it is JSON.
 */
function runnerFor(helperPath: string, timeoutMs: number): (args: readonly string[]) => Promise<string> {
	let executableChecked = false;
	return (args) => new Promise<string>((resolve, reject) => {
		if (!executableChecked) { ensureExecutable(helperPath); executableChecked = true; }
		childProcess.execFile(helperPath, [...args], { timeout: timeoutMs }, (error, stdout, stderr) => {
			if (stdout.trim().startsWith('{')) { resolve(stdout); return; }
			const said = /error (.*)/.exec(String(stderr))?.[1];
			reject(new TransportError(`The Bluetooth helper failed: ${said ?? (error instanceof Error ? error.message : 'no answer')}`));
		});
	});
}

/** Options for {@link createMacPresence}. */
export interface MacPresenceOptions {
	helperPath: string;
	/** For tests: runs the helper and gives back its stdout. */
	run?: (args: readonly string[]) => Promise<string>;
}

/**
 * Presence on macOS, for `BtPresenceMonitor`: a check of one paired brick (a name request that
 * pages it, with no link and no pairing, as the L2CAP connect does on Linux) and an inquiry that
 * finds the bricks around, paired or not, with their names. A refused Bluetooth stops the monitor
 * with its reason, said once, rather than failing every round.
 */
export function createMacPresence(options: MacPresenceOptions): {
	check: (mac: string) => Promise<boolean>;
	inquire: () => Promise<ScannedBrick[]>;
} {
	// The inquiry window plus the name requests it makes afterwards, with room.
	const run = options.run ?? runnerFor(options.helperPath, (BT.PRESENCE_INQUIRY_SECONDS + 40) * 1000);
	const answer = (text: string): Record<string, unknown> => {
		const parsed = JSON.parse(text) as Record<string, unknown>;
		if (parsed.error === 'denied') { throw new BackendUnavailableError(MAC_BT_DENIED); }
		if (parsed.error) { throw new TransportError(`The Bluetooth helper failed: ${String(parsed.error)}`); }
		return parsed;
	};
	return {
		check: async (mac) => answer(await run(['check', bareOf(mac)])).answered === true,
		inquire: async () => {
			const started = Date.now();
			const devices = (answer(await run(['inquire', String(BT.PRESENCE_INQUIRY_SECONDS)])).devices ?? []) as
				Array<{ mac?: string; name?: string; paired?: boolean; rssi?: number }>;
			const atMs = Date.now() - started;
			return devices
				.filter((device) => typeof device.mac === 'string' && device.mac.length === 12 && device.mac.startsWith(LEGO_OUI))
				.map((device) => ({
					mac: formatMac(device.mac!),
					name: device.name ?? '',
					paired: device.paired === true,
					// IOBluetooth reports 127 when it has no reading.
					signal: typeof device.rssi === 'number' && device.rssi !== 127 ? device.rssi : null,
					atMs,
				}));
		},
	};
}

/** Options for {@link createMacPairing}. */
export interface MacPairingOptions {
	helperPath: string;
	/** For tests: starts the helper. */
	spawnHelper?: SpawnHelper;
}

/** What a user reads when a pairing ends with the helper's status. */
function pairingReason(status: string): string {
	if (status === 'Denied') { return MAC_BT_DENIED; }
	if (status === 'AuthenticationTimeout') { return 'The brick did not confirm the pairing in time. Accept it on the brick\'s screen and try again.'; }
	return `Pairing failed (${status}).`;
}

/**
 * Pairs through the helper's `pair`, for `BtClassicDiscovery`. The helper answers the PIN or the
 * numeric confirmation itself; the brick asks its user to accept on its screen. Each JSON line it
 * prints is a pairing event, the last one the result.
 */
export function createMacPairing(options: MacPairingOptions): (
	mac: string, onEvent?: (event: BtPairingEvent) => void, signal?: AbortSignal,
) => Promise<HelperPairingResult> {
	const spawnHelper = options.spawnHelper ?? spawnerFor(options.helperPath);
	return (mac, onEvent, signal) => new Promise<HelperPairingResult>((resolve) => {
		if (signal?.aborted) { resolve({ ok: false, reason: 'Pairing was cancelled.', status: 'Cancelled' }); return; }
		const helper = spawnHelper(['pair', bareOf(mac)]);
		let result: HelperPairingResult | undefined;
		let pending = '';
		let stderr = '';
		const onAbort = () => helper.kill('SIGTERM');
		signal?.addEventListener('abort', onAbort, { once: true });
		helper.stdin?.on('error', () => { /* the helper reads nothing; a closed pipe changes nothing */ });
		helper.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
		helper.stdout?.on('data', (chunk: Buffer) => {
			pending += chunk.toString('utf8');
			let newline: number;
			while ((newline = pending.indexOf('\n')) >= 0) {
				const line = pending.slice(0, newline).trim();
				pending = pending.slice(newline + 1);
				if (!line.startsWith('{')) { continue; }
				const event = JSON.parse(line) as BtPairingEvent;
				onEvent?.(event);
				if (event.type === 'result') {
					const { ok, status } = event as { ok?: unknown; status?: unknown };
					const said = String(status ?? '');
					result = ok === true ? { ok: true, status: said } : { ok: false, status: said, reason: pairingReason(said) };
				}
			}
		});
		const finish = (fallback: string) => {
			signal?.removeEventListener('abort', onAbort);
			if (signal?.aborted) { resolve({ ok: false, reason: 'Pairing was cancelled.', status: 'Cancelled' }); return; }
			resolve(result ?? { ok: false, reason: /error (.*)/.exec(stderr)?.[1] ?? fallback });
		};
		helper.on('error', (error) => finish(`The Bluetooth helper did not start: ${error.message}`));
		helper.on('close', (code) => finish(`The Bluetooth helper ended (${code}) without a result.`));
	});
}

/** Removes the Mac's pairing with a brick, through the helper's `forget`. */
export function createMacUnpair(options: { helperPath: string; run?: (args: readonly string[]) => Promise<void> }): (mac: string) => Promise<UnpairResult> {
	let executableChecked = false;
	const run = options.run ?? ((args: readonly string[]) => new Promise<void>((resolve, reject) => {
		if (!executableChecked) { ensureExecutable(options.helperPath); executableChecked = true; }
		childProcess.execFile(options.helperPath, [...args], { timeout: 30_000 }, (error, _stdout, stderr) => {
			if (!error) { resolve(); return; }
			const said = /error (.*)/.exec(String(stderr))?.[1];
			reject(new TransportError((error as { code?: unknown }).code === 3 ? MAC_BT_DENIED : (said ?? error.message)));
		});
	}));
	return async (mac) => {
		try {
			await run(['forget', bareOf(mac)]);
			return { ok: true };
		} catch (error) {
			return { ok: false, reason: error instanceof Error ? error.message : String(error) };
		}
	};
}

function bareOf(mac: string): string {
	return mac.replace(/[^0-9a-fA-F]/g, '').toLowerCase();
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

	/**
	 * The helper of the current link or of the open in progress. Every callback a helper registers
	 * checks that it is still this one: a helper being stopped, or one an earlier open gave up on,
	 * may end long after a newer link took its place, and must not close that link (review of the
	 * Mac visit).
	 */
	private helper?: Helper;
	private opening?: Promise<void>;
	private _isOpen = false;
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
		this.opening ??= this.openOnce(options?.signal).finally(() => { this.opening = undefined; });
		return this.opening;
	}

	private async openOnce(signal: AbortSignal | undefined): Promise<void> {
		if (signal?.aborted) { throw signal.reason ?? new TransportError('BT open aborted.'); }

		const helper = this.start();
		this.helper = helper;
		try {
			await new Promise<void>((resolve, reject) => {
				const settle = (error?: unknown) => {
					clearTimeout(timer);
					signal?.removeEventListener('abort', onAbort);
					helper.onOpen = undefined;
					helper.onOpenFailed = undefined;
					if (error === undefined) { resolve(); } else { reject(error); }
				};
				const timer = setTimeout(() => settle(new TimeoutError(
					`BT connect to ${this.mac} timed out after ${this.connectTimeoutMs} ms.`)), this.connectTimeoutMs);
				timer.unref?.();
				const onAbort = () => settle(signal?.reason ?? new TransportError('BT open aborted.'));
				signal?.addEventListener('abort', onAbort, { once: true });
				helper.onOpen = () => settle();
				helper.onOpenFailed = (error) => settle(error);
			});
		} catch (error) {
			if (this.helper === helper) { this.helper = undefined; }
			// Not awaited: the open reports its failure now; the helper leaves in the background.
			void this.stop(helper);
			throw error;
		}
		// A close while the channel was opening took the helper away: the open loses.
		if (this.helper !== helper) {
			void this.stop(helper);
			throw new TransportError(`BT connect to ${this.mac} was cancelled by a close.`);
		}
		// The helper said "open" and then failed or ended before this continuation ran: there is no
		// link to publish.
		if (helper.failure !== undefined || helper.ended) {
			this.helper = undefined;
			void this.stop(helper);
			throw helper.failure ?? new TransportError(`BT connect to ${this.mac} failed: the helper ended right after opening.`);
		}
		this.receiveBuffer = Buffer.alloc(0);
		this._isOpen = true;
	}

	/** Starts a helper and wires its pipes; what reaches this adapter is gated on it being current. */
	private start(): Helper {
		const process = this.spawnHelper(['connect', this.mac.replace(/[^0-9a-fA-F]/g, '').toLowerCase()]);
		let markClosed!: () => void;
		const helper: Helper = {
			process, status: '', ended: false,
			closed: new Promise<void>((resolve) => { markClosed = () => { helper.ended = true; resolve(); }; }),
		};

		// A write to a helper that has just gone fails with EPIPE, reported to the write's callback
		// *and* as an `error` event: unlistened, that event would take the extension host down.
		process.stdin?.on('error', (error: Error) => this.helperFailed(helper, new TransportError(`BT link to ${this.mac} failed: ${error.message}`, error)));
		process.on('error', (error) => {
			markClosed();
			this.helperFailed(helper, new TransportError(`The Bluetooth helper did not start: ${error.message}`, error));
		});
		process.stderr?.on('data', (chunk: Buffer) => {
			helper.status += chunk.toString('utf8');
			if (/^open \d+/m.test(helper.status)) { helper.onOpen?.(); }
		});
		process.stdout?.on('data', (data: Buffer) => {
			if (this.helper !== helper || !this._isOpen) { return; }
			this.receiveBuffer = Buffer.concat([this.receiveBuffer, data]);
			this.pendingReply = drainPendingReply(this.pendingReply, () => this.extractNextPacket());
		});
		// `close`, not `exit`: by now both pipes are drained, so the last reply has been delivered
		// and the helper's last status line, with the reason it failed, has been read.
		process.on('close', (code) => {
			markClosed();
			const reason = /error (.*)/.exec(helper.status)?.[1]
				?? (code === 3 ? MAC_BT_DENIED : `the helper ended (${code})`);
			this.helperFailed(helper, helper.onOpenFailed
				? new TransportError(`BT connect to ${this.mac} failed: ${reason}`)
				: new TransportError(`BT link to ${this.mac} closed: `
					+ (/^closed$/m.test(helper.status) ? 'by the brick or the radio' : reason)));
		});
		return helper;
	}

	async close(): Promise<void> {
		this._isOpen = false;
		this.pendingReply = rejectPendingReply(this.pendingReply, new TransportError('BT adapter closed while waiting for reply.'));
		this.receiveBuffer = Buffer.alloc(0);
		const helper = this.helper;
		this.helper = undefined;
		if (helper) { await this.stop(helper); }
	}

	async send(packet: Uint8Array, options?: SendOptions): Promise<Uint8Array> {
		const helper = this.helper;
		const stdin = helper?.process.stdin;
		if (!this._isOpen || !helper || !stdin) { throw new TransportError('BT adapter is not open.'); }
		if (this.pendingReply) { throw new TransportError('BT adapter already has in-flight send request.'); }
		if (options?.signal?.aborted) { throw new TransportError('BT send aborted before dispatch.'); }
		// Strictly request-reply: whatever is buffered now is a late fragment of an abandoned exchange.
		this.receiveBuffer = Buffer.alloc(0);
		return new Promise<Uint8Array>((resolve, reject) => {
			// What a late callback may touch: this exchange, on this helper, and nothing that replaced
			// either — a write error from a helper already closed must not fail a newer request.
			const exchange = createPendingReply({
				resolve,
				reject,
				fail: (error) => {
					if (this.pendingReply !== exchange) { return; }
					this.receiveBuffer = Buffer.alloc(0);
					this.pendingReply = rejectPendingReply(this.pendingReply, error);
				},
				timeoutMs: options?.timeoutMs ?? BT.SEND_TIMEOUT_MS,
				signal: options?.signal,
				expectedMessageCounter: options?.expectedMessageCounter,
				transport: 'BT',
			});
			this.pendingReply = exchange;
			stdin.write(Buffer.from(packet), (error?: Error | null) => {
				if (!error || this.helper !== helper || this.pendingReply !== exchange) { return; }
				this.pendingReply = rejectPendingReply(this.pendingReply, error);
			});
		});
	}

	private extractNextPacket(): Uint8Array | undefined {
		const result = extractLengthPrefixedPacket(this.receiveBuffer);
		if (!result) { return undefined; }
		this.receiveBuffer = result.remaining;
		return result.packet;
	}

	/**
	 * Every way a helper fails comes here — it ended, it never started, a pipe broke — and leaves
	 * the same marks whatever stage it is in (review of the Mac visit, after three rounds found a
	 * race between the separate paths each time): the helper is marked failed, so an open that is
	 * about to publish it does not; it is stopped, since a broken pipe does not end the process and
	 * nothing would once it is unreferenced; an open waiting on it is rejected; and if it carries the
	 * current link, that link ends. A helper that is no longer current changes nothing else.
	 */
	private helperFailed(helper: Helper, error: unknown): void {
		helper.failure ??= error;
		if (!helper.ended) { void this.stop(helper); }
		if (helper.onOpenFailed) { helper.onOpenFailed(error); return; }
		if (this.helper !== helper || !this._isOpen) { return; }
		this._isOpen = false;
		this.helper = undefined;
		this.pendingReply = rejectPendingReply(this.pendingReply, error);
	}

	/**
	 * Ends a helper: EOF on its stdin, so it closes the channel itself and frees the brick at once;
	 * killed if it has not gone after the grace. Resolves when it has.
	 */
	private stop(helper: Helper): Promise<void> {
		try { helper.process.stdin?.end(); } catch { /* already gone */ }
		const timer = setTimeout(() => helper.process.kill('SIGKILL'), HELPER_EXIT_GRACE_MS);
		timer.unref?.();
		return helper.closed.then(() => clearTimeout(timer));
	}
}

/** One started helper: its process, what it has said on stderr, and the open waiting on it. */
interface Helper {
	readonly process: HelperProcess;
	status: string;
	/** Set the moment the process is known to be gone, before anything awaits. */
	ended: boolean;
	/** The first way it failed, once it has; an open that sees it does not publish the link. */
	failure?: unknown;
	/** Resolves once the process has ended and its pipes are drained (or it never started). */
	readonly closed: Promise<void>;
	onOpen?: () => void;
	onOpenFailed?: (error: unknown) => void;
}
