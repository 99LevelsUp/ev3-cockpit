---
topic: Daemon and Clients
last_compiled: 2026-11-23
status: active
---

# Daemon and Clients

## Purpose [coverage: high — 6 sources]

One daemon per user, the native binary `ev3-cockpitd`, holds the bricks: their connections, presence, telemetry, programs, files, the transfer ledger and the settings. Every client reaches the bricks through it, so two programs never pull at one brick:

- the VS Code extension (one client per window);
- the `ev3` command (native, `daemon/crates/cli`; the npm package `ev3-cockpit` installs it through a launcher, `src/npm/ev3.ts`);
- the MCP server (`ev3 mcp`, part of the native `ev3`);
- add-ons such as EVƎ C.

The protocol is in `docs/protocol.md`, the channel in `docs/channel.md`; add-on authors start with `docs/api-for-consumers.md`.

## Modules [coverage: high — 6 sources]

**`daemon/crates/daemon/`** is the daemon (`src/`):

- `main.rs`, `cli.rs`: start, command line, modes (hardware, record, replay);
- `server.rs`: the daemon's life, from refusing to run elevated to a clean end;
- `lock.rs`, `key.rs`, `channel.rs`, `rpc.rs`: the single-instance lock, the user's key, the pipe or socket and `channel.json`, the hello and the JSON-RPC dispatch;
- `methods.rs`: the daemon's own methods (status, exit, log, settings);
- `surface/`: every brick method over the runtime (`runtime.rs` builds the runtime the channel and mode allow);
- `holders.rs`: who holds each brick, and `held.json`;
- `leases.rs`: one writer per brick per request;
- `questions.rs`: questions for a person, put only to a VS Code window or a terminal;
- `access.rs`: the access mode, `safe` or `full`;
- `resolver.rs`: a brick named by id or name;
- `settings.rs`: the settings (`full` is never stored);
- `lifecycle.rs`: `daemon/exit` (replacement or restart), and what a client on another contract version is served;
- `confine.rs`: the check every local path a client names goes through;
- `migrate.rs`: takes over the ledger and settings of the TypeScript daemon it replaced, and removes that daemon's leftovers;
- `log.rs`: the log, rotated by size.

**`daemon/crates/channel/`** is what the daemon and the native `ev3` share: state root, key, `channel.json`, framing.

**`src/client/`** is the TypeScript client library (`CockpitClient`, `nativeClient.ts`). It:

- finds the daemon from `channel.json`, or starts a verified copy of the binary it carries (`nativeDaemon.ts`, `nativeLaunch.ts`);
- proves the user's key (`hello.ts`, `proofs.ts`);
- keeps the brick list and settings current from notifications;
- after the daemon goes, connects again, reconnects its own bricks and renews its subscriptions, each with a fresh snapshot first;
- turns a write cut off by the daemon going into `outcome_unknown`.

**Other clients:** `src/vscode/daemonBridge.ts` lets the extension's commands run over the daemon.

## Key decisions [coverage: high — 3 sources]

- **One process opens a brick.** `bricks/connect` runs the brick layer's sign-in and makes the client one of the brick's holders.
- **A lease lasts one request.** Work of several steps is one request (`programs/deployAndRun`, `files/removePaths`). Stop and emergency stop never wait for a lease.
- **A person confirms every dangerous action.** The daemon asks; no client-set flag counts. `keep`, silence and a client that left change nothing.
- **Replacement without handover.** A newer release client, or a development client meeting a release daemon, asks the daemon to exit once no write runs and starts its own; any other exit is a restart that needs a person. Holds from `ev3 connect` survive in `held.json`.
- **Clients run a verified copy.** The binary is copied to `bin/<sha256>/` in the state root and checked before it starts; the installed file is never locked.
- **The settings live in the daemon.** The extension declares no VS Code settings.

## Gotchas [coverage: medium — 3 sources]

- Development and release builds share the user's channel; tests run daemons on private test channels with their own state root (`--channel`, `--state-root`).
- A test channel runs on recordings (`--replay`) and opens hardware only to record (`--mode record`); the user's channel never does either.
- The daemon refuses to run elevated or as root (exit code 3).
- Smart App Control on Windows blocks the unsigned binary; clients report it as `smart_app_control`.

## Sources

- [daemon/crates/daemon/src/lib.rs](../../daemon/crates/daemon/src/lib.rs)
- [daemon/crates/daemon/src/holders.rs](../../daemon/crates/daemon/src/holders.rs)
- [daemon/crates/daemon/src/migrate.rs](../../daemon/crates/daemon/src/migrate.rs)
- [src/client/index.ts](../../src/client/index.ts)
- [docs/protocol.md](../../docs/protocol.md)
- [docs/channel.md](../../docs/channel.md)
- [docs/plans/2026-11-20-1845-refactor-native-daemon-plan.md](../../docs/plans/2026-11-20-1845-refactor-native-daemon-plan.md)
