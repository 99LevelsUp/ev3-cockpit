---
topic: Errors
last_compiled: 2026-11-23
status: active
---

# Errors

## Purpose [coverage: high — 4 sources]

Every failure a client sees carries a stable string code from the contract. A client decides on that code; the message is ready to show.

## Architecture [coverage: high — 4 sources]

- **The contract** (`contract/methods.json`) lists every error code with its family. On the wire an error is a JSON-RPC error whose numeric `code` is the family's — `brick` 1000, `lease` 1100, `person` 1200, `daemon` 1300, `cancelled` 1400, `request` 1500, `internal` 1900 — and whose `data` holds `code`, `family`, and `holder`, `candidates` or `command` where they apply.
- **Rust:** each layer has its own error (`ev3_transports::TransportError` with an `ErrorCode`, `ev3_protocol::ProtocolError`, `ev3_runtime::SessionError`, telemetry's errors); `daemon/crates/daemon/src/surface/errors.rs` maps them to contract errors.
- **TypeScript:** `src/contract/errors.ts` names every code (`WireErrorCode`); the client library rejects a failed request with `ContractError` (`src/client/connection.ts`) and a failed start with `DaemonStartError` (`code` `daemon_unavailable`, `failure` saying which case).

## API Surface [coverage: high — 3 sources]

| Family | Codes |
|--------|-------|
| `brick` | `transport_failed`, `connection_failed`, `timeout`, `protocol_failed`, `brick_unreachable`, `link_lost`, `backend_unavailable`, `device_permission`, `not_connected`, `brick_ambiguous`, `brick_not_found`, `program_running`, `program_not_found`, `mode_conflict`, `access_denied`, … |
| `lease` | `brick_busy` |
| `person` | `needs_person` |
| `daemon` | `daemon_unavailable`, `outcome_unknown`, `replay_unmatched` |
| `cancelled` | `cancelled` |
| `request` | `invalid_request` |
| `internal` | `internal` |

## Key Decisions [coverage: medium — 2 sources]

- **Decide by code, never by class name** — the native daemon sends no class name. `ContractError.kind` remains in the TypeScript client for now and reads `Unknown` for daemon errors; removing it is open.
- **Families for the numeric code** — JSON-RPC reserves -32768..-32000, so the contract's numbers are positive.
- **`outcome_unknown` is never retried** — a write cut off by the daemon going may or may not have happened; the caller reads the state first.

## Gotchas [coverage: low — 1 source]

- `program_cancelled` is still in `WireErrorCode`; only the TypeScript daemon raised it, and the native daemon ends a stopped run with `cancelled`.

## Sources

- [contract/methods.json](../../contract/methods.json)
- [src/contract/errors.ts](../../src/contract/errors.ts)
- [src/client/connection.ts](../../src/client/connection.ts)
- [daemon/crates/daemon/src/surface/errors.rs](../../daemon/crates/daemon/src/surface/errors.rs)
