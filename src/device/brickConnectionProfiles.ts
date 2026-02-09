import * as vscode from 'vscode';
import { TransportMode, TransportConfigOverrides } from '../transport/transportFactory';

const PROFILE_STORE_KEY = 'ev3-cockpit.connectionProfiles.v1';

export interface BrickConnectionProfile {
	brickId: string;
	displayName: string;
	savedAtIso: string;
	rootPath: string;
	transport: TransportConfigOverrides;
}

interface ProfileStoreShape {
	profiles: BrickConnectionProfile[];
}

function sanitizeTransportMode(value: unknown): TransportMode {
	if (value === 'auto' || value === 'usb' || value === 'bluetooth' || value === 'tcp' || value === 'mock') {
		return value;
	}
	return 'auto';
}

function normalizeRootPath(path: string): string {
	let value = path.trim();
	if (!value.startsWith('/')) {
		value = `/${value}`;
	}
	if (!value.endsWith('/')) {
		value = `${value}/`;
	}
	return value;
}

function sanitizeProfile(input: BrickConnectionProfile): BrickConnectionProfile {
	return {
		brickId: input.brickId.trim(),
		displayName: input.displayName.trim(),
		savedAtIso: input.savedAtIso,
		rootPath: normalizeRootPath(input.rootPath),
		transport: {
			mode: sanitizeTransportMode(input.transport.mode),
			usbPath: input.transport.usbPath?.trim(),
			bluetoothPort: input.transport.bluetoothPort?.trim(),
			tcpHost: input.transport.tcpHost?.trim(),
			tcpPort: typeof input.transport.tcpPort === 'number' ? Math.max(1, Math.floor(input.transport.tcpPort)) : undefined,
			tcpUseDiscovery: input.transport.tcpUseDiscovery === true,
			tcpSerialNumber: input.transport.tcpSerialNumber?.trim()
		}
	};
}

function isConnectionProfile(value: unknown): value is BrickConnectionProfile {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const candidate = value as Partial<BrickConnectionProfile>;
	if (typeof candidate.brickId !== 'string' || typeof candidate.displayName !== 'string') {
		return false;
	}
	if (typeof candidate.rootPath !== 'string' || typeof candidate.savedAtIso !== 'string') {
		return false;
	}
	if (!candidate.transport || typeof candidate.transport !== 'object') {
		return false;
	}
	return true;
}

export function captureConnectionProfileFromWorkspace(
	brickId: string,
	displayName: string,
	rootPath: string
): BrickConnectionProfile {
	const cfg = vscode.workspace.getConfiguration('ev3-cockpit');
	const transportMode = sanitizeTransportMode(cfg.get('transport.mode'));
	const usbPathRaw = cfg.get('transport.usb.path');
	const bluetoothPortRaw = cfg.get('transport.bluetooth.port');
	const tcpHostRaw = cfg.get('transport.tcp.host');
	const tcpPortRaw = cfg.get('transport.tcp.port');
	const tcpSerialRaw = cfg.get('transport.tcp.serialNumber');

	return sanitizeProfile({
		brickId,
		displayName,
		savedAtIso: new Date().toISOString(),
		rootPath,
		transport: {
			mode: transportMode,
			usbPath: typeof usbPathRaw === 'string' ? usbPathRaw : undefined,
			bluetoothPort: typeof bluetoothPortRaw === 'string' ? bluetoothPortRaw : undefined,
			tcpHost: typeof tcpHostRaw === 'string' ? tcpHostRaw : undefined,
			tcpPort: typeof tcpPortRaw === 'number' && Number.isFinite(tcpPortRaw) ? tcpPortRaw : undefined,
			tcpUseDiscovery: cfg.get('transport.tcp.useDiscovery') === true,
			tcpSerialNumber: typeof tcpSerialRaw === 'string' ? tcpSerialRaw : undefined
		}
	});
}

export class BrickConnectionProfileStore {
	private readonly profilesByBrickId = new Map<string, BrickConnectionProfile>();

	public constructor(private readonly storage: Pick<vscode.Memento, 'get' | 'update'>) {
		this.loadFromStorage();
	}

	public get(brickId: string): BrickConnectionProfile | undefined {
		return this.profilesByBrickId.get(brickId);
	}

	public list(): BrickConnectionProfile[] {
		return [...this.profilesByBrickId.values()].sort((left, right) => left.displayName.localeCompare(right.displayName));
	}

	public async upsert(profile: BrickConnectionProfile): Promise<void> {
		const sanitized = sanitizeProfile(profile);
		if (!sanitized.brickId) {
			return;
		}
		this.profilesByBrickId.set(sanitized.brickId, sanitized);
		await this.saveToStorage();
	}

	private loadFromStorage(): void {
		const raw = this.storage.get<ProfileStoreShape>(PROFILE_STORE_KEY);
		if (!raw || !Array.isArray(raw.profiles)) {
			return;
		}
		for (const entry of raw.profiles) {
			if (!isConnectionProfile(entry)) {
				continue;
			}
			const sanitized = sanitizeProfile(entry);
			if (!sanitized.brickId) {
				continue;
			}
			this.profilesByBrickId.set(sanitized.brickId, sanitized);
		}
	}

	private async saveToStorage(): Promise<void> {
		await this.storage.update(PROFILE_STORE_KEY, {
			profiles: [...this.profilesByBrickId.values()]
		} as ProfileStoreShape);
	}
}
