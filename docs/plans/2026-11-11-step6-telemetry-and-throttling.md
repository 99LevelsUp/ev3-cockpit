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

- **D6. A sensor mode is a parameter of the subscription** (owner, 11.11.2026, during U5): row ids stay `ports.sensor.1.value`; a claim may carry `modes: { '1': 2 }`. One row is one value of a port, so ids do not multiply per mode.
- **D7. The first claim holds a port's mode; a conflicting claim is refused** with the typed error `mode_conflict`, naming the holder (owner, 11.11.2026). Nobody's mode changes under them. The cockpit's own foreground claim holds no mode: it reads whatever mode is held, the device's default when none is — otherwise no consumer could ever ask for another mode of an active brick.

- **D8. One telemetry command a tick** (owner, 11.11.2026, after the program-load measurement): the event and static rows ride in the same command as the sampled ones; KTD3's separate slow command is withdrawn. Every command costs a running program about 2 ms.

## Key Technical Decisions

- KTD1. **One loop per signed-in brick, not only the active one.** Foreground preset for the active brick, subscribed preset for a brick some consumer subscribed to, minimal otherwise (DESIGN §4.4). A brick that is not signed in or has no route runs nothing (2.8.10a).
- KTD2. **The schedule is split from the row.** A row says what to read and how to parse it; how often comes from the claims on it (cockpit foreground, subscribers), recomputed when a claim comes or goes. The scheduler's rows and period change while it runs.
- KTD3. ~~**The slow tier gets its own command on its own ticks**~~ — **superseded by D8**: one command a tick. Was: (DESIGN §9.1b), within the one-frame-in-flight rule: on a slow tick the fast frame goes first and the slow command follows when it returns; a slow command still outstanding at the next tick makes that tick skip like any frame.
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

### U4. A schedule that changes while running; mode ownership; port state — done 11.11.2026; review three rounds, converged (see Review)
KTD2, KTD3, the rest of 3.1.8 (mode ownership across ticks, switch and settle — 3.1.4b), 3.1.11 (KTD7). **As built (parts 1–3, 11.11.2026):** the scheduler refuses a row set with two modes of one port, when built and on `setRows`, so a frame never meets a conflict; a carried-over row in an old mode is dropped with its set. A mode switch withholds the port's readings until one comes back as a number, at most `SETTLE_LIMIT_MS` (1200 ms, `MAX_DEVICE_BUSY_TIME`, `lms2012.h` 313; U10 tunes it).

### U5. Subscriptions and the effective interval — done 11.11.2026; review three rounds, converged (see Review)
Part 1 `TelemetryClaims` (6243cbd); the grant is the request clamped to the floor, fixed when the claim is made (f85a939, D2); part 2 one loop per brick in `TelemetryService`, `modeOf` reports subscribed, claims wait out a lost link and end with the session via `onClaimsEnded` (adc826c, mutations 15/15); the session's own `activeMode` and categories removed (31b83eb, drift 3 closed). A static row claimed after it was read is not read again: its value comes from the read model (U6). Planned:
3.3.5, 3.1.10, 3.3.2, 3.8 (subscribed interval), KTD4; one source for `ActivityMode` (drift 3); 3.7.3, 3.7.6. The category subscriptions in `sessionEntry` are removed.

### U6. Read model, stale policy, wiring — done 13.11.2026; review five rounds, converged (see Review)
Part 1 read model + settings + service plan/session events (d64aab1, mutations 17/17 — the first run hung all night on a mutation that turned the timer into a busy loop; the test's fake timer now fails after 10 000 rounds and the mutation runner has a time limit); part 2 the view of the active brick (ccb1ce1, 9/9); part 3 wiring into `createRuntime` and `activate()` (3bc10ee, 4/4; end to end over the mock's interpreted frames; host tests 5/5). Planned:
3.2.1, 3.2.2, 3.5.x, 3.6.x, 2.8.10a, 3.7.4, 3.7.5.

**Goal.** What the loops read lands in one place a reader can ask: per brick, the last value of every row with `sampledAt`, its effective interval and whether it is still fresh. The panel's view of the active brick (Phase 5) and the API's snapshot and events (U8) both read it; neither talks to a loop. The service runs in the shipped extension, not only in tests.

**Where it stands (checked 11.11.2026).** `TelemetryService` is built only by tests and two scripts; `extension.ts` has no telemetry at all; `createRuntime` builds `BrickManager` but not the service. `ActiveBrickViewModel` and `PortState` exist in `contracts/models.ts` with no producer; `PortState` has no `layer` (D3). Favorites and the value display style have no store yet (Phase 5/6). The host already gates telemetry on the pair (2.8.10a): since the U5 review a brick has a session only while signed in, and runs a loop only while it also has a route.

**Parts.**
1. `src/telemetry/telemetryReadModel.ts` — `TelemetryReadModel`, fed by `TelemetryService.onValues`. Per brick a map row id → `{ value, unit?, mode?, sampledAt, effectiveIntervalMs, stale }`. Queries: `snapshot(brick, rowIds?)` (plain data, every value with its `sampledAt`), `valueOf(brick, rowId)`. Event `onChange({ brick, rows })`, batched per frame, only rows whose value, mode, stale flag or effective interval changed (D10).
2. Effective interval per row from the service: `effectiveIntervalOf(brick, rowId)` = the loop's tick × the row's divider, `'once'` for a static row; it moves with throttling (U7) and a route change, which is how D2's "travels in the data" is kept.
3. Stale policy (D9), driven by an injectable clock: a value is stale when its brick's loop is not running for it (link lost, brick no longer read, row no longer claimed), or when it is older than `STALE_FACTOR` (3) × its effective interval while the loop runs (the brick is stalling). A stale value stays, marked, for `staleTimeoutMs`, then goes. Session end (disconnect, sign-out) clears the brick at once (§9.3, 4.5.4). A static row read once stays fresh for the whole session — that is what serves a claim made after the read (U5).
4. `src/telemetry/activeBrickView.ts` — a pure function from the read model's rows of one brick (+ identity, route, channels) to `ActiveBrickViewModel`: motor ports A–D and sensor ports 1–4 with `layer: 0` (D3, `PortState.layer` added), the port state from the occupancy row (`portStateOf`), peripheral name and raw type code, the value with unit only for a known port, buttons, battery level and voltage, firmware version, Bluetooth on/visible. `favorite` false and `valueDisplayStyle` `'numeric'` until Phase 5/6 give them a store.
5. Wiring: `createRuntime` builds the service on `bricks.telemetryHost()` and the read model on the service, after `BrickManager`, so disposal (reverse order) stops telemetry before the brick layer; `Runtime` gains `telemetry` and `telemetryView`. Log: a loop starting and stopping per brick with its mode and period at info; frame errors once per brick until a frame succeeds again (no line per tick). `activate()` takes them from the runtime. Verified by grepping the construction in `createRuntime` and the use in `extension.ts`, not only the classes.

**Tests first (RED).** Read model: a frame's values land with `sampledAt` and effective interval; only changed rows make an event; a value turns stale past 3× its interval and when its loop stops; stale values go after the timeout, not before; session end clears at once; a static row survives the foreground leaving; two bricks never mix. View: an empty, identifying, known, error and unreported port each map right; a value is shown only for a known port; unknown type codes keep `typeCode`; `layer` is 0. Wiring: `createRuntime` with the mock provider, sign a mock brick in, and the read model fills from the mock's interpreted frames (U3) — the first end-to-end telemetry through the shipped wiring; sign out and it clears. Mutation check on the stale rules.

**Not in U6.** The API surface (U8), throttling (U7), the program-running preset (U9/U7), the panel (Phase 5).

**Owner decisions (11.11.2026).**
- **D9. Stale and clearing — agreed, and parametrised:** stale = loop not running for the row, or older than `staleFactor` × its effective interval; kept for `staleTimeoutMs`, then dropped; session end clears at once; static rows stay for the session. Owner: *no fixed constants in the code* — both are user settings (`ev3-cockpit.telemetry.staleFactor`, default 3; `ev3-cockpit.telemetry.staleTimeoutMs`, default 10 000), whose only defaults live in `package.json`; the read model takes them as required options and follows a settings change without a restart; a value out of range falls back to the declared default with a warning.
- **D10. Events carry changed rows only — agreed on the condition that no information is lost in an outage.** How that holds: during an outage there are no samples to lose; the values turn stale, and that is itself an event; when the link comes back, the first sample makes an event even if its value is unchanged, because the stale flag flips; a reader can take the whole snapshot at any time (U8 sends it before events). Every value carries `sampledAt`. Pinned by a test. A consumer that wants every sample (a graph) can be offered a flag in U8 if one asks.

### U7. Adaptive throttling — done 13.11.2026; review converged (see Review)
Part 1 `TickThrottle` and the settings (08b110d, mutations 17/17); part 2 into the service: round trips per frame, base × factor, re-announced plans, `throttleOf`/`onThrottleChange`, runtime and `activate()` (ab5cf5d, 8/8); part 3 rows by relative lateness on a tight budget (c9590e4, 5/6, a dead tie-break removed); phase offsets left out (libusb carries 1024 B on Linux too). Planned:
**Design.** Per brick, a `TickThrottle` watches the round trip of every telemetry frame (send to reply, queue wait included: a brick busy with a file transfer is a brick to slow down for). Tumbling windows of `windowSize` frames; at the end of each, the p95 is set against a limit of `tailFactor` × the transport's measured round trip (`COMMAND_RTT_MS`: USB 10, TCP 60, Bluetooth 130 ms — measured data, not settings). Over the limit: the tick slows one `step` (× 1.5), never past `maxSlowdown` (× 4). Within it for `calmWindows` windows in a row: one step back, never faster than the plan's tick. Port View's 37 ms p95 on USB trips it (limit 30 ms); a quiet brick's does not. The factor multiplies the plan's period, so dividers and phases stay (§9.5); a re-plan keeps the factor; a restart on a new transport starts afresh. Every change re-announces the plan, so `effectiveIntervalMs` in the data moves with it (D2). The numbers — period, factor, p95, stalls (round trips over the limit), samples — are exposed per brick for the diagnostic display (3.4.5). Owner rule (D9): no tunable constant in code — `enabled`, `windowSize`, `tailFactor`, `step`, `maxSlowdown`, `calmWindows` are user settings `ev3-cockpit.telemetry.throttle.*`, defaults only in package.json, applied without a reload.

**Deviation from KTD5's wording, for the owner:** KTD5 caps the tick so that "the slowest row's interval" stays inside the heartbeat window. On Bluetooth the foreground's event rows already run every 2.5 s against a 3 s heartbeat, so that cap would leave Bluetooth — where throttling matters most — almost no room. The cap here is `maxSlowdown` on the tick; the heartbeat is not throttled and does not depend on telemetry. Reversible if the owner wants KTD5 as written.

**Not in U7:** the program-running preset (200 ms on USB/TCP) waits for U9, which makes "a program runs" a telemetry row; the HID ordering by relative lateness (below) is its own part. Thresholds are re-checked in U10 on hardware.

Planned as written first:
3.4.1 (a per-brick round-trip window with p95 and stall count), 3.4.3 (KTD5), 3.4.4 (per brick), 3.4.5 (the numbers for the diagnostic display, exposed for Phase 5), 3.7.2. Tests drive a fake clock and a brick whose latency tail grows and falls; one slow brick does not slow another.

Minor, agreed with the owner 11.11.2026 (his proposal: slow rows fill the room the fast ones leave, the rest on the following ticks). That is already how truncation works, and it only bites on the 64-byte HID fallback; libusb, Bluetooth and TCP carry 1024 bytes and the whole set fits. Two refinements for the HID case:
- **Order by relative lateness**, not "carried over first": a row's lateness is the share of its own interval it is overdue (a fast row one tick late is 100 %, a divider-5 row one tick late 20 %). Fast rows keep their cadence while there is room; a slow row still gets in, because its lateness grows. "Fast first, slow fills the rest" was rejected: a full packet would starve the slow rows for good. A change in `candidatesFor`, with a test on the HID budget.
- **Phase offsets** for rows with the same divider, so they do not all come due on one tick and burst the packet.
"Fast / slow" stays a setting the cockpit offers; underneath, each row keeps its own divider, since what costs a running program is the number of commands (D8), not the rows in one.

### U8. Telemetry on the public API — done 13.11.2026; review five rounds, converged (see Review)
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

### U4, round 3 — confirmation of round 2 (11.11.2026): no blocker or major

| # | Sev | Finding | Verdict | Outcome |
|---|---|---|---|---|
| 1 | minor | a throwing `onValues` landed in the send's `catch` and forgot a mode the brick had received | CONFIRMED | the reply is consumed outside the send's `try`; a listener error goes to `onError` and is not a failed frame |

Convergence gate met: no blocker or major survives. U4 is closed in code; U10 measures the settle time, the read stall and the slow tier's frame costs.

### U5, round 1 (codex, inline packet `.review-out/step6-u5-packet.md`, 11.11.2026) — NOT-READY → fixed (80c04e1)

| # | Sev | Finding | Verdict | Outcome |
|---|---|---|---|---|
| 1 | major | a background brick that lost its link and was then signed out kept its claims for good: no route left to lose, so sign-out fired no event | CONFIRMED (`recomputeRoute` returns when best === previous) | `BrickManager` fires a sign-in-ended event from `forgetSignIn`; the telemetry host passes it on; production-shaped test in `brickManager.test.ts` |
| 2 | major | a claim on a brick nobody read since a route change was granted against the old link's floor | CONFIRMED | `claim` sets the current transport's cadence before the grant is fixed |
| 3 | major | a loop restarted on a transport change can leave the old loop's frame outstanding beside the new loop's first | CONFIRMED as a fact, **minor** in effect | the two frames go over different links into different queues, so each queue still holds at most one; the old loop is disposed and drops its reply; the new loop settles every port afresh anyway. Cost: one extra command on the brick, once per route change (~2 ms of a running program). **Superseded in round 2:** the old frame can also command a sensor mode; fixed by chaining |
| 4 | minor | `modeOf` reported a disconnected session as minimal | CONFIRMED | `none` |
| 5 | minor | a re-planned loop clamped the probes' tick override to the transport floor while its plan used the override | CONFIRMED | the loop clamps to the floor the plan used (`floorMs` option) |

### U5, round 2 — confirmation of round 1 (codex, `.review-out/step6-u5-r2-packet.md`, 11.11.2026) — NOT-READY → fixed (80400be)

| # | Sev | Finding | Verdict | Outcome |
|---|---|---|---|---|
| 1 | major | disposing the brick layer left a connected brick's claims and loop alive: the sign-in ended, but the host reported the brick Connected from its route, which is removed only after | CONFIRMED | the host's `getSession` reports no session for a brick that is not signed in, whatever its routes; test disposes `BrickManager` with a claimed brick |
| 2 | major | the retired loop's frame, still outstanding after a transport change, can command a sensor mode after the new loop set another, switching the device behind its back (NaN readings not withheld) | CONFIRMED (`opINPUT_READSI` with a mode sets the mode) | round 1's row 3 came back in the same area, so the approach changed instead of the verdict being argued: all loops of a brick send through one chain in the service, and a new loop's first frame waits for the retired one's to settle |

### U5, round 3 — confirmation of round 2 (codex, `.review-out/step6-u5-r3-packet.md`, 11.11.2026) — fixed

| # | Sev | Finding | Verdict | Outcome |
|---|---|---|---|---|
| 1 | major | a retired frame that never settles blocks the chain, and so the new loop, for good | REJECTED with evidence: the packet lacked the adapters; every one times a send out (`SEND_TIMEOUT_MS`, 1–2 s: `usbLibusbAdapter.ts`, `usbHidAdapter.ts`, `btWinsockAdapter.ts`, `btSppAdapter.ts`, `tcpSocketAdapter.ts`) and rejects a pending reply when its link closes | the worst case is a pause of about 2 s; the service's doc states the bound and where it comes from |
| 2 | minor | a frame waiting in the chain still went out after its loop was retired by a further route change, or the service disposed | CONFIRMED | each loop has an identity; a waiting frame is refused unless its loop is still the brick's; a retired loop's values and errors are not reported; a frame with nothing ahead goes out at once. Mutations 4/5 killed; the fifth showed the `disposed` check dead (dispose stops every loop) and it was removed |

Convergence gate: no blocker or major survives verification. U5 is closed in code; U8 builds the API on `claim`/`release`/`grantOf`/`onClaimsEnded`.

### U6, round 1 (codex, inline packet `.review-out/step6-u6-packet.md`, 13.11.2026) — NOT-READY → fixed (f44b7d5)

| # | Sev | Finding | Verdict | Outcome |
|---|---|---|---|---|
| 1 | major | a late reply for a row that left the plan revived it as fresh with its old interval, and put off its drop | CONFIRMED (a re-plan waits for the frame in flight) | a sample for a row not in the plan keeps it stale, with no interval, and keeps its drop time |
| 2 | major | an unchanged sample processed before an overdue timer erased the outage without an event (D10) | CONFIRMED | each sample first runs the deadlines that have passed: stale is announced, then the recovery |
| 3 | major | a value's stale time counted from when the timer ran, not from when it went stale; a lowered `staleFactor` granted extra time | CONFIRMED | stale from the deadline (`sampledAt + staleFactor × interval`); dropped against it in the same pass |
| 4 | major | with `staleTimeoutMs` 0 the stale event was swallowed and only the removal told | CONFIRMED | stale and gone are two events, in that order |
| 5 | major | a delay past Node's timer limit (2³¹−1 ms) fires after 1 ms, so a huge setting made the timer spin | CONFIRMED | the delay is capped at the platform's limit and the deadline checked again on waking; a huge `staleFactor` simply never stales by age |
| 6 | major | a read model attached to a service already reading a brick never learned its plan | CONFIRMED as a contract gap (not reachable in today's wiring: no brick is active when the runtime is built) | `TelemetryService.currentPlans()`; the read model starts from it |
| 7 | minor | the view gives no freshness for battery, buttons and Bluetooth visibility | CONFIRMED | recorded for Phase 5: the panel decides how stale system values show; the read model has the flag for each row |

Mutations on the fixes 8/8; unit 957/957.

### U6, round 2 — confirmation of round 1 (codex, `.review-out/step6-u6-r2-packet.md`, 13.11.2026) — NOT-READY → approach changed (5c551a7)

| # | Sev | Finding | Verdict | Outcome |
|---|---|---|---|---|
| 1 | major | a row that left the plan kept its old effective interval in snapshots and events; one already stale got no event | CONFIRMED | leaving the plan clears the interval, and the change is told |
| 2 | major | a plan change could still erase an overdue outage or put off a drop (round 1 fixed this for samples only) | CONFIRMED | see below |
| 3 | major | a late reply after the session ended recreated its values, also when a listener ended the session during the stale news | CONFIRMED | a brick whose session ended takes no reply until a new plan says it is read again |

Same area two rounds running, each finding an input that forgot a case: **the approach changed instead of a third patch.** Every input — sample, plan, session end, settings, timer — goes through one `run()`: time is brought up to now under the old state (stale told first, then what expired goes), the input applies, then time again under the new state. Events are no longer picked by hand: they are the difference between what readers were last told and what holds now. Mutations on the rebuilt model 19/19; unit 961/961.

### U6, round 3 — audit of the rebuilt model (codex, `.review-out/step6-u6-r3-packet.md`, 13.11.2026) — NOT-READY → fixed (caf497f)

| # | Sev | Finding | Verdict | Outcome |
|---|---|---|---|---|
| 1 | major | a late reply after a stopped row's stale time had run out recreated it for another `staleTimeoutMs` | CONFIRMED (realistic with a low timeout) | the model keeps, per brick and session, when each row stopped being read; a reply past that row's drop is not taken |
| 2 | major | a static row whose first reply came after it left the plan went stale | CONFIRMED (the active brick changing just after sign-in) | the same history keeps that the row was planned static |

Both came from one missing piece of state, not from the ordering the rebuild settled: what a plan said of a row was forgotten with its value. Mutations 5/6 — the survivor deletes the history at session end, which nothing observable depends on (a static row is static in every session; other rows are rewritten by the next plan). Unit 963/963.

### U6, round 4 — confirmation of round 3 (codex, `.review-out/step6-u6-r4-packet.md`, 13.11.2026) — fixed (a304ff6)

| # | Sev | Finding | Verdict | Outcome |
|---|---|---|---|---|
| 1 | major | a row stale by age before it left the plan came back from a late reply after its drop, for the gap between its stale time and its stop time | CONFIRMED (tens of ms in the reported sequence) | the history notes the drop; no reply for an unplanned row brings it back until a plan reads it again — a rule with no time to count, instead of one more time |

Mutations 2/2; a plan check in the note proved dead and was removed. Unit 964/964.

### U6, round 5 — confirmation of round 4 (codex, `.review-out/step6-u6-r5-packet.md`, 13.11.2026): READY, no findings

Convergence gate met: no blocker or major survives. Majors per round 6 → 3 → 2 → 1 → 0; round 2 changed the read model's approach (one order for every input, events by difference) instead of a third patch. U6 is closed in code; U8 builds the API's snapshot and events on it.

### U7, round 1 (codex, `.review-out/step6-u7-packet.md`, 13.11.2026) — no blocker or major; three minors fixed (78a5896)

| # | Sev | Finding | Verdict | Outcome |
|---|---|---|---|---|
| 1 | minor | a smaller `windowSize` kept the oversized window in progress | CONFIRMED | new settings start from fresh evidence: window, calm count and last numbers dropped |
| 2 | minor | a changed `tailFactor` left the display's stalls counted against the old limit | CONFIRMED | same reset |
| 3 | minor | `configureThrottle` accepted bad settings with no loop running | CONFIRMED | it checks them itself |

Convergence gate met: no blocker or major. The deviation from KTD5 (cap by `maxSlowdown`, not the heartbeat window) — **accepted by the owner 13.11.2026**.

### U8, round 1 (codex, inline packet, 13.11.2026) — NOT-READY → fixed (7c5d86b)

| # | Sev | Finding | Verdict | Outcome |
|---|---|---|---|---|
| 1 | major | a change between the claim and the snapshot was lost: the snapshot was taken when it went out, not at the claim | CONFIRMED | the snapshot is taken at the claim; changes after it queue until it has gone out |
| 2 | major | a brick that went before the snapshot went out gave `ended` with no snapshot before it | CONFIRMED | `ended` queues behind the snapshot like any change |

### U8, round 2 — confirmation of round 1 (codex, 13.11.2026) — NOT-READY → fixed (a173519)

| # | Sev | Finding | Verdict | Outcome |
|---|---|---|---|---|
| 1 | major | a listener that ended the brick while hearing the snapshot made `ended` overtake a change still queued | CONFIRMED | while the queue is told, anything new joins its end |

### U8, round 3 — confirmation of round 2 (codex, `.review-out/packet_u8r3.txt`, 13.11.2026) — NOT-READY → approach changed

| # | Sev | Finding | Verdict | Outcome |
|---|---|---|---|---|
| 1 | blocker | delivery was reentrant across subscriptions: one consumer's listener ending the brick or causing a change made another subscription lose the change it was being told, or hear a newer one first; a subscription made inside a listener heard again the change its snapshot held | CONFIRMED (updates went out from inside the source's dispatch) | see below |

Same area three rounds running — the order of updates when a listener reacts — with each round patching one subscription's own ordering. **The approach changed instead of a fourth patch.** The order belongs to the stream of events, which no single subscription sees, so one owner keeps it: `TelemetryDelivery`, one per API. An event is queued for the subscriptions that exist when it happens. Updates go out only from its drain, never from inside the source's dispatch, so whatever a listener causes queues behind everything before it, for every subscription of every consumer. A snapshot is queued at its claim. Delivery is asynchronous, and one drain tells only what was queued when it began: a listener whose every update causes another cannot freeze the extension host. The consumer guide says so.

Tests first: two consumers where one's listener ends the brick, a listener causing a newer change, a subscription made inside a listener, a claim that itself causes a change, a disposed subscription with an update on its way, a feedback loop (with a ceiling, so a regression cannot hang the run), one listener on the source for all. The test's stand-in source now fires like the product's emitter: a copy of the listeners, and a dispose that removes. Mutations 7/10. Three survive. Two are equivalent: an ended claim left among the recipients, and `ended` told without being marked done. Changes after `ended` queue behind it and are dropped at delivery either way. The third, the consumer's record cleaned after `ended`, is memory only and cannot be seen through the API. Unit 1022/1022.

### U8, round 4 — audit of the rebuilt delivery (codex, `.review-out/tmp/packet_u8r4.txt`, 13.11.2026) — NOT-READY → fixed

| # | Sev | Finding | Verdict | Outcome |
|---|---|---|---|---|
| 1 | major → **minor** | a claim that ends inside `claim()` is opened afterwards as live: it never hears `ended`, and its dispose releases a claim already gone | CONFIRMED as a fact, not reachable today | nothing inside `TelemetryService.claim()` can end a brick (it refreshes the plan; the read model's only listener is the delivery, which never tells synchronously), and `release` of a gone handle does nothing. **Trigger to revisit:** a second synchronous listener on the read model or the service, such as the Phase 5 panel |
| 2 | major | a callback inside `claim()` that unregisters the consumer leaves its claim behind; a consumer registered after the API was disposed holds a claim nobody releases | CONFIRMED for the second part (an extension holding the API object after deactivate), the first not reachable today | the API refuses consumers once disposed, the flag set before anything else goes; after the claim the consumer is checked again and a claim it can no longer own is given back |
| 3 | major → **minor** | the delivery keeps the order its callback is called in, which another `onChange` listener reacting synchronously could make differ from the read model's own | CONFIRMED as a fact, not reachable today | the delivery is the read model's only listener (`extension.ts`). **Same trigger as row 1:** then the order is fixed at the producer: the read model fires without reentrancy and stamps each change with a sequence number, which a subscription's snapshot records |
| 4 | major | no test that nothing is told inside the call that subscribes, nor that a throwing listener harms no one else | CONFIRMED | both tested, the first also from inside a listener |

Rows 2 and 4 tested and mutated, 5/5 caught. The delivery's approach stands: this round's findings are at its edges, at the claim, the API's lifetime and the source, not in the order it keeps.

### U8, round 5 — confirmation of round 4 (codex, `.review-out/tmp/packet_u8r5.txt`, 13.11.2026): READY

| # | Sev | Finding | Verdict | Outcome |
|---|---|---|---|---|
| 1 | minor | the packet alone does not prove that round 4's two downgraded interleavings are unreachable in production | CONFIRMED as a gap in the packet; **verified against the production wiring** | the read model's only `onChange` listener is the delivery (`extension.ts` → `cockpitApi.ts`), which only queues; the service's `onPlanChange` has the read model and the runtime's log line, neither of which reaches back into a claim; so nothing inside `TelemetryService.claim()` can end a brick or reorder a change today. Both limitations stay recorded with their trigger: a second synchronous listener, such as the Phase 5 panel |

Convergence gate met: READY, no blocker or major. Round 3 changed the delivery's approach (one `TelemetryDelivery` owns the order) instead of a fourth patch. U8 is closed in code.

## Measurement: does telemetry slow a running program? (owner's question, 11.11.2026)

**Question.** The owner fears that telemetry read as fast as the foreground cadence splits the brick between the program and the reads, so a running program slows down.

**What the source says** (`lms2012.c` 1777–1786, 2397–2412; `lms2012.h`): the VM is one thread and takes its slots in turn, each for up to `PRG_PRIORITY` instructions or 2 ms. A telemetry frame is a direct command in `CMD_SLOT` of some 20–40 instructions; while it runs, the program in `USER_SLOT` waits. The expectation is a loss of a few milliseconds a second, not a half — but that is an argument, and the owner asked for it confirmed or refuted.

**Method.** `scripts/bench/Bench.lms` (assembled with the firmware's `lmsasm`) counts passes of a tight loop for 10 s and writes the count to a file; it draws nothing. `scripts/program-load-probe.js` uploads it through the filesystem layer, runs it, runs `BrickTelemetry` beside it at a given period over USB, reads the count back; telemetry off, 500, 100 and 20 ms, interleaved, three rounds.

**Rule, written before the run.** At the foreground cadences (USB 100 ms, Bluetooth 500 ms) the program loses at most **2 %**; at 20 ms at most **10 %**. More than that confirms the concern, and telemetry slows down while a user program runs (a fourth preset beside foreground, subscribed and minimal).

**Result (11.11.2026, three bricks over USB, three interleaved rounds each; loop passes in 10 s, firmware 1.09d).**

| Brick | Telemetry off | 500 ms | 100 ms | 20 ms |
|---|---|---|---|---|
| AAA | 307 435 | −0.44 % | −2.64 % | −9.45 % |
| BBB | 328 714 | −0.84 % | −2.27 % | −8.60 % |
| CCC | 334 984 | −0.76 % | −2.09 % | −8.26 % |

Rounds of one setting agree within about 1 %. **Verdict against the rule:** 500 ms (the Bluetooth cadence) and 20 ms pass; **100 ms (the USB foreground cadence) fails**, at 2.1–2.6 % against 2 %. The owner's concern is confirmed in part: not a half, but more than allowed at the USB cadence.

**What the numbers say beyond the rule.** The loss grows linearly with the commands sent: each telemetry command costs the program about **2 ms** (BBB: 234 ms over 114 frames at 100 ms, 886 ms over 406 at 20 ms), nearly whatever it carries — in line with the VM's 2 ms slice (`PreemptMilliSeconds < 2`). Two consequences:

1. **While a user program runs, telemetry slows down**, as the rule decided beforehand: a fourth preset, USB and TCP at 200 ms (about 1.2 % by this measurement), Bluetooth unchanged at 500 ms. It needs to know a program runs — the program-status row of U9 — so it is built with U9 and U7.
2. **The slow tier's own command (KTD3) costs the program about 2 ms on every slow tick**, which merging it into the fast frame saves. Owner decision **D8**: one command a tick; DESIGN §9.1b corrected.

Not measured yet: Bluetooth and TCP carry their commands through other paths in the VM's communication handling; U10 repeats this over both.


## Linux session on HOSTC (11.11.2026) — folded

Results on master: `docs/plans/linux-session-results/2026-11-11-hostc.md` (branch `linux-session-rpi5-2026-11-11`, 412e026). L1 failed (47 tests cancelled: timers armed with `unref()`) → fixed 5488a11, 926/926 on HOSTC; L2 holds; L3 failed (Bluetooth cache warning every 3 s) → fixed dd34e41, holds; L4 not run (no USB); L5/L6 hold on all three bricks — the facts are in IMPLEMENTATION_PLAN 1.11.11, now unblocked. Left open: the picker's "Bluetooth presence unavailable, the list shows Windows' records only" is Windows-worded on Linux (minor). CCC runs firmware V1.09H, AAA and BBB V1.10E — a second firmware variant on the bench, as the owner said to expect.

## Open, decided later

- ~~Two consumers want two modes of one sensor~~ — decided as D6/D7.

- 3.1.2 filesystem state as a row: `storage()` answers it today; a row when a consumer needs to follow it.

- Daisy chain beyond layer 0 (D3).
- The diagnostic display itself (Phase 5).
