/**
 * Consolidated configuration reader that delegates to individual config readers.
 *
 * @packageDocumentation
 */

import { FeatureConfigSnapshot, readFeatureConfig } from './featureConfig';
import { SchedulerConfigSnapshot, readSchedulerConfig } from './schedulerConfig';

/**
 * Consolidated snapshot of all extension configuration sections.
 */
export interface ExtensionConfig {
	scheduler: SchedulerConfigSnapshot;
	feature: FeatureConfigSnapshot;
}

/**
 * Reads all configuration sections at once by delegating to individual read functions.
 */
export function readExtensionConfig(): ExtensionConfig {
	return {
		scheduler: readSchedulerConfig(),
		feature: readFeatureConfig()
	};
}
