export type ProgramSessionSource =
	| 'deploy-and-run-single'
	| 'deploy-project-run'
	| 'remote-fs-run'
	| 'run-command'
	| 'restart-command';

export interface ProgramSessionState {
	remotePath: string;
	startedAtIso: string;
	transportMode: string;
	source: ProgramSessionSource;
}

export interface RuntimeSchedulerLike {
	dispose(): void;
	getState(): string;
	getQueueSize(): number;
}

export interface RuntimeCommandClientLike {
	close(): Promise<void>;
}

export interface BrickRuntimeSession<
	TScheduler extends RuntimeSchedulerLike = RuntimeSchedulerLike,
	TCommandClient extends RuntimeCommandClientLike = RuntimeCommandClientLike
> {
	brickId: string;
	scheduler: TScheduler;
	commandClient: TCommandClient;
}

export interface BrickRuntimeSnapshot {
	brickId: string;
	schedulerState: string;
	queuedCommands: number;
	busyCommandCount: number;
}

export interface BrickProgramSnapshot {
	brickId: string;
	lastRunProgramPath?: string;
	programSession?: ProgramSessionState;
}

export interface ProgramSessionClearResult {
	scope: 'all' | 'single';
	brickId?: string;
	removedPath?: string;
	removedSession?: ProgramSessionState;
}

function toBusyCommandCount(schedulerState: string, queuedCommands: number): number {
	if (schedulerState === 'running') {
		return Math.max(0, queuedCommands) + 1;
	}
	return Math.max(0, queuedCommands);
}

export class BrickSessionManager<
	TScheduler extends RuntimeSchedulerLike = RuntimeSchedulerLike,
	TCommandClient extends RuntimeCommandClientLike = RuntimeCommandClientLike
> {
	private readonly brickSessions = new Map<string, BrickRuntimeSession<TScheduler, TCommandClient>>();
	private readonly lastRunProgramPathByBrick = new Map<string, string>();
	private readonly programSessionByBrick = new Map<string, ProgramSessionState>();

	public constructor(private readonly createSession: (brickId: string) => BrickRuntimeSession<TScheduler, TCommandClient>) {}

	public async prepareSession(brickId: string): Promise<TCommandClient> {
		await this.closeSession(brickId);
		const session = this.createSession(brickId);
		this.brickSessions.set(brickId, session);
		return session.commandClient;
	}

	public getSession(brickId: string): BrickRuntimeSession<TScheduler, TCommandClient> | undefined {
		return this.brickSessions.get(brickId);
	}

	public isSessionAvailable(brickId: string): boolean {
		return this.brickSessions.has(brickId);
	}

	public async closeSession(brickId: string): Promise<void> {
		const session = this.brickSessions.get(brickId);
		if (!session) {
			return;
		}

		this.brickSessions.delete(brickId);
		session.scheduler.dispose();
		await session.commandClient.close().catch(() => undefined);
	}

	public async closeAllSessions(): Promise<void> {
		const brickIds = [...this.brickSessions.keys()];
		for (const brickId of brickIds) {
			await this.closeSession(brickId);
		}
	}

	public listSessionBrickIds(): string[] {
		return [...this.brickSessions.keys()].sort((left, right) => left.localeCompare(right));
	}

	public getRuntimeSnapshot(brickId: string): BrickRuntimeSnapshot | undefined {
		const session = this.brickSessions.get(brickId);
		if (!session) {
			return undefined;
		}

		const schedulerState = session.scheduler.getState();
		const queuedCommands = session.scheduler.getQueueSize();
		return {
			brickId,
			schedulerState,
			queuedCommands,
			busyCommandCount: toBusyCommandCount(schedulerState, queuedCommands)
		};
	}

	public listRuntimeSnapshots(): BrickRuntimeSnapshot[] {
		return this.listSessionBrickIds()
			.map((brickId) => this.getRuntimeSnapshot(brickId))
			.filter((snapshot): snapshot is BrickRuntimeSnapshot => snapshot !== undefined);
	}

	public markProgramStarted(
		brickId: string,
		remotePath: string,
		source: ProgramSessionSource,
		transportMode: string
	): ProgramSessionState {
		this.lastRunProgramPathByBrick.set(brickId, remotePath);
		const session: ProgramSessionState = {
			remotePath,
			startedAtIso: new Date().toISOString(),
			transportMode,
			source
		};
		this.programSessionByBrick.set(brickId, session);
		return session;
	}

	public clearProgramSession(brickId?: string): ProgramSessionClearResult | undefined {
		if (!brickId) {
			if (this.lastRunProgramPathByBrick.size === 0 && this.programSessionByBrick.size === 0) {
				return undefined;
			}
			this.lastRunProgramPathByBrick.clear();
			this.programSessionByBrick.clear();
			return {
				scope: 'all'
			};
		}

		const removedPath = this.lastRunProgramPathByBrick.get(brickId);
		const removedSession = this.programSessionByBrick.get(brickId);
		this.lastRunProgramPathByBrick.delete(brickId);
		this.programSessionByBrick.delete(brickId);
		if (!removedPath && !removedSession) {
			return undefined;
		}
		return {
			scope: 'single',
			brickId,
			removedPath,
			removedSession
		};
	}

	public getLastRunProgramPath(brickId: string): string | undefined {
		return this.lastRunProgramPathByBrick.get(brickId);
	}

	public getRestartCandidatePath(brickId: string): string | undefined {
		return this.programSessionByBrick.get(brickId)?.remotePath ?? this.lastRunProgramPathByBrick.get(brickId);
	}

	public listProgramSnapshots(): BrickProgramSnapshot[] {
		const brickIds = new Set<string>([
			...this.lastRunProgramPathByBrick.keys(),
			...this.programSessionByBrick.keys()
		]);
		return [...brickIds]
			.sort((left, right) => left.localeCompare(right))
			.map((brickId) => ({
				brickId,
				lastRunProgramPath: this.lastRunProgramPathByBrick.get(brickId),
				programSession: this.programSessionByBrick.get(brickId)
			}));
	}
}
