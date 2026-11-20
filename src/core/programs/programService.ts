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
 * The brick does not say when a program ends, so the state is followed — only while someone
 * listens (KTD4, owner decision D5 of the step-6 plan, 11.11.2026). Since step 6 U9 it is followed
 * through the telemetry row `program.user.running` ({@link followProgramRow}), which rides in the
 * frame a read brick sends anyway, instead of a poll of this service's own. Following ends with the
 * brick's session, as every telemetry claim does; a lost link that comes back keeps it.
 */

import { BrickCommand, BrickId, BrickResponse, SendCommandOptions } from '../contracts';
import { CancelledError, ErrorCode, ProgramError, ProtocolError, SubscriptionError } from '../errors/CockpitError';
import { mayHaveRun } from '../fs/transferLedger';
import { PROGRAM_RUNNING_ROW } from '../telemetry/ev3Rows';
import type { ClaimRequest } from '../telemetry/telemetryClaims';
import type { ReadModelChange, ReadValue } from '../telemetry/telemetryReadModel';

/** Sends one command to this service's brick, through its session. */
export type ProgramSend = (command: BrickCommand, options?: SendCommandOptions) => Promise<BrickResponse>;

/**
 * How a start ended: the brick showed the program running; it never did within the confirmation
 * window (a short program may have ended already, or the brick refused in silence); or the start's
 * reply was lost, so whether the brick ran it is not known — and it is not sent a second time.
 */
export type StartOutcome = 'started' | 'not_seen_running' | 'uncertain';

/** Following a brick's program: started for the first listener, ended with the last or with the brick. */
export interface ProgramFollow {
	/**
	 * Starts following; `onState` hears each program state with the time it was sampled, and
	 * `onEnded` hears that the brick's session ended the follow. Throws when the brick cannot be followed.
	 */
	follow(onState: (running: boolean, at: number) => void, onEnded: () => void): { dispose(): void };
}

export interface ProgramServiceOptions {
	/** How long a start may take to show the program running before it counts as refused. */
	readonly confirmTimeoutMs?: number;
	/** The gap between the confirmation's questions. */
	readonly confirmStepMs?: number;
	/**
	 * Waits for the brick's route until a deadline. A start with a deadline waits here, before its
	 * last check for a stop; its own send never waits. Absent, a start finds the route there is.
	 */
	readonly waitForRoute?: (options: { readonly deadline?: number; readonly signal?: AbortSignal }) => Promise<unknown>;
}

export interface RunOptions {
	/** Stop a running program first, rather than refuse. */
	readonly replace?: boolean;
	/**
	 * A mark from {@link ProgramService.stopMark}: the start is not sent when any stop came after
	 * it. Absent, the mark is taken when the run is asked.
	 */
	readonly since?: number;
	/** The operation's deadline: each command waits out a lost route until then (see `SendCommandOptions`). */
	readonly deadline?: number;
	readonly signal?: AbortSignal;
}

/** Defaults: a start that shows within a second on every transport. */
const CONFIRM_TIMEOUT_MS = 1500;
const CONFIRM_STEP_MS = 100;

export class ProgramService {
	private readonly confirmTimeoutMs: number;
	private readonly confirmStepMs: number;
	private readonly waitForRoute?: ProgramServiceOptions['waitForRoute'];
	private readonly listeners = new Set<(running: boolean) => void>();
	/** The last state seen, or undefined before the first answer. */
	private known: boolean | undefined;
	/** When the last state taken was observed: an older one is not taken (U9 review, round 1). */
	private knownAt = Number.NEGATIVE_INFINITY;
	/** The follow running for the listeners, while there are any. */
	private following: { dispose(): void } | undefined;
	private disposed = false;
	/** The tail of the run operations, so they take turns. */
	private queue: Promise<void> = Promise.resolve();
	/** Stops and emergency stops asked so far: a run asked before one of them must not send its start. */
	private stops = 0;
	/** Who asked the last stop, as it named itself. */
	private lastStopper: string | undefined;

	/**
	 * @param follow How the run state is followed for listeners — the telemetry row in the product.
	 *   Absent, a listener is refused: there is nothing to follow with.
	 */
	constructor(private readonly send: ProgramSend, options: ProgramServiceOptions = {}, private readonly follow?: ProgramFollow) {
		this.confirmTimeoutMs = options.confirmTimeoutMs ?? CONFIRM_TIMEOUT_MS;
		this.confirmStepMs = options.confirmStepMs ?? CONFIRM_STEP_MS;
		this.waitForRoute = options.waitForRoute;
	}

	/**
	 * Load an `.rbf` into the user slot and start it. Resolves `true` once the brick shows it
	 * running, `false` when it never did within the confirmation window: a short program may have
	 * ended already, or the brick refused the start — the slot's state cannot tell the two apart,
	 * so this does not claim either (review 11.11.2026).
	 *
	 * Runs take turns per brick, so two callers cannot both pass the check and race their starts,
	 * the second refused in silence (review 11.11.2026). A stop or an emergency stop does not wait
	 * its turn; instead it cancels every run asked before it whose start is not sent yet, so no
	 * program starts after the stop was asked (review round 2, 11.11.2026).
	 *
	 * A start whose reply is lost fails with the link's error, as before; {@link start} reports it
	 * as uncertain instead.
	 */
	async run(path: string, options: RunOptions = {}): Promise<boolean> {
		const since = options.since ?? this.stops;
		const outcome = await this.inTurn(() => this.startNow(path, options, since, () => {
			throw new ProgramError(ErrorCode.ProgramCancelled, 'A stop came first: the program was not started.');
		}, false));
		return outcome === 'started';
	}

	/**
	 * Load an `.rbf` into the user slot and start it, as {@link run} does, and say how the start
	 * ended. A start whose reply was lost is `uncertain` and is never sent again: the brick may
	 * have run it. A stop that came after `since` fails it with a {@link CancelledError} naming
	 * who stopped the brick, and nothing is started.
	 */
	start(path: string, options: RunOptions = {}): Promise<StartOutcome> {
		const since = options.since ?? this.stops;
		return this.inTurn(() => this.startNow(path, options, since, () => {
			throw new CancelledError(this.stoppedMessage(), this.lastStopper);
		}, true));
	}

	private async startNow(
		path: string, options: RunOptions, since: number, cancel: () => never, lostIsUncertain: boolean,
	): Promise<StartOutcome> {
		const sendOptions = { deadline: options.deadline, signal: options.signal };
		const cancelled = (): void => { if (this.stops !== since) { cancel(); } };
		cancelled();
		if (await this.isRunning(sendOptions)) {
			if (!options.replace) {
				throw new ProgramError(ErrorCode.ProgramRunning,
					'A program is running on the brick. Stop it first, or ask to replace it.');
			}
			await this.stopNow(sendOptions);
		}
		// A lost route is waited out before the last check, never inside the start's own send: a
		// stop pressed while the route was down must not be followed by the start once it is back.
		if (options.deadline !== undefined) {
			await this.waitForRoute?.({ deadline: options.deadline, signal: options.signal });
		}
		// Checked right before the start is sent: nothing awaits between this and the send.
		cancelled();
		let reply: BrickResponse;
		try {
			reply = await this.send({ kind: 'program:run', path }, { signal: options.signal });
		} catch (error) {
			if (lostIsUncertain && mayHaveRun(error)) { return 'uncertain'; }
			throw error;
		}
		if (reply.kind !== 'program:run') { throw new ProtocolError(`Expected program:run, got ${reply.kind}.`); }
		if (reply.imageBytes <= 0) {
			throw new ProgramError(ErrorCode.ProgramNotFound, `No program at ${path} on the brick.`);
		}
		const deadline = Date.now() + this.confirmTimeoutMs;
		while (!(await this.isRunning(sendOptions))) {
			if (Date.now() >= deadline) { return 'not_seen_running'; }
			await delay(this.confirmStepMs);
		}
		return 'started';
	}

	/**
	 * A point in this brick's stops: a run given it as `since` does not start when any stop came
	 * after it, so work of several steps that ends in a start can take the mark at its first step.
	 */
	stopMark(): number {
		return this.stops;
	}

	/** Whether a stop came after `mark`, and who asked the last one. */
	stoppedSince(mark: number): { readonly stopped: boolean; readonly stoppedBy: string | undefined } {
		return { stopped: this.stops !== mark, stoppedBy: this.stops !== mark ? this.lastStopper : undefined };
	}

	/**
	 * Stop the program in the user slot, at once: not behind a run that is still confirming its
	 * start, so a stop pressed while another client's run waits reaches the brick then. A run asked
	 * before it and not yet sent sees the count change and does not send its start; a start already
	 * sent is ahead of this stop on the brick's session, so this stop ends it.
	 *
	 * @param stoppedBy Who asks, as a cancelled start names them.
	 */
	stop(stoppedBy?: string, options?: SendCommandOptions): Promise<void> {
		this.noteStop(stoppedBy);
		return this.stopNow(options);
	}

	/** The brick's own power-off sequence: the user and debug slots, then every motor. */
	emergencyStop(stoppedBy?: string, options?: SendCommandOptions): Promise<void> {
		// Not behind a run in progress, as a stop is not.
		this.noteStop(stoppedBy);
		return (async () => {
			await this.send({ kind: 'program:emergencyStop' }, options);
			await this.isRunning(options);
		})();
	}

	private noteStop(stoppedBy: string | undefined): void {
		this.stops += 1;
		this.lastStopper = stoppedBy;
	}

	private stoppedMessage(): string {
		return this.lastStopper
			? `${this.lastStopper} stopped the brick first: the program was not started.`
			: 'The brick was stopped first: the program was not started.';
	}

	private async stopNow(options?: SendCommandOptions): Promise<void> {
		await this.send({ kind: 'program:stop' }, options);
		await this.isRunning(options);
	}

	/** Runs `work` after every operation queued before it; a failure does not block the next. */
	private inTurn<T>(work: () => Promise<T>): Promise<T> {
		const result = this.queue.then(work, work);
		this.queue = result.then(() => undefined, () => undefined);
		return result;
	}

	/** Whether a program runs in the user slot; tells the listeners when that changed. */
	async isRunning(options?: SendCommandOptions): Promise<boolean> {
		const reply = await this.send({ kind: 'program:status' }, options);
		if (reply.kind !== 'program:status') { throw new ProtocolError(`Expected program:status, got ${reply.kind}.`); }
		this.note(reply.running, Date.now());
		return reply.running;
	}

	/**
	 * Be told when a program starts or ends; the state is followed while anyone listens. Throws when
	 * it cannot be followed — no telemetry, or the brick cannot be read — and keeps no listener then.
	 */
	onStateChange(listener: (running: boolean) => void): { dispose(): void } {
		if (!this.follow) { throw new SubscriptionError('Following a program needs the cockpit\'s telemetry, which is not available.'); }
		if (this.disposed) { throw new SubscriptionError('This brick\'s program service has been disposed.'); }
		if (!this.following) { this.following = this.startFollow(this.follow); }
		this.listeners.add(listener);
		let open = true;
		return {
			dispose: () => {
				if (!open) { return; }
				open = false;
				this.listeners.delete(listener);
				// The last listener gone: nobody to follow for.
				if (this.listeners.size === 0) { this.stopFollowing(); }
			},
		};
	}

	/**
	 * Follows again, as when the user changed how often a program is read: the new follow starts
	 * before the old one goes, so nothing falls between; the listeners stay. A brick that cannot be
	 * followed now keeps the old follow.
	 */
	followAgain(): void {
		if (!this.follow || !this.following) { return; }
		const old = this.following;
		try {
			this.following = this.startFollow(this.follow);
		} catch {
			return;
		}
		old.dispose();
	}

	dispose(): void {
		this.disposed = true;
		this.listeners.clear();
		this.stopFollowing();
	}

	private startFollow(follow: ProgramFollow): { dispose(): void } {
		const following = follow.follow(
			(running, at) => { if (this.following === following) { this.note(running, at); } },
			() => { if (this.following === following) { this.sessionEnded(); } },
		);
		return following;
	}

	/**
	 * The brick's session ended the follow (U9 review, round 1). Its listeners end with it, as
	 * telemetry subscriptions do: one that subscribes after a reconnect starts a new follow, and a
	 * listener of the ended session is not revived by it.
	 */
	private sessionEnded(): void {
		this.following = undefined;
		this.listeners.clear();
	}

	private stopFollowing(): void {
		const following = this.following;
		this.following = undefined;
		following?.dispose();
	}

	/** Takes a state observed `at`, unless a newer one was taken already: a cached reading cannot undo a confirmed start. */
	private note(running: boolean, at: number): void {
		if (at < this.knownAt) { return; }
		this.knownAt = at;
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
}

/** What following the program row needs of the telemetry: the API's own dependencies. */
export interface ProgramRowTelemetry {
	claim(brickId: BrickId, request: ClaimRequest, owner: string): { readonly handle: string };
	release(handle: string): void;
	snapshot(brickId: BrickId, rowIds?: readonly string[]): ReadValue[];
	onChange(listener: (change: ReadModelChange) => void): { dispose(): void };
	onClaimsEnded(listener: (event: { readonly brickKey: string; readonly handles: readonly string[] }) => void): { dispose(): void };
}

/**
 * Follows a brick's program through its telemetry row (step-6 U9): claims `program.user.running`
 * at `intervalMs()` and hears the read model. A stale or dropped value says nothing about the
 * program and tells nothing. The state is told after the read model's dispatch, never inside it:
 * the API's delivery is the read model's only listener that reacts synchronously (review of U8,
 * round 4), and a consumer's program listener must not become a second one.
 */
export function followProgramRow(telemetry: ProgramRowTelemetry, brickId: BrickId, intervalMs: () => number): ProgramFollow {
	return {
		follow: (onState, onEnded) => {
			// Listening before the claim is made: a claim that ends inside `claim()` itself — a
			// synchronous listener ending the brick — is heard too (review of U9, round 2).
			let handle: string | undefined;
			const endedEarly = new Set<string>();
			const ending = telemetry.onClaimsEnded((event) => {
				if (event.brickKey !== brickId) { return; }
				if (handle === undefined) { for (const ended of event.handles) { endedEarly.add(ended); } return; }
				if (!open || !event.handles.includes(handle)) { return; }
				close();
				onEnded();
			});
			try {
				handle = telemetry.claim(brickId, { rowIds: [PROGRAM_RUNNING_ROW], intervalMs: intervalMs() }, 'cockpit:programs').handle;
			} catch (error) {
				ending.dispose();
				throw error;
			}
			if (endedEarly.has(handle)) {
				ending.dispose();
				throw new SubscriptionError(`Brick ${brickId} went while its program was being followed.`);
			}
			const claimed = handle;
			let open = true;
			const tell = (value: ReadValue | undefined): void => {
				if (!value || value.stale || typeof value.value !== 'boolean') { return; }
				const running = value.value;
				const at = value.sampledAt;
				queueMicrotask(() => { if (open) { onState(running, at); } });
			};
			const close = (): void => {
				open = false;
				listening.dispose();
				ending.dispose();
			};
			const listening = telemetry.onChange((change) => {
				if (change.brickKey === brickId) { tell(change.rows.find((row) => row.rowId === PROGRAM_RUNNING_ROW)); }
			});
			tell(telemetry.snapshot(brickId, [PROGRAM_RUNNING_ROW])[0]);
			return {
				dispose: () => {
					if (!open) { return; }
					close();
					telemetry.release(claimed);
				},
			};
		},
	};
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
