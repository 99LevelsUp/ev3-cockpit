/**
 * When the daemon lives and when it goes.
 *
 * - Starting: it has won the channel and is loading what a predecessor handed over.
 * - Serving: it works for its clients. It runs while at least one client is connected or one brick
 *   is held; once neither is true for the grace period, it exits.
 * - Lent: its whole hardware is lent to a development daemon; it keeps its clients and waits.
 * - HandingOver: a successor is taking over; new clients are told to wait.
 * - Exiting: it is going; new clients are told to start a new daemon.
 *
 * A daemon in Lent, or with bricks lent, is never idle for a replacement.
 */

export type DaemonState = 'starting' | 'serving' | 'lent' | 'handingOver' | 'exiting';

/** How long the daemon waits, with no client and no held brick, before it exits. */
export const EXIT_GRACE_MS = 10_000;

export interface LifecycleOptions {
	readonly graceMs?: number;
	/** Called once, when the daemon decides to exit. */
	readonly onExit: () => void;
}

export class Lifecycle {
	private current: DaemonState = 'starting';
	private readonly clients = new Set<string>();
	private holds = 0;
	private lentBricks = 0;
	private timer: NodeJS.Timeout | undefined;
	private readonly graceMs: number;

	constructor(private readonly options: LifecycleOptions) {
		this.graceMs = options.graceMs ?? EXIT_GRACE_MS;
	}

	get state(): DaemonState {
		return this.current;
	}

	/** What a client's handshake hears about this daemon's state. */
	helloState(): 'serving' | 'exiting' | 'handingOver' {
		if (this.current === 'exiting') { return 'exiting'; }
		if (this.current === 'handingOver') { return 'handingOver'; }
		return 'serving';
	}

	/** Starting is over: serve, and start counting toward the exit if nobody comes. */
	serve(): void {
		if (this.current !== 'starting') { return; }
		this.current = 'serving';
		this.check();
	}

	clientConnected(id: string): void {
		this.clients.add(id);
		this.check();
	}

	clientLeft(id: string): void {
		this.clients.delete(id);
		this.check();
	}

	/** How many bricks are held through `ev3 connect`. */
	setHolds(count: number): void {
		this.holds = count;
		this.check();
	}

	/** How many single bricks are lent to a development daemon. */
	setLentBricks(count: number): void {
		this.lentBricks = count;
	}

	lend(): void {
		if (this.current === 'serving') { this.current = 'lent'; }
	}

	reclaim(): void {
		if (this.current === 'lent') {
			this.current = 'serving';
			this.check();
		}
	}

	/** True when the daemon may be replaced without cutting anything off: nothing lent, and `busy` says nothing runs. */
	replaceable(busy: boolean): boolean {
		return this.current === 'serving' && this.lentBricks === 0 && !busy;
	}

	handOver(): void {
		this.cancelTimer();
		this.current = 'handingOver';
	}

	/** Leaves now, whatever holds it. */
	exit(): void {
		if (this.current === 'exiting') { return; }
		this.cancelTimer();
		this.current = 'exiting';
		this.options.onExit();
	}

	dispose(): void {
		this.cancelTimer();
	}

	private check(): void {
		if (this.current !== 'serving' && this.current !== 'lent') { return; }
		const idle = this.clients.size === 0 && this.holds === 0;
		if (!idle) { this.cancelTimer(); return; }
		if (this.timer) { return; }
		this.timer = setTimeout(() => {
			this.timer = undefined;
			if (this.clients.size === 0 && this.holds === 0) { this.exit(); }
		}, this.graceMs);
		this.timer.unref?.();
	}

	private cancelTimer(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
	}
}
