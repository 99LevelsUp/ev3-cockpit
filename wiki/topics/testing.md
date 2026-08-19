---
topic: Testing
last_compiled: 2026-04-13
status: active
---

# Testing

## Purpose [coverage: medium — 4 sources]

The `src/__tests__/` directory and `src/test/` utilities provide comprehensive unit testing for all implemented modules. The test suite validates contract compliance, state machine transitions, protocol encoding/decoding, transport infrastructure, and session runtime behavior. Currently 197+ unit tests cover Phases 0-2 of the implementation.

## Architecture [coverage: medium — 4 sources]

**Test files** in `src/__tests__/`:
- `contracts.test.ts` — type correctness, BrickKey factory, enum values
- `extension.test.ts` — extension activation/deactivation lifecycle
- `dynamics.test.ts` — mock value dynamic evaluation (static, sine, triangle, square)
- `providerRegistry.test.ts` — provider register/unregister/enumerate/lookup
- `discoveryScheduler.test.ts` — polling, dedup, timeout, state transitions
- `presenceAggregator.test.ts` — unified list, ordering, presence merge, metadata overlay
- `mockTransport.test.ts` — mock transport contract compliance, filesystem, error/loss simulation
- `ev3Protocol.test.ts` — bytecode encoding/decoding round-trips, packet framing
- `transportInfra.test.ts` — transport guard rate limiting, BT connection queue serialization
- `sessionRuntime.test.ts` — session state machine, connect/disconnect, multi-brick, foreground switching, heartbeat, reconnect, command queue

**Test utilities** in `src/test/`:
- `vscodeStub.cjs` — VS Code API stub for running tests outside the extension host

**Test runners:**
- `npm run test:unit` — Node built-in test runner (`node --test`), uses `assert/strict`
- `npm run test:host` — VS Code extension host tests
- `npm run test:pw:smoke` — Playwright smoke tests (placeholder)
- `npm run test:ci` — compile + lint + unit + host
- `npm run test:ci:release` — full gate: bundle + VSIX + smoke

## Talks To [coverage: medium — 3 sources]

- **All source modules** — tests import directly from contracts, runtime, transports, mock, protocol, errors, events
- **Node.js test runner** — `node:test` built-in module with `describe`/`it`/`assert`
- **VS Code extension host** — host tests run inside a real VS Code instance

## API Surface [coverage: low — 1 source]

Test utilities export only `vscodeStub.cjs` for shimming `vscode` imports outside the extension host.

## Data [coverage: low — 0 sources]

No persistent data. Tests use in-memory mock configurations and synthetic brick definitions.

## Key Decisions [coverage: medium — 3 sources]

- **Node built-in test runner** — no external test framework dependency (no Jest, Mocha); uses `node:test` and `assert/strict`.
- **Mock transport is the primary test vehicle** — most runtime and session tests use `MockTransportProvider` rather than mocking individual methods, ensuring tests exercise the real contract.
- **CI gate before every commit** — `npm run test:ci:release` must pass before committing (enforced by convention, documented in AGENTS.md).

## Gotchas [coverage: low — 1 source]

- Tests compile to `out/__tests__/` alongside production code — the test runner discovers them from the compiled output.
- Playwright tests are placeholder-only; real browser-based testing will come with Phase 5 (UI implementation).

## Sources

- [src/__tests__/contracts.test.ts](../../src/__tests__/contracts.test.ts)
- [src/__tests__/extension.test.ts](../../src/__tests__/extension.test.ts)
- [src/__tests__/dynamics.test.ts](../../src/__tests__/dynamics.test.ts)
- [src/__tests__/providerRegistry.test.ts](../../src/__tests__/providerRegistry.test.ts)
- [src/__tests__/discoveryScheduler.test.ts](../../src/__tests__/discoveryScheduler.test.ts)
- [src/__tests__/presenceAggregator.test.ts](../../src/__tests__/presenceAggregator.test.ts)
- [src/__tests__/mockTransport.test.ts](../../src/__tests__/mockTransport.test.ts)
- [src/__tests__/ev3Protocol.test.ts](../../src/__tests__/ev3Protocol.test.ts)
- [src/__tests__/transportInfra.test.ts](../../src/__tests__/transportInfra.test.ts)
- [src/__tests__/sessionRuntime.test.ts](../../src/__tests__/sessionRuntime.test.ts)
- [src/test/vscodeStub.cjs](../../src/test/vscodeStub.cjs)
