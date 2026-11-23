---
topic: Project Overview
last_compiled: 2026-11-23
status: active
---

# Project Overview

## Purpose [coverage: high — 6 sources]

EVƎ Cockpit discovers, connects and monitors LEGO Mindstorms EV3 bricks over USB, TCP/Wi-Fi and Bluetooth, from VS Code, a terminal or an AI agent. One per-user daemon, the native binary `ev3-cockpitd`, holds the bricks; the VS Code extension, the `ev3` command, the MCP server and add-ons such as EVƎ C are its clients (see [Daemon and Clients](daemon.md)). It is not a program editor: it moves files, runs and stops programs and reads telemetry for add-ons that build programs. Primary users range from about age 10 to adults, so the basic mode must explain itself; advanced features live in settings.

## Architecture [coverage: high — 6 sources]

Two languages, split at the process boundary (native daemon plan, `docs/plans/2026-11-20-1845-refactor-native-daemon-plan.md`):

- **Rust**, the Cargo workspace `daemon/`: [protocol](protocol.md) (`crates/protocol`), [transports](transports.md) (`crates/transports`), [runtime](runtime.md) (`crates/runtime`), the daemon binary (`crates/daemon`), the shared channel code (`crates/channel`), the generated contract (`crates/contract`) and the native `ev3` with `ev3 mcp` (`crates/cli`).
- **TypeScript**, `src/`: the VS Code extension (`src/vscode/`), the client library `@ev3-cockpit/client` (`src/client/`), the generated contract and wire error codes (`src/contract/`), and the TypeScript `ev3` and MCP server (`src/cli/`, `src/mcp/`) that the npm package still ships.
- **The contract**, JSON Schema in `contract/`, generated into both ([contracts](contracts.md)).

Layers inside the daemon, bottom to top: transport providers → discovery and presence → sessions → brick layer → command layer → services (telemetry, files, programs) → daemon surface (holders, leases, questions, settings) → clients. The webview panel (Phase 5) is not built.

Entry points: `daemon/crates/daemon/src/main.rs` (the daemon), `src/vscode/extension.ts` (`activate()`, a client of the daemon).

## Talks To [coverage: medium — 3 sources]

- **Physical EV3 bricks** — only the daemon: USB through libusb (`rusb`) with a `hidapi` fallback, TCP with the UDP beacon, Bluetooth through Winsock and WinRT on Windows and BlueZ (`zbus`, raw sockets) on Linux.
- **VS Code Extension API** — only `src/vscode/`.
- **Add-ons** — through `@ev3-cockpit/client`; the extension exports no API.

## Key Decisions [coverage: high — 5 sources]

- **Runtime is the source of truth** — the webview will be a read-only view; it owns no brick state.
- **One owner of sessions** — clients connect a brick with `bricks/connect`; only the daemon opens a brick.
- **One foreground brick, several sessions** — at most one brick per client gets foreground telemetry; several can be connected at once.
- **The whole daemon is native** — independent of VS Code and Node, with an owner-only channel (native plan, Key Decisions).
- **Recordings instead of a mock** — simulated bricks are deferred; recorded sessions replayed at the provider trait guard regressions ([testing](testing.md)).

## Gotchas [coverage: medium — 3 sources]

- **Not built yet** (23.11.2026): the UI panel, persistence of favorites and remembered bricks, simulated bricks, macOS (GitHub issue #1).
- **Hardware sign-off open** — the native daemon's hardware rounds are the native plan's U16.
- **`IMPLEMENTATION_PLAN.md` before 23.11.2026** describes the TypeScript implementation; it keeps the paths it was written with.
- **Firmware safety** — see [Firmware Safety Constraints](../concepts/firmware-safety-constraints.md).

## Sources

- [AGENTS.md](../../AGENTS.md)
- [DESIGN.md](../../DESIGN.md)
- [REQUIREMENTS.md](../../REQUIREMENTS.md)
- [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)
- [docs/plans/2026-11-20-1845-refactor-native-daemon-plan.md](../../docs/plans/2026-11-20-1845-refactor-native-daemon-plan.md)
- [daemon/Cargo.toml](../../daemon/Cargo.toml)
- [package.json](../../package.json)
