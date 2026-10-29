/**
 * Drives `native/bt-pairing-helper`, the net48 console app that pairs a brick over WinRT.
 *
 * Why a separate process at all: the pairing ceremony lives in
 * `Windows.Devices.Enumeration.DeviceInformationCustomPairing`, a WinRT (COM/vtable) API that
 * koffi's C-ABI FFI cannot reach, and the legacy `bthprops.cpl` path it replaces cannot work
 * from any host — Windows' own Bluetooth service owns the single authentication callback slot
 * (IMPLEMENTATION_PLAN.md 1.11.13/2.8.17/2.8.18). Pairing happens once per brick, so a
 * process per attempt costs nothing worth optimising; the data channel stays in-process.
 *
 * This module is the wrapper only: spawn, read the JSON-lines protocol, turn it into the
 * `{ ok, reason }` the discovery layer already speaks. Two things deliberately live outside
 * it — serialising against `BtConnectionQueue` (pairing and connecting contend for the one
 * radio slot, and that is the call site's concern) and retrying a missed inquiry (a policy,
 * not a mechanism).
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { BackendUnavailableError } from '../errors/CockpitError';
import { BT } from './transportConstants';

/** One line of the helper's stdout protocol, as `Program.cs` emits them today. */
export type BtPairingEvent =
	| { type: 'apartment'; state: string }
	| { type: 'searching'; mac: string }
	| { type: 'found'; id: string; name: string; alreadyPaired: boolean; seen?: string[] }
	| { type: 'alreadyPaired'; mac: string }
	| { type: 'pairingRequested'; kind: string }
	| { type: 'watcherEnumerationCompleted'; status: string; atMs: number }
	| { type: 'watcherStopped'; status: string; atMs: number }
	| { type: 'inquiryTimedOut'; seen: string[]; status: string; atMs: number }
	| { type: 'result'; status: string; ok: boolean }
	| { type: 'device'; mac: string; name: string; paired: boolean; signal: number | null; atMs: number }
	| { type: 'deviceUpdated'; mac: string; signal: number | null; atMs: number }
	| { type: 'deviceLost'; mac: string; atMs: number }
	| { type: 'scanComplete'; count: number; atMs: number }
	| { type: 'error'; message: string }
	/** Anything the helper grows later. Forwarded, never rejected. */
	| { type: string; [key: string]: unknown };

/** Matches `BtClassicDiscovery`'s `PairingResult` — the shape the discovery layer consumes. */
export interface HelperPairingResult {
	ok: boolean;
	/** Why it did not happen. Absent on success. */
	reason?: string;
}

/** A readable stream, narrowed to what this module listens for. */
interface HelperStream {
	on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
}

/**
 * The slice of a spawned process this module uses.
 *
 * Narrower than `ChildProcess` on purpose: it states exactly what the helper contract needs,
 * which is also all a test double has to provide.
 */
export interface HelperProcess {
	stdout: HelperStream | null;
	stderr: HelperStream | null;
	on(event: 'close', listener: (code: number | null, signal: string | null) => void): unknown;
	on(event: 'error', listener: (error: Error) => void): unknown;
	kill(): boolean;
}

/** The slice of `child_process.spawn` this module uses, so tests can supply their own. */
export type SpawnLike = (
	command: string,
	args: string[],
	options: Record<string, unknown>
) => HelperProcess;

/** Configuration for {@link createHelperPairing}. */
export interface BtPairingHelperOptions {
	/**
	 * Absolute path to the helper executable.
	 *
	 * Required rather than resolved here: the only component that knows where the extension
	 * was installed is `extension.ts`, via `context.extensionPath`. Making this module guess
	 * would put a filesystem search behind every pairing attempt and a second source of truth
	 * next to the packaging step.
	 */
	helperPath: string;
	/** Pairing PIN. Every EV3 uses the same one and cannot be changed. */
	pin?: string;
	/**
	 * How long the helper runs its live inquiry before giving up.
	 *
	 * A cold find was measured at 4.7 s and the cache path answers in tens of ms, so this is
	 * mostly headroom for a brick that is slow to answer an inquiry rather than a typical wait.
	 */
	inquirySeconds?: number;
	/**
	 * The helper's own overall deadline. Covers the inquiry *and* the pairing ceremony, which
	 * measured between ~5 s and ~46 s and includes the time a person takes to confirm on the
	 * brick's display.
	 */
	timeoutSeconds?: number;
	/**
	 * When to kill a helper that has stopped responding entirely, as a backstop to its own
	 * deadline. Only fires if the helper fails to exit on its own.
	 */
	killAfterMs?: number;
	/** Overrides the spawn, so the protocol can be exercised without a radio or a binary. */
	spawn?: SpawnLike;
	/**
	 * Called for each protocol line, in order.
	 *
	 * This is the seam the UI prompt hangs off. Prompt on **`found` with
	 * `alreadyPaired: false`** — that is the moment before the brick puts `Connect?` on its
	 * display. By `pairingRequested` the brick is already asking and the user has seconds,
	 * not the whole window.
	 */
	onEvent?: (event: BtPairingEvent) => void;
}

const DEFAULT_INQUIRY_SECONDS = 30;
const DEFAULT_TIMEOUT_SECONDS = 120;
const KILL_GRACE_MS = 5000;

/** One brick the radio can currently see. */
export interface ScannedBrick {
	/** Colon-separated, uppercase. */
	mac: string;
	/** What the brick calls itself, which is what a user picks by. */
	name: string;
	paired: boolean;
	/**
	 * Signal, where the host reported one. Good enough to order a list by, not a measurement.
	 *
	 * Measured across two scans on 03.09.2026: it moves while a scan is open (one brick read
	 * -17, then -11, then -23 within 17 s) and occasionally returns something implausible
	 * (one paired brick read -2 in one scan and -35 in the next). So refresh it from
	 * `deviceUpdated` rather than trusting the first value, and never show it to a user as a
	 * distance or a quality figure.
	 */
	signal: number | null;
	/** Milliseconds from the scan's start until this brick appeared. */
	atMs: number;
}

/** A scan in flight. */
export interface BrickScan {
	/** Resolves with everything the scan saw, in the order it saw it. */
	done: Promise<ScannedBrick[]>;
	/**
	 * Ends the scan early and stops the helper.
	 *
	 * The point of a progressive list is that a user picks the brick they wanted as soon as it
	 * appears — usually seconds before the window closes. Without this the helper would keep
	 * the radio busy scanning for a brick nobody is waiting for any more, and the connect that
	 * follows would be queued behind it.
	 */
	cancel: () => void;
}

/** Configuration for {@link scanForBricks}. */
export interface BrickScanOptions extends Omit<BtPairingHelperOptions, 'onEvent' | 'pin'> {
	/**
	 * Called with the whole current list whenever it changes — a brick appearing, its signal
	 * moving, or a brick leaving range.
	 *
	 * The list rather than the delta, because the consumer redraws itself anyway.
	 *
	 * **In the order the bricks were first seen, which is not an order to show anyone.**
	 * Deciding what comes first is a question about the person looking at the screen, not
	 * about the radio: a list sorted by signal so the brick someone is carrying rises to the
	 * top as they walk over is a UI behaviour, and this layer has no business guessing at it.
	 * All it owes the caller is an accurate record of what is visible.
	 */
	onChange?: (bricks: ScannedBrick[]) => void;
	/** Called once the helper reports the scan finished on its own. */
	onComplete?: (count: number) => void;
	/** Restricts the list to bricks; anything else the radio hears is dropped. */
	ouiFilter?: string;
}

/**
 * Builds a pairing function bound to one helper binary.
 *
 * The returned function has the same shape as `pairBluetoothDevice`, so it drops into
 * `BtClassicDiscovery`'s injectable `pairDevice` without the discovery layer learning that a
 * process is involved.
 *
 * @throws {BackendUnavailableError} From the returned function, when this host cannot run the
 *   helper at all — a non-Windows platform, or a binary that is not where it should be. That
 *   is an install fault rather than a pairing outcome, and reads differently to a user.
 */
export function createHelperPairing(
	options: BtPairingHelperOptions
): (mac: string) => Promise<HelperPairingResult> {
	const {
		pin = BT.PAIRING_PIN,
		inquirySeconds = DEFAULT_INQUIRY_SECONDS,
		timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
		onEvent,
	} = options;

	return (mac: string) => {
		let result: { status: string; ok: boolean } | undefined;
		let helperError: string | undefined;
		let alreadyPaired = false;

		const run = runHelper([
			'--mac', mac,
			'--pin', pin,
			'--inquiry-seconds', String(Math.round(inquirySeconds)),
			'--timeout-seconds', String(Math.round(timeoutSeconds)),
		], options, (event) => {
			switch (event.type) {
			case 'result':
				result = {
					status: readString(event, 'status') ?? 'unknown',
					ok: readBoolean(event, 'ok') === true,
				};
				break;
			case 'alreadyPaired':
				alreadyPaired = true;
				break;
			case 'error':
				helperError = readString(event, 'message') ?? 'the helper reported an error';
				break;
			default:
				break;
			}
			onEvent?.(event);
		});

		return run.done.then((outcome) => interpret({
			result, alreadyPaired, helperError, timeoutSeconds, ...outcome,
		}));
	};
}

/**
 * Lists the bricks the radio can currently see, filling the list in as they answer.
 *
 * A scan is not a snapshot: bricks are switched on and off and carried in and out of range
 * while somebody is looking at the list, so this reports appearances, signal changes and
 * departures for as long as it runs. Measured on three bricks: one answered in 6 s and
 * another in 18 s of the same window, which is why nothing here waits for a complete list
 * before showing the first entry.
 */
export function scanForBricks(options: BrickScanOptions): BrickScan {
	const {
		inquirySeconds = DEFAULT_INQUIRY_SECONDS,
		timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
		onChange,
		onComplete,
		ouiFilter,
	} = options;

	const found = new Map<string, ScannedBrick>();
	const normalise = (mac: string): string => mac.replace(/[^0-9a-fA-F]/g, '').toLowerCase();
	const wanted = (mac: string): boolean =>
		!ouiFilter || normalise(mac).startsWith(normalise(ouiFilter));

	const changed = (): void => onChange?.([...found.values()]);

	const run = runHelper([
		'--scan',
		'--inquiry-seconds', String(Math.round(inquirySeconds)),
		'--timeout-seconds', String(Math.round(timeoutSeconds)),
	], options, (event) => {
		// Every field here came off a pipe as JSON, so each one is read and checked rather
		// than asserted. A helper that grows a field, or truncates one, must not take the
		// picker down with it.
		const mac = readString(event, 'mac');

		switch (event.type) {
		case 'device': {
			const name = readString(event, 'name');
			if (!mac || name === undefined || !wanted(mac)) { return; }
			found.set(normalise(mac), {
				mac,
				name,
				paired: readBoolean(event, 'paired') === true,
				signal: readNumber(event, 'signal') ?? null,
				atMs: readNumber(event, 'atMs') ?? 0,
			});
			changed();
			break;
		}
		case 'deviceUpdated': {
			const existing = mac ? found.get(normalise(mac)) : undefined;
			if (!existing) { return; }
			existing.signal = readNumber(event, 'signal') ?? null;
			changed();
			break;
		}
		case 'deviceLost': {
			if (mac && found.delete(normalise(mac))) { changed(); }
			break;
		}
		case 'scanComplete':
			onComplete?.(found.size);
			break;
		default:
			break;
		}
	});

	return {
		// A cancelled scan still answers with what it saw. The caller cancelled because they
		// already picked something out of that list, not because the list was worthless.
		done: run.done.then(() => [...found.values()]),
		cancel: run.cancel,
	};
}

// The helper's lines arrive as JSON over a pipe, so every field is checked before it is
// believed. These three keep that check in one place instead of scattering `typeof` through
// the switch statements above.

function readString(event: BtPairingEvent, key: string): string | undefined {
	const value = (event as Record<string, unknown>)[key];
	return typeof value === 'string' ? value : undefined;
}

function readNumber(event: BtPairingEvent, key: string): number | undefined {
	const value = (event as Record<string, unknown>)[key];
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readBoolean(event: BtPairingEvent, key: string): boolean | undefined {
	const value = (event as Record<string, unknown>)[key];
	return typeof value === 'boolean' ? value : undefined;
}

/** What one helper run produced, beyond the events already delivered to the caller. */
interface HelperOutcome {
	stderr: string;
	code: number | null;
	timedOut: boolean;
}

/** A helper process in flight. */
interface HelperRun {
	done: Promise<HelperOutcome>;
	cancel: () => void;
}

/**
 * Spawns the helper and turns its stdout into protocol events.
 *
 * Shared by pairing and scanning because the plumbing is the same either way: one process,
 * JSON lines, a deadline, and a kill for the case where it stops answering.
 */
function runHelper(
	args: string[],
	options: Pick<BtPairingHelperOptions, 'helperPath' | 'spawn' | 'killAfterMs' | 'timeoutSeconds'>,
	onEvent: (event: BtPairingEvent) => void
): HelperRun {
	const {
		helperPath,
		spawn = nodeSpawn as unknown as SpawnLike,
		timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
		killAfterMs = timeoutSeconds * 1000 + KILL_GRACE_MS,
	} = options;

	let cancel = (): void => { /* replaced once the process exists */ };

	const done = new Promise<HelperOutcome>((resolve, reject) => {
		// An injected spawn means the caller has taken responsibility for what runs, which is
		// what keeps this suite runnable on a machine that is not the target platform.
		if (!options.spawn && process.platform !== 'win32') {
			reject(new BackendUnavailableError(
				`This needs the Windows Bluetooth helper; this host is ${process.platform}.`
			));
			return;
		}

		let child: HelperProcess;
		try {
			child = spawn(helperPath, args, {
				stdio: ['ignore', 'pipe', 'pipe'],
				// Without this a net48 console app flashes a window over the editor.
				windowsHide: true,
			});
		} catch (error) {
			reject(new BackendUnavailableError(
				`Could not start the Bluetooth helper at ${helperPath}.`, error));
			return;
		}

		let stderr = '';
		let stdoutTail = '';
		let settled = false;
		let timedOut = false;

		const killTimer = setTimeout(() => {
			timedOut = true;
			child.kill();
		}, killAfterMs);

		cancel = () => {
			if (settled) { return; }
			child.kill();
		};

		const handleLine = (line: string): void => {
			const trimmed = line.trim();
			if (!trimmed) { return; }

			let event: BtPairingEvent;
			try {
				event = JSON.parse(trimmed) as BtPairingEvent;
			} catch {
				// A half-written or non-JSON line is not worth failing a run over; the lines
				// that matter are whole ones and they keep arriving after it.
				return;
			}
			if (typeof event?.type !== 'string') { return; }
			onEvent(event);
		};

		child.stdout?.on('data', (chunk: Buffer | string) => {
			stdoutTail += String(chunk);
			const lines = stdoutTail.split('\n');
			// The last element is whatever arrived after the final newline — hold it until the
			// rest of it does.
			stdoutTail = lines.pop() ?? '';
			for (const line of lines) { handleLine(line); }
		});

		child.stderr?.on('data', (chunk: Buffer | string) => { stderr += String(chunk); });

		child.on('error', (error: Error) => {
			if (settled) { return; }
			settled = true;
			clearTimeout(killTimer);
			reject(new BackendUnavailableError(
				`Could not start the Bluetooth helper at ${helperPath}.`, error));
		});

		child.on('close', (code: number | null) => {
			if (settled) { return; }
			settled = true;
			clearTimeout(killTimer);
			if (stdoutTail) { handleLine(stdoutTail); }
			resolve({ stderr, code, timedOut });
		});
	});

	return { done, cancel: () => cancel() };
}

/**
 * Turns everything the run produced into one answer.
 *
 * The protocol line wins over the exit code wherever both exist: the code is a coarse summary
 * and the line carries the status Windows actually reported. Where neither says anything, an
 * exit code of 0 is still not a success — a helper that paired nothing and reported nothing
 * has not paired anything, and calling that ok would leave a caller believing in a brick that
 * is not there.
 */
function interpret(run: {
	result?: { status: string; ok: boolean };
	alreadyPaired: boolean;
	helperError?: string;
	stderr: string;
	code: number | null;
	timedOut: boolean;
	timeoutSeconds: number;
}): HelperPairingResult {
	if (run.timedOut) {
		return {
			ok: false,
			reason: `The pairing helper timed out after ${run.timeoutSeconds}s and was stopped.`,
		};
	}

	if (run.result) {
		return run.result.ok ? { ok: true } : { ok: false, reason: describeStatus(run.result.status) };
	}

	// The idempotent path: Program.cs reports `alreadyPaired` and exits 0 without a result.
	if (run.alreadyPaired) { return { ok: true }; }

	if (run.helperError) { return { ok: false, reason: run.helperError }; }

	const stderr = run.stderr.trim();
	if (stderr) { return { ok: false, reason: stderr }; }

	return {
		ok: false,
		reason: `The pairing helper exited with code ${run.code ?? 'unknown'} without reporting a result.`,
	};
}

/**
 * Wording for the statuses a user can do something about.
 *
 * `AuthenticationTimeout` is the one that matters: it means the brick asked and nobody
 * pressed. Reporting it like any other failure sends the user to check the radio instead of
 * the brick in front of them — measured twice on hardware before the STA fix, and it will
 * keep happening whenever someone looks away.
 */
function describeStatus(status: string): string {
	switch (status) {
	case 'NotFound':
		return 'Could not find the brick over Bluetooth. Check that it is switched on and '
				+ 'that Bluetooth and visibility are enabled on the brick itself.';
	case 'AuthenticationTimeout':
		return 'The brick asked for confirmation and nobody accepted in time. Watch the '
				+ 'brick\'s display and confirm there, then try again.';
	case 'RejectedByHandler':
	case 'AccessDenied':
		return `Windows refused the pairing (${status}).`;
	default:
		return `Pairing did not complete (${status}).`;
	}
}
