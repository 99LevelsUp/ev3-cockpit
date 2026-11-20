/**
 * A development daemon's one contact with the user's daemon (KTD17, R34): a `peer` connection that
 * says which bricks the user's daemon holds, and borrows bricks from it.
 *
 * The development daemon shows the user's held bricks as blocked, naming the holding clients, the
 * way a brick held in a Bluetooth chain is shown. Connecting a brick borrows it first; `borrowAll`
 * borrows everything. When the user's daemon goes, the development daemon takes the hardware lock
 * if it can and owns the hardware from then on.
 *
 * The connection never starts the user's daemon and never registers a replacement of it.
 */

import { ContractError, Endpoint } from '../client/connection';
import { connectToDaemon } from '../client/ensureDaemon';
import { WireErrorCode } from '../contract/errors';
import type { LoanResult } from '../contract/methods';
import type { BrickStatus } from '../contract/models';
import type { Runtime } from '../core/runtime/createRuntime';
import type { LoanGate } from '../core/runtime/deviceGate';
import type { DaemonPaths } from './paths';
import type { Surface, SurfaceLoans } from './surface';

/** How often a development daemon looks for the user's daemon, or for a free hardware lock. */
export const PEER_RETRY_MS = 2000;

const HELD_THERE = 'held by the user\'s cockpit daemon';

export interface PeerLinkDeps {
	/** Where the user's own daemon listens. */
	readonly userPaths: DaemonPaths;
	readonly name: string;
	readonly version: string;
	readonly gate: LoanGate;
	readonly surface: Surface;
	readonly runtime: Runtime;
	readonly log: { info(message: string): void; warn(message: string): void; debug(message: string): void };
	/** Tries the hardware lock: true when this daemon owns the hardware now. */
	readonly takeHardware: () => boolean;
}

export class PeerLink implements SurfaceLoans {
	private endpoint: Endpoint | undefined;
	private timer: NodeJS.Timeout | undefined;
	private disposed = false;
	private refreshing = false;
	private refreshAgain = false;
	/** The first look for the user's daemon: a borrow at start waits for it rather than finding no link. */
	private firstAttempt: Promise<void> = Promise.resolve();

	constructor(private readonly deps: PeerLinkDeps) {}

	start(): void {
		this.firstAttempt = this.connect();
	}

	dispose(): void {
		this.disposed = true;
		if (this.timer) { clearTimeout(this.timer); }
		this.endpoint?.close();
	}

	async ensureOpenable(brickId: string): Promise<void> {
		const { gate, surface } = this.deps;
		if (gate.allowsBrick(brickId)) { return; }
		await this.firstAttempt;
		if (gate.allowsBrick(brickId)) { return; }
		if (!this.endpoint) {
			throw new ContractError(WireErrorCode.NotConnected,
				`Brick ${brickId} belongs to the user's cockpit daemon, which this development daemon cannot reach to borrow it.`);
		}
		const result = await this.endpoint.request<LoanResult>('peer/borrowBrick', { brickId });
		if (!result.lent) {
			throw new ContractError(WireErrorCode.BrickBusy,
				`The user's cockpit daemon did not lend ${brickId}${result.refusedBy ? `: ${result.refusedBy} ${result.reason ?? 'refused'}` : result.reason ? `: ${result.reason}` : ''}.`,
				{ kind: 'BrickBusyError', ...(result.refusedBy ? { holder: result.refusedBy } : {}) });
		}
		gate.add(brickId, result.usb ?? []);
		surface.blocked.delete(brickId);
		surface.refreshBricks();
		this.deps.log.info(`Borrowed ${brickId} from the user's daemon`);
	}

	async borrowAll(): Promise<LoanResult> {
		const { gate, surface, runtime } = this.deps;
		await this.firstAttempt;
		if (gate.role === 'owner') { return { lent: true, reason: 'This daemon owns the hardware already.' }; }
		if (!this.endpoint) { return { lent: false, reason: 'The user\'s cockpit daemon cannot be reached.' }; }
		const result = await this.endpoint.request<LoanResult>('peer/borrowAll', {});
		if (result.lent) {
			gate.setAll(true);
			surface.blocked.clear();
			surface.refreshBricks();
			void runtime.scheduler.scanOnce().catch(() => undefined);
			this.deps.log.info('Borrowed every brick from the user\'s daemon');
		}
		return result;
	}

	private async connect(): Promise<void> {
		if (this.disposed) { return; }
		try {
			const { endpoint } = await connectToDaemon({
				client: { name: this.deps.name, kind: 'peer', version: this.deps.version },
				paths: this.deps.userPaths,
				readinessMs: 1000,
			});
			if (this.disposed) { endpoint.close(); return; }
			this.endpoint = endpoint;
			this.deps.log.info('Connected to the user\'s cockpit daemon; its bricks are borrowed one by one');
			for (const name of ['bricks/changed', 'daemon/lent']) { endpoint.onNotification(name, () => { void this.refreshHeld(); }); }
			endpoint.onClose(() => this.lost());
			await this.refreshHeld();
		} catch (error) {
			this.deps.log.debug(`The user's cockpit daemon is not reachable: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
			this.later();
		}
	}

	/** The user's daemon went: take the hardware if it is free, else look for that daemon again. */
	private lost(): void {
		this.endpoint = undefined;
		if (this.disposed) { return; }
		this.clearHeld();
		this.deps.log.info('The user\'s cockpit daemon went');
		this.later();
	}

	private later(): void {
		if (this.disposed) { return; }
		if (this.deps.takeHardware()) {
			this.deps.gate.own();
			this.clearHeld();
			void this.deps.runtime.scheduler.scanOnce().catch(() => undefined);
			this.deps.log.info('No user\'s daemon holds the hardware: this development daemon owns it now');
			return;
		}
		this.timer = setTimeout(() => { void this.connect(); }, PEER_RETRY_MS);
		this.timer.unref?.();
	}

	private clearHeld(): void {
		const { surface } = this.deps;
		const before = this.heldKey();
		for (const [brickId, block] of [...surface.blocked]) { if (block.by === HELD_THERE) { surface.blocked.delete(brickId); } }
		if (this.heldKey() !== before) { surface.refreshBricks(); }
	}

	/** The bricks shown as held by the user's daemon, with who holds them: to tell a real change from none. */
	private heldKey(): string {
		return JSON.stringify([...this.deps.surface.blocked].filter(([, block]) => block.by === HELD_THERE).sort(([a], [b]) => a.localeCompare(b)));
	}

	/** Shows what the user's daemon holds as blocked, naming who holds it. */
	private async refreshHeld(): Promise<void> {
		if (this.refreshing) { this.refreshAgain = true; return; }
		this.refreshing = true;
		try {
			do {
				this.refreshAgain = false;
				const endpoint = this.endpoint;
				if (!endpoint) { return; }
				const held = await endpoint.request<BrickStatus[]>('peer/heldBricks', {});
				const { surface, gate } = this.deps;
				const before = this.heldKey();
				const now = new Set(held.map((b) => b.brickId));
				for (const [brickId, block] of [...surface.blocked]) {
					if (block.by === HELD_THERE && !now.has(brickId)) { surface.blocked.delete(brickId); }
				}
				for (const brick of held) {
					if (gate.allowsBrick(brick.brickId)) { continue; }
					const names = brick.holders.map((h) => h.client ?? (h.kind === 'hold' ? 'ev3 connect' : 'remembered bricks'));
					surface.blocked.set(brick.brickId, { by: HELD_THERE, ...(names.length > 0 ? { holder: names.join(', ') } : {}) });
				}
				// The user's daemon announces many changes that do not change what it holds.
				if (this.heldKey() !== before) { surface.refreshBricks(); }
			} while (this.refreshAgain);
		} catch (error) {
			this.deps.log.debug(`Reading the user's daemon's bricks failed: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			this.refreshing = false;
		}
	}
}
