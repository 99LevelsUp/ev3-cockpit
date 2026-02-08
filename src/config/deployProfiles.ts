export type DeployProfileId = 'safe-sync' | 'atomic-sync' | 'full-sync';

export interface DeployProfilePreset {
	id: DeployProfileId;
	label: string;
	description: string;
	detail: string;
	settings: Record<string, string | boolean | number>;
}

export const DEPLOY_PROFILE_PRESETS: readonly DeployProfilePreset[] = [
	{
		id: 'safe-sync',
		label: 'Safe Sync',
		description: 'safe FS + incremental upload',
		detail: 'Balanced default for regular project sync to EV3 safe roots.',
		settings: {
			'fs.mode': 'safe',
			'deploy.atomic.enabled': false,
			'deploy.incremental.enabled': true,
			'deploy.cleanup.enabled': false,
			'deploy.verifyAfterUpload': 'size',
			'deploy.conflictPolicy': 'overwrite',
			'deploy.resilience.enabled': true
		}
	},
	{
		id: 'atomic-sync',
		label: 'Atomic Sync',
		description: 'safe FS + staged swap',
		detail: 'Uploads to staging root and swaps project atomically with rollback fallback.',
		settings: {
			'fs.mode': 'safe',
			'deploy.atomic.enabled': true,
			'deploy.incremental.enabled': false,
			'deploy.cleanup.enabled': false,
			'deploy.verifyAfterUpload': 'md5',
			'deploy.conflictPolicy': 'overwrite',
			'deploy.resilience.enabled': true
		}
	},
	{
		id: 'full-sync',
		label: 'Full Sync',
		description: 'full FS + cleanup',
		detail: 'For advanced sync/cleanup workflows outside safe roots (confirmation may be required).',
		settings: {
			'fs.mode': 'full',
			'deploy.atomic.enabled': false,
			'deploy.incremental.enabled': false,
			'deploy.cleanup.enabled': true,
			'deploy.cleanup.confirmBeforeDelete': true,
			'deploy.verifyAfterUpload': 'md5',
			'deploy.conflictPolicy': 'overwrite',
			'deploy.resilience.enabled': true
		}
	}
];

export function resolveDeployProfilePreset(id: DeployProfileId): DeployProfilePreset {
	const preset = DEPLOY_PROFILE_PRESETS.find((entry) => entry.id === id);
	if (!preset) {
		throw new Error(`Unknown deploy profile preset "${id}".`);
	}
	return preset;
}

