import * as vscode from 'vscode';
import { CompatProfileMode } from '../compat/capabilityProfile';
import { DeployConfigSnapshot, readDeployConfig } from './deployConfig';
import { sanitizeEnum, sanitizeStringList } from './sanitizers';

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

const FS_MODES: readonly FsMode[] = ['safe', 'full'];
const COMPAT_PROFILE_MODES: readonly CompatProfileMode[] = ['auto', 'stock-strict'];

function sanitizeRoots(value: unknown): string[] {
	const cleaned = sanitizeStringList(value);
	return cleaned.length > 0 ? cleaned : [...DEFAULT_SAFE_ROOTS];
}

export function readFeatureConfig(): FeatureConfigSnapshot {
	const cfg = vscode.workspace.getConfiguration('ev3-cockpit');

	return {
		compatProfileMode: sanitizeEnum(cfg.get('compat.profile'), COMPAT_PROFILE_MODES, 'auto'),
		fs: {
			mode: sanitizeEnum(cfg.get('fs.mode'), FS_MODES, 'safe'),
			defaultRoots: sanitizeRoots(cfg.get('fs.defaultRoots')),
			fullModeConfirmationRequired: cfg.get('fs.fullMode.confirmationRequired', true)
		},
		deploy: readDeployConfig(cfg)
	};
}
