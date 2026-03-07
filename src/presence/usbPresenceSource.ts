import { TransportMode } from '../types/enums';
import type { Logger } from '../diagnostics/logger';
import type { PresenceChangeCallback, PresenceRecord, PresenceSource } from './presenceSource';
import { encodeEv3Packet, decodeEv3Packet, EV3_COMMAND, EV3_REPLY } from '../protocol/ev3Packet';
import { concatBytes, uint16le, lc0, gv0 } from '../protocol/ev3Bytecode';
import { UsbHidAdapter } from '../transport/usbHidAdapter';

export interface UsbPresenceSourceOptions {
	pollIntervalMs: number;
	nameProbeIntervalMs: number;
	vendorId: number;
	productId: number;
	toSafeIdentifier: (value: string) => string;
}

interface HidDevice {
	path: string;
	vendorId?: number;
	productId?: number;
	product?: string;
	serialNumber?: string;
	manufacturer?: string;
	usage?: number;
	usagePage?: number;
	interface?: number;
}

const OP_COM_GET = 0xd3;
const GET_BRICKNAME_SUB = 0x0d;
const BRICKNAME_MAX_LEN = 13; // 12 chars + null terminator
const NAME_PROBE_TIMEOUT_MS = 3000;
const NAME_PROBE_MSG_COUNTER = 0xfffd;

export class UsbPresenceSource implements PresenceSource {
	public readonly transport = TransportMode.USB;

	private readonly options: UsbPresenceSourceOptions;
	private readonly logger: Logger;
	private readonly present = new Map<string, PresenceRecord>();
	private readonly listeners: PresenceChangeCallback[] = [];
	private readonly resolvedNames = new Map<string, string>();
	private readonly probingNow = new Set<string>();
	private timer: ReturnType<typeof setInterval> | undefined;
	private nameProbeTimer: ReturnType<typeof setInterval> | undefined;
	private started = false;
	private pollCount = 0;

	constructor(options: UsbPresenceSourceOptions, logger: Logger) {
		this.options = options;
		this.logger = logger;
	}

	public start(): void {
		if (this.started) {
			return;
		}
		this.started = true;
		this.logger.info('UsbPresenceSource started', {
			pollIntervalMs: this.options.pollIntervalMs,
			nameProbeIntervalMs: this.options.nameProbeIntervalMs
		});
		this.poll();
		this.timer = setInterval(() => this.poll(), this.options.pollIntervalMs);
		this.timer.unref?.();
		this.nameProbeTimer = setInterval(() => this.probeAllNames(), this.options.nameProbeIntervalMs);
		this.nameProbeTimer.unref?.();
	}

	public stop(): void {
		this.started = false;
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		if (this.nameProbeTimer) {
			clearInterval(this.nameProbeTimer);
			this.nameProbeTimer = undefined;
		}
	}

	public getPresent(): ReadonlyMap<string, PresenceRecord> {
		return this.present;
	}

	public onChange(callback: PresenceChangeCallback): void {
		this.listeners.push(callback);
	}

	private poll(): void {
		this.pollCount += 1;
		const devices = this.listHidDevices();
		const now = Date.now();
		let changed = false;

		// Deduplicate: node-hid returns multiple HID collections per physical device.
		// Group by serialNumber and pick one path per brick.
		const deduped = this.deduplicateByBrick(devices);

		if (this.pollCount <= 3) {
			this.logger.info('USB HID poll', {
				poll: this.pollCount,
				rawDevices: devices.length,
				deduped: deduped.length,
				serials: deduped.map((d) => d.serialNumber ?? '(none)')
			});
		}

		const seenIds = new Set<string>();
		for (const device of deduped) {
			const usbPath = device.path?.trim();
			if (!usbPath) {
				continue;
			}

			// Use serialNumber as stable identifier when available;
			// fall back to path-based identifier.
			const stableKey = device.serialNumber?.trim()
				? this.options.toSafeIdentifier(device.serialNumber.trim())
				: this.options.toSafeIdentifier(usbPath);
			const candidateId = `usb-${stableKey}`;
			seenIds.add(candidateId);

			const existing = this.present.get(candidateId);
			const resolvedName = this.resolvedNames.get(candidateId);
			const displayName = resolvedName ?? 'EV3';

			const record: PresenceRecord = {
				candidateId,
				transport: TransportMode.USB,
				displayName,
				detail: usbPath,
				connectable: true,
				lastSeenMs: now,
				connectionParams: { mode: 'usb', usbPath }
			};

			this.present.set(candidateId, record);
			if (!existing) {
				this.logger.info('USB device appeared', { candidateId, path: usbPath });
				changed = true;
				// Trigger immediate name probe for new device
				void this.probeName(candidateId, usbPath);
			} else if (existing.displayName !== displayName) {
				changed = true;
			} else if (now - existing.lastSeenMs > this.options.pollIntervalMs * 3) {
				// Device was stale (missed 3+ polls) but is back — notify aggregator
				changed = true;
			}
		}

		// Devices not in current scan keep their old lastSeenMs.
		// The aggregator reaper handles stale device removal via TTL —
		// we never delete here to avoid flapping on transient scan failures.

		if (changed) {
			this.fireChange();
		}
	}

	private async probeAllNames(): Promise<void> {
		for (const [candidateId, record] of this.present) {
			if (this.probingNow.has(candidateId)) {
				continue;
			}
			await this.probeName(candidateId, record.connectionParams.mode === 'usb'
				? record.connectionParams.usbPath
				: record.detail);
		}
	}

	private async probeName(candidateId: string, usbPath: string): Promise<void> {
		if (this.probingNow.has(candidateId)) {
			return;
		}
		this.probingNow.add(candidateId);
		try {
			const name = await this.probeGetBrickName(usbPath);
			const existing = this.present.get(candidateId);
			if (!existing) {
				return;
			}
			if (name) {
				const previous = this.resolvedNames.get(candidateId);
				this.resolvedNames.set(candidateId, name);
				if (previous !== name || !existing.connectable) {
					this.present.set(candidateId, { ...existing, displayName: name, connectable: true });
					this.logger.info('USB device name resolved', { candidateId, name });
					this.fireChange();
				}
			} else {
				// Name probe failed — mark as not connectable so aggregator shows ERROR
				if (existing.connectable) {
					this.present.set(candidateId, { ...existing, connectable: false });
					this.logger.warn('USB name probe failed — brick set to error state', { candidateId });
					this.fireChange();
				}
			}
		} catch (err) {
			this.logger.debug('USB name probe exception', { candidateId, error: String(err) });
			const existing = this.present.get(candidateId);
			if (existing && existing.connectable) {
				this.present.set(candidateId, { ...existing, connectable: false });
				this.fireChange();
			}
		} finally {
			this.probingNow.delete(candidateId);
		}
	}

	/**
	 * Open HID device via UsbHidAdapter, send GET_BRICKNAME, decode reply, close.
	 * Uses the same proven adapter that connection-probe uses.
	 */
	private async probeGetBrickName(usbPath: string): Promise<string | undefined> {
		const adapter = new UsbHidAdapter({ path: usbPath });
		try {
			await adapter.open();

			const bytecodePayload = concatBytes(
				uint16le(BRICKNAME_MAX_LEN),
				new Uint8Array([OP_COM_GET, GET_BRICKNAME_SUB]),
				lc0(BRICKNAME_MAX_LEN),
				gv0(0)
			);
			const packet = encodeEv3Packet(
				NAME_PROBE_MSG_COUNTER,
				EV3_COMMAND.DIRECT_COMMAND_REPLY,
				bytecodePayload
			);

			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), NAME_PROBE_TIMEOUT_MS);

			try {
				const response = await adapter.send(packet, {
					timeoutMs: NAME_PROBE_TIMEOUT_MS,
					signal: controller.signal,
					expectedMessageCounter: NAME_PROBE_MSG_COUNTER
				});

				const decoded = decodeEv3Packet(response);
				if (decoded.type === EV3_REPLY.DIRECT_REPLY && decoded.payload.length >= 1) {
					const name = this.parseCString(decoded.payload, 0, BRICKNAME_MAX_LEN);
					this.logger.debug('USB name probe: decoded reply', { name, usbPath });
					return name || undefined;
				}
				if (decoded.type === EV3_REPLY.DIRECT_REPLY_ERROR) {
					this.logger.debug('USB name probe: brick returned error reply', { usbPath });
				}
				return undefined;
			} finally {
				clearTimeout(timer);
			}
		} finally {
			await adapter.close().catch(() => { /* ignore close errors */ });
		}
	}

	private parseCString(buf: Uint8Array, offset: number, maxLen: number): string {
		let end = offset;
		const limit = Math.min(offset + maxLen, buf.length);
		while (end < limit && buf[end] !== 0) {
			end += 1;
		}
		const bytes = buf.subarray(offset, end);
		return new TextDecoder('utf-8').decode(bytes).trim();
	}

	/**
	 * Deduplicate HID entries: one physical EV3 brick may expose multiple
	 * HID collections (different usage pages). Group by serialNumber and
	 * pick one representative entry per brick.
	 */
	private deduplicateByBrick(devices: HidDevice[]): HidDevice[] {
		const bySerial = new Map<string, HidDevice>();
		const noSerial: HidDevice[] = [];

		for (const device of devices) {
			const serial = device.serialNumber?.trim();
			if (serial) {
				if (!bySerial.has(serial)) {
					bySerial.set(serial, device);
				}
			} else {
				noSerial.push(device);
			}
		}

		return [...bySerial.values(), ...noSerial];
	}

	private listHidDevices(): HidDevice[] {
		try {
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			const hid = require('node-hid') as {
				devices: (vid?: number, pid?: number) => HidDevice[];
			};
			const all = hid.devices();
			let filtered = all.filter((d) =>
				d.vendorId === this.options.vendorId && d.productId === this.options.productId
			);
			if (filtered.length === 0) {
				filtered = all.filter((d) => d.vendorId === this.options.vendorId);
			}
			if (filtered.length === 0) {
				filtered = all.filter((d) => {
					const product = String(d.product ?? '');
					const manufacturer = String(d.manufacturer ?? '');
					return /ev3/i.test(product) || /lego/i.test(manufacturer);
				});
			}
			return filtered;
		} catch (err) {
			if (this.pollCount <= 3 || this.pollCount % 20 === 0) {
				this.logger.warn('USB HID enumeration failed', { error: String(err), poll: this.pollCount });
			}
			return [];
		}
	}

	private fireChange(): void {
		for (const listener of this.listeners) {
			try {
				listener(this.present);
			} catch {
				// swallow
			}
		}
	}
}
