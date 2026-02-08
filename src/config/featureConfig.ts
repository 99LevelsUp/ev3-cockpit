import * as vscode from 'vscode';
import { CompatProfileMode } from '../compat/capabilityProfile';
import { DeployConfigSnapshot, readDeployConfig } from './deployConfig';

export type FsMode = 'safe' | 'full';

export interface FsConfigSnapshot {
	mode: FsMode;
	defaultRoots: string[];
	fullModeConfirmationRequired: boolean;
}

export interface FeatureConfigSnapshot {
	compatProfileMode: CompatProfileMode;
	fs: FsConfigSnapshot;
	deploy: DeployConfigSnapshot;
}

export const DEFAULT_SAFE_ROOTS = ['/home/root/lms2012/prjs/', '/media/card/'];

function sanitizeFsMode(value: unknown): FsMode {
	if (value === 'safe' || value === 'full') {
		return value;
	}
	return 'safe';
}

function sanitizeCompatProfileMode(value: unknown): CompatProfileMode {
	if (value === 'auto' || value === 'stock-strict') {
		return value;
	}
	return 'auto';
}

function sanitizeRoots(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [...DEFAULT_SAFE_ROOTS];
	}

	const cleaned = value
		.filter((entry): entry is string => typeof entry === 'string')
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);

	return cleaned.length > 0 ? cleaned : [...DEFAULT_SAFE_ROOTS];
}

export function readFeatureConfig(): FeatureConfigSnapshot {
	const cfg = vscode.workspace.getConfiguration('ev3-cockpit');

	return {
		compatProfileMode: sanitizeCompatProfileMode(cfg.get('compat.profile')),
		fs: {
			mode: sanitizeFsMode(cfg.get('fs.mode')),
			defaultRoots: sanitizeRoots(cfg.get('fs.defaultRoots')),
			fullModeConfirmationRequired: cfg.get('fs.fullMode.confirmationRequired', true)
		},
		deploy: readDeployConfig(cfg)
	};
}
