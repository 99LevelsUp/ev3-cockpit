---
topic: Mock
last_compiled: 2026-04-13
status: active
---

# Mock

## Purpose [coverage: high — 6 sources]

The `src/mock/` module implements a complete mock transport provider that simulates EV3 bricks without physical hardware. It is a first-class transport channel — equal in contract compliance to USB, TCP, and BT — and was implemented early in the project to support development and testing of all higher layers (runtime, telemetry, API, UI). Mock bricks are defined via a JSON configuration with support for dynamic sensor values (oscillators), error simulation, loss/recovery simulation, and an in-memory filesystem.

## Architecture [coverage: high — 6 sources]

Five files, re-exported via `index.ts`:

- **mockTransportProvider.ts** — `MockTransportProvider` implements `TransportProvider`. Handles discovery (enumerates bricks from config), connect/disconnect, send (delegates to internal simulation), recover (reconnect simulation), and configurable error/loss behavior.
- **mockConfig.ts** — TypeScript types for the mock configuration schema: `MockConfig`, `MockBrickConfig`, `MockPortConfig`, `MockErrorConfig`, `MockLossConfig`, `MockFileEntry`, `ValueDynamic` (discriminated union: `StaticDynamic`, `SineDynamic`, `TriangleDynamic`, `SquareDynamic`). Includes `validateMockConfig()` for schema validation.
- **defaultConfig.ts** — `DEFAULT_MOCK_CONFIG` providing a pre-configured mock brick for out-of-the-box development.
- **dynamics.ts** — `evaluateDynamic(dynamic, timestamp)` evaluates a `ValueDynamic` at a given time. Supports static values, sine waves, triangle waves, and square waves with configurable period, amplitude, offset.
- **mockFilesystem.ts** — `MockFilesystem` provides an in-memory file tree for testing filesystem API operations (`list`, `read`, `write`, `exists`, `delete`).

## Talks To [coverage: medium — 3 sources]

- **contracts/** — implements `TransportProvider` interface, uses `BrickCommand`, `BrickResponse`, `DiscoveryItem`, `BrickKey`, `PortState`
- **runtime/** — `MockTransportProvider` is registered in `ProviderRegistry` and consumed by `DiscoveryScheduler` and `SessionManager` exactly like physical providers
- **extension.ts** — instantiated with `DEFAULT_MOCK_CONFIG` and registered in `activate()`

## API Surface [coverage: high — 6 sources]

| Export | Description |
|--------|-------------|
| `MockTransportProvider` | Full `TransportProvider` implementation for mock bricks |
| `MockFilesystem` | In-memory filesystem (list, read, write, exists, delete) |
| `evaluateDynamic(dynamic, ts)` | Evaluate a value dynamic at a timestamp |
| `DEFAULT_MOCK_CONFIG` | Pre-configured mock config for development |
| `validateMockConfig(config)` | Schema validation for mock configuration |
| `MockConfig`, `MockBrickConfig`, etc. | TypeScript configuration types |

## Data [coverage: high — 5 sources]

Mock configuration schema:
- `MockConfig.bricks[]` — array of `MockBrickConfig` entries
- `MockBrickConfig` — `id`, `displayName`, `motorPorts[]`, `sensorPorts[]`, `battery`, `firmwareVersion`, `error?`, `loss?`, `files[]`
- `MockPortConfig` — `port`, `peripheralType`, `value` (static or dynamic), `unit`
- `ValueDynamic` variants: `{ type: 'static', value }`, `{ type: 'sine', period, amplitude, offset }`, `{ type: 'triangle', ... }`, `{ type: 'square', ... }`
- `MockErrorConfig` — configurable failure probability and patterns
- `MockLossConfig` — configurable disappearance/reappearance timing

BrickKey format: `mock:<id>` where `id` comes from the config file.

## Key Decisions [coverage: medium — 3 sources]

- **Mock is a first-class transport** — it implements the exact same `TransportProvider` contract as physical transports, ensuring all higher layers can be tested without hardware.
- **Dynamic value evaluation is pure** — `evaluateDynamic()` is a stateless function of `(dynamic, timestamp)`, making it deterministic and testable.
- **Default config ships with the extension** — `DEFAULT_MOCK_CONFIG` provides a working mock brick immediately, requiring no user configuration.
- **Mock bypasses the protocol layer** — unlike physical transports which go through `ev3Commands`/`ev3Packet`/`ev3Responses`, mock directly simulates responses. This is by design: mock tests the transport contract, not the EV3 protocol encoding.

## Gotchas [coverage: medium — 2 sources]

- **Mock filesystem is in-memory only** — changes do not persist between sessions; the filesystem resets to the configured state on each connect.
- **Loss simulation affects discovery** — when a mock brick is in "lost" state, it disappears from discovery results, triggering the same `available → unavailable → removed` state machine as a real brick losing power.

## Sources

- [src/mock/index.ts](../../src/mock/index.ts)
- [src/mock/mockTransportProvider.ts](../../src/mock/mockTransportProvider.ts)
- [src/mock/mockConfig.ts](../../src/mock/mockConfig.ts)
- [src/mock/defaultConfig.ts](../../src/mock/defaultConfig.ts)
- [src/mock/dynamics.ts](../../src/mock/dynamics.ts)
- [src/mock/mockFilesystem.ts](../../src/mock/mockFilesystem.ts)
