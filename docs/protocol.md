# The cockpit daemon protocol

How clients talk to the EVƎ Cockpit daemon, as built in 4.10.2. The protocol was reviewed with the
EVƎ C session on 19.11.2026 before it was built. The TypeScript types in `src/contract/` are the
reference; this page explains them. Add-on authors should start with
[`api-for-consumers.md`](api-for-consumers.md), which describes the client library.

## One daemon per user

- One daemon runs per user. The first client that finds none starts it. It ends 10 s after its last
  client has left and no brick is held through `ev3 connect`.
- The VS Code extension starts the daemon on VS Code's own Node (`ELECTRON_RUN_AS_NODE`). The `ev3`
  command and the MCP server start it on the Node that runs them. An add-on carries no daemon of its
  own: it starts the one recorded by the installed cockpit, or tells the user to install the cockpit.
- The daemon refuses to run as administrator.

**Channel**

- On Windows the channel is the named pipe `\\.\pipe\ev3-cockpit-<sha256(user SID)[:16]>`.
- On Linux and macOS it is a unix socket in `$XDG_RUNTIME_DIR/ev3-cockpit/` (or
  `/tmp/ev3-cockpit-<uid>/`). The folder is readable by the user only.
- The daemon listens on no network port.
- A named channel (`EV3_COCKPIT_CHANNEL`) adds `-<name>` to the pipe or socket name and gets its own
  state folder.
  - `dev` and `dev-<suffix>` are development channels; see "Brick loans" below.
  - Other names are for tests.

**Files**

| File | Where | What |
|---|---|---|
| Key | `%LOCALAPPDATA%\ev3-cockpit\key`, `$XDG_STATE_HOME/ev3-cockpit/key`, `~/Library/Application Support/ev3-cockpit/key` | 32 random bytes, readable by the user only (an ACL on Windows, mode 0600 elsewhere). Shared by every channel. |
| Log | `logs/daemon[-<channel>].log` in the state folder; `~/Library/Logs/ev3-cockpit/` on macOS | One line per event, with a timestamp, a level and the client's name. Every notification a client showed a person is logged too. Rotated at 5 MB, keeping 3 files. |
| Settings | `settings.json` in the channel's state folder | Settings that differ from their defaults. |
| Transfer debts | `ledger.json` | Unsettled transfers per brick, settled before that brick's next transfer. |
| Handover | `handover.json`, `handover-state.json` | Written while a daemon hands over to its successor. |
| Hardware lock | `hardware.lock` in the per-user folder | Taken by the daemon that owns the hardware. |

## Framing and messages

The protocol is JSON-RPC 2.0 with LSP's `Content-Length` framing, using `vscode-jsonrpc`. A message
over 1 MiB closes the connection.

- Method names follow LSP's `area/action` form.
- Cancelling uses `$/cancelRequest`. The request ends with `cancelled`, and no other client's work is
  touched.
- Progress uses `$/progress` with the token the request carries. File transfers report
  `{ transferred, total? }`.
- Within one connection, notifications arrive in the order the daemon raised them.

## Handshake

Nothing is answered before the handshake, and the daemon says nothing first.

1. The client sends `hello/start` with a fresh nonce, its name, its kind (`vscode`, `cli`, `mcp`,
   `addon` or `peer`), its version and its contract version.
2. The daemon answers with its own nonce and its proof.
3. The client checks that proof and sends `hello/finish` with its own proof.
4. The daemon checks the client's proof and answers with:
   - its version and contract version;
   - its pid and instance id;
   - its transports;
   - its state: `serving`, `handingOver` or `exiting`.

Each proof is an HMAC-SHA256 under the key, over a label (`daemon` or `client`) and both nonces.
Only a process that can read the user's key gets past the handshake.

What the client does with the state the daemon reports:

- `handingOver`: the client waits and connects to the successor.
- `exiting`: the client waits, then starts a new daemon.

**Name.** The client's name shows up in other clients' `brick_busy` errors and in the log, so it
should say where the client runs. For example: `VS Code (robot-project, pid 4242)`.

## Methods

The full list, with parameters and results, is in `src/contract/methods.ts`.

| Area | Methods |
|---|---|
| daemon | `daemon/status`, `daemon/restart`, `daemon/registerReplacement`, `log/notice` |
| bricks | `bricks/list`, `connect`, `disconnect`, `info`, `storage`, `pair`, `forget`, `clearBluetoothList`, `inquiry`, `borrowAll` |
| files | `files/list`, `exists`, `size`, `read`, `write`, `makeDirectory`, `remove`, `removePaths`, `move` |
| transfer handles | `transfer/begin`, `write`, `read`, `close` |
| programs | `programs/deployAndRun`, `run`, `stop`, `emergencyStop`, `status`, `subscribe` |
| shell | `shell/run` (in full access mode only) |
| settings | `settings/list`, `set`, `accessMode` |
| telemetry and chain | `telemetry/rows`, `subscribe`, `foreground`; `chain/get`, `follow`; `subscriptions/cancel` |
| loans (peer only) | `peer/heldBricks`, `borrowBrick`, `borrowAll` |

**Naming a brick.** A request names its brick by id or by name; case does not matter.

- A name that matches two bricks fails with `brick_ambiguous` and the candidates.
- A name not found during the first discovery round waits for that round to finish first.
- A CLI connection may leave the brick out when exactly one brick is connected.

**File content** can travel in three ways:

- as a local path the daemon reads or writes;
- inline as base64: at most 4 KiB when writing and 64 KiB when reading;
- through a transfer handle, in 48 KiB chunks.

## Holders and write leases

**Holders.** A brick stays connected while it has at least one holder:

- a client that connected it;
- an `ev3 connect` hold;
- the long-lived clients together, for a remembered brick.

Each VS Code window is a holder of its own. `bricks/disconnect` drops only the caller's own hold and
answers with who still holds the brick. `forEveryone` signs the brick out whoever holds it.

**Write leases.** A request that changes a brick takes the brick's write lease for exactly its own
length (`LEASED_METHODS`).

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

`runSeq` counts the starts on each brick. Program states carry it, and `stoppedBy` when a stop ended
the program.

## Questions for a person

When an operation needs a person's yes, the daemon sends the request `question/ask` to the client
that started the operation, and only to that client. The question has:

- a kind: `sweep`, `forget`, `clearBluetoothList`, `bluetoothAccess` or `brickLoan`;
- its text;
- its details;
- a timeout of 60 s.

The answer is `yes`, `no` or `keep`. `keep` changes nothing. Three things count as `keep`:

- the answer of a client without a person (a script, `--json`, an agent);
- silence until the timeout;
- a client that left before answering.

For forget and clearing a Bluetooth list, `keep` ends the request with `needs_person`, which names
the `ev3` command a person can run.

`daemon/restart`, and changing a dangerous setting (access mode `full`), need
`confirmedByPerson: true`. The daemon honours it only from VS Code and CLI connections.

## Subscriptions

`programs/subscribe`, `telemetry/subscribe` and `chain/follow` return an id that is valid on that
connection only. The matching notifications are `programs/stateChanged`, `telemetry/update` (a
snapshot first, then changes) and `chain/changed`.

When the daemon is replaced or restarted, the client library connects again and reconnects the
bricks it connected. It then subscribes again, each subscription with a fresh snapshot first, and
keeps the ids it gave its caller.

## Errors

A failed request carries a stable code and a kind in its `data`, plus a holder, candidates or a
command where they apply. The full list of codes is in `src/contract/errors.ts`. The codes a client
handles most:

| Code | Meaning |
|---|---|
| `brick_busy` | Another client holds the brick's write lease; `holder` names it. Also used when a loan is refused. |
| `brick_ambiguous` / `brick_not_found` | The brick named matches several bricks, or none. |
| `not_connected` | The brick is not connected, or another daemon has it. |
| `needs_person` | A person's yes is needed; `command` is what they can run. |
| `outcome_unknown` | The daemon went while a write ran. Whether it finished is not known, and nobody retries it. |
| `cancelled` | The caller cancelled the request, or a stop came before a deployed program started. |
| `access_denied` | Safe access mode refuses the path or the command. |
| `daemon_unavailable` | No daemon could be reached or started. The message names the log. |

## Versions and replacement

Clients built in this repository (VS Code, `ev3`, the MCP server) compare package versions with the
daemon's. The newest wins:

- A newer client registers a replacement (`daemon/registerReplacement`) with its launch. The
  replacement happens once the daemon is idle: nothing is being written, nothing is lent, and no
  brick is connected.
- `ev3 daemon restart`, or the restart command in VS Code, asks for the replacement now, after the
  person confirms. A restart never downgrades the daemon.
- An older client never replaces a newer daemon. It shows a notice instead.
- Inside a development channel, any other version replaces the daemon.

**The handover.** The old daemon:

1. tells new clients to wait;
2. ends requests under a lease with `outcome_unknown`;
3. saves its holders, a `full` access mode and each Bluetooth brick's close time;
4. releases its devices;
5. writes the handover marker;
6. closes its listener;
7. starts its successor.

**The successor**:

- takes that state over and serves at once;
- reports the bricks that were held as `reconnecting` until they are connected again;
- removes the marker.

A client that finds no listener while the marker is less than 30 s old waits for the successor
instead of starting a daemon.

An add-on compares only the contract version (`CONTRACT_VERSION`). It warns only when the daemon's
contract cannot serve it.

## Brick loans between daemons

Every daemon that uses real transports takes the per-user hardware lock before it opens any device.
The extension's development host runs a development daemon on the `dev` channel.

**When the development daemon cannot take the lock**, it opens only what it borrows over a `peer`
connection to the user's daemon:

- The development daemon lists the user's held bricks as blocked, naming the clients that hold them.
- Connecting a brick borrows it. The user's daemon asks every client that holds it (`brickLoan`).
  Only when all of them say yes does it sign the brick out and stop touching its devices.
- A brick held through `ev3 connect`, or remembered for the long-lived clients, is refused, with
  `ev3 disconnect` named.
- `bricks/borrowAll` puts the user's daemon in Lent, where it opens nothing, the Bluetooth radio
  included.
- During a single-brick loan, only the user's daemon uses the Bluetooth radio.
- When the peer connection closes, every loan comes back. The user's daemon then connects the bricks
  again that still have holders.
- `daemon/restart` is refused while anything is lent.

**When the development daemon holds the lock** (it started first), a user's daemon that starts later
waits in Lent until the lock is free.
