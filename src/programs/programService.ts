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
 * listens (KTD4, owner decision D5 of the step-6 plan, 11.11.2026). Nothing reads a poll nobody
 * listens to, and keeping one alive for a started program was where review rounds 2 and 3 kept
 * finding defects. Step 6 moves the poll into the telemetry scheduler as a row.
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
	private timer: NodeJS.Timeout | undefined;
	private polling = false;
	private disposed = false;
	/** The tail of the run/stop operations, so they take turns. */
	private queue: Promise<void> = Promise.resolve();
	/** Emergency stops asked so far: a run asked before one of them must not send its start. */
	private emergencies = 0;

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
	 * Run and stop take turns per brick, so two callers cannot both pass the check and race their
	 * starts, the second refused in silence (review 11.11.2026). Emergency stop does not wait its
	 * turn; instead it cancels every run asked before it whose start is not sent yet, so no
	 * program starts after the emergency stop was asked (review round 2, 11.11.2026).
	 */
	run(path: string, options: RunOptions = {}): Promise<boolean> {
		const asked = this.emergencies;
		const cancelled = (): void => {
			if (this.emergencies !== asked) {
				throw new ProgramError(ErrorCode.ProgramCancelled, 'An emergency stop came first: the program was not started.');
			}
		};
		return this.inTurn(async () => {
			cancelled();
			if (await this.isRunning()) {
				if (!options.replace) {
					throw new ProgramError(ErrorCode.ProgramRunning,
						'A program is running on the brick. Stop it first, or ask to replace it.');
				}
				await this.stopNow();
			}
			// Checked right before the start is sent: nothing awaits between this and the send.
			cancelled();
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
			return true;
		});
	}

	/** Stop the program in the user slot. */
	stop(): Promise<void> {
		return this.inTurn(() => this.stopNow());
	}

	/** The brick's own power-off sequence: the user and debug slots, then every motor. */
	emergencyStop(): Promise<void> {
		// Not behind a run in progress: an emergency does not wait its turn. A run asked before it
		// and not yet sent sees the count change and does not send its start. A start already
		// sent is ahead of this stop on the brick's session, so this stop ends it.
		this.emergencies += 1;
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
		return {
			dispose: () => {
				this.listeners.delete(listener);
				// The last listener gone: the poll already scheduled would ask for nobody.
				if (this.listeners.size === 0 && this.timer) { clearTimeout(this.timer); this.timer = undefined; }
			},
		};
	}

	dispose(): void {
		this.disposed = true;
		this.listeners.clear();
		if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
	}

	private note(running: boolean): void {
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
		if (this.listeners.size === 0) { return; }
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.polling = true;
			this.isRunning()
				// A lost reply: the listeners asked to hear about this brick, so the poll goes on
				// until they leave; the brick's disconnect is the session's to report.
				.catch(() => undefined)
				.finally(() => {
					this.polling = false;
					this.schedulePoll();
				});
		}, this.pollMs);
		this.timer.unref?.();
	}
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
