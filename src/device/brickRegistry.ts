import type { BrickControlService } from './brickControlService';
import type { ButtonService } from './buttonService';
import type { LedService } from './ledService';
import type { MotorService } from './motorService';
import type { SensorService } from './sensorService';
import type { SoundService } from './soundService';
import type { BrickSettingsService } from './brickSettingsService';
import type { RemoteFsService } from '../fs/remoteFsService';
import type { TransportMode } from '../transport/transportFactory';

export type BrickRole = 'master' | 'slave' | 'standalone' | 'unknown';
export type BrickStatus = 'AVAILABLE' | 'CONNECTING' | 'READY' | 'UNAVAILABLE' | 'ERROR';

export interface BrickStatusChangeEvent {
	brickId: string;
	oldStatus: BrickStatus | undefined;
	newStatus: BrickStatus;
	snapshot: BrickSnapshot;
}

export type BrickRegistryListener = (event: BrickStatusChangeEvent) => void;

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
	lastOperation?: string;
	lastOperationAtIso?: string;
	busyCommandCount?: number;
	schedulerState?: string;
	fsService?: RemoteFsService;
	controlService?: BrickControlService;
	sensorService?: SensorService;
	motorService?: MotorService;
	ledService?: LedService;
	soundService?: SoundService;
	buttonService?: ButtonService;
	settingsService?: BrickSettingsService;
}

export interface BrickRuntimeReadyInput extends BrickIdentity {
	fsService: RemoteFsService;
	controlService: BrickControlService;
	sensorService?: SensorService;
	motorService?: MotorService;
	ledService?: LedService;
	soundService?: SoundService;
	buttonService?: ButtonService;
	settingsService?: BrickSettingsService;
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
	lastOperation?: string;
	lastOperationAtIso?: string;
	busyCommandCount?: number;
	schedulerState?: string;
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
		lastError: record.lastError,
		lastOperation: record.lastOperation,
		lastOperationAtIso: record.lastOperationAtIso,
		busyCommandCount: record.busyCommandCount,
		schedulerState: record.schedulerState
	};
}

export class BrickRegistry {
	private readonly records = new Map<string, BrickRuntimeRecord>();
	private activeBrickId: string | undefined;
	private readonly listeners: BrickRegistryListener[] = [];

	public onStatusChange(listener: BrickRegistryListener): () => void {
		this.listeners.push(listener);
		return () => {
			const index = this.listeners.indexOf(listener);
			if (index >= 0) {
				this.listeners.splice(index, 1);
			}
		};
	}

	private fireStatusChange(brickId: string, oldStatus: BrickStatus | undefined, newStatus: BrickStatus): void {
		const snapshot = this.getSnapshotOrThrow(brickId);
		const event: BrickStatusChangeEvent = { brickId, oldStatus, newStatus, snapshot };
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch {
				// swallow listener errors
			}
		}
	}

	private normalizeDisplayName(value: string): string {
		return value.trim();
	}

	public upsertAvailable(identity: BrickIdentity): BrickSnapshot {
		const existing = this.records.get(identity.brickId);
		if (existing && existing.status !== 'AVAILABLE') {
			const updated: BrickRuntimeRecord = {
				...existing,
				displayName: identity.displayName,
				transport: identity.transport,
				lastSeenAtIso: new Date().toISOString()
			};
			this.records.set(identity.brickId, updated);
			return cloneSnapshot(updated);
		}
		const oldStatus = existing?.status;
		this.upsertRecord({
			...identity,
			status: 'AVAILABLE',
			isActive: false,
			lastSeenAtIso: new Date().toISOString(),
			lastError: undefined,
			lastOperation: 'Discovered',
			lastOperationAtIso: new Date().toISOString(),
			busyCommandCount: 0,
			schedulerState: undefined,
			fsService: undefined,
			controlService: undefined
		});
		if (oldStatus !== 'AVAILABLE') {
			this.fireStatusChange(identity.brickId, oldStatus, 'AVAILABLE');
		}
		return this.getSnapshotOrThrow(identity.brickId);
	}

	public removeStale(activeIds: Set<string>): string[] {
		const removed: string[] = [];
		for (const [brickId, record] of this.records.entries()) {
			if (record.status === 'AVAILABLE' && !activeIds.has(brickId)) {
				this.records.delete(brickId);
				removed.push(brickId);
			}
		}
		return removed;
	}

	public upsertConnecting(identity: BrickIdentity): BrickSnapshot {
		const oldStatus = this.records.get(identity.brickId)?.status;
		this.upsertRecord({
			...identity,
			status: 'CONNECTING',
			isActive: true,
			lastSeenAtIso: new Date().toISOString(),
			lastError: undefined,
			lastOperation: 'Connecting',
			lastOperationAtIso: new Date().toISOString(),
			busyCommandCount: 0,
			schedulerState: 'idle',
			fsService: undefined,
			controlService: undefined
		});
		this.activeBrickId = identity.brickId;
		this.syncActiveFlags();
		if (oldStatus !== 'CONNECTING') {
			this.fireStatusChange(identity.brickId, oldStatus, 'CONNECTING');
		}
		return this.getSnapshotOrThrow(identity.brickId);
	}

	public upsertReady(input: BrickRuntimeReadyInput): BrickSnapshot {
		const oldStatus = this.records.get(input.brickId)?.status;
		this.upsertRecord({
			...input,
			status: 'READY',
			isActive: true,
			lastSeenAtIso: new Date().toISOString(),
			lastError: undefined,
			lastOperation: 'Connected',
			lastOperationAtIso: new Date().toISOString(),
			busyCommandCount: 0,
			schedulerState: 'idle',
			fsService: input.fsService,
			controlService: input.controlService
		});
		this.activeBrickId = input.brickId;
		this.syncActiveFlags();
		if (oldStatus !== 'READY') {
			this.fireStatusChange(input.brickId, oldStatus, 'READY');
		}
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
		const oldStatus = existing.status;
		const updated: BrickRuntimeRecord = {
			...existing,
			status: 'UNAVAILABLE',
			isActive: false,
			lastSeenAtIso: new Date().toISOString(),
			lastError: reason,
			lastOperation: 'Disconnected',
			lastOperationAtIso: new Date().toISOString(),
			busyCommandCount: 0,
			schedulerState: undefined,
			fsService: undefined,
			controlService: undefined
		};
		this.records.set(brickId, updated);

		if (this.activeBrickId === brickId) {
			this.activeBrickId = undefined;
		}
		this.syncActiveFlags();
		if (oldStatus !== 'UNAVAILABLE') {
			this.fireStatusChange(brickId, oldStatus, 'UNAVAILABLE');
		}
		return cloneSnapshot(updated);
	}

	public markError(brickId: string, reason: string): BrickSnapshot {
		const existing = this.records.get(brickId);
		const oldStatus = existing?.status;
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
			lastOperation: 'Error',
			lastOperationAtIso: new Date().toISOString(),
			busyCommandCount: 0,
			schedulerState: undefined,
			fsService: undefined,
			controlService: undefined
		};
		this.records.set(brickId, updated);
		if (oldStatus !== 'ERROR') {
			this.fireStatusChange(brickId, oldStatus, 'ERROR');
		}
		return cloneSnapshot(updated);
	}

	public updateRuntimeMetrics(
		brickId: string,
		metrics: {
			busyCommandCount?: number;
			schedulerState?: string;
		}
	): BrickSnapshot | undefined {
		const existing = this.records.get(brickId);
		if (!existing) {
			return undefined;
		}

		const nextBusy =
			typeof metrics.busyCommandCount === 'number' && Number.isFinite(metrics.busyCommandCount)
				? Math.max(0, Math.floor(metrics.busyCommandCount))
				: 0;
		const nextState =
			typeof metrics.schedulerState === 'string' && metrics.schedulerState.trim().length > 0
				? metrics.schedulerState
				: undefined;
		if (existing.busyCommandCount === nextBusy && existing.schedulerState === nextState) {
			return cloneSnapshot(existing);
		}

		const updated: BrickRuntimeRecord = {
			...existing,
			busyCommandCount: nextBusy,
			schedulerState: nextState
		};
		this.records.set(brickId, updated);
		return cloneSnapshot(updated);
	}

	public noteOperation(brickId: string, operation: string): BrickSnapshot | undefined {
		const existing = this.records.get(brickId);
		if (!existing) {
			return undefined;
		}
		const label = operation.trim();
		if (!label) {
			return cloneSnapshot(existing);
		}
		const nowIso = new Date().toISOString();
		const updated: BrickRuntimeRecord = {
			...existing,
			lastOperation: label,
			lastOperationAtIso: nowIso,
			lastSeenAtIso: nowIso
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

	public setActiveBrick(brickId: string): boolean {
		if (!this.records.has(brickId)) {
			return false;
		}
		this.activeBrickId = brickId;
		this.syncActiveFlags();
		return true;
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

	public updateDisplayName(brickId: string, displayName: string): BrickSnapshot | undefined {
		const existing = this.records.get(brickId);
		if (!existing) {
			return undefined;
		}
		const nextDisplayName = this.normalizeDisplayName(displayName);
		if (!nextDisplayName || existing.displayName === nextDisplayName) {
			return cloneSnapshot(existing);
		}
		const updated: BrickRuntimeRecord = {
			...existing,
			displayName: nextDisplayName
		};
		this.records.set(brickId, updated);
		return cloneSnapshot(updated);
	}

	public updateDisplayNameForMatching(currentDisplayName: string, nextDisplayName: string): string[] {
		const normalizedCurrent = this.normalizeDisplayName(currentDisplayName);
		const normalizedNext = this.normalizeDisplayName(nextDisplayName);
		if (!normalizedCurrent || !normalizedNext) {
			return [];
		}
		const updatedBrickIds: string[] = [];
		for (const [brickId, existing] of this.records.entries()) {
			if (this.normalizeDisplayName(existing.displayName).toLowerCase() !== normalizedCurrent.toLowerCase()) {
				continue;
			}
			if (existing.displayName === normalizedNext) {
				updatedBrickIds.push(brickId);
				continue;
			}
			this.records.set(brickId, {
				...existing,
				displayName: normalizedNext
			});
			updatedBrickIds.push(brickId);
		}
		return updatedBrickIds;
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

	public removeWhere(predicate: (record: BrickRuntimeRecord) => boolean): string[] {
		const removed: string[] = [];
		for (const [brickId, record] of this.records.entries()) {
			if (!predicate(record)) {
				continue;
			}
			this.records.delete(brickId);
			removed.push(brickId);
			if (this.activeBrickId === brickId) {
				this.activeBrickId = undefined;
			}
		}
		this.syncActiveFlags();
		return removed;
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
