import * as vscode from 'vscode';
import type { BrickConnectionProfileStore } from '../device/brickConnectionProfiles';
import type { BrickRegistry } from '../device/brickRegistry';
import type { Logger } from '../diagnostics/logger';

export interface UsbCandidate {
	path: string;
	serialNumber?: string;
}

export interface UsbAutoConnectOptions {
	listUsbHidCandidates: () => Promise<UsbCandidate[]>;
	brickRegistry: BrickRegistry;
	profileStore: BrickConnectionProfileStore;
	logger: Logger;
	intervalMs: number;
	resolveDefaultRootPath: () => string;
	toSafeIdentifier: (value: string) => string;
	connectBrick: (brickId: string) => Promise<void>;
	disconnectBrick: (brickId: string, reason: string) => Promise<void>;
	isUsbMode: () => boolean;
}

export function createUsbAutoConnectPoller(options: UsbAutoConnectOptions): vscode.Disposable {
	const {
		listUsbHidCandidates,
		brickRegistry,
		profileStore,
		logger,
		intervalMs,
		resolveDefaultRootPath,
		toSafeIdentifier,
		connectBrick,
		disconnectBrick,
		isUsbMode
	} = options;

	let disposed = false;
	let timer: NodeJS.Timeout | undefined;

	const tick = async (): Promise<void> => {
		if (disposed) {
			return;
		}
		if (!isUsbMode()) {
			scheduleNext();
			return;
		}

		let usbCandidates: UsbCandidate[] = [];
		try {
			usbCandidates = await listUsbHidCandidates();
		} catch (error) {
			logger.warn('USB auto-connect scan failed', {
				error: error instanceof Error ? error.message : String(error)
			});
			scheduleNext();
			return;
		}

		const defaultRoot = resolveDefaultRootPath();
		const nowIso = new Date().toISOString();
		const activeCandidateIds = new Set<string>();

		for (const usb of usbCandidates) {
			const usbPath = usb.path?.trim();
			if (!usbPath) {
				continue;
			}
			const brickId = `usb-${toSafeIdentifier(usbPath)}`;
			activeCandidateIds.add(brickId);
			const snapshot = brickRegistry.getSnapshot(brickId);
			if (snapshot?.status === 'READY' || snapshot?.status === 'CONNECTING') {
				continue;
			}

			const displayName = usb.serialNumber
				? `EV3 USB (${usb.serialNumber})`
				: `EV3 USB (${usbPath})`;
			await profileStore.upsert({
				brickId,
				displayName,
				savedAtIso: nowIso,
				rootPath: defaultRoot,
				transport: {
					mode: 'usb',
					usbPath
				}
			});
			logger.info('USB auto-connect: connecting detected brick', { brickId, usbPath });
			await connectBrick(brickId);
		}

		for (const snapshot of brickRegistry.listSnapshots()) {
			if (snapshot.transport !== 'usb') {
				continue;
			}
			if (!activeCandidateIds.has(snapshot.brickId)) {
				if (snapshot.status === 'READY' || snapshot.status === 'CONNECTING') {
					logger.info('USB auto-connect: disconnecting removed brick', { brickId: snapshot.brickId });
					await disconnectBrick(snapshot.brickId, 'USB device removed.');
				}
			}
		}

		scheduleNext();
	};

	const scheduleNext = (): void => {
		if (disposed) {
			return;
		}
		timer = setTimeout(() => {
			void tick();
		}, intervalMs);
		timer.unref?.();
	};

	void tick();

	return new vscode.Disposable(() => {
		disposed = true;
		if (timer) {
			clearTimeout(timer);
			timer = undefined;
		}
	});
}
