import * as vscode from 'vscode';
import { CompatProfileMode } from '../compat/capabilityProfile';
import { DeployConfigSnapshot, readDeployConfig } from './deployConfig';
import { sanitizeBoolean, sanitizeEnum, sanitizeStringList } from './sanitizers';

export type FsMode = 'safe' | 'full';

export interface FsConfigSnapshot {
	mode: FsMode;
	defaultRoots: string[];
	fullModeConfirmationRequired: boolean;
}

export interface ExperimentalConfigSnapshot {
	connectionProfileCaching: boolean;
	treePrefetch: boolean;
	parallelUploads: boolean;
}

export interface FeatureConfigSnapshot {
	compatProfileMode: CompatProfileMode;
	fs: FsConfigSnapshot;
	deploy: DeployConfigSnapshot;
	experimental: ExperimentalConfigSnapshot;
}

export const DEFAULT_SAFE_ROOTS = ['/home/root/lms2012/prjs/', '/media/card/'];

/**
 * Recommended upload chunk sizes per transport type.
 * These are capped by the protocol maximum (DOWNLOAD_CHUNK_MAX = 1017) in remoteFsService.
 */
export interface TransportChunkConfig {
	/** Chunk size for USB HID transport (high throughput, low latency). */
	usb: number;
	/** Chunk size for Bluetooth SPP transport (limited bandwidth). */
	bluetooth: number;
	/** Chunk size for TCP transport (variable bandwidth). */
	tcp: number;
	/** Fallback chunk size when transport type is unknown. */
	fallback: number;
}

export const DEFAULT_TRANSPORT_CHUNK_BYTES: Readonly<TransportChunkConfig> = {
	usb: 1000,
	bluetooth: 512,
	tcp: 1000,
	fallback: 768
};

export type TransportType = 'usb' | 'bluetooth' | 'tcp' | 'unknown';

export function resolveTransportChunkBytes(
	transportType: TransportType,
	config: Readonly<TransportChunkConfig> = DEFAULT_TRANSPORT_CHUNK_BYTES
): number {
	switch (transportType) {
		case 'usb':
			return config.usb;
		case 'bluetooth':
			return config.bluetooth;
		case 'tcp':
			return config.tcp;
		default:
			return config.fallback;
	}
}

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
		deploy: readDeployConfig(cfg),
		experimental: {
			connectionProfileCaching: sanitizeBoolean(cfg.get('experimental.connectionProfileCaching'), false),
			treePrefetch: sanitizeBoolean(cfg.get('experimental.treePrefetch'), false),
			parallelUploads: sanitizeBoolean(cfg.get('experimental.parallelUploads'), false)
		}
	};
}
