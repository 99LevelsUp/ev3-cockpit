# The cockpit for add-ons: the contract and the client library

For add-on authors: EVƎ C (formerly ev3-native), ev3-explorer, and later ev3-python, ev3-blockly
or an MCP server of your own. It says what the cockpit provides, how to reach it, and where the
sibling designs assumed something else.

The cockpit is a per-user daemon, the native binary `ev3-cockpitd`. The VS Code extension, the
`ev3` command, the cockpit's MCP server and every add-on are its clients and talk to it over
JSON-RPC on a local pipe or socket. The VS Code extension exports nothing: an add-on does not ask it
for anything.

The reference is the contract, JSON Schema in `contract/` generated into TypeScript in
`src/contract/generated/`, with the wire error codes in `src/contract/errors.ts`, and the client
library in `src/client/index.ts`. Both ship as one package, `@ev3-cockpit/client`, built from this
repository and carrying no native modules and no daemon (`npm run package:npm` stages it in
`dist/npm/client/`; it is not published yet). Until it is, load the library from a compiled
checkout (`npm run compile`, then `out/client/index.js`), as `scripts/api-check` does.
[`protocol.md`](protocol.md) describes the protocol underneath, [`channel.md`](channel.md) how a
client finds the daemon.

## Connecting

```ts
import { CockpitClient, ContractError, WireErrorCode } from '@ev3-cockpit/client';

const cockpit = await CockpitClient.connect({
  name: 'EVƎ C (VS Code)',   // say where it runs: other clients read it in brick_busy, questions and stoppedBy
  kind: 'addon',
  version: '1.4.0',          // your add-on's version
});
context.subscriptions.push(cockpit);   // dispose() closes the connection and every subscription
```

- `kind` is `addon` for everything an add-on runs: its VS Code extension and its `ev3 <name>`
  command alike.
- `name` should say where the client runs, for example "EVƎ C (VS Code)" or "ev3 c run
  (terminal)". It appears in the daemon's log, in another client's `brick_busy` error, in the
  questions your requests raise, and as `stoppedBy` when you stop a program.
- A VS Code add-on needs no `extensionDependencies` on the cockpit to work; the cockpit must be
  installed for its daemon to exist.
- The `channel` and `stateRoot` options put a client on a test channel, with a daemon and state of
  its own; an add-on leaves them out and reaches the user's daemon.

**Starting the daemon.** `connect` finds the user's daemon and proves both sides hold the user's
key. When no daemon runs, an add-on starts the one the installed cockpit recorded in `install.json`
(see [`install.json`](#installjson)); `installedNativeLaunch(nativeChannelFiles(nativeStateRoot()))`,
exported from the package, reads that record and returns `undefined` when there is none. With
nothing to start, `connect` fails with a `DaemonStartError` (`failure: 'missing_binary'`), and you
tell the user to install (or open) EVƎ Cockpit.

An add-on passes no daemon of its own (the `daemon` option is for the cockpit's own clients), never
asks the daemon to exit and never compares package versions with it; see
[Version notices](#version-notices).

## Naming a brick

Every request that works on a brick takes `brick`: its id or its name. The daemon matches names
without regard to case, and so does the cache's `brick(ref)`; names need not be
unique (a fresh brick is called "EV3"):

- a name that fits several bricks is refused with `brick_ambiguous`; `error.data.candidates`
  lists `{ brickId, name }` of each;
- a name or id nobody knows is refused with `brick_not_found`, but only after the daemon's first
  discovery round, so a request sent just after the daemon started does not fail early;
- an add-on must always name the brick. Only the `ev3` command may leave it out.

Answers that concern a brick carry its id (`brickId`), so use the id from the first answer for the
rest of the work.

The active brick is your client's own (`activeBrick()`, `setActiveBrick(id)`); the daemon keeps
none for requests. Setting it tells the daemon to read that brick's telemetry in the foreground for
you; requests still name the brick.

**Which brick the cockpit shows.** To follow the brick a VS Code window shows, read
`daemon/status`: each entry of `clients` is `{ name, kind, version, buildKind, shows? }`, where
`shows` is the id of the brick that client shows (absent when none). Then listen with
`cockpit.on('daemon/showsChanged', ({ clients }) => …)`: every client hears it whenever any
client's shown brick changes, including when a window that showed one closes, and it carries the
whole client list in the same form. Pick the entry with `kind: 'vscode'`; with several windows open,
several may show a brick.

## What there is

`cockpit.request(method, params)` sends any contract method. The cache answers without a round
trip: `bricks()`, `brick(ref)`, `settings()`, `accessMode()`.

| Need | Method or call |
|---|---|
| bricks, including ones not connected | `bricks()`, `onBricksChanged`; `bricks/list` (`waitForDiscovery`) → `{ bricks }` |
| connect / disconnect | `bricks/connect` (pairs on the way if needed), `bricks/disconnect` |
| firmware version | `bricks/info` → name, firmware, OS |
| storage | `bricks/storage` → `totalKb`, `freeKb` |
| files | `files/list`, `exists`, `size`, `read`, `write`, `makeDirectory`, `remove` (`recursive`), `removePaths`, `move` |
| a file as it grows (a program's output) | `files/follow` (`fromOffset`) → `files/appended`, `files/followEnded`; end it with `subscriptions/cancel` |
| put files on the brick and start a program | `programs/deployAndRun` |
| start an `.rbf` already on the brick | `programs/run` (`replace`) |
| stop / emergency stop / state | `programs/stop`, `programs/emergencyStop` (also stops every motor), `programs/status` (`waitMs`), `subscribePrograms` |
| a shell command | `shell/run`, only in full mode |
| the access mode | `accessMode()`, `settings/accessMode`; `settings/accessModeChanged` |
| settings | `settings()`, `settings/list`, `settings/set` |
| telemetry | `telemetry/rows`, `subscribeTelemetry(brick, { rows, intervalMs, modes? }, listener)` |
| the daisy chain | `chain/get`, `followChain(brick, listener)` |
| pairing, forgetting, clearing a Bluetooth list | `bricks/pair`, `bricks/forget`, `bricks/clearBluetoothList` (the last two ask the person) |

Results are objects: `bricks/list` answers `{ bricks }`, `settings/list` `{ settings }`,
`settings/accessMode` `{ mode }`, `files/list` `{ entries }`, `files/exists` `{ exists }`;
`telemetry/foreground` takes `{ brick? }` (absent for none).

**Hold the brick you work with.** A request on a brick nobody connected fails with
`not_connected`, and a brick another client holds can go when that client lets it go. Connect it
(`bricks/connect`, no `hold`) for as long as you work with it; the library connects it again after
a daemon replacement. `bricks/disconnect` drops your client's hold. The brick stays connected while
anyone else holds it (a VS Code window, `ev3 connect`); the answer's `stillHeldBy` says who. When
your client's connection closes, its holds go with it.

## Errors

A failed request rejects with a `ContractError`:

- `code` is a stable string from `WireErrorCode` (the generated `ErrorCode`); decide on it. The
  codes say what happened finely enough: a link that dropped is `link_lost`, a brick that never
  answered `brick_unreachable`.
- `data` carries the code's `family` (`brick`, `lease`, `person`, `daemon`, `cancelled`, `request`,
  `internal`) and extras: `holder` for `brick_busy`, `candidates` for `brick_ambiguous`, `command`
  (what a person should run) for `needs_person`.
- There is no class name: `kind` left `ContractError` with the Node daemon (23.11.2026).

The codes an add-on meets most: `brick_busy`, `brick_ambiguous`, `brick_not_found`,
`not_connected`, `access_denied`, `program_running`, `program_not_found`, `mode_conflict`,
`subscription_failed`, `needs_person`, `daemon_unavailable`, `outcome_unknown`, `cancelled`,
`invalid_request`, `transport_failed`, `link_lost`, `brick_unreachable`, `timeout`,
`protocol_failed`.

## Write leases and `brick_busy`

A request that changes a brick takes the brick's write lease for exactly its own length:
`files/write`, `makeDirectory`, `remove`, `removePaths`, `move`, `programs/deployAndRun`,
`programs/run`, `shell/run`, `bricks/forget`, `bricks/clearBluetoothList`. Reads never take it.
Stop and emergency stop never take it and never wait for it.

While another request holds the lease, a second writer is refused at once with `brick_busy`;
nothing is queued. `error.data.holder` names the client holding it, so you can tell the user who is
writing. Try again when that client is done.

No client holds a lease between requests, so work of several steps is one request:
`programs/deployAndRun` (files, then the start) and `files/removePaths` (several removals). When
a client's connection closes, its requests are aborted and its leases end once those requests
have settled, so a dead client's upload never interleaves with the next writer.

## `outcome_unknown`

If the daemon goes away (a crash, a restart, or a newer version taking over) while a request that changes a
brick is running, the request ends with `outcome_unknown`: it may or may not have taken effect.
Nobody retries it, not the library and not the daemon. Read the state first (`programs/status`,
`files/exists`, `files/list`) and decide from that. The same failure during a read is
`daemon_unavailable`, which is safe to repeat once the client is connected again.

## Questions for a person, and `needs_person`

Some operations need a person's yes. The daemon asks only a VS Code window or a terminal: the
requesting client when it is one of those (kind `vscode` or `cli`), otherwise the VS Code window
that connected last, else the terminal that connected last. An add-on or an MCP server is never
asked. The question names the client whose request raised it (`question.requester`, its name and
kind), so the person sees that your add-on asked.

What this means for an add-on:

- `bricks/forget` and `bricks/clearBluetoothList` from your add-on raise the question in the
  user's VS Code or terminal. A `no` ends the request with `cancelled` and changes nothing. When no
  answer comes (`keep`, silence for 60 s, or nobody to ask), it ends with `needs_person`, and
  `error.data.command` is the `ev3` command a person can run instead.
- `sweep` is asked when a transfer of yours starts and an earlier transfer left a file slot open on
  the brick: `yes` releases it, `no` drops the debt for good, `keep` lets your transfer go ahead and
  keeps the debt, with a warning in the log. With nobody to ask it counts as `keep`.
- `daemon/exit` from an add-on is always a restart, asked of the person the same way; it answers
  `{ accepted: false, reason }` when no yes comes (`channel.md`, "`daemon/exit`").
- `CockpitClient.onQuestion` is how the cockpit's own `vscode` and `cli` clients answer; an add-on
  that sets a handler is never called. The answers are `'yes' | 'no' | 'keep'`, or
  `{ answer, remember: true }` to apply a yes or no to the same question about that client's own
  later requests while its connection lasts; `keep` is never taken as `no`.

Some changes need a person in any case. The access mode is the one dangerous setting today:
`settings/set` with `accessMode: 'full'` from an add-on is refused with `needs_person`; the user
switches it in VS Code (EVƎ: Settings) or with `ev3 config` in a terminal. Setting it back to
`safe` is allowed.

## Files

File content never travels as one large message:

- inline base64: `files/write` with `content` up to 4 KiB, `files/read` with `inline: true` up
  to 64 KiB (a larger file is refused with `invalid_request` as soon as the brick says its size,
  before the rest of it is read, so trying inline first costs one exchange);
- a local path the daemon reads or writes itself (`fromLocalPath`, `toLocalPath`): the daemon
  runs as the same user on the same computer, so this is the normal way for larger files. The
  path must be absolute: the daemon's working directory is not the client's;
- a transfer handle filled or drained in chunks (`transfer/begin`, `write`, `read`, `close`),
  for clients that cannot share a file system path with the daemon.

A write or a deployment to a path whose folders do not exist yet creates them. Rename is
`files/move`: a copy and a removal on the brick, not atomic.

## Programs

`programs/deployAndRun` takes the files and the program to start:

```ts
const result = await cockpit.request('programs/deployAndRun', {
  brick: brickId,
  files: [{ remotePath: '/home/root/lms2012/prjs/demo/demo.rbf', localPath, skipIfSameMd5: true }],
  runPath: '/home/root/lms2012/prjs/demo/demo.rbf',
});
// result.outcome: 'started' | 'not_seen_running' | 'uncertain'; result.runSeq; result.uploaded; result.skipped
```

It checks first that nothing runs (otherwise `program_running`, and nothing is put on the brick),
then uploads each file (a file whose MD5 on the brick matches is left, with `skipIfSameMd5`), then
starts the program; the lease ends at the start. `programs/run` starts a program already on the
brick; `replace: true` stops the one running first.

- `started`: the brick reported the program running.
- `not_seen_running`: the start was confirmed but the program was not seen running; it may have
  ended at once, or the brick refused it in silence.
- `uncertain`: the reply to the start was lost. Do not start again; read the state first.

A brick refusing a program is an error: `program_not_found`, `program_running`, `access_denied`.

**Stopping.** `programs/stop` and `programs/emergencyStop` reach the brick at once from any client,
even while another client holds the lease; they never wait. A stop also ends any
`deployAndRun` or `run` on that brick that has not sent its start yet: it fails with `cancelled`,
the message naming who stopped, and nothing is started, so a stop pressed during an upload is
never followed by a start.

**State.** `ProgramState` is `{ brickId, running, runSeq, stoppedBy? }`:

- `runSeq` counts the starts sent to the brick (0 before any). `DeployResult.runSeq` is your
  start's number. The daemon takes a number before the start is checked, so a refused or cancelled
  start uses one too and the numbers you see have gaps. The daemon keeps each brick's last number
  in its state directory (`runs.json`) before it sends the start, so a daemon that replaces it
  counts on and a higher `runSeq` is a later run across daemons too. Only a damaged `runs.json`
  restarts the count at 0; the daemon log says so.
- A state is told with the number of the latest start at the time it is told. So a higher
  `runSeq` than yours means someone started again after you. The same number does not prove the
  state is about your program: when you start with `replace`, the previous program ending is told
  with your number, as `running: false`, just before your program shows as running.
- `stoppedBy` names the client whose stop came after the latest start, when the program is not
  running. A program that ended by itself has none.
- In the answers to `programs/stop`, `programs/emergencyStop`, `programs/status` and in the state
  `subscribePrograms` returns, `running` is what the brick said when asked just then. In
  `programs/stateChanged` it comes from the brick's telemetry, read at
  `programs.statusIntervalMs` (1000 ms unless the user changed it) for a brick nobody shows in the
  foreground, so it lags the brick.

`programs/status` answers now, or with `waitMs` (up to 120 s) once the state changes; when the
wait runs out, it answers with the unchanged state.
`subscribePrograms(brick, listener)` gives the state now as `.state` and tells the listener each
change after that. It follows the brick's telemetry row `program.user.running`, read only while
someone follows the program, not a poll of its own. It ends, without a notification, when the
brick is signed out; subscribe again after connecting it again.

## Telemetry

```ts
const sub = await cockpit.subscribeTelemetry(brickId, { rows: ['ports.motor.A.tacho'], intervalMs: 100 }, (update) => {
  // update.kind: 'snapshot' first, then 'change'; 'ended' when the brick goes
  for (const v of update.values) { /* v.rowId, v.value, v.sampledAt, v.effectiveIntervalMs, v.stale */ }
});
sub.grant;      // { 'ports.motor.A.tacho': 100 } — at least this often
sub.dispose();  // ends exactly this subscription
```

- `telemetry/rows` names every row: `ports.sensor.1.value`, `ports.sensor.1.occupancy` (the type
  code, with the device's mode), `ports.motor.A.tacho`, `ui.button.enter`,
  `system.battery.level`, …
- The grant is the request clamped to the link's floor (USB 50 ms, TCP 100 ms, Bluetooth 250
  ms), fixed when you subscribe. What a row really runs at — slower while the brick answers
  slowly (adaptive throttling) — is each value's `effectiveIntervalMs`.
- A sensor's mode is part of the request: `modes: { '1': 2 }`. The first subscription on a port
  holds its mode; asking another mode of that port is refused with `mode_conflict`, naming who
  holds it.
- After the snapshot you hear only rows whose value, mode, staleness or interval changed. A row
  not read yet is missing from the snapshot and arrives as a change. Values turn `stale` in an
  outage, and the first reading after it is sent even if unchanged; values stale long enough are
  dropped and listed in `removed`.
- Connecting a brick starts no telemetry: the daemon reads a brick for a client that shows it
  (`telemetry/foreground`, which `setActiveBrick` sends) or while a subscription asks for rows.
- A subscription to a brick nobody shows in the foreground runs that brick's telemetry for you;
  each telemetry command costs a program running on the brick about 2 ms, so ask for what you
  need.
- **While a program runs on a brick, its telemetry slows down** to the user's
  `telemetry.programRunningTickMs` (200 ms unless changed; 0 turns it off), for everyone, your
  subscription included. Your grant stays; `effectiveIntervalMs` shows the slower reads.
- `ended` means the brick went (signed out or gone); subscribe again after connecting it.

## Cancellation and progress

Pass an `AbortSignal` to cancel your own request:
`cockpit.request('files/write', params, { signal })`. The request ends with `cancelled`; nothing
else is stopped (cancelling a `deployAndRun` does not stop a program someone else started). A
write cancelled halfway may leave a partial file on the brick.

`request` also takes `onProgress`, and the contract says requests that move file content report
`{ transferred, total? }`. The daemon does not send progress yet, so do not rely on it.

## Reconnects and subscriptions

When the daemon goes — a crash, `ev3 daemon restart`, a newer version taking over — the library
connects again by itself. Nothing is handed over between daemons: the library waits a moment for a
successor (another client replacing the daemon starts one), then:

- every subscription made through `subscribeTelemetry`, `subscribePrograms` and `followChain` is
  renewed, and the ids and disposables it gave you stay valid. A telemetry listener hears a fresh
  `snapshot` first; a chain listener hears the chain; a program listener hears the current
  state, which may repeat the last one it heard;
- bricks your client connected are connected again if the new daemon does not hold them already;
  bricks held with `ev3 connect` the new daemon connects itself;
- `onReconnected` fires once this is done; `onLost` fires if no daemon could be reached again.

A `programs/subscribe`, `telemetry/subscribe` or `chain/follow` sent through `request` is not
renewed: its id is valid on one connection only. Use the library's calls.

## Version notices

An add-on compares only the contract version (`CONTRACT_VERSION`, now 2), never the package
versions, and never asks the daemon to step aside. The contract version rises only on a breaking
change, so a daemon from a newer release with the same contract version serves you as before. The
hello carries both sides' versions; a daemon on another contract version answers only
`daemon/exit`, and `connect` rejects with a `DaemonStartError` whose `failure` is
`contract_mismatch` and whose message says which side to update.

`onNotice` gives other things the user should know as a text ready to show, for example that a
development daemon runs.

## Events and ordering

The daemon sends notifications (`Notifications` in the generated contract); the library dispatches them to
`on(name, handler)` and keeps its cache current from them. What holds:

- **One connection, one order.** On one connection, notifications arrive in the order the daemon
  sent them. There is no order between connections.
- **The brick list is coalesced.** `bricks/changed` carries the whole list. Changes made in one
  synchronous stretch of the daemon's work go out as one list, after the notifications sent
  directly in that stretch; several lists with the same content can still arrive in a row. So
  `bricks/reconnected` arrives before the `bricks/changed` that shows the brick connected. `bricks/reconnected` is sent whenever a brick gets a route after having none: after a
  lost link comes back, and also when it is first connected.
- **Answers and notifications are not ordered.** A request's answer may arrive before or after
  the notifications its work caused. Right after `bricks/connect` returns, use its result; the
  cache (`bricks()`) may still show the old state for a moment.
- **Telemetry has one order for everyone.** Updates for every subscription of every client come
  out of one queue in the daemon, so each client hears its own updates in that queue's order. The
  snapshot holds everything up to your subscription, and each later change comes once, behind it.
- **The snapshot is told before `subscribeTelemetry` resolves.** The library calls your listener
  with the snapshot while the subscribe call is still running; the same holds for the chain in
  `followChain`. `subscribePrograms` does not call the listener for the state it returns.
- **Listeners.** A listener that throws stops nothing else, the first snapshot included: the
  subscription stays.
- **Program state.** One `programs/stateChanged` per change the daemon sees; see
  [Programs](#programs) for what `runSeq` does and does not prove.

## Safe and full mode

The user chooses it, in VS Code or with `ev3 config`; the daemon enforces it for every client.
**safe** (default): writing, deleting and running only under `/home/root/lms2012/prjs` and
`/media/card`; reading everywhere; no shell. **full**: everything, shell included. Read the mode
(`accessMode()`, `settings/accessModeChanged`) to grey out what cannot be done; do not enforce it
yourself. Safe mode is a guardrail against mistakes, not a sandbox: a program it runs can do
anything on the brick, and a symbolic link inside a user area that points outside is not caught.
Full mode is never stored in the settings file: it lasts until the daemon ends, and a new daemon
starts in safe.

## The daemon's log

The daemon logs every client's connection, connects, deployments, stops and setting changes under
the client's `name`:

- Windows: `%LOCALAPPDATA%\ev3-cockpit\native\daemon.log`
- Linux: `$XDG_STATE_HOME/ev3-cockpit/native/daemon.log` (`~/.local/state/…` by default)

A test daemon logs to `daemon.log` in its channel's directory, `channels/<name>/`. `daemon/status`
returns the path as `logPath`, and a start failure from `connect` includes the log's last lines.
The log rotates at 5 MB and keeps three files.

## Running a native program (EVƎ C)

The stock firmware runs `.rbf` bytecode only. The cockpit runs an `.rbf`; it does not build one.
EVƎ C puts its binary and a launcher `.rbf` (the ev3duder approach) in the project folder and
starts the launcher, in one `programs/deployAndRun` with both files (`skipIfSameMd5` leaves an
unchanged binary on the brick). Setting the binary executable, or `ldconfig` for an "install
ev3lib" action, is a shell command: `shell/run`, which needs full mode. The program state the
cockpit reports is the launcher's slot, not the native process it started.

## What the package exports

| Export | What |
|---|---|
| `CockpitClient` | the client: `connect`, `request`, the cache, subscriptions, questions |
| the generated contract, at the top level | `Methods`, `Notifications`, `ParamsOf`, `ResultOf`, `METHODS`, `ERROR_FAMILY`, `CONTRACT_VERSION`, `readClientKind`, `readBuildKind` and every type (`ContractBrick`, `ProgramState`, `TelemetryUpdate`, `Question`, …) |
| `WireErrorCode`, `ContractError` | the error codes and the error a failed request rejects with |
| `DaemonStartError` | why `connect` could not reach or start a daemon (`failure`, below) |
| `installedNativeLaunch`, `nativeChannelFiles`, `nativeStateRoot`, `nativeInstallFile` | where the installed cockpit recorded its daemon, and the state root's files |
| `packagedDaemon`, `developmentDaemon`, `ensureNativeDaemon`, `decideOnDaemon`, `DAEMON_MANIFEST`, `recordNativeInstall` | how the cockpit's own clients carry and start their daemon; an add-on does not need them |

`CockpitClient.connect` takes `buildKind` too (`release` by default for an add-on).

## The Rust client, `ev3-client`

A Rust add-on (EVƎ C's backend) uses the crate `ev3-client` from this repository
(`daemon/crates/client`), the client `ev3` and `ev3 mcp` are built on. It is not on crates.io:
depend on it by git at a pinned rev, and take the contract from it so the two never differ.

```toml
ev3-client = { git = "https://github.com/99LevelsUp/ev3-cockpit", rev = "<rev>" }
```

```rust
use ev3_client::{Client, ClientOptions, Launch, method, user_paths};

let paths = user_paths(None)?;                // the user's daemon; Some("name") for a test channel
let client = Client::connect(ClientOptions {
    name: "EVƎ C (terminal)".into(),
    kind: "addon",
    version: "1.4.0",
    build_kind: "release",
    daemon: Launch::Installed,                // start what the installed cockpit recorded
    paths: &paths,
    daemon_args: Vec::new(),                  // a test passes --mode replay --fixtures <dir>
    asker: None,                              // answers the daemon's questions; None keeps them
    notice: &|text| eprintln!("{text}"),
}).await?;
let bricks = client.call::<method::BricksList>(params).await?;   // typed, from ev3-contract
```

- **Requests:** `call::<M>` for every request of the method table (`ev3_client::method`), typed by
  `ev3-contract`; `request(&str, Value)` for untyped ones. Dropping a request's future sends
  `$/cancelRequest`.
- **Errors:** one `ClientError` (`Clone`, `Send + Sync`): `Contract { code, message, data }` with
  `error_code()` and `error_data()` as the contract's `ErrorCode` and `ErrorData`, a code this
  version does not know left as its string; `Start { failure, message }` for the
  [start failures](#start-failures) (`failure()`); `Other`.
- **Starting the daemon:** `Launch::Installed` reads [`install.json`](#installjson) as the
  TypeScript client does; `Launch::Nothing` works only with a running daemon. With nothing to
  start, `connect` fails with `missing_binary`.
- **Bricks:** `bricks()` answers the list, asked for once and then kept current by
  `bricks/changed`.
- **Notifications:** `events()` reads every notification from then on as the contract's
  `Notification` (`BricksChanged`, `DaemonShowsChanged`, `ProgramsStateChanged`, …), in the order
  the daemon sent them; a reader that falls behind by thousands loses the oldest and counts them
  in `skipped()`.
- **A program's state:** `subscribe_programs(brick)` answers a `ProgramStates` with `state`, the
  state when it was made, and `next()` for every change, in order, for that subscription alone;
  a change the daemon sends before its answer is not lost. Dropping it cancels the subscription.
- **A file as it grows** (a program's output while it runs): `follow_file(brick, path,
  from_offset)` answers a `FileFollow` with `offset` and `size` (the file's size then) and
  `next()`: `FileEvent::Appended { offset, data }` for every growth, in order, each starting where
  the last ended (bytes, not text: a character may be split between two), then
  `FileEvent::Ended(reason)` when the daemon ends it (`removed`, `replaced` by a shorter file,
  `signedOut`, or `failed` when the brick refused its reads three times in a row). `file_not_found` when the file is not there yet: follow again a moment later. At
  most two follows per brick, for every client together. `reached()` is where to follow again
  from. Dropping it cancels the follow. The daemon polls the brick, often while the file grows
  and up to every 2 s while it does not; each poll reads only what is new.
- `ev3_client::CONTRACT_VERSION` and `ev3_client::contract` re-export `ev3-contract`.
- Rust 1.100.0 (the repository's `rust-toolchain.toml`), edition 2024, tokio 1 with `rt`, `net`,
  `io-util`, `sync`, `time` and `macros`; no transport is linked. The static C runtime this
  repository sets in `daemon/.cargo/config.toml` does not reach a consumer: set it in your own.
- **Outliving the daemon:** `Cockpit` (with `CockpitOptions`, owned) is the client an add-on
  keeps for a long time, as the TypeScript `CockpitClient`: when the connection closes it
  connects again by itself, starting the daemon its `Launch` names; the bricks it connected
  without a hold are connected again and every `subscribe_programs` is renewed, its reader getting
  the fresh state first; every `follow_file` (`CockpitFile`) is followed again from the offset
  its bytes reached, so nothing comes twice or is skipped, and a file gone meanwhile ends it as
  `removed`. `events()` carries `CockpitEvent::Notification`, `Reconnected` and `Lost`
  (no daemon came back; the next request tries again). A write cut by the daemon going fails with
  `outcome_unknown` and is never sent again. `Client` stays the short-lived connection `ev3` uses,
  which never reconnects; its `events()` and `ProgramStates` end with `None` when it closes.

## Start failures

`connect` rejects with a `DaemonStartError`. Its `code` is `daemon_unavailable`, so code-based
handling keeps working; its `failure` says which case it is, and every client tells them apart the
same way:

| `failure` | What happened |
|---|---|
| `missing_binary` | no daemon to start: the cockpit is not installed, or has not recorded its daemon yet |
| `sha_mismatch` | the binary does not match the SHA-256 its package recorded; nothing was started |
| `not_private` | the folder of the verified copies can be reached by another account |
| `smart_app_control` | Windows Smart App Control blocked the unsigned binary; the cockpit cannot run while it is on |
| `name_held` | the daemon refused to run (its pipe or socket name is held, or it was started elevated) |
| `lock_held` | another daemon was starting or ending on the channel and none became reachable |
| `contract_mismatch` | the running daemon speaks another contract version and could not be replaced |
| `failed` | anything else; the message carries the exit code and the end of the daemon's log |

## `install.json`

How the installed cockpit's daemon is started, for add-ons that carry none:

- **Where:** the native state root, `<state root>/install.json` (`%LOCALAPPDATA%\ev3-cockpit\native`
  on Windows, `$XDG_STATE_HOME/ev3-cockpit/native` on Linux); a test channel's in
  `channels/<name>/`.
- **Shape:** a `LaunchSpec`, `{ binary, sha256, version, buildKind }`, schema-typed.
- **Written by:** the VS Code extension and the `ev3` command of a release build, whenever they
  connect; whole or not at all, in the user's own state root (mode `0600` on Linux).
- **Used:** `binary` is never started itself. The client copies it to `bin/<sha256>/` under the
  state root, checks the copy against `sha256`, and starts that copy.

An add-on reads it through `installedNativeLaunch`; `undefined` means the cockpit is not installed
(or has not run yet), and `connect` then fails with `missing_binary`.

## Where the sibling designs differ

- **ev3-native `design.md` §3.1** says the cockpit registers 45+ commands, provides `ev3://` and
  runs programs. It provides the contract above; `ev3://` is registered by ev3-explorer over this
  contract (DESIGN §4.6a); there are no deploy/run palette commands for add-ons to call.
- **ev3-native §3.2/§3.3** — three channels (commands, `ev3://`, API). Use the contract through
  the client library.
- **ev3-native 484** runs the ELF directly; the firmware runs only `.rbf`, see above.
- **ev3-explorer §8.3** names `resolveAuthority`, `getDefaultRoots`, `getFsAvailability`,
  `resolveFsService`. Not in the contract: build them in ev3-explorer over `bricks()`, the file
  methods and the access mode.
- **ev3-explorer §12** — safe/full is the cockpit's, now defined (above).
- **Program output** (stdout of a native program) and log tailing: not yet, when an add-on asks.
