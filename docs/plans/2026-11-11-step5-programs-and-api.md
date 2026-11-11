---
title: Step 5 — programs and the public API
date: 2026-11-11
status: active
origin: owner, 11.11.2026 — users have robots nearly built and want to program them; finish Phases 1–4 so only the visuals remain
---

# Step 5: programs and the public API - Plan

## Goal Capsule

- **Objective:** any VS Code extension (ev3-c, formerly ev3-native; ev3-explorer; later ev3-python, ev3-blockly) can put files on a brick, run a program, stop it, and follow its state through the cockpit's public API, and the API is plain data so an MCP server can wrap it later.
- **Means:** a program control service on the service tier (4.7a), a shell command gated by an access mode (KD3), the access-mode policy enforced in the cockpit (KD2), and a versioned API object exported from `activate()` (4.2–4.4, 4.7, 4.9) that also lists bricks and connects them (KD4).
- **Authority:** owner decisions in this plan's Key Decisions > `DESIGN.md` > this plan's KTDs > existing code. KD4 rewrites DESIGN §10.3.
- **Not in this step:** telemetry on the API (4.5) and the read model go to step 6; Linux Bluetooth to step 7; the panel to Phase 5.
- **Finishes and ships:** Claude implements, commits and pushes per unit; the owner runs the hardware session (U9).

## Product Contract

### Requirements

- R1. A consumer uploads, downloads, lists, removes, renames and creates folders on a brick, with progress and cancellation for transfers (the filesystem layer exists; this exposes it).
- R2. A consumer runs an `.rbf` on a brick, stops it, asks whether it runs, and is told when it starts and ends.
- R3. Emergency stop ends the user's program and stops every motor, the way the brick's own power-off does.
- R4. A consumer in full mode runs a shell command on the brick and gets its exit status; in safe mode it is refused.
- R5. Safe mode lets a consumer write, delete and run only in the user areas; reading is allowed everywhere. The cockpit enforces it, not the consumer.
- R6. A consumer lists every brick the cockpit knows with its channels' states, asks for the active brick, sets it, connects a brick and disconnects it.
- R7. Every call names a brick by its id or by `'active'`; program, shell and brick-info answers and every event name the brick by its id (file answers carry only the file data — narrowed after review round 2).
- R8. The API is versioned, and a consumer's subscriptions end when it unregisters or its extension deactivates.

### Key Decisions (owner, 11.11.2026)

- KD1. **A brick is named by its id or by `'active'`,** resolved when the call is made; answers carry the id. (Both sibling designs use `'active'`: ev3-native `design.md` 483, ev3-explorer `ideas.md` 321.)
- KD2. **Safe mode = the user areas.** Safe (default): writing, deleting and running only under `/home/root/lms2012/prjs/` and the SD card (`/media/card/`); reading anywhere. Full: the whole filesystem and the shell. Switched in the cockpit's settings, enforced by the cockpit.
- KD3. **The shell (`opSYSTEM`) only in full mode,** every call logged. A launcher `.rbf` for a native program is the consumer's job (ev3-c), not the cockpit's.
- KD4. **Brick list, connect and disconnect through the API.** DESIGN §10.3 excluded them to keep the connection lifecycle in one place; the owner chose to expose them. They go through the brick layer's own paths (sign-in with pairing and the brick's dialog as consent, sign-out), so the lifecycle still has one owner.

## Facts the plan rests on (firmware 1.09d developer edition)

Research 11.11.2026; paths under `ev3-resources/11_Firmware/ev3_firmware_109d_developer_edition/`.

- `opFILE` 0xC0 / `LOAD_IMAGE` 8: `PAR16 slot, PAR8 name, out PAR32 size, out PAR32 address`; size and address 0 when the file is missing (`c_memory.c` 3057–3127). The image belongs to the slot, so load and start name the same slot. A name without a path gets the folder `ui`, without an extension `.rbf`.
- `opPROGRAM_START` 0x03: `PAR16 slot, PAR32 size (ignored, "Dummy"), PAR32 address, PAR8 debug` (`lms2012.c` 2966–2999); debug 0 normal.
- `opPROGRAM_STOP` 0x02: `PAR16 slot`; **0 means all slots including the brick's UI, and the VM exits** (2943–2951, 1713–1729) — never send it.
- `opPROGRAM_INFO` 0x0C / `GET_STATUS` 22: a program is `RUNNING` 0x10 or `STOPPED` 0x40 (`bytecodes.h` 1593–1596).
- **A start into a slot that is not STOPPED is refused silently;** from `CMD_SLOT` both `USER_SLOT` and `DEBUG_SLOT` must be stopped (`lms2012.c` 3002–3030). A loaded image whose start was refused stays allocated until the slot next runs.
- Slots: `GUI` 0, `USER` 1, `CMD` 2 (direct commands), `TERM` 3, `DEBUG` 4. The brick's file browser runs programs in `USER_SLOT` (`ui.lms` 640, 1488–1489), and only `USER_SLOT` opens and closes the sound, output, input and UI modules.
- Motors: the VM does not stop them; the UI does, sending `INPUT_DEVICE(STOP_ALL,-1)` when `USER_SLOT` turns STOPPED (`ui.lms` 180–189). The brick's power-off sequence is `PROGRAM_STOP(USER_SLOT)`, `PROGRAM_STOP(DEBUG_SLOT)`, `INPUT_DEVICE(STOP_ALL,-1)` (`ui.lms` 1887–1889).
- `opSYSTEM` 0x60: `PAR8 command, out PAR32 status`; calls `system()` inside the VM and waits, then `sync()` (`lms2012.c` 4622–4635); a long command needs `&`.

## Key Technical Decisions

- KTD1. **Programs run in `USER_SLOT`,** as the brick's own browser runs them, so the brick's motor and sound clean-up apply. The API exposes no slot.
- KTD2. **`runProgram` checks before it starts:** `GET_STATUS(USER_SLOT)`; if a program runs, it is refused with a typed error unless the caller passes `replace: true`, which stops it first. Then `LOAD_IMAGE` (size 0 → file not found), `PROGRAM_START`, and `GET_STATUS` until RUNNING within a short limit; never seen running answers `false` rather than an error, since a short program may have ended already (review 11.11.2026). Run and stop take turns per brick. This turns the firmware's silent refusal into an answer and avoids the stranded image.
- KTD3. **Emergency stop is the brick's power-off sequence** (facts above), never `PROGRAM_STOP(0)`.
- KTD4. **Run state is polled** with `GET_STATUS(USER_SLOT)` at about 1 s while a program the cockpit knows of runs or while anyone subscribes to it, and fires `onProgramStateChanged`. Step 6 moves the poll into the telemetry scheduler's command budget.
- KTD5. **The access mode is checked in the API layer** for every write, delete, run and shell call, against the brick path normalised (no `..` escape). Cockpit commands go through the same check.
- KTD6. **The API object is plain data and promises:** no `vscode` types in arguments or answers except `Disposable`/`Event` for subscriptions; errors carry a stable `code`. `apiVersion` starts at 1.
- KTD7. **The mock brick answers the new commands** (program start/stop/info, `opSYSTEM`), so the API is testable without hardware and works in the development host.

## Implementation Units

| U-ID | Title | Covers |
|---|---|---|
| U1 | Protocol: the program and shell commands | 4.7a (encoding), 4.6.13 |
| U2 | Mock brick runs programs | KTD7 |
| U3 | Program control service | 4.7a.1–4.7a.6, R2, R3 |
| U4 | Access mode | 4.9.2, R5, KD2 |
| U5 | Shell | R4, KD3 |
| U6 | Public API object | 4.2–4.4, 4.7, 4.9.1, 4.9.3, R1, R6–R8, KD1, KD4 |
| U7 | Integration tests with a mock consumer | 4.8 (without telemetry) |
| U8 | Documents | DESIGN §10, IMPLEMENTATION_PLAN, 4.9.4 |
| U9 | Hardware session | R1–R6 on bricks |

Each unit: tests first (RED), mutation check of the key assertions, `npm run test:ci`, a topic commit, push. A codex round on the service and API units (U3, U6) with an inline packet.

### U1. Protocol: the program and shell commands

- `BrickCommand` kinds `program:loadImage`, `program:start`, `program:stop`, `program:status`, `system:run`, `input:stopAll`; encoders and reply parsers in `src/protocol`, values from the facts above, pinned by tests against hand-computed bytes from `c_com.h` 820–843's example.

### U2. Mock brick runs programs

- `MockTransportProvider` keeps a per-slot state, answers load (file present in the mock filesystem → size/address), start (refuses a busy slot silently, as the firmware does), stop, status, `STOP_ALL`, and `system` (records the command, answers status 0).

### U3. Program control service

- `src/programs/programService.ts`: `run(path, {replace})`, `stop()`, `emergencyStop()`, `isRunning()`, `onStateChange`; KTD2–KTD4. Tests: busy slot refused unless replace; missing file; start refused → error; emergency stop sends the three commands in order; the poll fires one event per change and stops when nothing needs it.

### U4. Access mode

- Setting `ev3-cockpit.accessMode`: `safe` (default) | `full`; `src/api/accessPolicy.ts` decides allowed(operation, path, mode); normalisation; event on change. Tests: each operation inside and outside the user areas in both modes; `..` escapes; the SD card.

### U5. Shell

- Program service or its own small service: `runShell(command)` → exit status; refused in safe mode; logged ("Shell on <brick>: <command> → <status>").

### U6. Public API object

- `src/api/cockpitApi.ts` built in `extension.ts` and returned from `activate()`: `apiVersion`, `registerConsumer(name)`, bricks (`listBricks`, `getBrick` with firmware version, `getActiveBrickId`, `setActiveBrick`, `connect`, `disconnect`, `onBricksChanged`, `onActiveBrickChanged`, `onBrickStateChanged`), files (`list`, `exists`, `size`, `storage`, `read`, `write` with progress and cancellation, `mkdir`, `remove`, `move`), programs (`run`, `stop`, `emergencyStop`, `isRunning`, `onProgramStateChanged`), `runShell`, `getAccessMode`, `onAccessModeChanged`. `'active'` resolution in one place; typed errors with codes.

### U7. Integration tests

- 4.8.1, 4.8.2, 4.8.4–4.8.6 against the mock: register, snapshot, events, files, programs, cleanup on unregister, two consumers at once.

### U8. Documents

- DESIGN §10 rewritten to the built API (and §10.3 per KD4); IMPLEMENTATION_PLAN boxes; a short "for consumers" note answering 4.9.4 (what exists, `'active'`, safe/full, where the launcher comes from), to hand to the sibling projects.

### U9. Hardware session

- Upload a file, list, remove; run a brick's own demo `.rbf` and stop it; run while one runs (refused, then `replace`); emergency stop with a motor turning; a shell `echo` in full mode, refused in safe mode; connect and disconnect through the API.
- IMPLEMENTATION_PLAN 4.6.4: the largest write chunk the firmware takes over TCP and over Bluetooth (today both use the firmware's 1024-byte buffer); write files of 1, 1000 and 100 000 bytes over each and read them back.

## Review (codex, inline packet)

### Round 1 — U3, U4, U6 (11.11.2026), NOT-READY → fixed in ddcdf57

| # | Sev | Finding | Verdict | Outcome |
|---|---|---|---|---|
| 1 | major | two `run` calls race their checks; the second start is refused in silence | CONFIRMED | run and stop take turns per brick |
| 2 | major | never seen running reported as a refusal; a short program may have ended | CONFIRMED | answers `false`, no claim either way |
| 3 | major | a symbolic link inside a user area escapes safe mode | NEEDS-DESIGN-DECISION | documented: safe mode is a guardrail, not a sandbox (DESIGN §10) |
| 4 | minor | the poll keeps running for a brick that no longer answers | CONFIRMED | following ends on a failed poll |
| 5 | minor | a throwing listener costs the others the change | CONFIRMED | listeners isolated |
| 6 | minor | a closed consumer can still subscribe | CONFIRMED | refused with `consumer_failed` |
| 7 | minor | a wrong reply kind reported as a lost connection | CONFIRMED | `protocol_failed` |

### Round 2 — confirmation of round 1 (11.11.2026), NOT-READY → 6d03495

| # | Sev | Finding | Verdict | Outcome |
|---|---|---|---|---|
| 1 | major | `emergencyStop` is not queued, so a waiting `run` can start the program after it | CONFIRMED | an emergency stop cancels every run asked before it whose start is not sent (`program_cancelled`); test + 2 mutations |
| 2 | major | one failed poll ends following of a started program | CONFIRMED | three failures in a row; **the fix itself is round 3's finding 1 — not closed** |
| 3 | minor | program services pile up, also for invalid ids | CONFIRMED | an id the cockpit does not know is refused before any command |
| 4 | minor | file answers carry no brick id though the module says every answer does | CONFIRMED | the claim narrowed (R7, DESIGN 10.2) |

### Round 3 — confirmation of round 2 (11.11.2026), NOT-READY → escalated

| # | Sev | Finding | Verdict | Outcome |
|---|---|---|---|---|
| 1 | major | the failure count survives a stop and a new run: two failures on program A, stop, run B, one failure ends following of B | CONFIRMED (`stopNow` and `run`'s confirmation call `isRunning` directly; only the poll path resets the count) | **escalated to the owner** — third round in the same area, a defect in the previous round's fix |
| 2 | minor | "ask `getActiveBrickId()` afterwards" is itself racy | CONFIRMED | docs: take the id first and pass it |

Why escalated, not patched: rounds 2 and 3 both found majors in keeping the poll alive while nobody listens (`following`). Nothing outside the service reads a poll that has no listener: the API's `onProgramStateChanged` is the only reader of the state changes, and `isProgramRunning` asks the brick itself. Options put to the owner:

- **(a)** keep KTD4's following and rework the accounting: failures count against the brick's answers, any answer and every transition reset the count; regression test two failures → stop → run B → one failure, B still followed.
- **(b)** poll only while someone listens: drop `following` and the counter; step 6's telemetry scheduler takes the poll over, as KTD4 already says. Removes the class of rounds 2–3 instead of closing one more instance. Recommended, since no reader exists.

## Open, decided later

- 4.7a.4's poll joins the telemetry scheduler (step 6).
- Program output (stdout of a native program, 4.6.13 log tailing) — when a consumer asks.
