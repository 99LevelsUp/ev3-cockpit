/**
 * Runs, stops and follows the program on one brick (step-5 plan, U3; IMPLEMENTATION_PLAN 4.7a).
 *
 * A peer of the filesystem and telemetry services on the service tier, not part of the API: the
 * API wraps it. Programs run in the user slot, as the brick's own file browser runs them, so the
 * brick's clean-up of motors and sound applies when they end (KTD1).
 *
 * The firmware refuses a start into a running slot without saying so (`lms2012.c` 3002–3030),
 * and a loaded image whose start was refused stays allocated. So `run` asks first and refuses
 * with a typed error unless the caller asked to replace the running program, and afterwards
 * confirms the start by asking again (KTD2). Emergency stop is the brick's own power-off
 * sequence, never `PROGRAM_STOP(0)`, which stops the brick's UI and ends its VM (KTD3).
 *
 * The brick does not say when a program ends, so the state is polled — only while someone
 * listens or a program this service started runs (KTD4). Step 6 moves the poll into the
 * telemetry scheduler's command budget.
 */

import { BrickCommand, BrickResponse } from '../contracts';
import { ErrorCode, ProgramError, ProtocolError } from '../errors/CockpitError';

/** Sends one command to this service's brick, through its session. */
export type ProgramSend = (command: BrickCommand) => Promise<BrickResponse>;

export interface ProgramServiceOptions {
	/** How often the run state is asked while it is followed. */
	readonly pollMs?: number;
	/** How long a start may take to show the program running before it counts as refused. */
	readonly confirmTimeoutMs?: number;
	/** The gap between the confirmation's questions. */
	readonly confirmStepMs?: number;
}

export interface RunOptions {
	/** Stop a running program first, rather than refuse. */
	readonly replace?: boolean;
}

/** Defaults: a human-scale poll, and a start that shows within a second on every transport. */
const POLL_MS = 1000;
const CONFIRM_TIMEOUT_MS = 1500;
const CONFIRM_STEP_MS = 100;

export class ProgramService {
	private readonly pollMs: number;
	private readonly confirmTimeoutMs: number;
	private readonly confirmStepMs: number;
	private readonly listeners = new Set<(running: boolean) => void>();
	/** The last state seen, or undefined before the first answer. */
	private known: boolean | undefined;
	/** A program this service started is running: follow it even with nobody listening. */
	private following = false;
	private timer: NodeJS.Timeout | undefined;
	private polling = false;
	private disposed = false;
	/** The tail of the run/stop operations, so they take turns. */
	private queue: Promise<void> = Promise.resolve();

	constructor(private readonly send: ProgramSend, options: ProgramServiceOptions = {}) {
		this.pollMs = options.pollMs ?? POLL_MS;
		this.confirmTimeoutMs = options.confirmTimeoutMs ?? CONFIRM_TIMEOUT_MS;
		this.confirmStepMs = options.confirmStepMs ?? CONFIRM_STEP_MS;
	}

	/**
	 * Load an `.rbf` into the user slot and start it. Resolves `true` once the brick shows it
	 * running, `false` when it never did within the confirmation window: a short program may have
	 * ended already, or the brick refused the start — the slot's state cannot tell the two apart,
	 * so this does not claim either (review 11.11.2026).
	 *
	 * Run, stop and emergency stop take turns per brick, so two callers cannot both pass the
	 * check and race their starts, the second refused in silence (review 11.11.2026).
	 */
	run(path: string, options: RunOptions = {}): Promise<boolean> {
		return this.inTurn(async () => {
			if (await this.isRunning()) {
				if (!options.replace) {
					throw new ProgramError(ErrorCode.ProgramRunning,
						'A program is running on the brick. Stop it first, or ask to replace it.');
				}
				await this.stopNow();
			}
			const reply = await this.send({ kind: 'program:run', path });
			if (reply.kind !== 'program:run') { throw new ProtocolError(`Expected program:run, got ${reply.kind}.`); }
			if (reply.imageBytes <= 0) {
				throw new ProgramError(ErrorCode.ProgramNotFound, `No program at ${path} on the brick.`);
			}
			const deadline = Date.now() + this.confirmTimeoutMs;
			while (!(await this.isRunning())) {
				if (Date.now() >= deadline) { return false; }
				await delay(this.confirmStepMs);
			}
			this.following = true;
			this.schedulePoll();
			return true;
		});
	}

	/** Stop the program in the user slot. */
	stop(): Promise<void> {
		return this.inTurn(() => this.stopNow());
	}

	/** The brick's own power-off sequence: the user and debug slots, then every motor. */
	emergencyStop(): Promise<void> {
		// Not behind a run in progress: an emergency does not wait its turn.
		return (async () => {
			await this.send({ kind: 'program:emergencyStop' });
			await this.isRunning();
		})();
	}

	private async stopNow(): Promise<void> {
		await this.send({ kind: 'program:stop' });
		await this.isRunning();
	}

	/** Runs `work` after every operation queued before it; a failure does not block the next. */
	private inTurn<T>(work: () => Promise<T>): Promise<T> {
		const result = this.queue.then(work, work);
		this.queue = result.then(() => undefined, () => undefined);
		return result;
	}

	/** Whether a program runs in the user slot; tells the listeners when that changed. */
	async isRunning(): Promise<boolean> {
		const reply = await this.send({ kind: 'program:status' });
		if (reply.kind !== 'program:status') { throw new ProtocolError(`Expected program:status, got ${reply.kind}.`); }
		this.note(reply.running);
		return reply.running;
	}

	/** Be told when a program starts or ends; the state is polled while anyone listens. */
	onStateChange(listener: (running: boolean) => void): { dispose(): void } {
		this.listeners.add(listener);
		this.schedulePoll();
		return { dispose: () => { this.listeners.delete(listener); } };
	}

	dispose(): void {
		this.disposed = true;
		this.listeners.clear();
		if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
	}

	private note(running: boolean): void {
		if (!running) { this.following = false; }
		// Nothing left to follow: a poll already scheduled would only ask the brick for nothing.
		if (this.listeners.size === 0 && !this.following && this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		const first = this.known === undefined;
		if (this.known === running) { return; }
		this.known = running;
		// The first answer is where things stand, not a change; `isRunning` tells it.
		if (first) { return; }
		// One consumer's failing listener must not cost the others the change, or the caller its answer.
		for (const listener of [...this.listeners]) {
			try { listener(running); } catch { /* the consumer's own error; the others still hear */ }
		}
	}

	/** One poll at a time, and only while there is a reason to ask (KTD4). */
	private schedulePoll(): void {
		if (this.disposed || this.timer || this.polling) { return; }
		if (this.listeners.size === 0 && !this.following) { return; }
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.polling = true;
			this.isRunning()
				// A brick that does not answer any more: stop following what it ran; listeners, who
				// asked to hear about this brick, keep their poll (review 11.11.2026).
				.catch(() => { this.following = false; })
				.finally(() => {
					this.polling = false;
					this.schedulePoll();
				});
		}, this.pollMs);
		this.timer.unref?.();
	}
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
