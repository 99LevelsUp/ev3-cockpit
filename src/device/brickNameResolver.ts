/**
 * Resolves display names for bricks from hardware, profiles, and user overrides.
 *
 * @packageDocumentation
 */

import { BrickRegistry } from './brickRegistry';
import type { BrickConnectionProfile, BrickConnectionProfileStore } from './brickConnectionProfiles';

export const normalizeDisplayName = (value: string | undefined): string => {
	return typeof value === 'string' ? value.trim() : '';
};

export const hasSameDisplayName = (left: string | undefined, right: string | undefined): boolean => {
	const leftName = normalizeDisplayName(left).toLowerCase();
	const rightName = normalizeDisplayName(right).toLowerCase();
	return leftName.length > 0 && leftName === rightName;
};

export interface DiscoveredProfileSource {
	listDiscoveredProfiles(): ReadonlyMap<string, BrickConnectionProfile>;
	updateDiscoveredProfile?(brickId: string, profile: BrickConnectionProfile): void;
}

export interface DisplayNamePropagationDeps {
	brickRegistry: BrickRegistry;
	profileStore: BrickConnectionProfileStore;
	discoveryService: DiscoveredProfileSource;
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
			discoveryService.updateDiscoveredProfile?.(brickId, {
				...profile,
				displayName: normalizedNext,
				savedAtIso: nowIso
			});
			updated.add(brickId);
		}
	}

	return Array.from(updated);
};
