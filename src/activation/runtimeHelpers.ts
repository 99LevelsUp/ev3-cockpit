import { BrickConnectionProfile } from '../device/brickConnectionProfiles';
import { BrickSnapshot } from '../device/brickRegistry';
import { TransportConfigOverrides } from '../transport/transportFactory';

export function sortBrickSnapshotsForTree(
	snapshots: readonly BrickSnapshot[],
	favoriteOrder: readonly string[]
): BrickSnapshot[] {
	const favoriteIndex = new Map<string, number>();
	for (let i = 0; i < favoriteOrder.length; i += 1) {
		favoriteIndex.set(favoriteOrder[i], i);
	}
	return snapshots
		.slice()
		.sort((left, right) => {
			const leftPinned = favoriteIndex.has(left.brickId);
			const rightPinned = favoriteIndex.has(right.brickId);
			if (leftPinned !== rightPinned) {
				return leftPinned ? -1 : 1;
			}
			if (leftPinned && rightPinned) {
				return (favoriteIndex.get(left.brickId) ?? 0) - (favoriteIndex.get(right.brickId) ?? 0);
			}
			if (left.isActive !== right.isActive) {
				return left.isActive ? -1 : 1;
			}
			return left.displayName.localeCompare(right.displayName);
		});
}

export function toTransportOverrides(profile?: BrickConnectionProfile): TransportConfigOverrides | undefined {
	if (!profile?.transport) {
		return undefined;
	}
	return {
		mode: profile.transport.mode,
		usbPath: profile.transport.usbPath,
		tcpHost: profile.transport.tcpHost,
		tcpPort: profile.transport.tcpPort,
		tcpUseDiscovery: profile.transport.tcpUseDiscovery,
		tcpSerialNumber: profile.transport.tcpSerialNumber,
		btPortPath: profile.transport.btPortPath
	};
}
