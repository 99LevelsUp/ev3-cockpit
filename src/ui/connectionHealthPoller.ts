import * as vscode from 'vscode';
import { BrickRegistry } from '../device/brickRegistry';
import type { Logger } from '../diagnostics/logger';
import type { Ev3CommandRequest } from '../protocol/ev3CommandClient';
import { EV3_COMMAND, EV3_REPLY } from '../protocol/ev3Packet';
import { BrickTreeProvider } from './brickTreeProvider';

interface ProbeCommandResult {
	reply: {
		type: number;
		payload: Uint8Array;
	};
}

interface ConnectionHealthCommandClientLike {
	send(request: Ev3CommandRequest): Promise<ProbeCommandResult>;
}

export interface ConnectionHealthSessionSource {
	listSessionBrickIds(): string[];
	getSession(brickId: string): { commandClient: ConnectionHealthCommandClientLike } | undefined;
	closeSession(brickId: string): Promise<void>;
	getRuntimeSnapshot(brickId: string): { busyCommandCount: number; schedulerState?: string } | undefined;
}

export interface ConnectionHealthPollerOptions {
	activeIntervalMs?: number;
	idleIntervalMs?: number;
	probeTimeoutMs?: number;
	reconnectIntervalMs?: number;
	onDisconnected?: (brickId: string, reason: string) => void;
	onReconnectRequested?: (brickId: string) => Promise<void> | void;
	logger?: Logger;
}

const PROBE_COMMAND = 0x9d;

function toErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

async function runConnectionProbe(
	commandClient: ConnectionHealthCommandClientLike,
	brickId: string,
	timeoutMs: number
): Promise<void> {
	const result = await commandClient.send({
		id: `connection-health-${brickId}-${Date.now().toString(36)}`,
		lane: 'high',
		idempotent: true,
		timeoutMs,
		type: EV3_COMMAND.SYSTEM_COMMAND_REPLY,
		payload: new Uint8Array([PROBE_COMMAND])
	});
	const replyType = result.reply.type;
	if (replyType !== EV3_REPLY.SYSTEM_REPLY && replyType !== EV3_REPLY.SYSTEM_REPLY_ERROR) {
		throw new Error(`Unexpected probe reply type 0x${replyType.toString(16)}.`);
	}
	if (result.reply.payload.length < 2) {
		throw new Error('Probe reply payload is too short.');
	}
	const echoedCommand = result.reply.payload[0];
	const status = result.reply.payload[1];
	if (echoedCommand !== PROBE_COMMAND) {
		throw new Error(
			`Probe reply command mismatch: expected 0x${PROBE_COMMAND.toString(16)}, got 0x${echoedCommand.toString(16)}.`
		);
	}
	if (replyType === EV3_REPLY.SYSTEM_REPLY_ERROR || status !== 0x00) {
		throw new Error(`Probe reply returned status 0x${status.toString(16)}.`);
	}
}

export function createConnectionHealthPoller(
	brickRegistry: BrickRegistry,
	sessionSource: ConnectionHealthSessionSource,
	treeProvider: BrickTreeProvider,
	options?: ConnectionHealthPollerOptions
): vscode.Disposable {
	const activeIntervalMs =
		typeof options?.activeIntervalMs === 'number' && Number.isFinite(options.activeIntervalMs)
			? Math.max(150, Math.floor(options.activeIntervalMs))
			: 500;
	const idleIntervalMs =
		typeof options?.idleIntervalMs === 'number' && Number.isFinite(options.idleIntervalMs)
			? Math.max(500, Math.floor(options.idleIntervalMs))
			: 2_000;
	const probeTimeoutMs =
		typeof options?.probeTimeoutMs === 'number' && Number.isFinite(options.probeTimeoutMs)
			? Math.max(100, Math.floor(options.probeTimeoutMs))
			: 700;
	const reconnectIntervalMs =
		typeof options?.reconnectIntervalMs === 'number' && Number.isFinite(options.reconnectIntervalMs)
			? Math.max(500, Math.floor(options.reconnectIntervalMs))
			: Math.max(1_000, activeIntervalMs * 2);

	let disposed = false;
	let timer: NodeJS.Timeout | undefined;
	const inFlight = new Set<string>();
	const reconnectInFlight = new Set<string>();
	const lastReconnectAttemptByBrickId = new Map<string, number>();

	const isConnectedSnapshot = (brickId: string): boolean => {
		const snapshot = brickRegistry.getSnapshot(brickId);
		return snapshot?.status === 'READY' || snapshot?.status === 'CONNECTING';
	};

	const shouldProbe = (brickId: string): boolean => {
		if (!isConnectedSnapshot(brickId)) {
			return false;
		}
		const runtime = sessionSource.getRuntimeSnapshot(brickId);
		if (!runtime) {
			return false;
		}
		// Avoid probe contention with active command traffic.
		if (runtime.busyCommandCount > 0) {
			return false;
		}
		return true;
	};

	const markDisconnected = async (brickId: string, reason: string): Promise<void> => {
		try {
			await sessionSource.closeSession(brickId);
		} catch (closeError) {
			options?.logger?.debug('Connection health closeSession failed.', {
				brickId,
				error: toErrorMessage(closeError)
			});
		}
		const updated = brickRegistry.markUnavailable(brickId, reason);
		if (!updated) {
			return;
		}
		options?.logger?.info('Connection health marked Brick unavailable.', {
			brickId,
			reason
		});
		treeProvider.refreshBrick(brickId);
		options?.onDisconnected?.(brickId, reason);
	};

	const probeBrickIfNeeded = async (brickId: string): Promise<void> => {
		if (!shouldProbe(brickId) || inFlight.has(brickId)) {
			return;
		}
		const session = sessionSource.getSession(brickId);
		if (!session) {
			return;
		}
		inFlight.add(brickId);
		try {
			await runConnectionProbe(session.commandClient, brickId, probeTimeoutMs);
		} catch (error) {
			const reason = `Connection lost: ${toErrorMessage(error)}`;
			await markDisconnected(brickId, reason);
		} finally {
			inFlight.delete(brickId);
		}
	};

	const isRecoverableUnavailable = (brickId: string): boolean => {
		const snapshot = brickRegistry.getSnapshot(brickId);
		if (snapshot?.status !== 'UNAVAILABLE') {
			return false;
		}
		const reason = (snapshot.lastError ?? '').trim();
		return reason.startsWith('Connection lost:');
	};

	const maybeRequestReconnect = async (brickId: string): Promise<void> => {
		if (!options?.onReconnectRequested) {
			return;
		}
		if (!isRecoverableUnavailable(brickId)) {
			return;
		}
		if (reconnectInFlight.has(brickId)) {
			return;
		}
		const now = Date.now();
		const lastAttempt = lastReconnectAttemptByBrickId.get(brickId) ?? 0;
		if (now - lastAttempt < reconnectIntervalMs) {
			return;
		}
		lastReconnectAttemptByBrickId.set(brickId, now);
		reconnectInFlight.add(brickId);
		try {
			await options.onReconnectRequested(brickId);
		} catch (error) {
			options?.logger?.debug('Connection health auto-reconnect request failed.', {
				brickId,
				error: toErrorMessage(error)
			});
		} finally {
			reconnectInFlight.delete(brickId);
		}
	};

	const tick = async (): Promise<void> => {
		if (disposed) {
			return;
		}

		const snapshots = brickRegistry.listSnapshots();
		const hasConnectedSnapshot = snapshots.some(
			(snapshot) => snapshot.status === 'READY' || snapshot.status === 'CONNECTING'
		);
		const brickIds = sessionSource.listSessionBrickIds();
		await Promise.all(brickIds.map((brickId) => probeBrickIfNeeded(brickId)));
		const unavailableBrickIds = snapshots
			.filter((snapshot) => snapshot.status === 'UNAVAILABLE')
			.map((snapshot) => snapshot.brickId);
		await Promise.all(unavailableBrickIds.map((brickId) => maybeRequestReconnect(brickId)));

		if (disposed) {
			return;
		}
		const nextDelay = hasConnectedSnapshot ? activeIntervalMs : idleIntervalMs;
		timer = setTimeout(() => {
			void tick();
		}, nextDelay);
		timer.unref?.();
	};

	void tick();

	return new vscode.Disposable(() => {
		disposed = true;
		if (timer) {
			clearTimeout(timer);
			timer = undefined;
		}
	});
}
