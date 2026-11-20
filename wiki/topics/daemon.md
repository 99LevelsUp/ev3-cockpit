---
topic: Daemon and Clients
last_compiled: 2026-11-20
status: active
---

# Daemon and Clients

## Purpose [coverage: high — 8 sources]

Since 4.10.2 one cockpit daemon per user holds the bricks: their connections, presence,
telemetry, programs, files, the transfer ledger, and the settings. Every client reaches the bricks
through it, so two programs never pull at one brick:

- the VS Code extension (one client per window);
- the `ev3` command;
- the MCP server `ev3-cockpit-mcp`;
- add-ons such as EVƎ C.

The wire protocol is in `docs/protocol.md`; add-on authors start with `docs/api-for-consumers.md`.

## Modules [coverage: high — 8 sources]

**`src/contract/`** is the one contract every client uses. It holds:

- the method names, parameters and results (`methods.ts`);
- the notifications and the daemon's question request (`events.ts`);
- the models (`models.ts`);
- the stable error codes (`errors.ts`);
- the handshake (`hello.ts`);
- `CONTRACT_VERSION`.

It imports nothing from the core.

**`src/client/`** is the client library (`CockpitClient`). It:

- finds or starts the daemon (`ensureDaemon.ts`);
- proves the user's key;
- keeps the brick list and settings current from notifications;
- after the daemon is replaced, connects again, reconnects its own bricks and renews its
  subscriptions, each with a fresh snapshot first;
- turns a write cut off by the daemon going into `outcome_unknown`.

**`src/daemon/`** is the daemon itself:

- `main.ts`: start, channel, handshake, roles, and the base handlers;
- `surface.ts`: every contract method, on the core's per-brick services;
- `holders.ts`: who holds each brick;
- `leases.ts`: one writer per brick per request;
- `questions.ts`: questions for a person;
- `settingsStore.ts`: the settings;
- `handover.ts`: replacement by a newer version, and `daemon restart`;
- `brickLoans.ts`, `peer.ts` and `hardwareLock.ts`: brick loans between the user's daemon and a
  development daemon;
- `log.ts`: the daemon's log.

**Other clients:** `src/cli/` is the `ev3` command and its add-on dispatch; `src/mcp/` is the MCP
server; `src/vscode/daemonBridge.ts` lets the extension's commands run over the daemon.

**`src/core/runtime/deviceGate.ts`** says what this process may open. A daemon never opens a device
it has lent, and a development daemon opens only what it has borrowed.

## Key decisions [coverage: high — 3 sources]

- **One process opens a brick.** Clients never open a brick; `bricks/connect` runs the brick
  layer's own sign-in and makes the client one of the brick's holders.
- **A lease lasts one request.** Work of several steps is a single request (`programs/deployAndRun`,
  `files/removePaths`), so no client holds a lease between requests. Stop and emergency stop never
  wait for a lease.
- **`keep` changes nothing.** A question goes only to the client that started the operation. A
  client without a person answers `keep`, and so do silence and a client that has left.
- **The newest version wins, without cutting work off.** A replacement waits until nothing is
  written, nothing is lent and no brick is connected. A restart keeps held bricks and `full`.
- **The settings live in the daemon.** The extension declares no VS Code settings. `full` needs a
  person's confirmation and lasts until the daemon ends.

## Gotchas [coverage: medium — 3 sources]

- Tests that start real daemon processes use a private home (`privateHome()`). A test that leaves
  a brick held through `ev3 connect` keeps its daemon alive, so release holds in `t.after`.
- A daemon started with simulated bricks takes the hardware lock only with `--hardware-lock`, so
  test daemons do not block each other.
- On Windows a VS Code update fails while the daemon runs on VS Code's `Code.exe`. End the `ev3`
  holds and the MCP servers before updating VS Code.

## Sources

- [src/contract/methods.ts](../../src/contract/methods.ts)
- [src/client/index.ts](../../src/client/index.ts)
- [src/daemon/main.ts](../../src/daemon/main.ts)
- [src/daemon/surface.ts](../../src/daemon/surface.ts)
- [src/daemon/handover.ts](../../src/daemon/handover.ts)
- [src/daemon/brickLoans.ts](../../src/daemon/brickLoans.ts)
- [docs/protocol.md](../../docs/protocol.md)
- [docs/plans/2026-11-19-0937-feat-cockpit-daemon-and-clients-plan.md](../../docs/plans/2026-11-19-0937-feat-cockpit-daemon-and-clients-plan.md)
