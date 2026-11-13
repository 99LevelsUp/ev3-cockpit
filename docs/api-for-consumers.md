# The cockpit's API, for the extensions that use it

For ev3-c (formerly ev3-native), ev3-explorer, and later ev3-python, ev3-blockly or an MCP server.
It answers IMPLEMENTATION_PLAN 4.9.4: what the cockpit provides, and where the sibling designs
assumed something else. The reference is DESIGN §10 and `src/api/cockpitApi.ts`.

## Getting it

```ts
const cockpit = vscode.extensions.getExtension('99LevelsUp.ev3-cockpit');
const api = await cockpit?.activate();          // { apiVersion: 1, registerConsumer }
if (api?.apiVersion !== 1) { /* tell the user to update the cockpit */ }
const ev3 = api.registerConsumer('ev3-c');
context.subscriptions.push(ev3);                // its subscriptions end with it
```

Declare `"extensionDependencies": ["99LevelsUp.ev3-cockpit"]`.

## Naming a brick

Every call takes a brick id or `'active'`, resolved when the call is made. Answers and events
carry the id. With no active brick, `'active'` fails with `code: 'not_connected'`.

## What there is

| Need | Call |
|---|---|
| bricks, including ones not connected | `listBricks()`, `onBricksChanged` |
| the active brick | `getActiveBrickId()`, `setActiveBrick(id)`, `onActiveBrickChanged` |
| connect / disconnect | `connect(brick)` — "Connect a Brick", pairing included; `disconnect(brick)` |
| firmware version | `getBrickInfo(brick)` → name, firmware, OS |
| files | `list`, `exists`, `size`, `storage`, `readFile`, `writeFile` (progress, `AbortSignal`), `makeDirectory`, `remove` (`recursive`), `move` |
| run an `.rbf` | `runProgram(brick, path, { replace })` — the user slot, as the brick's own browser; `running: false` means it was never seen running (ended already, or refused) |
| stop / emergency stop / state | `stopProgram`, `emergencyStop` (also stops every motor; a `runProgram` asked before it and not yet sent is cancelled), `isProgramRunning`, `onProgramStateChanged` |
| a shell command | `runShell(brick, command)` — only in full mode |
| the access mode | `getAccessMode()`, `onAccessModeChanged` |
| telemetry | `listTelemetryRows()`, `subscribeTelemetry(brick, { rows, intervalMs, modes? }, listener)` — below |

Errors are `CockpitError`s with a stable `code`: `not_connected`, `access_denied`,
`program_running`, `program_not_found`, `program_cancelled` (an emergency stop came before the
start was sent), `mode_conflict`, `subscription_failed`, `protocol_failed`, `transport_failed`,
`timeout`, …

A brick id the cockpit does not know is refused with `not_connected`. Program, shell and
brick-info answers name the brick by id; file answers are just the file data. A consumer that
needs to know which brick answered takes `getActiveBrickId()` first and passes that id, not
`'active'`: asked afterwards, the active brick may already be another one.

## Telemetry

```ts
const sub = cockpit.subscribeTelemetry('active', { rows: ['ports.motor.A.tacho'], intervalMs: 100 }, (update) => {
  // update.kind: 'snapshot' first, then 'change'; 'ended' when the brick goes
  for (const v of update.values) { /* v.rowId, v.value, v.sampledAt, v.effectiveIntervalMs, v.stale */ }
});
sub.grant;      // { 'ports.motor.A.tacho': 100 } — at least this often
sub.dispose();  // releases exactly this subscription
```

- `listTelemetryRows()` names every row: `ports.sensor.1.value`, `ports.sensor.1.occupancy` (the type
  code, with the device's mode), `ports.motor.A.tacho`, `ui.button.enter`, `system.battery.level`, …
- The grant is the request clamped to the link's floor (USB 50 ms, TCP 100 ms, Bluetooth 250 ms),
  fixed when you subscribe. What a row really runs at — slower while the brick answers slowly
  (adaptive throttling) — is each value's `effectiveIntervalMs`.
- A sensor's mode is part of the request: `modes: { '1': 2 }`. The first subscription on a port holds
  its mode; asking another mode of that port is refused with `mode_conflict`, naming who holds it.
- After the snapshot you hear only rows whose value, mode, staleness or interval changed. Nothing is
  lost in an outage: values turn `stale`, and the first reading after it is sent even if unchanged.
  Values stale long enough are dropped and listed in `removed`. `snapshot()` gives the current
  values any time, so it can be ahead of the updates your listener has heard so far.
- Updates arrive asynchronously, never inside the call that subscribed, and in one order for every
  subscription of every consumer. The snapshot holds everything up to your subscription, and each
  later change comes once, behind it. Anything your listener causes, such as another change, a
  brick's end or a new subscription, arrives after the update you are handling, for you and for
  everyone else. A listener that throws stops nothing but itself.
- A subscription to a brick that is not the active one runs that brick's telemetry for you; each
  telemetry command costs a program running on the brick about 2 ms, so ask for what you need.
- **While a program runs on a brick, its telemetry slows down** to the user's
  `ev3-cockpit.telemetry.programRunningTickMs` (200 ms unless changed; 0 turns it off) — for
  everyone, your subscription included. Your grant stays; `effectiveIntervalMs` shows the slower
  reads. The program comes first.

## Following a program

`onProgramStateChanged(brick, listener)` follows the brick's program through its telemetry
(`program.user.running`), not a poll of its own, and only while someone listens. The listener hears
each start and end once, asynchronously, never inside the call that subscribed. A lost link that
comes back keeps following; it ends when the brick is disconnected or signed out, as telemetry
subscriptions do — subscribe again after reconnecting. How often a brick you follow is asked is the
user's `ev3-cockpit.programs.statusIntervalMs`; the active brick is asked at its own telemetry pace
anyway. `isProgramRunning(brick)` asks the brick directly, now.

## Safe and full mode

The user chooses it in the cockpit's settings (`ev3-cockpit.accessMode`); the cockpit enforces
it. **safe** (default): writing, deleting and running only under `/home/root/lms2012/prjs` and
`/media/card`; reading everywhere; no shell. **full**: everything, shell included. A consumer
reads the mode to grey out what it cannot do; it does not enforce it itself. Safe mode is a
guardrail against mistakes, not a sandbox: a program it runs can do anything on the brick, and a
symbolic link inside a user area that points outside is not caught.

## Running a native program (ev3-c)

The stock firmware runs `.rbf` bytecode only. The cockpit runs an `.rbf`; it does not build one.
ev3-c puts its binary and a launcher `.rbf` (the ev3duder approach) in the project folder and
calls `runProgram` on the launcher. Setting the binary executable, or `ldconfig` for an "install
ev3lib" action, is a shell command: `runShell`, which needs full mode. Note that the program
state the cockpit reports is the launcher's slot, not the native process it started.

## Where the sibling designs differ

- **ev3-native `design.md` §3.1** says the cockpit registers 45+ commands, provides `ev3://` and
  runs programs. It provides the API above; `ev3://` is registered by ev3-explorer over this API
  (DESIGN §4.6a); there are no deploy/run palette commands for consumers to call.
- **ev3-native §3.2/§3.3** — three channels (commands, `ev3://`, API). Use the API.
- **ev3-native 484** runs the ELF directly with `runProgram`; the firmware runs only `.rbf`, see
  above.
- **ev3-explorer §8.3** names `resolveAuthority`, `getDefaultRoots`, `getFsAvailability`,
  `resolveFsService`. Not in the API: build them in ev3-explorer over `listBricks`, the file
  calls and the access mode.
- **ev3-explorer §12** — safe/full is the cockpit's, now defined (above).
- **Rename** is `move`: a copy and a removal on the brick, not atomic.
- **Program output** (stdout of a native program) and log tailing: not yet, when a consumer asks.
