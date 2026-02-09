import * as path from 'node:path';
import { OrphanRecoveryContext, OrphanRecoveryStrategy } from '../scheduler/orphanRecovery';
import { BrickRole } from '../device/brickRegistry';
import { TransportMode } from '../transport/transportFactory';

export class LoggingOrphanRecoveryStrategy implements OrphanRecoveryStrategy {
	public constructor(private readonly log: (message: string, meta?: Record<string, unknown>) => void) {}

	public async recover(context: OrphanRecoveryContext): Promise<void> {
		this.log('Running orphan-risk recovery', {
			requestId: context.requestId,
			lane: context.lane,
			reason: context.reason
		});

		// Placeholder recovery for current MVP.
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
}

export interface ConnectedBrickDescriptor {
	brickId: string;
	displayName: string;
	role: BrickRole;
	transport: TransportMode | 'unknown';
	rootPath: string;
}

export function normalizeBrickRootPath(input: string): string {
	let rootPath = input.trim();
	if (!rootPath.startsWith('/')) {
		rootPath = `/${rootPath}`;
	}
	if (!rootPath.endsWith('/')) {
		rootPath = `${rootPath}/`;
	}
	return rootPath;
}

export function normalizeRemotePathForReveal(input: string): string {
	const normalized = path.posix.normalize(input.replace(/\\/g, '/'));
	if (normalized === '.') {
		return '/';
	}
	return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

export function toSafeIdentifier(input: string): string {
	const normalized = input
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
	return normalized.length > 0 ? normalized : 'active';
}
