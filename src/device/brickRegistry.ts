import type { BrickControlService } from './brickControlService';
import type { RemoteFsService } from '../fs/remoteFsService';
import type { TransportMode } from '../transport/transportFactory';

export type BrickRole = 'master' | 'standalone' | 'unknown';
export type BrickStatus = 'CONNECTING' | 'READY' | 'UNAVAILABLE' | 'ERROR';

export interface BrickIdentity {
	brickId: string;
	displayName: string;
	role: BrickRole;
	transport: TransportMode | 'unknown';
	rootPath: string;
}

export interface BrickRuntimeRecord extends BrickIdentity {
	status: BrickStatus;
	isActive: boolean;
	lastSeenAtIso?: string;
	lastError?: string;
	fsService?: RemoteFsService;
	controlService?: BrickControlService;
}

export interface BrickRuntimeReadyInput extends BrickIdentity {
	fsService: RemoteFsService;
	controlService: BrickControlService;
}

export interface BrickSnapshot {
	brickId: string;
	displayName: string;
	role: BrickRole;
	transport: TransportMode | 'unknown';
	rootPath: string;
	status: BrickStatus;
	isActive: boolean;
	lastSeenAtIso?: string;
	lastError?: string;
}

function cloneSnapshot(record: BrickRuntimeRecord): BrickSnapshot {
	return {
		brickId: record.brickId,
		displayName: record.displayName,
		role: record.role,
		transport: record.transport,
		rootPath: record.rootPath,
		status: record.status,
		isActive: record.isActive,
		lastSeenAtIso: record.lastSeenAtIso,
		lastError: record.lastError
	};
}

export class BrickRegistry {
	private readonly records = new Map<string, BrickRuntimeRecord>();
	private activeBrickId: string | undefined;

	public upsertConnecting(identity: BrickIdentity): BrickSnapshot {
		this.upsertRecord({
			...identity,
			status: 'CONNECTING',
			isActive: true,
			lastSeenAtIso: new Date().toISOString(),
			lastError: undefined,
			fsService: undefined,
			controlService: undefined
		});
		this.activeBrickId = identity.brickId;
		this.syncActiveFlags();
		return this.getSnapshotOrThrow(identity.brickId);
	}

	public upsertReady(input: BrickRuntimeReadyInput): BrickSnapshot {
		this.upsertRecord({
			...input,
			status: 'READY',
			isActive: true,
			lastSeenAtIso: new Date().toISOString(),
			lastError: undefined,
			fsService: input.fsService,
			controlService: input.controlService
		});
		this.activeBrickId = input.brickId;
		this.syncActiveFlags();
		return this.getSnapshotOrThrow(input.brickId);
	}

	public markActiveUnavailable(reason?: string): BrickSnapshot | undefined {
		if (!this.activeBrickId) {
			return undefined;
		}
		return this.markUnavailable(this.activeBrickId, reason);
	}

	public markUnavailable(brickId: string, reason?: string): BrickSnapshot | undefined {
		const existing = this.records.get(brickId);
		if (!existing) {
			return undefined;
		}

		const updated: BrickRuntimeRecord = {
			...existing,
			status: 'UNAVAILABLE',
			isActive: false,
			lastSeenAtIso: new Date().toISOString(),
			lastError: reason,
			fsService: undefined,
			controlService: undefined
		};
		this.records.set(brickId, updated);

		if (this.activeBrickId === brickId) {
			this.activeBrickId = undefined;
		}
		this.syncActiveFlags();
		return cloneSnapshot(updated);
	}

	public markError(brickId: string, reason: string): BrickSnapshot {
		const existing = this.records.get(brickId);
		const fallback: BrickRuntimeRecord =
			existing ?? {
				brickId,
				displayName: `EV3 (${brickId})`,
				role: 'unknown',
				transport: 'unknown',
				rootPath: '/home/root/lms2012/prjs/',
				status: 'ERROR',
				isActive: false
			};

		const updated: BrickRuntimeRecord = {
			...fallback,
			status: 'ERROR',
			isActive: this.activeBrickId === brickId,
			lastSeenAtIso: new Date().toISOString(),
			lastError: reason,
			fsService: undefined,
			controlService: undefined
		};
		this.records.set(brickId, updated);
		return cloneSnapshot(updated);
	}

	public markAllUnavailable(reason: string): void {
		for (const brickId of this.records.keys()) {
			this.markUnavailable(brickId, reason);
		}
		this.activeBrickId = undefined;
		this.syncActiveFlags();
	}

	public getActiveBrickId(): string | undefined {
		return this.activeBrickId;
	}

	public getActiveFsService(): RemoteFsService | undefined {
		if (!this.activeBrickId) {
			return undefined;
		}
		return this.records.get(this.activeBrickId)?.fsService;
	}

	public getActiveControlService(): BrickControlService | undefined {
		if (!this.activeBrickId) {
			return undefined;
		}
		return this.records.get(this.activeBrickId)?.controlService;
	}

	public getSnapshot(brickId: string): BrickSnapshot | undefined {
		const record = this.records.get(brickId);
		return record ? cloneSnapshot(record) : undefined;
	}

	public listSnapshots(): BrickSnapshot[] {
		const snapshots = [...this.records.values()].map((entry) => cloneSnapshot(entry));
		snapshots.sort((left, right) => {
			if (left.isActive !== right.isActive) {
				return left.isActive ? -1 : 1;
			}
			return left.displayName.localeCompare(right.displayName);
		});
		return snapshots;
	}

	public resolveFsService(brickId: string): RemoteFsService | undefined {
		const targetBrickId = brickId === 'active' ? this.activeBrickId : brickId;
		if (!targetBrickId) {
			return undefined;
		}
		return this.records.get(targetBrickId)?.fsService;
	}

	public resolveControlService(brickId: string): BrickControlService | undefined {
		const targetBrickId = brickId === 'active' ? this.activeBrickId : brickId;
		if (!targetBrickId) {
			return undefined;
		}
		return this.records.get(targetBrickId)?.controlService;
	}

	private upsertRecord(record: BrickRuntimeRecord): void {
		this.records.set(record.brickId, record);
	}

	private syncActiveFlags(): void {
		for (const [brickId, record] of this.records.entries()) {
			if (record.isActive !== (brickId === this.activeBrickId)) {
				this.records.set(brickId, {
					...record,
					isActive: brickId === this.activeBrickId
				});
			}
		}
	}

	private getSnapshotOrThrow(brickId: string): BrickSnapshot {
		const snapshot = this.getSnapshot(brickId);
		if (!snapshot) {
			throw new Error(`Brick snapshot missing for ${brickId}.`);
		}
		return snapshot;
	}
}
