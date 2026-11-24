# The cockpit daemon protocol

How clients talk to the EVƎ Cockpit daemon `ev3-cockpitd`. The reference is the contract in
`contract/`: the JSON Schema under `contract/schema/` and the method table `contract/methods.json`,
generated into Rust (`daemon/crates/contract`) and TypeScript (`src/contract/generated/`). This page
explains it. How a client finds the daemon, the key, the lock, the framing, the hello and
`daemon/exit` are specified in [`channel.md`](channel.md). Add-on authors should start with
[`api-for-consumers.md`](api-for-consumers.md), which describes the client library.

## One daemon per user

- One daemon runs per user, a native binary that needs no Node runtime. The first client that finds
  none starts it. It ends 10 s after its last client has left while no brick is held through
  `ev3 connect`.
- A client starts a verified copy of the binary it carries: it copies it to `bin/<sha256>/` under
  the state root, checks the copy's SHA-256 and starts that copy. An add-on carries no daemon of its
  own: it starts the one the installed cockpit recorded in `install.json`, or tells the user to
  install the cockpit.
- The daemon refuses to run as administrator on Windows and as root on Linux.
- It listens on no network port: a named pipe on Windows, a unix socket on Linux, both reachable by
  the user alone, under a name drawn from the user's key at each start (`channel.md`).

**Files** (in the native state root, `channel.md` has the full table)

| File | What |
|---|---|
| `key` | 32 random bytes, readable by the user only. Shared by every channel. |
| `channel.json` | where the pipe or socket is, and the daemon's pid |
| `daemon.log` | one line per event, with a timestamp, a level and the client's name; rotated at 5 MB, three files kept |
| `settings.json` | settings that differ from their defaults |
| `held.json` | the bricks held with `ev3 connect`, which the next daemon connects again |
| `ledger.json` | unsettled transfers per brick, settled before that brick's next transfer |
| `runs.json` | each brick's last `runSeq`, so the next daemon counts on |

## Messages

JSON-RPC 2.0 with LSP's `Content-Length` framing. A message over 1 MiB closes the connection.

- Method names follow LSP's `area/action` form.
- Cancelling uses `$/cancelRequest`. The request ends with `cancelled`, and no other client's work is
  touched.
- Progress uses `$/progress` with the token the request carries. The contract says file transfers
  report `{ transferred, total? }`; the daemon does not send progress yet.
- Within one connection, notifications arrive in the order the daemon raised them.

## Handshake

Nothing but the hello is answered until the client has proved it holds the user's key. The client
sends `hello/start` with a fresh nonce, its name, its kind (`vscode`, `cli`, `mcp` or `addon`), its
version, its contract version and its build kind; the daemon proves itself, the client proves
itself with `hello/finish`, and the daemon answers with its version, contract version, build kind,
build id, mode (`hardware` or `replay`), pid, instance id, state (`serving` or `exiting`) and
transports. `channel.md` gives the proofs byte for byte.

**Name.** The client's name shows up in other clients' `brick_busy` errors, in questions and in the
log, so it should say where the client runs. For example: `VS Code (robot-project, pid 4242)`.

**Kind.** The kind limits what a client may do: an `mcp` client may not send `daemon/exit`, and
questions for a person go only to `vscode` and `cli` clients. The kind is what the client says; the
key proves only that it runs as the user (`channel.md`, the trust boundary).

## Methods

`contract/methods.json` lists every method with its parameters, result, whether it takes the write
lease, whether it needs a person and which client kinds may call it.

| Area | Methods |
|---|---|
| daemon | `daemon/status`, `daemon/exit`, `log/notice` |
| bricks | `bricks/list`, `connect`, `disconnect`, `info`, `storage`, `pair`, `forget`, `clearBluetoothList`, `inquiry` |
| files | `files/list`, `exists`, `size`, `read`, `write`, `makeDirectory`, `remove`, `removePaths`, `move` |
| transfer handles | `transfer/begin`, `write`, `read`, `close` |
| programs | `programs/deployAndRun`, `run`, `stop`, `emergencyStop`, `status`, `subscribe` |
| shell | `shell/run` (in full access mode only) |
| settings | `settings/list`, `set`, `accessMode` |
| telemetry and chain | `telemetry/rows`, `subscribe`, `foreground`; `chain/get`, `follow`; `subscriptions/cancel` |

Notifications: `bricks/changed`, `bricks/reconnected`, `bricks/pairingStarted`,
`bricks/pairingEvent`, `bricks/pairingDone`, `bricks/oneSidedRepair`, `programs/stateChanged`,
`telemetry/update`, `chain/changed`, `settings/changed`, `settings/accessModeChanged`,
`question/withdrawn`, `daemon/showsChanged`. The daemon's one request to a client is `question/ask`.

**Naming a brick.** A request names its brick by id or by name; case does not matter.

- A name that matches two bricks fails with `brick_ambiguous` and the candidates.
- A name not found during the first discovery round waits for that round to finish first.
- A `cli` connection may leave the brick out when exactly one brick is connected.

**File content** can travel in three ways:

- as an absolute local path the daemon reads or writes; the daemon refuses a path into its own
  directories (`channel.md`, "Local paths");
- inline as base64: at most 4 KiB when writing and 64 KiB when reading;
- through a transfer handle, in 48 KiB chunks, up to 64 MiB.

## Holders and write leases

**Holders.** A brick stays connected while it has at least one holder:

- a client that connected it;
- an `ev3 connect` hold (`bricks/connect` with `hold`), which outlives every client and the daemon
  itself (`held.json`).

Each VS Code window is a holder of its own. `bricks/disconnect` drops only the caller's own hold and
answers with who still holds the brick. `forEveryone` signs the brick out whoever holds it;
`releaseHold` drops the `ev3 connect` hold.

A request on a brick nobody connected fails with `not_connected`.

**Write leases.** A request that changes a brick takes the brick's write lease for exactly its own
length (`leased` in the method table).

- A second writer gets `brick_busy`, naming the holder.
- When a client's connection closes, its requests are aborted. Their leases are released only once
  those requests have settled.
- `programs/stop` and `programs/emergencyStop` never wait for a lease.

**`programs/deployAndRun`** works in this order:

1. It checks that no program is running.
2. It uploads the files, skipping any whose MD5 already matches.
3. It starts the program. The lease ends once the start is verified.

A stop that arrives before the start ends the request with `cancelled`, and nothing is started. The
start outcome is one of:

- `started`;
- `not_seen_running`;
- `uncertain`: the program may have started. Do not start it again; check its state first.

`runSeq` counts the starts on each brick. Program states carry it, and `endedBy` once the latest start ended:
the client whose stop ended it, or `brick`. The daemon writes each brick's last number to `runs.json` before it sends the start,
so a daemon that replaces it counts on. A missing `runs.json` counts from 0; a damaged one is moved
aside, said in the log, and counting starts from 0.

## Questions for a person

Every dangerous action is confirmed by a person the daemon asks; no flag a client sets counts as
consent. The daemon sends the request `question/ask` to the client that started the operation when
that client has a person at it (`vscode` or `cli`), else to the VS Code window that connected last,
else to the terminal that connected last. An `mcp` or `addon` client is never asked. The question
has:

- a kind: `forget`, `clearBluetoothList`, `sweep`, `setting`, `restart`, `bluetoothAccess` or
  `bluetoothCheckAgain`;
- the requester, `{ name, kind }`, the client whose request raised it;
- its text and details;
- a timeout of 60 s.

The answer is `yes`, `no` or `keep`, optionally with `remember: true`, which applies a yes or no to
the same question about the client's own later requests for as long as its connection lasts.
`keep` changes nothing. Three things count as `keep`:

- the answer of a client without a person (a script, `--json`, an agent);
- silence until the timeout, after which the daemon sends `question/withdrawn`;
- a client that left before answering.

A `no` to a forget or a Bluetooth list clear ends the request with `cancelled`. When no answer
comes for a forget, a clear or switching to `full`, the request ends with `needs_person`, which
names the `ev3` command a person can run. An unconfirmed restart answers `daemon/exit` with
`{ accepted: false, reason }` (`channel.md`). Switching back to `safe` needs nobody.

## Subscriptions

`programs/subscribe`, `telemetry/subscribe` and `chain/follow` return an id that is valid on that
connection only. The matching notifications are `programs/stateChanged`, `telemetry/update` (a
snapshot first, then changes) and `chain/changed`. `subscriptions/cancel` ends one.

Connecting a brick starts no telemetry: the daemon reads a brick for a client that shows it
(`telemetry/foreground`) or while a subscription asks for rows.

**Which brick a client shows.** `daemon/status` names it per client: each entry of `clients` has
`shows`, the id of the brick that client last made foreground, and no `shows` when it shows none.
When that changes for any client (it shows another brick or none, or its connection closes while it
shows one), every client hears `daemon/showsChanged`, which carries every connected client the way
`daemon/status` lists them. Sending the same brick again changes nothing and is not announced.

When the daemon is replaced or restarted, the client library connects again and reconnects the
bricks it connected. It then subscribes again, each subscription with a fresh snapshot first, and
keeps the ids it gave its caller. Nothing is handed over between daemons.

## Errors

A failed request is a JSON-RPC error whose numeric `code` is its family's (`brick` 1000, `lease`
1100, `person` 1200, `daemon` 1300, `cancelled` 1400, `request` 1500, `internal` 1900) and whose
`data` carries the stable string `code`, the `family`, and a holder, candidates or a command where
they apply. A client decides on `data.code`; the codes and their families are in
`contract/methods.json`. The codes a client handles most:

| Code | Meaning |
|---|---|
| `brick_busy` | Another client holds the brick's write lease; `holder` names it. |
| `brick_ambiguous` / `brick_not_found` | The brick named matches several bricks, or none. |
| `not_connected` | Nobody connected the brick. |
| `needs_person` | A person's yes is needed; `command` is what they can run. |
| `outcome_unknown` | The daemon went while a write ran. Whether it finished is not known, and nobody retries it. |
| `cancelled` | The caller cancelled the request, or a stop came before a deployed program started. |
| `access_denied` | Safe access mode refuses the path or the command, or the client kind may not call the method. |
| `daemon_unavailable` | No daemon could be reached or started. The message names the log. |
| `replay_unmatched` | A replay daemon has no recorded reply left: the recording is stale. |

## Versions and replacement

`CONTRACT_VERSION` (in `contract/methods.json`, now 2) rises only on a breaking change. A daemon on
another contract version than the client's serves that client only `daemon/exit` and answers every
other request with `invalid_request` naming both versions.

A newer release client, or a development client meeting a release daemon, asks the running daemon
to end with `daemon/exit` and starts its own binary; nobody is asked, since installing a release or
building a development build is the person's own act. Any other `daemon/exit` is a restart and runs
only after a person said yes. Either way the daemon ends only once no write is in progress, waiting
at most 60 s. The table is in `channel.md`.

An add-on never replaces the daemon. It compares only the contract version, and the client library
refuses to connect when the running daemon speaks another one.
