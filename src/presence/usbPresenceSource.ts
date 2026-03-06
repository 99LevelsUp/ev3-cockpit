import { TransportMode } from '../types/enums';
import type { Logger } from '../diagnostics/logger';
import type { PresenceChangeCallback, PresenceRecord, PresenceSource } from './presenceSource';

export interface UsbPresenceSourceOptions {
	pollIntervalMs: number;
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
}

export class UsbPresenceSource implements PresenceSource {
	public readonly transport = TransportMode.USB;

	private readonly options: UsbPresenceSourceOptions;
	private readonly logger: Logger;
	private readonly present = new Map<string, PresenceRecord>();
	private readonly listeners: PresenceChangeCallback[] = [];
	private timer: ReturnType<typeof setInterval> | undefined;
	private started = false;

	constructor(options: UsbPresenceSourceOptions, logger: Logger) {
		this.options = options;
		this.logger = logger;
	}

	public start(): void {
		if (this.started) {
			return;
		}
		this.started = true;
		this.poll();
		this.timer = setInterval(() => this.poll(), this.options.pollIntervalMs);
		this.timer.unref?.();
	}

	public stop(): void {
		this.started = false;
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	public getPresent(): ReadonlyMap<string, PresenceRecord> {
		return this.present;
	}

	public onChange(callback: PresenceChangeCallback): void {
		this.listeners.push(callback);
	}

	private poll(): void {
		const devices = this.listHidDevices();
		const now = Date.now();
		let changed = false;

		const seenIds = new Set<string>();
		for (const device of devices) {
			const usbPath = device.path?.trim();
			if (!usbPath) {
				continue;
			}
			const candidateId = `usb-${this.options.toSafeIdentifier(usbPath)}`;
			seenIds.add(candidateId);

			const existing = this.present.get(candidateId);
			const displayName = device.serialNumber
				? `EV3 USB (${device.serialNumber})`
				: `EV3 USB (${usbPath})`;

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
				changed = true;
			}
		}

		// Mark unseen devices as stale (don't remove — reaper handles TTL)
		// But update lastSeenMs only for seen devices (already done above)
		// If a device disappeared, we just don't update its lastSeenMs.
		// However, we need to detect NEW removals to fire onChange.
		for (const candidateId of this.present.keys()) {
			if (!seenIds.has(candidateId)) {
				// Device gone from HID — keep in map (reaper handles removal)
				// but fire change so aggregator knows
				changed = true;
			}
		}

		if (changed) {
			this.fireChange();
		}
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
		} catch {
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
