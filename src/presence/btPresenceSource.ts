import { TransportMode } from '../types/enums';
import type { Logger } from '../diagnostics/logger';
import type { PresenceChangeCallback, PresenceRecord, PresenceSource } from './presenceSource';
import { LEGO_MAC_OUI_PREFIX } from '../transport/bluetoothPortSelection';

export interface BtPresenceSourceOptions {
	fastIntervalMs: number;
	inquiryIntervalMs: number;
	toSafeIdentifier: (value: string) => string;
}

interface BluetoothCandidate {
	path: string;
	mac?: string;
	displayName?: string;
	hasLegoPrefix: boolean;
	present?: boolean;
	connectable?: boolean;
}

export class BtPresenceSource implements PresenceSource {
	public readonly transport = TransportMode.BT;

	private readonly options: BtPresenceSourceOptions;
	private readonly logger: Logger;
	private readonly present = new Map<string, PresenceRecord>();
	private readonly listeners: PresenceChangeCallback[] = [];
	private fastTimer: ReturnType<typeof setTimeout> | undefined;
	private inquiryTimer: ReturnType<typeof setTimeout> | undefined;
	private started = false;
	private scanning = false;

	constructor(options: BtPresenceSourceOptions, logger: Logger) {
		this.options = options;
		this.logger = logger;
	}

	public start(): void {
		if (this.started) {
			return;
		}
		this.started = true;
		this.scheduleFastScan();
		this.scheduleInquiryScan();
	}

	public stop(): void {
		this.started = false;
		if (this.fastTimer) {
			clearTimeout(this.fastTimer);
			this.fastTimer = undefined;
		}
		if (this.inquiryTimer) {
			clearTimeout(this.inquiryTimer);
			this.inquiryTimer = undefined;
		}
	}

	public getPresent(): ReadonlyMap<string, PresenceRecord> {
		return this.present;
	}

	public onChange(callback: PresenceChangeCallback): void {
		this.listeners.push(callback);
	}

	private scheduleFastScan(): void {
		if (!this.started) {
			return;
		}
		this.fastTimer = setTimeout(async () => {
			await this.runFastScan();
			this.scheduleFastScan();
		}, this.options.fastIntervalMs);
		this.fastTimer.unref?.();
	}

	private scheduleInquiryScan(): void {
		if (!this.started) {
			return;
		}
		this.inquiryTimer = setTimeout(async () => {
			await this.runInquiryScan();
			this.scheduleInquiryScan();
		}, this.options.inquiryIntervalMs);
		this.inquiryTimer.unref?.();
	}

	private async runFastScan(): Promise<void> {
		if (!this.started || this.scanning) {
			return;
		}
		this.scanning = true;
		try {
			const candidates = await this.listBluetoothCandidates();
			this.updateFromCandidates(candidates);
		} catch (err) {
			this.logger.warn('BT fast scan failed', { error: String(err) });
		} finally {
			this.scanning = false;
		}
	}

	private async runInquiryScan(): Promise<void> {
		// Inquiry scan is the same as fast scan for now
		// In the future, PS worker will differentiate fast (cached) vs full (inquiry)
		await this.runFastScan();
	}

	private updateFromCandidates(candidates: BluetoothCandidate[]): void {
		const now = Date.now();
		let changed = false;

		const seenIds = new Set<string>();
		for (const bt of candidates) {
			const rawPath = bt.path.trim();
			if (!rawPath) {
				continue;
			}

			const idSuffix = bt.mac ?? this.options.toSafeIdentifier(rawPath);
			const candidateId = `bt-${idSuffix}`;
			seenIds.add(candidateId);

			const connectable = bt.connectable !== false && /^COM\d+$/i.test(rawPath);
			const displayName = bt.displayName
				?? (bt.mac ? `EV3 BT (${bt.mac.slice(-4).toUpperCase()})` : `EV3 BT (${rawPath})`);
			const detail = bt.mac
				? `${connectable ? rawPath : 'BT live-only'} | ${bt.mac.toUpperCase()}`
				: rawPath;

			const record: PresenceRecord = {
				candidateId,
				transport: TransportMode.BT,
				displayName,
				detail,
				connectable,
				lastSeenMs: now,
				mac: bt.mac,
				connectionParams: {
					mode: 'bt',
					btPortPath: connectable ? rawPath : undefined,
					mac: bt.mac
				}
			};

			const existing = this.present.get(candidateId);
			this.present.set(candidateId, record);
			if (!existing) {
				changed = true;
			}
		}

		// Detect disappearances (don't remove — reaper handles TTL)
		for (const candidateId of this.present.keys()) {
			if (!seenIds.has(candidateId)) {
				changed = true;
			}
		}

		if (changed) {
			this.fireChange();
		}
	}

	private async listBluetoothCandidates(): Promise<BluetoothCandidate[]> {
		const [serial, unknownDevices, connectedDevices] = await Promise.all([
			this.listSerialCandidates(),
			this.listWinApiDevices(false),
			this.listWinApiDevices(true)
		]);

		const candidatesById = new Map<string, BluetoothCandidate>();
		const connectedMacs = new Set(connectedDevices.map((d) => d.mac.toLowerCase()));

		for (const serialCandidate of serial) {
			const path = serialCandidate.path.trim();
			if (!/^COM\d+$/i.test(path)) {
				continue;
			}
			const mac = this.extractMacFromPnpId(serialCandidate.pnpId);
			if (!this.isLikelyEv3(serialCandidate, mac)) {
				continue;
			}
			const key = mac ?? `com:${path.toLowerCase()}`;
			const present = mac ? connectedMacs.has(mac) : undefined;
			candidatesById.set(key, {
				path,
				mac,
				displayName: serialCandidate.friendlyName?.trim() || undefined,
				hasLegoPrefix: mac?.startsWith(LEGO_MAC_OUI_PREFIX.toLowerCase()) ?? false,
				present,
				connectable: true
			});
		}

		for (const device of unknownDevices) {
			const mac = device.mac;
			if (!mac.startsWith(LEGO_MAC_OUI_PREFIX.toLowerCase())) {
				continue;
			}
			const existing = candidatesById.get(mac);
			if (existing) {
				if (!existing.displayName && device.name) {
					existing.displayName = device.name;
				}
				existing.present = true;
				continue;
			}
			candidatesById.set(mac, {
				path: `BTADDR-${mac}`,
				mac,
				displayName: device.name,
				hasLegoPrefix: true,
				present: true,
				connectable: false
			});
		}

		return Array.from(candidatesById.values());
	}

	private async listSerialCandidates(): Promise<Array<{
		path: string;
		pnpId?: string;
		friendlyName?: string;
		manufacturer?: string;
	}>> {
		try {
			const mod = require('serialport') as {
				SerialPort?: { list: () => Promise<Array<{
					path: string;
					pnpId?: string;
					friendlyName?: string;
					manufacturer?: string;
				}>> };
			};
			if (!mod.SerialPort || typeof mod.SerialPort.list !== 'function') {
				return [];
			}
			return await mod.SerialPort.list();
		} catch {
			return [];
		}
	}

	private listWinApiDevices(connected: boolean): Promise<Array<{ mac: string; name?: string }>> {
		if (process.platform !== 'win32') {
			return Promise.resolve([]);
		}
		try {
			const { listBluetoothDevices } = require('../transport/windowsBluetoothApi') as {
				listBluetoothDevices: (opts: {
					returnAuthenticated: boolean;
					returnRemembered: boolean;
					returnUnknown: boolean;
					returnConnected: boolean;
					issueInquiry: boolean;
					timeoutMultiplier: number;
				}) => Array<{ mac: string; name?: string }>;
			};
			const devices = listBluetoothDevices(connected
				? {
					returnAuthenticated: true,
					returnRemembered: false,
					returnUnknown: false,
					returnConnected: true,
					issueInquiry: false,
					timeoutMultiplier: 4
				}
				: {
					returnAuthenticated: false,
					returnRemembered: false,
					returnUnknown: true,
					returnConnected: false,
					issueInquiry: false,
					timeoutMultiplier: 4
				}
			);
			return Promise.resolve(devices.map((d) => ({
				mac: d.mac.toLowerCase(),
				name: d.name?.trim() || undefined
			})));
		} catch {
			return Promise.resolve([]);
		}
	}

	private extractMacFromPnpId(pnpId?: string): string | undefined {
		if (!pnpId) {
			return undefined;
		}
		const match = pnpId.match(/([0-9A-Fa-f]{12})/);
		if (!match) {
			return undefined;
		}
		return match[1].toLowerCase();
	}

	private isLikelyEv3(
		candidate: { path: string; pnpId?: string; manufacturer?: string; friendlyName?: string },
		mac?: string
	): boolean {
		if (mac?.startsWith(LEGO_MAC_OUI_PREFIX.toLowerCase())) {
			return true;
		}
		if (candidate.pnpId && /ev3|lego/i.test(candidate.pnpId)) {
			return true;
		}
		if (candidate.manufacturer && /lego/i.test(candidate.manufacturer)) {
			return true;
		}
		if (candidate.friendlyName && /\bev3\b/i.test(candidate.friendlyName)) {
			return true;
		}
		return false;
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
