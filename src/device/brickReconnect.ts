/**
 * Auto-reconnection logic for disconnected bricks with transport-specific path migration.
 *
 * @packageDocumentation
 */

import { BrickRegistry } from './brickRegistry';
import { BrickConnectionProfileStore } from './brickConnectionProfiles';
import type { PresenceAggregator } from '../presence/presenceAggregator';

export interface UsbReconnectDeps {
	brickRegistry: BrickRegistry;
	profileStore: BrickConnectionProfileStore;
	presenceAggregator: PresenceAggregator;
}

export interface BtReconnectDeps {
	brickRegistry: BrickRegistry;
	profileStore: BrickConnectionProfileStore;
	presenceAggregator: PresenceAggregator;
}

export const isUsbReconnectCandidateAvailable = async (
	deps: UsbReconnectDeps,
	brickId: string
): Promise<boolean> => {
	const { brickRegistry, profileStore, presenceAggregator } = deps;
	const snapshot = brickRegistry.getSnapshot(brickId);
	if (!snapshot || snapshot.transport !== 'usb') {
		return false;
	}
	const profile = profileStore.get(brickId);
	if (!profile || profile.transport.mode !== 'usb') {
		return false;
	}
	// Check presence aggregator for live USB candidate
	if (presenceAggregator.hasLiveCandidate(brickId)) {
		const liveRecord = presenceAggregator.getLiveRecord(brickId);
		if (liveRecord?.connectionParams.mode === 'usb') {
			const livePath = liveRecord.connectionParams.usbPath;
			const configuredPath = profile.transport.usbPath?.trim() || '';
			if (livePath && livePath !== configuredPath) {
				await profileStore.upsert({
					...profile,
					savedAtIso: new Date().toISOString(),
					transport: {
						...profile.transport,
						usbPath: livePath
					}
				});
			}
			return true;
		}
	}
	return false;
};

export const isBtReconnectCandidateAvailable = async (
	deps: BtReconnectDeps,
	brickId: string
): Promise<boolean> => {
	const { brickRegistry, profileStore, presenceAggregator } = deps;
	const snapshot = brickRegistry.getSnapshot(brickId);
	if (!snapshot || snapshot.transport !== 'bt') {
		return false;
	}
	const profile = profileStore.get(brickId);
	if (!profile || profile.transport.mode !== 'bt') {
		return false;
	}
	// Check presence aggregator for live BT candidate
	if (presenceAggregator.hasLiveCandidate(brickId)) {
		const liveRecord = presenceAggregator.getLiveRecord(brickId);
		if (liveRecord?.connectionParams.mode === 'bt' && liveRecord.connectable) {
			const livePath = liveRecord.connectionParams.btPortPath;
			const configuredPort = profile.transport.btPortPath?.trim() || '';
			if (livePath && livePath !== configuredPort) {
				await profileStore.upsert({
					...profile,
					savedAtIso: new Date().toISOString(),
					transport: {
						...profile.transport,
						btPortPath: livePath
					}
				});
			}
			return true;
		}
	}
	return false;
};
