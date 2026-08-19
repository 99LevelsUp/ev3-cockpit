---
topic: Errors
last_compiled: 2026-04-13
status: active
---

# Errors

## Purpose [coverage: high — 2 sources]

The `src/errors/` module provides a typed error hierarchy for the entire EVƎ Cockpit extension. Every error thrown within the codebase can be narrowed to a specific category (transport, session, or API) via the `ErrorCode` field, enabling consistent error handling and logging across all layers.

## Architecture [coverage: high — 2 sources]

Single file `CockpitError.ts`, re-exported via `index.ts`:

- **`ErrorCode`** — const object with 7 error codes: `transport_failed`, `connection_failed`, `timeout`, `session_failed`, `heartbeat_failed`, `consumer_failed`, `subscription_failed`
- **`CockpitError`** — base class extending `Error` with `code: ErrorCode` and optional `cause`
- **Subclasses** — `TransportError`, `ConnectionError`, `TimeoutError`, `SessionError`, `HeartbeatError`, `ConsumerError`, `SubscriptionError`

Each subclass sets its own `name` property and delegates to a specific error code.

## Talks To [coverage: medium — 2 sources]

- **transports/** — throws `TransportError`, `ConnectionError`, `TimeoutError` during I/O operations
- **runtime/** — `SessionManager` catches transport errors and may throw `SessionError`; `HeartbeatMonitor` triggers on `HeartbeatError`
- **api/** (planned) — will use `ConsumerError`, `SubscriptionError` for API consumer issues

## API Surface [coverage: high — 2 sources]

| Class | Error Code | Usage |
|-------|-----------|-------|
| `CockpitError` | any | Base class — catch all Cockpit errors |
| `TransportError` | `transport_failed` | I/O failures in transport adapters |
| `ConnectionError` | `connection_failed` | Connection establishment failures |
| `TimeoutError` | `timeout` | Operation timeouts |
| `SessionError` | `session_failed` | Session lifecycle failures |
| `HeartbeatError` | `heartbeat_failed` | Heartbeat probe failures |
| `ConsumerError` | `consumer_failed` | API consumer registration issues |
| `SubscriptionError` | `subscription_failed` | Telemetry subscription issues |

## Data [coverage: high — 2 sources]

`CockpitError` carries three fields: `code` (typed `ErrorCode`), `message` (string), and optional `cause` (unknown) for error chaining.

## Key Decisions [coverage: medium — 1 source]

- **Enum-like const object for codes** — `ErrorCode` uses `as const` pattern rather than a TypeScript `enum`, enabling both string literal types and runtime iteration.
- **Error chaining via `cause`** — follows the standard `Error` cause pattern for wrapping lower-level errors without losing context.

## Gotchas [coverage: low — 1 source]

- `ConsumerError` and `SubscriptionError` are defined but not yet used — they're reserved for the Phase 4 public API implementation.

## Sources

- [src/errors/index.ts](../../src/errors/index.ts)
- [src/errors/CockpitError.ts](../../src/errors/CockpitError.ts)
