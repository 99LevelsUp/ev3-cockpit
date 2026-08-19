---
topic: Contracts
last_compiled: 2026-04-13
status: active
---

# Contracts

## Purpose [coverage: high — 6 sources]

The `src/contracts/` module defines all shared types, enums, interfaces, and data models used across the entire EVƎ Cockpit codebase. It is the foundation layer with zero dependencies on runtime, transport, or UI modules. Every other module imports from contracts; contracts import from nothing else in the project.

## Architecture [coverage: high — 6 sources]

Six files, re-exported through a barrel `index.ts`:

- **enums.ts** — `Transport`, `PresenceState`, `ConnectionState`, `ActivityMode`, `TelemetryCategory`
- **brickKey.ts** — branded `BrickKey` type and `makeBrickKey()` factory
- **models.ts** — `DiscoveryItem`, `ConnectedSession`, `ActiveBrickViewModel`, `PortState`, `BatteryState`, `SignalInfo`, `HeartbeatState`, `ValueDisplayStyle`
- **transport.ts** — `TransportProvider` interface, `SessionHandle`, `TransportCapabilities`, `DiscoveryScanResult`, `BrickCommand`/`BrickResponse` discriminated unions
- **api.ts** — public API models: `ConnectedBrickSnapshot`, `BrickStateChangeEvent`, `ActiveBrickSnapshot`, `TelemetrySnapshot`, `TelemetryEvent`, `FilesystemEvent`

## Talks To [coverage: high — 6 sources]

Contracts is consumed by every module in the codebase:
- **runtime/** — uses `ConnectionState`, `ActivityMode`, `DiscoveryItem`, `ConnectedSession`
- **transports/** — implements `TransportProvider`, uses `BrickCommand`, `BrickResponse`, `SessionHandle`
- **mock/** — implements `TransportProvider` using `MockConfig` types and contract models
- **protocol/** — maps `BrickCommand` to bytecode and raw replies to `BrickResponse`
- **errors/** — error codes align with contract categories (transport, session, API)
- **events/** — generic infrastructure, but typed events carry contract types

## API Surface [coverage: high — 6 sources]

Key types exported:

| Type | Kind | Description |
|------|------|-------------|
| `Transport` | enum | `mock`, `usb`, `tcp`, `bt` |
| `PresenceState` | enum | `remembered`, `available`, `unavailable`, `removed` |
| `ConnectionState` | enum | `connecting`, `connected`, `reconnecting`, `disconnected` |
| `ActivityMode` | enum | `foreground`, `subscribed`, `minimal`, `none` |
| `TelemetryCategory` | enum | `ports`, `filesystem`, `system` |
| `BrickKey` | branded string | `transport:id` format, stable identifier |
| `DiscoveryItem` | interface | full discovery list entry |
| `ConnectedSession` | interface | connected brick session model |
| `ActiveBrickViewModel` | interface | foreground brick UI model |
| `TransportProvider` | interface | unified transport contract (discover, connect, disconnect, send, recover?, forget?) |
| `BrickCommand` | discriminated union | 9 command kinds (battery, ports, buttons, info, fs:*) |
| `BrickResponse` | discriminated union | 9 response kinds matching commands |

## Data [coverage: high — 6 sources]

The `BrickCommand` union covers: `battery`, `ports`, `buttons`, `info`, `fs:list`, `fs:read`, `fs:write`, `fs:exists`, `fs:delete`.

`BrickKey` is a branded string (`string & { __brand: 'BrickKey' }`) created via `makeBrickKey(transport, id)` producing `"transport:id"` format. It is explicitly not based on `displayName` to ensure stable ordering.

`DiscoveryItem` tracks: brickKey, displayName, transport, presenceState, remembered, connected, favorite, signalInfo (optional RSSI + strength), availableTransports, btVisible, lastSeenAt.

## Key Decisions [coverage: medium — 3 sources]

- **Branded types for BrickKey** — prevents accidental string usage as brick identifiers; enforced via TypeScript's structural typing.
- **Discriminated unions for commands/responses** — narrow on `kind` field for type-safe access to typed response fields.
- **API models separate from internal models** — `ConnectedBrickSnapshot` and `TelemetrySnapshot` are public-facing; `ConnectedSession` and `ActiveBrickViewModel` are internal. This allows the public API surface to evolve independently.
- **Transport capabilities are declarative** — `TransportCapabilities.supportsSignalInfo` allows runtime to query provider features without try-catch.

## Gotchas [coverage: low — 1 source]

- The `DiscoveryItem.remembered` field has a documented invariant: when `presenceState === Remembered`, `remembered` is always `true`, but the inverse does not hold — a brick can be `remembered: true` while `presenceState: Available`.

## Sources

- [src/contracts/index.ts](../../src/contracts/index.ts)
- [src/contracts/enums.ts](../../src/contracts/enums.ts)
- [src/contracts/brickKey.ts](../../src/contracts/brickKey.ts)
- [src/contracts/models.ts](../../src/contracts/models.ts)
- [src/contracts/transport.ts](../../src/contracts/transport.ts)
- [src/contracts/api.ts](../../src/contracts/api.ts)
