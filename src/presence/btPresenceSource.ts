import { TransportMode } from '../types/enums';
import type { Logger } from '../diagnostics/logger';
import type { PresenceChangeCallback, PresenceRecord, PresenceSource } from './presenceSource';
import { LEGO_MAC_OUI_PREFIX } from '../transport/bluetoothPortSelection';
import {
	canUseNativeBluetoothDiscovery,
	listBluetoothDevicesNative,
	type BluetoothDeviceInfo
} from './bluetoothNativeDiscovery';

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
	private scanCount = 0;

	constructor(options: BtPresenceSourceOptions, logger: Logger) {
		this.options = options;
		this.logger = logger;
	}

	public start(): void {
		if (this.started) {
			return;
		}
		this.started = true;
		this.logger.info('BtPresenceSource started', {
			fastIntervalMs: this.options.fastIntervalMs,
			inquiryIntervalMs: this.options.inquiryIntervalMs
		});
		// Run first scan immediately
		void this.runFastScan().then(() => this.scheduleFastScan());
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
		this.scanCount += 1;
		try {
			const candidates = await this.listBluetoothCandidates(false);
			if (this.scanCount <= 3) {
				this.logger.info('BT fast scan result', {
					scan: this.scanCount,
					candidates: candidates.length,
					names: candidates.map((c) => c.displayName ?? '(none)'),
					macs: candidates.map((c) => c.mac ?? '(none)')
				});
			}
			this.updateFromCandidates(candidates);
		} catch (err) {
			this.logger.warn('BT fast scan failed', { error: String(err) });
		} finally {
			this.scanning = false;
		}
	}

	private async runInquiryScan(): Promise<void> {
		if (!this.started || this.scanning) {
			return;
		}
		this.scanning = true;
		this.scanCount += 1;
		try {
			const candidates = await this.listBluetoothCandidates(true);
			this.logger.info('BT inquiry scan result', {
				scan: this.scanCount,
				candidates: candidates.length,
				names: candidates.map((c) => c.displayName ?? '(none)')
			});
			this.updateFromCandidates(candidates);
		} catch (err) {
			this.logger.warn('BT inquiry scan failed', { error: String(err) });
		} finally {
			this.scanning = false;
		}
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
				this.logger.info('BT device appeared', { candidateId, displayName, connectable });
				changed = true;
			} else if (
				existing.displayName !== displayName
				|| existing.connectable !== connectable
			) {
				changed = true;
			} else if (now - existing.lastSeenMs > this.options.fastIntervalMs * 3) {
				// Device was stale (missed 3+ scans) but is back — notify aggregator
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

	private async listBluetoothCandidates(issueInquiry: boolean): Promise<BluetoothCandidate[]> {
		const [serial, nativeDevices] = await Promise.all([
			this.listSerialCandidates(),
			Promise.resolve(this.listNativeDevices(issueInquiry))
		]);

		if (this.scanCount <= 3) {
			this.logger.info('BT scan sources', {
				serialPorts: serial.length,
				nativeDevices: nativeDevices.length,
				nativeAvailable: canUseNativeBluetoothDiscovery()
			});
		}

		const candidatesById = new Map<string, BluetoothCandidate>();
		const nativeByMac = new Map<string, BluetoothDeviceInfo>();
		for (const nd of nativeDevices) {
			nativeByMac.set(nd.mac, nd);
		}

		// 1) Serial port candidates (COM ports / rfcomm ports with LEGO MAC)
		for (const serialCandidate of serial) {
			const path = serialCandidate.path.trim();
			if (process.platform === 'win32' && !/^COM\d+$/i.test(path)) {
				continue;
			}
			const mac = this.extractMacFromPnpId(serialCandidate.pnpId);
			if (!this.isLikelyEv3(serialCandidate, mac)) {
				continue;
			}
			const key = mac ?? `serial:${path.toLowerCase()}`;
			const nativeInfo = mac ? nativeByMac.get(mac) : undefined;
			candidatesById.set(key, {
				path,
				mac,
				displayName: nativeInfo?.name?.trim()
					|| serialCandidate.friendlyName?.trim()
					|| undefined,
				hasLegoPrefix: mac?.startsWith(LEGO_MAC_OUI_PREFIX.toLowerCase()) ?? false,
				present: nativeInfo?.connected ?? undefined,
				connectable: true
			});
		}

		// 2) Native BT devices not already found via serial ports
		for (const nd of nativeDevices) {
			if (!nd.mac.startsWith(LEGO_MAC_OUI_PREFIX.toLowerCase())) {
				continue;
			}
			if (candidatesById.has(nd.mac)) {
				// Already have this device via serial — just enrich
				const existing = candidatesById.get(nd.mac)!;
				if (!existing.displayName && nd.name) {
					existing.displayName = nd.name;
				}
				existing.present = true;
				continue;
			}
			candidatesById.set(nd.mac, {
				path: `BTADDR-${nd.mac}`,
				mac: nd.mac,
				displayName: nd.name || undefined,
				hasLegoPrefix: true,
				present: true,
				connectable: false  // no serial port yet
			});
		}

		return Array.from(candidatesById.values());
	}

	/**
	 * Query native Bluetooth stack via koffi FFI.
	 * Windows: bthprops.cpl. Linux: libbluetooth.so.
	 */
	private listNativeDevices(issueInquiry: boolean): BluetoothDeviceInfo[] {
		if (!canUseNativeBluetoothDiscovery()) {
			if (this.scanCount <= 1) {
				this.logger.warn('BT: native discovery not available (koffi not loaded or unsupported platform)');
			}
			return [];
		}
		try {
			return listBluetoothDevicesNative({
				returnAuthenticated: true,
				returnRemembered: true,
				returnUnknown: true,
				returnConnected: true,
				issueInquiry,
				timeoutMultiplier: issueInquiry ? 8 : 4
			});
		} catch (err) {
			if (this.scanCount <= 1 || this.scanCount % 20 === 0) {
				this.logger.warn('BT: native discovery failed', {
					error: String(err), scan: this.scanCount
				});
			}
			return [];
		}
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
				if (this.scanCount <= 1) {
					this.logger.warn('BT: serialport module not available');
				}
				return [];
			}
			return await mod.SerialPort.list();
		} catch (err) {
			if (this.scanCount <= 1 || this.scanCount % 20 === 0) {
				this.logger.warn('BT: serialport list failed', { error: String(err), scan: this.scanCount });
			}
			return [];
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
