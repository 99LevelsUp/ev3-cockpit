# ev3-cockpit Knowledge Base

Last compiled: 2026-11-23
Total topics: 10

## Topics

| Topic | Also Known As | Sources | Last Updated | Status |
|-------|--------------|---------|-------------|--------|
| [Project Overview](topics/project-overview.md) | ev3-cockpit, EVƎ Cockpit, architecture, design, requirements, implementation plan | 7 | 2026-11-23 | active |
| [Daemon and Clients](topics/daemon.md) | ev3-cockpitd, native daemon, CLI, ev3, ev3 mcp, client library, holders, leases, questions, replacement | 7 | 2026-11-23 | active |
| [Contracts](topics/contracts.md) | contract/, JSON Schema, methods.json, generated contract, contract version | 5 | 2026-11-23 | active |
| [Errors](topics/errors.md) | error codes, families, WireErrorCode, ContractError, DaemonStartError | 4 | 2026-11-23 | active |
| [Protocol](topics/protocol.md) | EV3 bytecode, packet framing, BrickCommand, BrickResponse, ev3-protocol | 4 | 2026-11-23 | active |
| [Transports](topics/transports.md) | TransportProvider, USB libusb/HID, TCP beacon, Bluetooth Winsock/WinRT/BlueZ, BtConnectionQueue, record and replay | 9 | 2026-11-23 | active |
| [Runtime](topics/runtime.md) | sessions, command queue, guard, discovery, presence, brick layer, files, programs, telemetry | 7 | 2026-11-23 | active |
| [Testing](topics/testing.md) | cargo test, fixtures, strict and matched replay, test:unit, test:host, CI | 6 | 2026-11-23 | active |
| [Events](topics/events.md) | EventEmitter, Event, Disposable, setListenerErrorHandler | 3 | 2026-11-23 | active |
| [Development Environment](topics/dev-environment.md) | F5 launch, daemon:build, EMFILE bug, Copilot Chat, launch.json, tasks.json | 5 | 2026-11-23 | active |

## Concepts

| Concept | Connects | Last Updated |
|---------|----------|-------------|
| [Transport Contract Pattern](concepts/transport-contract-pattern.md) | contracts, transports, runtime, testing | 2026-11-23 |
| [Firmware Safety Constraints](concepts/firmware-safety-constraints.md) | transports, runtime, protocol | 2026-11-23 |

## Recent Changes
- 2026-11-23: The switch (native daemon plan U17): every topic now describes the Rust workspace `daemon/` and the TypeScript clients; the mock topic is gone (simulated bricks are deferred, recordings replace them, see testing); events moved to `src/vscode/events.ts`
- 2026-11-20: Added the daemon topic (4.10.2); project-overview, contracts, errors and runtime no longer describe API v1
- 2026-04-13: Added dev-environment topic — VS Code workspace setup, Copilot Chat EMFILE bug, launch.json fix
- 2026-04-13: Initial compilation — 9 topics and 2 concepts from 53 source files
