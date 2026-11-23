---
topic: Contracts
last_compiled: 2026-11-23
status: active
---

# Contracts

## Purpose [coverage: high — 5 sources]

The contract between the daemon and its clients is one language-neutral schema in `contract/`, generated into Rust (`daemon/crates/contract`) and TypeScript (`src/contract/generated/`). Nothing is mirrored by hand, so neither side can drift (native plan KTD1).

## Architecture [coverage: high — 5 sources]

- **`contract/schema/*.json`** — JSON Schema draft-07: `core`, `bricks`, `files`, `messages`, `reports`, `settings`, `telemetry`, `daemon` (hello, questions, status).
- **`contract/methods.json`** — the method table: every request with its params and result types, `leased`, `needsPerson`, `callableBy` (client kinds) and `stableCore`; the notifications; the daemon's request to a client (`question/ask`); the hello; the error codes and their families; `contractVersion`.
- **`contract/vectors/`** — cross-language test vectors: the hello proofs and `channel.json` (`channel.json`), and messages (`messages.json`).
- **Generators** — `npm run contract:generate` writes `src/contract/generated/` (`types.ts` through `json-schema-to-typescript`, `methods.ts` with `Methods`, `Notifications`, `METHODS`, `ERROR_FAMILY`, `CONTRACT_VERSION`); `npm run contract:check` fails on a stale output. The Rust crate's `build.rs` generates the types (`typify`), the `Methods` dispatch trait, the `Notification` enum and the error families at build time.
- **`src/contract/errors.ts`** — the wire error codes as `WireErrorCode`, held by the compiler to the generated `ErrorCode` ([errors](errors.md)).

## Talks To [coverage: high — 4 sources]

- **daemon** — dispatches through the generated trait (`ev3-contract`).
- **runtime** — uses the contract's brick and telemetry types for what the daemon serves.
- **client library** — exports the generated contract at the top level of `@ev3-cockpit/client`.
- **native `ev3`** — the same crate.

## Key Decisions [coverage: high — 4 sources]

- **Schema first, both sides generated** — readable by clients in other languages later (ev3-python).
- **The contract version marks breaking changes only** — a removed or renamed method, field or code, a type change, a newly required field, a changed meaning. Additive changes keep it, so a client meeting a newer daemon with the same version keeps working. It is 2 today.
- **Schema rules** — no `anyOf`; `oneOf` only with a required `const` tag; objects on the stable core accept unknown properties.
- **Errors by code** — clients decide on `data.code`, never on a class name.

## Gotchas [coverage: medium — 2 sources]

- Edit `contract/`, never `src/contract/generated/`; regenerate and commit both.
- A daemon on another contract version serves a client only `daemon/exit` (the stable core).
- `BrickKey` (`transport:id`, one channel) and the brick id (the twelve hex digits shared by USB serial, Bluetooth address and TCP beacon) are different things; the contract names bricks by id or name.

## Sources

- [contract/methods.json](../../contract/methods.json)
- [contract/schema/bricks.json](../../contract/schema/bricks.json)
- [daemon/crates/contract/src/lib.rs](../../daemon/crates/contract/src/lib.rs)
- [src/contract/generated/methods.ts](../../src/contract/generated/methods.ts)
- [docs/protocol.md](../../docs/protocol.md)
