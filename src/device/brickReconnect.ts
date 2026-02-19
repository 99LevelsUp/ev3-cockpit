import { BrickRegistry } from './brickRegistry';
import { BrickConnectionProfileStore } from './brickConnectionProfiles';
import { UsbHidCandidate } from '../transport/discovery';
import type { BluetoothCandidate } from '../transport/discovery';

export interface UsbReconnectDeps {
	brickRegistry: BrickRegistry;
	profileStore: BrickConnectionProfileStore;
	listUsbHidCandidates: () => Promise<UsbHidCandidate[]>;
}

export interface BtReconnectDeps {
	brickRegistry: BrickRegistry;
	profileStore: BrickConnectionProfileStore;
	listBluetoothCandidates: () => Promise<BluetoothCandidate[]>;
}

export const isUsbReconnectCandidateAvailable = async (
	deps: UsbReconnectDeps,
	brickId: string
): Promise<boolean> => {
	const { brickRegistry, profileStore, listUsbHidCandidates } = deps;
	const snapshot = brickRegistry.getSnapshot(brickId);
	if (!snapshot || snapshot.transport !== 'usb') {
		return false;
	}
	const profile = profileStore.get(brickId);
	if (!profile || profile.transport.mode !== 'usb') {
		return false;
	}
	const usbCandidates = await listUsbHidCandidates();
	if (usbCandidates.length === 0) {
		return false;
	}
	const configuredPath = profile.transport.usbPath?.trim() || '';
	let selectedPath =
		configuredPath
			? usbCandidates
				.map((candidate) => candidate.path.trim())
				.find((path) => path === configuredPath)
			: undefined;
	if (!selectedPath) {
		if (usbCandidates.length !== 1) {
			return false;
		}
		selectedPath = usbCandidates[0]?.path.trim();
	}
	if (!selectedPath) {
		return false;
	}
	if (selectedPath !== configuredPath) {
		await profileStore.upsert({
			...profile,
			savedAtIso: new Date().toISOString(),
			transport: {
				...profile.transport,
				usbPath: selectedPath
			}
		});
	}
	return true;
};

export const isBtReconnectCandidateAvailable = async (
	deps: BtReconnectDeps,
	brickId: string
): Promise<boolean> => {
	const { brickRegistry, profileStore, listBluetoothCandidates } = deps;
	const snapshot = brickRegistry.getSnapshot(brickId);
	if (!snapshot || snapshot.transport !== 'bt') {
		return false;
	}
	const profile = profileStore.get(brickId);
	if (!profile || profile.transport.mode !== 'bt') {
		return false;
	}
	const btCandidates = await listBluetoothCandidates();
	const connectableBtCandidates = btCandidates.filter((candidate) => (
		candidate.connectable !== false && /^COM\d+$/i.test(candidate.path.trim())
	));
	if (connectableBtCandidates.length === 0) {
		return false;
	}
	const configuredPort = profile.transport.btPortPath?.trim() || '';

	// Try to match by MAC (from brickId) or by configured COM path
	const macFromId = brickId.startsWith('bt-') ? brickId.slice(3) : undefined;
	const matchByMac = macFromId && macFromId.length === 12
		? connectableBtCandidates.find((c) => c.mac === macFromId)
		: undefined;

	if (matchByMac) {
		const newPath = matchByMac.path.trim();
		if (newPath && newPath !== configuredPort) {
			await profileStore.upsert({
				...profile,
				savedAtIso: new Date().toISOString(),
				transport: {
					...profile.transport,
					btPortPath: newPath
				}
			});
		}
		return true;
	}

	// Fall back to matching by configured COM path
	if (configuredPort) {
		const matchByPath = connectableBtCandidates.find((c) => c.path.trim() === configuredPort);
		if (matchByPath) {
			return true;
		}
	}

	// If exactly one BT candidate, use it
	if (connectableBtCandidates.length === 1) {
		const singlePath = connectableBtCandidates[0].path.trim();
		if (singlePath && singlePath !== configuredPort) {
			await profileStore.upsert({
				...profile,
				savedAtIso: new Date().toISOString(),
				transport: {
					...profile.transport,
					btPortPath: singlePath
				}
			});
		}
		return !!singlePath;
	}

	return false;
};
