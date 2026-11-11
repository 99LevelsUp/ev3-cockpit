---
title: Step 6 — telemetry, adaptive throttling, telemetry on the API
date: 2026-11-11
status: active — decisions D1–D5 taken 11.11.2026
origin: owner, 11.11.2026 — finish Phases 1–4 so only the visuals remain; adaptive throttling 3.4 built now, not gated
---

# Step 6: telemetry, adaptive throttling and telemetry on the API - Plan

## Goal Capsule

- **Objective:** a consumer subscribes to rows of a brick's telemetry through the public API and gets a snapshot, then events, at an interval it negotiated; the cockpit keeps one telemetry loop per brick that slows itself when the brick's latency tail grows, and never starves the heartbeat or explicit commands.
- **Means:** what Phase 3 already built (rows, frame assembler, scheduler, `BrickTelemetry`, `TelemetryService`) gets a row registry, a mock that serves frames, a schedule that can change while running, subscriptions, a read model, wiring into the runtime, the throttler (3.4), and the API surface (4.5).
- **Authority:** owner decisions D1–D5 below > `DESIGN.md` (§4.4, §4.5, §5.4, §9.x, §10) > this plan's KTDs > existing code.
- **Not in this step:** the panel and its diagnostic display (Phase 5) — this step exposes the numbers the display will show; daisy chain beyond layer 0 (D3); Linux (step 7).
- **Finishes and ships:** Claude implements, commits and pushes per unit; the owner runs the hardware session (U10).

## Where the code is (inventory 11.11.2026, checked against the repo)

Built and tested: rows (`telemetryRow.ts`), a catalogue of 26 EV3 rows (`ev3Rows.ts`, no direct test), the frame assembler with alignment, the 1019-byte cap and the HID budget (`frameAssembler.ts`), the scheduler with base tick, dividers, one frame in flight and rotating carry-over (`telemetryScheduler.ts`), one brick's loop (`brickTelemetry.ts`), and the active-brick loop (`telemetryService.ts`).

Not wired: `new TelemetryService` appears only in tests and in `scripts/arena-scenario.js` and `scripts/telemetry-queue-probe.js`; `brickManager.telemetryHost()` is ready and unused in production. Not used: `TELEMETRY_CADENCE.floorMs`; `contracts/api.ts` `TelemetrySnapshot`/`TelemetryEvent` (category-based, imported by nothing); the `TelemetryCategory` subscriptions in `sessionEntry`. The mock refuses `telemetry:frame`. Per-command RTT is measured (`sessionManager.ts` 612–616) but only the last value is kept.

## Drift to settle in U1 (documents only, no owner decision)

| # | Drift | Settled as |
|---|---|---|
| 1 | The scheduler merges the divider-5 (slow) rows into the fast frame; DESIGN §9.1b says the slow tier keeps its own command on its own ticks | follow DESIGN (KTD3) |
| 2 | "57 B of declared globals on HID" (plan 3.1.6, DESIGN §9.3) vs "under 59" (§9.1b) | the code is right: globals ≤ 64 − 5 = 59, bytecode ≤ 64 − 7 = 57; fix both texts |
| 3 | two sources of `ActivityMode` (`sessionManager` categories, `telemetryService.modeOf`) disagree for an active mock brick | one source, the telemetry service (U5) |
| 4 | DESIGN §4.4 runs the mock minimal; §13.1 says it must do telemetry | the mock does telemetry (D4) |
| 5 | plan 4.1.4/4.1.5 ticked for category types that DESIGN §5.4 rejects | unticked, redone in U8 |
| 6 | plan 4.5.1 `(brickKey, category)` vs DESIGN §9.6 `(brickKey, rows, intervalMs, apiVersion)`; step 5 names bricks by id or `'active'` | `(brick, rows, intervalMs)` on the consumer, `apiVersion` on the API object (KTD6) |
| 7 | plan 3.4 still "gated" and lists queue depth (3.4.2); DESIGN §4.5 retired depth; REQUIREMENTS §8 still names it | un-gated by the owner; 3.4.2 closed as measured; REQUIREMENTS §8 edited |
| 8 | `frameAssembler.ts` 104 says registration calls `validateRow`; only tests do | true after U2 |
| 9 | `telemetryConstants.ts` 22–24 calls `MAX_COMMANDS_PER_SEC`/`COMMAND_RTT_MS` retracted; `transportConstants.ts` holds measured values | header rewritten |
| 10 | `commandQueue.ts` 5 says depth is for throttling | comment removed |

Also closed in U1 as done or absorbed: 3.1.9 (rotating truncation, test `telemetryScheduler.test.ts` 227), 3.1.4e (DESIGN §4.5), 3.1.4h (`RowResult.alignment`).

## Decisions (owner, 11.11.2026 — each as recommended; D3 taken as the default)

- **D1. Row id format — the contract consumers name rows by.** The code uses `ports.sensor.1.value` / `ports.motor.A.tacho`; DESIGN §9.3 writes `ports.1.value`. *Recommendation:* the code's form. The EV3 names inputs 1–4 and outputs A–D, so `ports.1` is unambiguous today, but `sensor`/`motor` also says what kind of reading it is and leaves room for a layer (`ports.sensor.1` → later `layer.2.ports.sensor.1`).
- **D2. Granted interval under throttling.** Subscribe returns the interval the rows got (clamped to the transport's floor). The throttler then moves the tick. *Recommendation:* the grant stays what was negotiated; the snapshot and each event carry `effectiveIntervalMs`, and a consumer that cares listens to it. No re-negotiation events.
- **D3. Daisy chain.** Layer is hardcoded to 0. *Recommendation:* layer 0 only in this step, but every port in the read model and on the API carries `layer: 0`, so adding layers later does not change the shape. Whether the layer belongs in the brick's key or in its session is decided when someone chains bricks.
- **D4. The mock serves telemetry how?** (a) a small interpreter of the ~7 opcodes the assembler emits, decoding our own frames and answering from the mock's ports; (b) a row-level fake that skips the bytecode. *Recommendation:* (a). The mock must break where the product breaks: (b) would never exercise the encoding, the alignment or the reply layout, which is where telemetry has gone wrong before.
- **D5. Who owns the program run-state poll** (escalated from step-5 review round 3). (a) keep "follow a started program with nobody listening" and rework its failure accounting; (b) poll only while someone listens, and let the telemetry loop carry it as a row (U9). *Recommendation:* (b) — nothing reads a poll without a listener; rounds 2 and 3 both found majors in keeping it alive.

## Key Technical Decisions

- KTD1. **One loop per signed-in brick, not only the active one.** Foreground preset for the active brick, subscribed preset for a brick some consumer subscribed to, minimal otherwise (DESIGN §4.4). A brick that is not signed in or has no route runs nothing (2.8.10a).
- KTD2. **The schedule is split from the row.** A row says what to read and how to parse it; how often comes from the claims on it (cockpit foreground, subscribers), recomputed when a claim comes or goes. The scheduler's rows and period change while it runs.
- KTD3. **The slow tier gets its own command on its own ticks** (DESIGN §9.1b), within the one-frame-in-flight rule: on a slow tick the fast frame goes first and the slow command follows when it returns; a slow command still outstanding at the next tick makes that tick skip like any frame.
- KTD4. **Fastest subscriber wins, clamped to the transport's floor;** subscriptions are opaque handles; releasing one recomputes the effective interval (DESIGN §9.3).
- KTD5. **Throttling moves only the base tick** (DESIGN §4.5, §9.5). Input: per brick, a window of the last N telemetry round trips; signal: p95 against the transport's target and the count of stalls (round trip above a stall threshold). Slower in steps when the tail is high, faster in steps when it is low for long enough; never below the floor, never so slow that the slowest row's interval exceeds the heartbeat window. Explicit commands and the heartbeat are not throttled. Thresholds are set from the U10 measurements; until then they are the DESIGN §4.5 numbers (6 ms median, 37 ms p95 with Port View open).
- KTD6. **Telemetry on the API follows step 5:** a brick by id or `'active'` (resolved at the call), plain data, `sampledAt` per value, the raw type code beside the resolved device name, `listTelemetryRows()`, snapshot before events, subscriptions end with the consumer and when the brick disconnects (with an event saying so).
- KTD7. **A port has five states** (3.1.11): empty (126), identifying (125), known, error (127), terminal (124); any other code ≥ 124 shows as not readable, and the value is read only when known. The occupancy gate becomes a model the read model and the API expose, with the two documented consequences (a freshly known port shows no value for one extra tick; a just-emptied port had a slot in the frame already in flight).

## Implementation Units

Each unit: tests first (RED), a mutation check of the key assertions, `npm run test:ci`, a topic commit, push. A codex round on U4–U8 with an inline packet; L8 doc drift after the fixes.

### U1. Documents settle the drift — done 11.11.2026
The table above; close 3.1.9, 3.1.4e, 3.1.4h, 3.4.2; un-gate 3.4; owner decisions D1–D5 written into DESIGN and IMPLEMENTATION_PLAN. No code. Drift 3 (one `ActivityMode`) waits for U5 and drift 8 (`validateRow` at registration) for U2; drift 1 (the slow tier's own command) is DESIGN already and is built in U4.

### U2. Row registry and vocabulary — done 11.11.2026 (f939eca and the radio rows)
3.1.6, 3.1.4 (`PeripheralType`), 3.2.5, 3.1.1–3.1.3 as row bundles. A registry object validates on registration (`validateRow`, mode conflicts with rows already registered), keeps the raw type code beside the resolved name (the occupancy parse keeps the mode), and lists rows with id, unit, tier. `ev3Rows.ts` gets its own tests. New rows: transports and Bluetooth visibility (3.1.3), the pairing list `FAVOUR_ITEMS` (3.1.4k) — encodings verified on hardware in U10.

### U3. The mock serves frames — done 11.11.2026
3.1.7a per D4: the mock decodes the assembler's bytecode for the opcodes in use and answers from its configured ports, battery and buttons; unknown opcodes are an error, not a zero. Tests run the real `BrickTelemetry` against it.

### U4. A schedule that changes while running; mode ownership; port state — built 11.11.2026 (05f9b93, 29ccfb0, 901df00, 3cf25bc, slow tier); codex review pending
KTD2, KTD3, the rest of 3.1.8 (mode ownership across ticks, switch and settle — 3.1.4b), 3.1.11 (KTD7). **As built (parts 1–3, 11.11.2026):** the scheduler refuses a row set with two modes of one port, when built and on `setRows`, so a frame never meets a conflict; a carried-over row in an old mode is dropped with its set. A mode switch withholds the port's readings until one comes back as a number, at most `SETTLE_LIMIT_MS` (1200 ms, `MAX_DEVICE_BUSY_TIME`, `lms2012.h` 313; U10 tunes it).

### U5. Subscriptions and the effective interval
3.3.5, 3.1.10, 3.3.2, 3.8 (subscribed interval), KTD4; one source for `ActivityMode` (drift 3); 3.7.3, 3.7.6. The category subscriptions in `sessionEntry` are removed.

### U6. Read model, stale policy, wiring
3.2.1, 3.2.2, 3.5.x, 3.6.x: per brick, the last value of each row with `sampledAt`, stale after a policy per tier, cleared on disconnect. `TelemetryService` wired into `createRuntime` and `activate()` (checked by grepping the registration, not only the class). 2.8.10a. 3.7.4, 3.7.5.

### U7. Adaptive throttling
3.4.1 (a per-brick round-trip window with p95 and stall count), 3.4.3 (KTD5), 3.4.4 (per brick), 3.4.5 (the numbers for the diagnostic display, exposed for Phase 5), 3.7.2. Tests drive a fake clock and a brick whose latency tail grows and falls; one slow brick does not slow another.

### U8. Telemetry on the public API
4.5.1–4.5.5, 4.8.3, KTD6; `contracts/api.ts` rewritten (4.1.4/4.1.5 redone). `listTelemetryRows`, `subscribeTelemetry(brick, rows, intervalMs)` → handle with the granted interval, snapshot, then events with `effectiveIntervalMs` (D2). Integration test over the runtime and the mock (U3).

### U9. The program run-state poll
D5 (b). Done in step 5 already: the service polls only while someone listens; `following` and its failure count are gone. What is left here: the program status becomes a row the program service claims while someone listens, and the service's own timer goes.

### U10. Hardware session (owner)
3.1.12 the TCP and Bluetooth columns; 3.1.13 the HID over-long reply; the new rows' encodings (U2); switch-and-settle timing for UART modes; throttle thresholds: Port View open, Wi-Fi on, three bricks with one slowed; 3.1.4f a motor type on layer 2 only if a second brick can be chained. **Does a value read stall?** Per `c_input.c`, `opINPUT_READSI` never re-executes (U4 finding): plug a sensor in during a session with the value row ungated, and switch a UART sensor's mode, and measure the frame's round trip — a 1.2 s frame would mean the source reading is wrong. Re-measure the frame costs of 3.1.12 with the slow tier in its own command. **Real bricks against the mock** (owner, 11.11.2026; must not be skipped): the same composed frames from the full row catalogue go to each of the three bricks over USB and over Bluetooth and to the mock, with the same devices configured on the mock as plugged into the brick; compare type codes, modes, value layouts and the bytes a brick leaves unwritten, and every difference is either a mock fix or a recorded firmware variant. Results go into this plan with a verdict against the rule written beforehand.

## Review

### U4, round 1 (codex, inline packet, 11.11.2026) — NOT-READY → fixed

Three roots, fixed as approaches rather than one patch each: a row set changed under a tick in flight; a settle tied to the row set and to ticks instead of to what the brick was sent and to time; lifecycle edges.

| # | Sev | Finding | Verdict | Outcome |
|---|---|---|---|---|
| 1 | major | `setRows` during a tick: the captured slow rows still go out and the tick's carry-over resurrects removed rows | CONFIRMED | a set given in flight is checked now and applied when the tick ends; the slow command waits if a set is pending |
| 2 | major | a reply in the old mode ends the new mode's settle | CONFIRMED | settle starts when a command sends the new mode; with one frame in flight a reply always reads the mode being settled |
| 3 | major | the settle deadline counts ticks from `setRows`: expires before a late divider sends the mode, or outlives a period change | CONFIRMED | timed by the clock from the send |
| 4 | major | a one-shot withheld by the settle is retired undelivered | CONFIRMED | retired only when delivered |
| 5 | major | a carried-over row switched off is still sent | CONFIRMED | not carried |
| 6 | major | a failed fast command drops carried-over slow rows | CONFIRMED | unsent slow rows are carried |
| 7 | major | dispose during the fast command: values delivered and the slow command sent | CONFIRMED | nothing consumed or sent after dispose |
| 8 | major | removing a port's rows loses the mode the device was left in | CONFIRMED | the mode sent to each port is tracked apart from the rows, forgotten when the port stops being known |
| 9 | minor | the class-migration test never slowed an existing row | CONFIRMED | test fixed |
| 10 | nit | the scheduler header still claimed a 1.2 s sensor stall | CONFIRMED | rewritten |

Mutations on the rework exposed three redundant guards (removed) and one missing test (an unplugged and replugged device settles again, added).

### U4, round 2 — confirmation of round 1 (11.11.2026), NOT-READY → fixed

| # | Sev | Finding | Verdict | Outcome |
|---|---|---|---|---|
| 1 | major | `dispose()` from the fast frame's own `onValues` still lets the slow command go | CONFIRMED | `sendFrame` refuses once disposed |
| 2 | major | a switch command that failed before the brick leaves the mode recorded and its deadline running; the retry after the deadline publishes NaN | CONFIRMED | a failed send forgets the modes and settles it carried |

Both in edges of the round-1 rework, not in its approach. A third round finding majors here stops the patching and questions the approach (owner's rule).

## Open, decided later

- **Two consumers want two modes of one sensor** (from U4): the scheduler takes one mode per port; who wins is U5's arbitration, and may be the owner's decision.

- 3.1.2 filesystem state as a row: `storage()` answers it today; a row when a consumer needs to follow it.

- Daisy chain beyond layer 0 (D3).
- The diagnostic display itself (Phase 5).
