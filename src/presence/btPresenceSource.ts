/**
 * Bluetooth presence source for discovering EV3 bricks via serial port enumeration.
 *
 * @packageDocumentation
 */

import { TransportMode } from '../types/enums';
import type { Logger } from '../diagnostics/logger';
import type { PresenceChangeCallback, PresenceRecord, PresenceSource } from './presenceSource';
import { LEGO_MAC_OUI_PREFIX } from '../transport/bluetoothPortSelection';
import {
	canUseNativeBluetoothDiscovery,
	listBluetoothDevicesNative,
	trackKnownDevicesNative,
	type BluetoothDeviceInfo
} from './bluetoothNativeDiscovery';
import { runWindowsPowerShell } from './windowsPowerShell';

export interface BtPresenceSourceOptions {
	fastIntervalMs: number;
	inquiryIntervalMs: number;
	toSafeIdentifier: (value: string) => string;
	_listBluetoothCandidates?: (issueInquiry: boolean) => Promise<BluetoothCandidate[]>;
}

interface BluetoothCandidate {
	path: string;
	mac?: string;
	displayName?: string;
	hasLegoPrefix: boolean;
	present?: boolean;
	connectable?: boolean;
}

interface WindowsKnownLegoDevice {
	mac: string;
	name?: string;
}

export function parseWindowsKnownLegoMacs(raw: string): string[] {
	return parseWindowsKnownLegoDevices(raw).map((device) => device.mac);
}

export function parseWindowsKnownLegoDevices(raw: string): WindowsKnownLegoDevice[] {
	if (!raw.trim()) {
		return [];
	}
	try {
		const parsed = JSON.parse(raw) as
			| string
			| string[]
			| { mac?: unknown; name?: unknown }
			| Array<{ mac?: unknown; name?: unknown }>;
		const rows = Array.isArray(parsed) ? parsed : [parsed];
		const byMac = new Map<string, WindowsKnownLegoDevice>();
		for (const row of rows) {
			const mac = typeof row === 'string'
				? row.trim().toLowerCase()
				: String(row.mac ?? '').trim().toLowerCase();
			if (!mac.startsWith(LEGO_MAC_OUI_PREFIX.toLowerCase()) || !/^[0-9a-f]{12}$/.test(mac)) {
				continue;
			}
			const existing = byMac.get(mac);
			const name = typeof row === 'string'
				? undefined
				: String(row.name ?? '').trim() || undefined;
			if (!existing) {
				byMac.set(mac, { mac, name });
				continue;
			}
			if (!existing.name && name) {
				existing.name = name;
			}
		}
		return Array.from(byMac.values());
	} catch {
		return [];
	}
}

export function mergeBluetoothDeviceInfos(...sources: BluetoothDeviceInfo[][]): BluetoothDeviceInfo[] {
	const byMac = new Map<string, BluetoothDeviceInfo>();
	for (const source of sources) {
		for (const device of source) {
			const mac = String(device.mac ?? '').trim().toLowerCase();
			if (!/^[0-9a-f]{12}$/.test(mac)) {
				continue;
			}
			const existing = byMac.get(mac);
			if (!existing) {
				byMac.set(mac, {
					mac,
					name: device.name?.trim() || '',
					connected: Boolean(device.connected),
					remembered: Boolean(device.remembered),
					authenticated: Boolean(device.authenticated)
				});
				continue;
			}
			if (!existing.name && device.name) {
				existing.name = device.name.trim();
			}
			existing.connected = existing.connected || Boolean(device.connected);
			existing.remembered = existing.remembered || Boolean(device.remembered);
			existing.authenticated = existing.authenticated || Boolean(device.authenticated);
		}
	}
	return Array.from(byMac.values());
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
	private scanCount = 0;
	private scanChain: Promise<void> = Promise.resolve();
	private fastScanQueued = false;
	private inquiryScanQueued = false;
	/** MAC addresses of LEGO devices seen in previous scans.
	 *  Used for BluetoothGetDeviceInfo fallback when devices
	 *  fall out of the FindFirstDevice discovery cache. */
	private readonly knownLegoMacs = new Set<string>();
	private knownRegistryMacsCache:
		| { ts: number; devices: WindowsKnownLegoDevice[]; inFlight?: Promise<WindowsKnownLegoDevice[]> }
		| undefined;

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
		// Startup should expose cached devices quickly and also run a real inquiry
		// immediately so visible bricks are not delayed until the first slow cycle.
		this.enqueueScan(false);
		this.enqueueScan(true);
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
		this.fastTimer = setTimeout(() => {
			this.enqueueScan(false);
			this.scheduleFastScan();
		}, this.options.fastIntervalMs);
		this.fastTimer.unref?.();
	}

	private scheduleInquiryScan(): void {
		if (!this.started) {
			return;
		}
		this.inquiryTimer = setTimeout(() => {
			this.enqueueScan(true);
			this.scheduleInquiryScan();
		}, this.options.inquiryIntervalMs);
		this.inquiryTimer.unref?.();
	}

	private enqueueScan(issueInquiry: boolean): void {
		if (!this.started) {
			return;
		}
		if (issueInquiry) {
			if (this.inquiryScanQueued) {
				return;
			}
			this.inquiryScanQueued = true;
		} else {
			if (this.fastScanQueued) {
				return;
			}
			this.fastScanQueued = true;
		}
		this.scanChain = this.scanChain
			.catch(() => undefined)
			.then(async () => {
				if (issueInquiry) {
					this.inquiryScanQueued = false;
				} else {
					this.fastScanQueued = false;
				}
				if (!this.started) {
					return;
				}
				await this.runScan(issueInquiry);
			});
	}

	private async runScan(issueInquiry: boolean): Promise<void> {
		this.scanCount += 1;
		try {
			const candidates = await this.listBluetoothCandidates(issueInquiry);
			if (issueInquiry) {
				this.logger.info('BT inquiry scan result', {
					scan: this.scanCount,
					candidates: candidates.length,
					names: candidates.map((c) => c.displayName ?? '(none)')
				});
			} else if (this.scanCount <= 3) {
				this.logger.info('BT fast scan result', {
					scan: this.scanCount,
					candidates: candidates.length,
					names: candidates.map((c) => c.displayName ?? '(none)'),
					macs: candidates.map((c) => c.mac ?? '(none)')
				});
			}
			this.updateFromCandidates(candidates);
		} catch (err) {
			this.logger.warn(issueInquiry ? 'BT inquiry scan failed' : 'BT fast scan failed', { error: String(err) });
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
				?? (bt.mac ? `EVƎ BT (${bt.mac.slice(-4).toUpperCase()})` : `EVƎ BT (${rawPath})`);
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
		if (this.options._listBluetoothCandidates) {
			return this.options._listBluetoothCandidates(issueInquiry);
		}
		const [serial, nativeDevices] = await Promise.all([
			this.listSerialCandidates(),
			this.listNativeDevices(issueInquiry)
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
	 *
	 * Uses a dual strategy on Windows:
	 *  1. FindFirstDevice — enumerates the discovery cache
	 *  2. GetDeviceInfo for known MACs — catches devices that
	 *     have fallen out of the volatile discovery cache
	 */
	private async listNativeDevices(issueInquiry: boolean): Promise<BluetoothDeviceInfo[]> {
		if (!canUseNativeBluetoothDiscovery()) {
			if (this.scanCount <= 1) {
				this.logger.warn('BT: native discovery backend not available on this platform');
			}
			return [];
		}
		try {
			let knownWindowsDevices: WindowsKnownLegoDevice[] = [];
			if (process.platform === 'win32') {
				knownWindowsDevices = await this.listWindowsKnownLegoDevices();
				for (const device of knownWindowsDevices) {
					this.knownLegoMacs.add(device.mac);
				}
			}

			// Windows returns different subsets for cached-vs-inquiry enumeration.
			// Keep both so visible devices and recently remembered LEGO bricks survive.
			const primary = await listBluetoothDevicesNative({
				returnAuthenticated: true,
				returnRemembered: true,
				returnUnknown: true,
				returnConnected: true,
				issueInquiry,
				timeoutMultiplier: issueInquiry ? 8 : 4
			});
			const secondary = process.platform === 'win32' && issueInquiry
				? await listBluetoothDevicesNative({
					returnAuthenticated: true,
					returnRemembered: true,
					returnUnknown: true,
					returnConnected: true,
					issueInquiry: false,
					timeoutMultiplier: 4
				})
				: [];
			const discovered = mergeBluetoothDeviceInfos(primary, secondary);

			// Remember LEGO MACs for future lookups
			const discoveredMacs = new Set<string>();
			for (const d of discovered) {
				if (d.mac.startsWith(LEGO_MAC_OUI_PREFIX.toLowerCase())) {
					this.knownLegoMacs.add(d.mac);
				}
				discoveredMacs.add(d.mac);
			}

			// Step 2: look up known MACs not found in discovery cache
			const missingMacs = [...this.knownLegoMacs].filter(m => !discoveredMacs.has(m));
			if (missingMacs.length > 0) {
				const recovered = await trackKnownDevicesNative(missingMacs);
				if (recovered.length > 0) {
					this.logger.info('BT: recovered devices via GetDeviceInfo', {
						recovered: recovered.map(d => d.name || d.mac)
					});
					discovered.push(...recovered);
				}
			}

			if (process.platform === 'win32' && knownWindowsDevices.length > 0) {
				const rememberedOnly = knownWindowsDevices
					.filter((device) => !discovered.some((candidate) => candidate.mac === device.mac))
					.map((device) => ({
						mac: device.mac,
						name: device.name ?? '',
						connected: false,
						remembered: true,
						authenticated: false
					}));
				return mergeBluetoothDeviceInfos(discovered, rememberedOnly);
			}

			return discovered;
		} catch (err) {
			if (this.scanCount <= 1 || this.scanCount % 20 === 0) {
				this.logger.warn('BT: native discovery failed', {
					error: String(err), scan: this.scanCount
				});
			}
			return [];
		}
	}

	private async listWindowsKnownLegoMacs(): Promise<string[]> {
		return (await this.listWindowsKnownLegoDevices()).map((device) => device.mac);
	}

	private async listWindowsKnownLegoDevices(): Promise<WindowsKnownLegoDevice[]> {
		if (process.platform !== 'win32') {
			return [];
		}
		const now = Date.now();
		if (this.knownRegistryMacsCache && !this.knownRegistryMacsCache.inFlight && now - this.knownRegistryMacsCache.ts < 10000) {
			return this.knownRegistryMacsCache.devices;
		}
		if (this.knownRegistryMacsCache?.inFlight) {
			return await this.knownRegistryMacsCache.inFlight;
		}

		const inFlight = (async (): Promise<WindowsKnownLegoDevice[]> => {
			const script = [
				'$root = "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\BTHPORT\\Parameters\\Devices";',
				'if (-not (Test-Path $root)) { "[]"; return }',
				'Get-ChildItem $root -ErrorAction SilentlyContinue |',
				'  ForEach-Object {',
				'    $props = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue;',
				'    [PSCustomObject]@{',
				'      mac = $_.PSChildName;',
				'      name = if ($props.Name) { [Text.Encoding]::UTF8.GetString($props.Name).Trim([char]0) } else { "" }',
				'    }',
				'  } |',
				'  Where-Object { $_.mac -match "^[0-9A-Fa-f]{12}$" } |',
				'  ConvertTo-Json -Compress'
			].join('\n');

			try {
				const raw = await runWindowsPowerShell(script, 8000);
				const values = parseWindowsKnownLegoDevices(raw);
				this.knownRegistryMacsCache = { ts: Date.now(), devices: values };
				return values;
			} catch (err) {
				if (this.scanCount <= 1 || this.scanCount % 20 === 0) {
					this.logger.warn('BT: Windows registry MAC enumeration failed', {
						error: String(err),
						scan: this.scanCount
					});
				}
				this.knownRegistryMacsCache = { ts: Date.now(), devices: [] };
				return [];
			}
		})();

		this.knownRegistryMacsCache = {
			ts: now,
			devices: this.knownRegistryMacsCache?.devices ?? [],
			inFlight
		};
		try {
			return await inFlight;
		} finally {
			if (this.knownRegistryMacsCache) {
				delete this.knownRegistryMacsCache.inFlight;
			}
		}
	}

	private async listSerialCandidates(): Promise<Array<{
		path: string;
		pnpId?: string;
		friendlyName?: string;
		manufacturer?: string;
	}>> {
		if (process.platform === 'win32') {
			return await this.listWindowsSerialCandidates();
		}
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

	private async listWindowsSerialCandidates(): Promise<Array<{
		path: string;
		pnpId?: string;
		friendlyName?: string;
		manufacturer?: string;
	}>> {
		const script = [
			'$rows = @();',
			'if (Get-Command Get-PnpDevice -ErrorAction SilentlyContinue) {',
			'  $ports = Get-PnpDevice -Class Ports -PresentOnly -ErrorAction SilentlyContinue;',
			'  foreach ($p in $ports) {',
			'    $inst = [string]$p.InstanceId;',
			'    $friendly = [string]$p.FriendlyName;',
			'    $manufacturer = [string]$p.Manufacturer;',
			'    $com = $null;',
			'    if ($friendly -match "\\((COM\\d+)\\)") { $com = $Matches[1]; }',
			'    elseif ($inst -match "\\b(COM\\d+)\\b") { $com = $Matches[1]; }',
			'    if (-not $com) { continue; }',
			'    $parent = (Get-PnpDeviceProperty -InstanceId $inst -KeyName "DEVPKEY_Device_Parent" -ErrorAction SilentlyContinue).Data;',
			'    $rows += [PSCustomObject]@{',
			'      path = $com;',
			'      pnpId = if ($parent) { [string]$parent } else { $inst };',
			'      friendlyName = $friendly;',
			'      manufacturer = $manufacturer',
			'    };',
			'  }',
			'}',
			'$rows | ConvertTo-Json -Compress'
		].join('\n');

		try {
			const raw = await runWindowsPowerShell(script, 8000);
			if (!raw.trim()) {
				return [];
			}
			const parsed = JSON.parse(raw) as
				| { path?: unknown; pnpId?: unknown; friendlyName?: unknown; manufacturer?: unknown }
				| Array<{ path?: unknown; pnpId?: unknown; friendlyName?: unknown; manufacturer?: unknown }>;
			const rows = Array.isArray(parsed) ? parsed : [parsed];
			return rows
				.map((row) => ({
					path: String(row.path ?? '').trim().toUpperCase(),
					pnpId: String(row.pnpId ?? '').trim() || undefined,
					friendlyName: String(row.friendlyName ?? '').trim() || undefined,
					manufacturer: String(row.manufacturer ?? '').trim() || undefined
				}))
				.filter((row) => /^COM\d+$/i.test(row.path));
		} catch (err) {
			if (this.scanCount <= 1 || this.scanCount % 20 === 0) {
				this.logger.warn('BT: Windows PnP COM enumeration failed', {
					error: String(err),
					scan: this.scanCount
				});
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
