import { BrickRegistry } from './brickRegistry';
import { BrickConnectionProfileStore } from './brickConnectionProfiles';
import { UsbHidCandidate } from '../transport/discovery';

export interface UsbReconnectDeps {
	brickRegistry: BrickRegistry;
	profileStore: BrickConnectionProfileStore;
	listUsbHidCandidates: () => Promise<UsbHidCandidate[]>;
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
