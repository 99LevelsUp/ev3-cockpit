---
topic: Runtime
last_compiled: 2026-11-23
status: active
---

# Runtime

## Purpose [coverage: high — 7 sources]

`daemon/crates/runtime` (`ev3-runtime`) is the brick runtime inside the daemon: sessions, the per-session queue and the per-brick guard, discovery and presence, bricks across channels, and the services on top (files and transfers, the debt ledger, programs, telemetry, forget, clear and the one-sided repair). The session manager is the single source of truth for connection state; clients reach the runtime only through the [daemon](daemon.md)'s contract.

## Architecture [coverage: high — 7 sources]

From the bottom up (`src/`):

- **`session.rs`** — one session per channel (one brick on one transport), from connect to disconnect: the codec and message counter per link, the heartbeat, reconnect with backoff. A dead link puts the session into `Reconnecting`; it ends only when someone disconnects it.
- **`queue.rs`** — one FIFO per session; commands go out one at a time, in order. On the transition to reconnecting the queue is drained.
- **`guard.rs`** — the firmware guard: a rate window per brick across all its channels (1000 commands/s; a full window waits, it does not refuse) and failure counting per channel, so a pulled cable degrades its USB channel and not the Bluetooth link standing by.
- **`heartbeat.rs`, `reconnect.rs`** — the battery query as probe and what counts as a missed beat; the reconnect backoff.
- **`discovery.rs`** — `DiscoveryScheduler`: every transport polled on its own timer, each channel's presence followed from scan to scan.
- **`presence.rs`** — the discovery list: one entry per brick, channels grouped by the brick's hardware digits. It does not order the list; views sort it.
- **`bricks.rs`** — the brick layer: signs a brick in over every channel that reaches it, routes each command over the highest-priority connected channel (USB, then Bluetooth, then TCP), fails over on a link fault, pins a file transfer to its channel.
- **`fs.rs`, `transfer.rs`, `ledger.rs`** — filesystem operations, chunked transfers over one pinned link, and the debt ledger of firmware file slots a cut transfer left taken.
- **`programs.rs`, `deploy.rs`, `shell.rs`** — running, stopping and watching the user-slot program; deploy-and-run as one operation; shell commands.
- **`telemetry/`** — rows, the EV3 row catalogue, one base tick per brick with integer dividers, the frame assembler, claims, the throttle, the read model, one delivery order for every subscription.
- **`forget.rs`, `clear.rs`, `repair.rs`, `chain.rs`** — forget a brick, clear its Bluetooth list, repair a pairing broken on one side, the daisy chain.
- **`ports.rs`** — the two ports the runtime owns and the daemon answers: ask a person, report write activity.

## Talks To [coverage: high — 6 sources]

- **transports** — providers for discovery, links, pairing, forget and presence.
- **protocol** — `build_command`, `encode_ev3_packet`, `decode_ev3_packet`, `parse_response`.
- **contract** — the brick and telemetry types the daemon serves (`ev3-contract`).
- **daemon** — builds the runtime from the providers its channel and mode allow (`surface/runtime.rs`) and implements the ports.

## Data [coverage: medium — 4 sources]

The heartbeat interval is at least 3 s (`MIN_HEARTBEAT_INTERVAL`). Telemetry ticks per transport (`telemetry/cadence.rs`): USB 100 ms (floor 50), TCP 200 ms (floor 100), Bluetooth 500 ms (floor 250).

## Key Decisions [coverage: high — 5 sources]

- **One owner of sessions** — only the daemon opens a session; clients ask with `bricks/connect`.
- **A queue per session, a guard per brick** — a USB exchange hung after a cable pull does not stall the same brick's Bluetooth traffic; writes to one brick are serialized by its lease (native plan KTD14).
- **No "one transport at a time"** — two links open to one brick with commands on both froze nothing; the rule and its 2 s cooldown are gone.
- **Consent and activity are ports** — services ask a person and report writes through interfaces the daemon implements; lower-layer tests use fakes.
- **Today's TypeScript was the spec** — each subsystem was ported rule by rule from the TypeScript core, with a Rust test or a fixture per rule (native plan KTD11).

## Gotchas [coverage: medium — 3 sources]

- **Explicit disconnect wins** — a disconnect during reconnect backoff ends the reconnect.
- **Telemetry runs only on demand** — for a client that shows the brick, or while a subscription asks for rows; connecting starts none.
- **Firmware workarounds** must work on the original and on a fixed firmware.

## Sources

- [daemon/crates/runtime/src/lib.rs](../../daemon/crates/runtime/src/lib.rs)
- [daemon/crates/runtime/src/session.rs](../../daemon/crates/runtime/src/session.rs)
- [daemon/crates/runtime/src/guard.rs](../../daemon/crates/runtime/src/guard.rs)
- [daemon/crates/runtime/src/bricks.rs](../../daemon/crates/runtime/src/bricks.rs)
- [daemon/crates/runtime/src/presence.rs](../../daemon/crates/runtime/src/presence.rs)
- [daemon/crates/runtime/src/telemetry/mod.rs](../../daemon/crates/runtime/src/telemetry/mod.rs)
- [DESIGN.md](../../DESIGN.md) §4.2–4.5
