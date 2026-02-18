/**
 * BluetoothAutoPortAdapter — wraps COM port discovery and ranked probing.
 *
 * On `open()`, enumerates COM ports via `listSerialCandidates()`, ranks
 * them with `buildBluetoothPortPlans()`, and tries each in order until
 * an EV3 brick responds to a probe command. After `open()` succeeds,
 * `send()` and `close()` delegate to the connected inner adapter.
 */

import { listSerialCandidates } from './discovery';
import { buildBluetoothPortPlans } from './bluetoothPortSelection';
import { BluetoothSppAdapter, type BluetoothSppAdapterOptions } from './bluetoothSppAdapter';
import { isTransientBluetoothError } from './bluetoothFailure';
import type { TransportAdapter, TransportRequestOptions } from './transportAdapter';

/** Configuration for automatic BT port discovery and connection. */
export interface BluetoothAutoPortOptions {
	/** Maximum attempts per COM port before moving to next. */
	portAttempts?: number;
	/** Delay (ms) between retries on transient errors. */
	retryDelayMs?: number;
	/** Post-open delay for firmware settling (passed to BluetoothSppAdapter). */
	postOpenDelayMs?: number;
	/** Probe timeout (ms). */
	probeTimeoutMs?: number;
	/** Number of rediscovery passes after initial COM enumeration fails. */
	rediscoveryAttempts?: number;
	/** Delay (ms) between rediscovery passes. */
	rediscoveryDelayMs?: number;
	/** Known brick serial number for exact-match ranking. */
	targetSerialNumber?: string;
	/** DTR profiles to try in order. */
	dtrProfiles?: boolean[];

	// ── test injection ──
	/** @internal Override COM port enumeration. */
	_listPorts?: () => Promise<Array<{ path: string; pnpId?: string; serialNumber?: string; manufacturer?: string; friendlyName?: string }>>;
	/** @internal Override adapter factory. */
	_createAdapter?: (opts: BluetoothSppAdapterOptions) => TransportAdapter;
	/** @internal Override EV3 probe. Returns true if the adapter talks EV3. */
	_probeEv3?: (adapter: TransportAdapter, timeoutMs: number) => Promise<boolean>;
}

const DEFAULT_PORT_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 300;
const DEFAULT_POST_OPEN_DELAY_MS = 120;
const DEFAULT_PROBE_TIMEOUT_MS = 5000;
const DEFAULT_REDISCOVERY_ATTEMPTS = 1;
const DEFAULT_REDISCOVERY_DELAY_MS = 700;
const DEFAULT_DTR_PROFILES: boolean[] = [false, true];

export class BluetoothAutoPortAdapter implements TransportAdapter {
	private inner?: TransportAdapter;
	private opened = false;
	private readonly opts: Required<
		Pick<BluetoothAutoPortOptions,
			| 'portAttempts'
			| 'retryDelayMs'
			| 'postOpenDelayMs'
			| 'probeTimeoutMs'
			| 'rediscoveryAttempts'
			| 'rediscoveryDelayMs'
			| 'dtrProfiles'
		>
	> & Pick<BluetoothAutoPortOptions, 'targetSerialNumber' | '_listPorts' | '_createAdapter' | '_probeEv3'>;

	/** The COM port path that was successfully connected (set after open). */
	public connectedPort?: string;

	constructor(options: BluetoothAutoPortOptions = {}) {
		this.opts = {
			portAttempts: options.portAttempts ?? DEFAULT_PORT_ATTEMPTS,
			retryDelayMs: options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
			postOpenDelayMs: options.postOpenDelayMs ?? DEFAULT_POST_OPEN_DELAY_MS,
			probeTimeoutMs: options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
			rediscoveryAttempts: options.rediscoveryAttempts ?? DEFAULT_REDISCOVERY_ATTEMPTS,
			rediscoveryDelayMs: options.rediscoveryDelayMs ?? DEFAULT_REDISCOVERY_DELAY_MS,
			dtrProfiles: options.dtrProfiles ?? DEFAULT_DTR_PROFILES,
			targetSerialNumber: options.targetSerialNumber,
			_listPorts: options._listPorts,
			_createAdapter: options._createAdapter,
			_probeEv3: options._probeEv3,
		};
	}

	public async open(): Promise<void> {
		if (this.opened && this.inner) {
			return;
		}

		const listPorts = this.opts._listPorts ?? listSerialCandidates;
		const errors: string[] = [];

		for (const dtr of this.opts.dtrProfiles) {
			const totalPasses = 1 + this.opts.rediscoveryAttempts;
			for (let pass = 0; pass < totalPasses; pass++) {
				if (pass > 0) {
					await sleep(this.opts.rediscoveryDelayMs);
				}

				const candidates = await listPorts();
				const plans = buildBluetoothPortPlans(candidates, this.opts.targetSerialNumber);

				if (plans.length === 0) {
					errors.push(`No BT COM ports found (pass ${pass + 1}, dtr=${dtr})`);
					continue;
				}

				for (const plan of plans) {
					const result = await this.tryPort(plan.path, dtr, errors);
					if (result) {
						this.inner = result;
						this.opened = true;
						this.connectedPort = plan.path;
						return;
					}
				}
			}
		}

		throw new Error(
			`BT auto-port: no EV3 found on any COM port. Tried: ${errors.join('; ')}`
		);
	}

	public async close(): Promise<void> {
		this.opened = false;
		const adapter = this.inner;
		this.inner = undefined;
		this.connectedPort = undefined;
		if (adapter) {
			await adapter.close();
		}
	}

	public async send(packet: Uint8Array, options: TransportRequestOptions): Promise<Uint8Array> {
		if (!this.inner || !this.opened) {
			throw new Error('BT auto-port adapter is not open.');
		}
		return this.inner.send(packet, options);
	}

	// ── internal ──

	private async tryPort(
		portPath: string,
		dtr: boolean,
		errors: string[]
	): Promise<TransportAdapter | undefined> {
		const createAdapter = this.opts._createAdapter ??
			((opts: BluetoothSppAdapterOptions) => new BluetoothSppAdapter(opts));
		const probeEv3 = this.opts._probeEv3 ?? defaultProbeEv3;

		for (let attempt = 1; attempt <= this.opts.portAttempts; attempt++) {
			const adapter = createAdapter({
				portPath,
				dtr,
				postOpenDelayMs: this.opts.postOpenDelayMs,
			});

			try {
				await adapter.open();
				const ok = await probeEv3(adapter, this.opts.probeTimeoutMs);
				if (ok) {
					return adapter;
				}
				await adapter.close();
				errors.push(`${portPath} probe negative (attempt ${attempt})`);
				return undefined; // probe negative is not transient — skip port
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				errors.push(`${portPath} attempt ${attempt}: ${msg}`);
				try { await adapter.close(); } catch { /* ignore close error */ }

				if (!isTransientBluetoothError(msg)) {
					return undefined; // permanent error — skip port
				}

				if (attempt < this.opts.portAttempts) {
					await sleep(this.opts.retryDelayMs);
				}
			}
		}

		return undefined; // all attempts exhausted
	}
}

/**
 * Default EV3 probe: sends a battery level request and checks for a valid reply.
 * Used when no `_probeEv3` override is injected.
 */
async function defaultProbeEv3(adapter: TransportAdapter, timeoutMs: number): Promise<boolean> {
	try {
		const { encodeEv3Packet, decodeEv3Packet, EV3_COMMAND } = require('../protocol/ev3Packet') as typeof import('../protocol/ev3Packet');
		const messageCounter = 0xFFFF; // probe uses max counter to avoid collisions
		const probe = encodeEv3Packet(messageCounter, EV3_COMMAND.DIRECT_COMMAND_REPLY, new Uint8Array([0x81, 0x12]));
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const reply = await adapter.send(probe, {
				timeoutMs,
				signal: controller.signal,
				expectedMessageCounter: messageCounter,
			});
			const decoded = decodeEv3Packet(reply);
			return decoded.messageCounter === messageCounter;
		} finally {
			clearTimeout(timer);
		}
	} catch {
		return false;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
