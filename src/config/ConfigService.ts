import { FeatureConfigSnapshot, readFeatureConfig } from './featureConfig';
import { SchedulerConfigSnapshot, readSchedulerConfig } from './schedulerConfig';

/**
 * Konsolidovaný snapshot všech konfiguračních sekcí rozšíření.
 */
export interface ExtensionConfig {
	scheduler: SchedulerConfigSnapshot;
	feature: FeatureConfigSnapshot;
}

/**
 * Načte všechny konfigurace najednou – deleguje na stávající čtecí funkce.
 */
export function readExtensionConfig(): ExtensionConfig {
	return {
		scheduler: readSchedulerConfig(),
		feature: readFeatureConfig()
	};
}
