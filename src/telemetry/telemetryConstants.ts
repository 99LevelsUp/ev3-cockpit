/**
 * Per-transport telemetry cadence.
 *
 * One composed frame is one command (§9.1b), so a tick period converts straight into a
 * share of the transport's measured sustained rate. Every figure below is derived from the
 * measurements in DESIGN §9.2 and states what share it takes:
 *
 * | Transport | Sustained | Worst RTT | Target       | Floor        |
 * |---|---|---|---|---|
 * | USB       | 176 cmd/s | 9 ms      | 100 ms (6%)  | 50 ms (11%)  |
 * | TCP       | 62 cmd/s  | 58 ms     | 200 ms (8%)  | 100 ms (16%) |
 * | BT        | 10.7 cmd/s| 121 ms    | 500 ms (19%) | 250 ms (37%) |
 *
 * **Bluetooth is what constrains the design.** At 10.7 commands a second the brick's whole
 * capacity is 10.7, and the heartbeat plus whatever the user does have to come out of the
 * same budget — so a "10 Hz everywhere" target would consume the entire link and starve
 * both. Two hertz leaves better than eight commands a second for everything else. This is
 * also why the floor exists as a separate figure from the target: throttling moves the tick
 * period and nothing else (§9.5), and it must not be free to move it below the point where
 * the heartbeat stops fitting.
 *
 * Deliberately **not** seeded from `MAX_COMMANDS_PER_SEC` or `COMMAND_RTT_MS` in
 * `transportConstants.ts`: the first was retracted in §9.2, and the second was pessimistic
 * by ~50x on USB. Neither was ever read by any code, which is why nobody noticed.
 */

import { Transport } from '../contracts/enums';

export interface TelemetryCadence {
	/** Tick period the foreground brick runs at, in milliseconds. */
	readonly foregroundMs: number;
	/**
	 * Fastest tick period this transport permits, in milliseconds.
	 *
	 * A subscriber may ask for more; it is granted this at best (3.1.10). The gap between
	 * this and `foregroundMs` is the room throttling has to move in.
	 */
	readonly floorMs: number;
}

/**
 * Cadence per transport.
 *
 * The mock has no wire, so its figures exist only to keep tests on the same code path as
 * production rather than a special case; they mirror USB.
 */
export const TELEMETRY_CADENCE: Readonly<Record<Transport, TelemetryCadence>> = {
	[Transport.USB]: { foregroundMs: 100, floorMs: 50 },
	[Transport.TCP]: { foregroundMs: 200, floorMs: 100 },
	[Transport.BT]: { foregroundMs: 500, floorMs: 250 },
	[Transport.Mock]: { foregroundMs: 100, floorMs: 50 },
} as const;

/**
 * Cadence for a transport, falling back to the slowest one we measured.
 *
 * An unknown transport gets Bluetooth's figures rather than USB's: guessing fast on a link
 * that cannot carry it produces a starved heartbeat, and guessing slow only produces a
 * slower panel.
 */
export function cadenceFor(transport: Transport | undefined): TelemetryCadence {
	return transport === undefined
		? TELEMETRY_CADENCE[Transport.BT]
		: TELEMETRY_CADENCE[transport];
}
