import { BrickConnectionProfileStore } from '../device/brickConnectionProfiles';
import { BrickRegistry } from '../device/brickRegistry';
import { Logger } from '../diagnostics/logger';
import { Ev3FileSystemProvider, FsAvailabilityError } from '../fs/ev3FileSystemProvider';
import { MockPresenceSource } from '../presence/mockPresenceSource';
import { PresenceAggregator } from '../presence/presenceAggregator';
import { BtPresenceSource } from '../presence/btPresenceSource';
import { TcpPresenceSource } from '../presence/tcpPresenceSource';
import { UsbPresenceSource } from '../presence/usbPresenceSource';

export interface PresenceRuntimeOptions {
	brickRegistry: BrickRegistry;
	profileStore: BrickConnectionProfileStore;
	logger: Logger;
	toSafeIdentifier: (value: string) => string;
	defaultRootPath: string;
	enableHardwarePresence: boolean;
}

export interface PresenceRuntime {
	presenceAggregator: PresenceAggregator;
	mockPresenceSource: MockPresenceSource;
}

export function createPresenceRuntime(options: PresenceRuntimeOptions): PresenceRuntime {
	const usbPresenceSource = new UsbPresenceSource(
		{ pollIntervalMs: 500, nameProbeIntervalMs: 15000, vendorId: 0x0694, productId: 0x0005, toSafeIdentifier: options.toSafeIdentifier },
		options.logger
	);
	const tcpPresenceSource = new TcpPresenceSource(
		{ discoveryPort: 3015, toSafeIdentifier: options.toSafeIdentifier },
		options.logger
	);
	const btPresenceSource = new BtPresenceSource(
		{ fastIntervalMs: 1000, inquiryIntervalMs: 30000, toSafeIdentifier: options.toSafeIdentifier },
		options.logger
	);
	const mockPresenceSource = new MockPresenceSource();
	const usbGoneTtlMs = process.platform === 'win32' ? 15_000 : 3_000;
	const presenceAggregator = new PresenceAggregator(
		{
			brickRegistry: options.brickRegistry,
			profileStore: options.profileStore,
			logger: options.logger,
			toSafeIdentifier: options.toSafeIdentifier
		},
		{
			goneTtl: { usb: usbGoneTtlMs, bt: 45000, tcp: 10000, mock: Infinity },
			reaperIntervalMs: 1000,
			defaultRootPath: options.defaultRootPath,
			candidateChangeCoalesceMs: 75
		}
	);
	if (options.enableHardwarePresence) {
		presenceAggregator.addSource(usbPresenceSource);
		presenceAggregator.addSource(tcpPresenceSource);
		presenceAggregator.addSource(btPresenceSource);
	}
	presenceAggregator.addSource(mockPresenceSource);
	presenceAggregator.start();
	return { presenceAggregator, mockPresenceSource };
}

export function createFsProvider(brickRegistry: BrickRegistry): Ev3FileSystemProvider {
	return new Ev3FileSystemProvider(async (brickId) => {
		const resolved = brickRegistry.resolveFsService(brickId);
		if (resolved) {
			return resolved;
		}

		if (brickId === 'active') {
			throw new FsAvailabilityError(
				'NO_ACTIVE_BRICK',
				'No active EV3 connection for filesystem access. Run "EV3 Cockpit: Connect to EV3 Brick".'
			);
		}

		const snapshot = brickRegistry.getSnapshot(brickId);
		if (snapshot) {
			throw new FsAvailabilityError(
				'BRICK_UNAVAILABLE',
				`Brick "${brickId}" is currently ${snapshot.status.toLowerCase()}.`
			);
		}

		throw new FsAvailabilityError(
			'BRICK_NOT_REGISTERED',
			`Brick "${brickId}" is not registered. Connect it first or use ev3://active/...`
		);
	});
}
