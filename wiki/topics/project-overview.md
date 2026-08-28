---
topic: Project Overview
last_compiled: 2026-04-13
status: active
---

# Project Overview

## Purpose [coverage: high — 6 sources]

EVƎ Cockpit is a Visual Studio Code extension for discovering, connecting, and monitoring LEGO Mindstorms EV3 bricks. It supports four transport channels — Mock, USB, TCP, and Bluetooth — and provides a stable public API for dependent extensions. The extension is not intended for programming bricks or browsing their filesystem via a GUI; instead, it focuses on real-time monitoring and exposes filesystem operations as a service API. Primary users range from approximately age 10 to adults, requiring the basic mode to be clear and self-explanatory while advanced features are exposed through settings and configuration mode.

## Architecture [coverage: high — 5 sources]

The codebase is a single TypeScript project (`package.json` name: `ev3-cockpit`, publisher: `99LevelsUp`) structured into clearly separated modules under `src/`:

- **contracts/** — shared types, enums, models, and the `TransportProvider` interface
- **errors/** — `CockpitError` hierarchy with typed error codes
- **events/** — `TypedEvent` wrapper and `DisposableStore` lifecycle utility
- **protocol/** — pure-function EV3 bytecode encoding, packet framing, command building, response parsing
- **transports/** — `ProviderRegistry`, transport adapters (USB HID, TCP socket, BT SPP), providers (USB, TCP, BT), infrastructure (TransportGuard, BtConnectionQueue)
- **runtime/** — `SessionManager`, `PresenceAggregator`, `DiscoveryScheduler`, `CommandQueue`, `HeartbeatMonitor`, `ReconnectStrategy`
- **mock/** — `MockTransportProvider`, mock filesystem, dynamics engine, configuration schema

Entry point: `src/extension.ts` — `activate()` wires all services using a `DisposableStore` pattern with reverse-order teardown.

Architecture layers (bottom to top): Transport Providers → Presence Aggregator → Session Manager → (future) Telemetry Runtime → Public API Layer → Cockpit UI Layer.

## Talks To [coverage: medium — 3 sources]

- **VS Code Extension API** — OutputChannel logging, EventEmitter pattern, Disposable lifecycle, globalState persistence (planned)
- **Physical EV3 bricks** — via USB HID (`node-hid`), TCP sockets (Node.js `net` + UDP `dgram`), Bluetooth RFCOMM (WinSock2 via koffi FFI, with serialport SPP as fallback)
- **Dependent extensions** — consume the public API via `vscode.extensions.getExtension('ev3-cockpit')?.exports` after declaring `extensionDependencies`

## API Surface [coverage: high — 5 sources]

Current exported API (Phase 2 complete):
- `TransportProvider` interface — `discover()`, `connect()`, `disconnect()`, `send()`, optional `recover()` and `forget()`
- `SessionManager` — `connect()`, `disconnect()`, `send()`, `setActiveBrick()`, `clearActiveBrick()`, `getSession()`, `getAllSessions()`
- `PresenceAggregator` — `getDiscoveryList()`, `getBrick()`, `mergeRemembered()`, `updateBrick()`
- `DiscoveryScheduler` — `start()`, `stop()`, `scanOnce()`, `getTrackedBricks()`

Planned (Phases 3-4): `registerConsumer`, `subscribeTelemetry`, `getConnectedBricks`, `onBrickStateChanged`, `onActiveBrickChanged`, filesystem operations.

## Data [coverage: high — 5 sources]

Key data models:
- `BrickKey` — branded string (`transport:id`), stable identifier not based on `displayName`
- `DiscoveryItem` — brickKey, displayName, transport, presenceState, remembered, connected, favorite, signalInfo, availableTransports, btVisible, lastSeenAt
- `ConnectedSession` — brickKey, displayName, transport, connectionState, activeMode, lastError, subscribedCategories, heartbeatState
- `ActiveBrickViewModel` — full model for foreground panel: identity, battery, ports A-D + 1-4, buttons, firmware, favorite, valueDisplayStyle

State enums: `Transport` (mock/usb/tcp/bt), `PresenceState` (remembered/available/unavailable/removed), `ConnectionState` (connecting/connected/reconnecting/disconnected), `ActivityMode` (foreground/subscribed/minimal/none), `TelemetryCategory` (ports/filesystem/system).

## Key Decisions [coverage: high — 5 sources]

- **Runtime is the source of truth** — the webview is strictly a read-only view over runtime models; it does not own brick state.
- **One foreground brick** — at most one connected brick receives foreground telemetry at any time.
- **Multiple simultaneous sessions** — several bricks can be connected concurrently, each with independent heartbeat and reconnect.
- **Public API is read-only for sessions** — dependent extensions cannot trigger connect/disconnect; session lifecycle stays exclusively under Cockpit's control.
- **Mock is a first-class transport** — implemented early to support all development and testing without physical hardware.
- **Implementation order: runtime-first** — build from contracts and runtime toward UI, not the other way around.

## Gotchas [coverage: medium — 3 sources]

- **Phase 3+ not yet implemented** — telemetry, public API, UI panel, persistence, and favorites are planned but not yet built. The current codebase covers Phases 0-2 only.
- **Native dependencies are optional** — `node-hid`, `serialport`, `ffi-napi`/`koffi` may not be available in all environments; transport providers gracefully degrade.
- **BT connection queue** — Windows RFCOMM allows only one active connection at a time; a serialized queue with 15-second inter-connection cooldown enforces this.
- **Firmware safety** — rate limiting (≤10 cmd/s per brick) and 2-second transport switch cooldown protect against EV3 firmware freezes.
- **Auto-connect suppression** — after explicit disconnect, a favorite brick will not auto-reconnect for the rest of the session.

## Sources

- [CLAUDE.md](../../CLAUDE.md)
- [DESIGN.md](../../DESIGN.md)
- [REQUIREMENTS.md](../../REQUIREMENTS.md)
- [IMPLEMENTATION_PLAN.md](../../IMPLEMENTATION_PLAN.md)
- [AGENTS.md](../../AGENTS.md)
- [CHANGELOG.md](../../CHANGELOG.md)
- [src/extension.ts](../../src/extension.ts)
- [package.json](../../package.json)
