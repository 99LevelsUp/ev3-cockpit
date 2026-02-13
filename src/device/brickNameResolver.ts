import { BrickRegistry } from './brickRegistry';
import { BrickConnectionProfileStore } from './brickConnectionProfiles';
import { BrickDiscoveryService } from './brickDiscoveryService';

export const normalizeDisplayName = (value: string | undefined): string => {
	return typeof value === 'string' ? value.trim() : '';
};

export const hasSameDisplayName = (left: string | undefined, right: string | undefined): boolean => {
	const leftName = normalizeDisplayName(left).toLowerCase();
	const rightName = normalizeDisplayName(right).toLowerCase();
	return leftName.length > 0 && leftName === rightName;
};

export interface DisplayNamePropagationDeps {
	brickRegistry: BrickRegistry;
	profileStore: BrickConnectionProfileStore;
	discoveryService: BrickDiscoveryService;
}

export const applyDisplayNameAcrossProfiles = async (
	deps: DisplayNamePropagationDeps,
	primaryBrickId: string,
	previousDisplayName: string,
	nextDisplayName: string
): Promise<string[]> => {
	const { brickRegistry, profileStore, discoveryService } = deps;
	const updated = new Set<string>();
	const normalizedNext = normalizeDisplayName(nextDisplayName);
	if (!normalizedNext) {
		return [];
	}

	const updatedPrimary = brickRegistry.updateDisplayName(primaryBrickId, normalizedNext);
	if (updatedPrimary) {
		updated.add(primaryBrickId);
	}
	for (const brickId of brickRegistry.updateDisplayNameForMatching(previousDisplayName, normalizedNext)) {
		updated.add(brickId);
	}

	const nowIso = new Date().toISOString();
	for (const profile of profileStore.list()) {
		if (
			profile.brickId === primaryBrickId
			|| updated.has(profile.brickId)
			|| hasSameDisplayName(profile.displayName, previousDisplayName)
		) {
			await profileStore.upsert({
				...profile,
				displayName: normalizedNext,
				savedAtIso: nowIso
			});
			updated.add(profile.brickId);
		}
	}

	for (const [brickId, profile] of discoveryService.listDiscoveredProfiles().entries()) {
		if (
			brickId === primaryBrickId
			|| updated.has(brickId)
			|| hasSameDisplayName(profile.displayName, previousDisplayName)
		) {
			discoveryService.updateDiscoveredProfile(brickId, {
				...profile,
				displayName: normalizedNext,
				savedAtIso: nowIso
			});
			updated.add(brickId);
		}
	}

	return Array.from(updated);
};
