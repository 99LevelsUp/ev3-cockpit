---
topic: Testing
last_compiled: 2026-11-23
status: active
---

# Testing

## Purpose [coverage: medium — 5 sources]

Two suites, one per language. The Rust tests cover the daemon, its runtime, transports and protocol; the TypeScript tests cover the client library, the CLI and MCP server, the extension's flows and packaging. Simulated bricks are deferred: recorded brick sessions stand in for hardware (native plan KTD7).

## Architecture [coverage: medium — 5 sources]

**Rust** (`daemon/crates/*/tests/`, plus unit tests in the modules): `cargo test --locked --workspace` in `daemon/`. Transports have fakes for the USB bus and BlueZ; hardware tests (`usb_hardware.rs`, `tcp_hardware.rs`, `bt_hw.rs`) run only on request.

**Recordings** (`daemon/fixtures/`):

- `link/<scenario>-<brick>/` — provider-level recordings (discovery, presence, pairing, link bytes with timing and failures) made by `daemon/crates/transports/examples/record.rs`. The transport and session tests replay them **strictly**: every call in order with its bytes, or the test fails.
- `service/<scenario>-<brick>/` — recordings made through the daemon by the hardware scenario script (`scripts/hardware-scenario`). `daemon/crates/daemon/tests/service_fixtures.rs` replays them strictly through the daemon.
- The TypeScript client tests and the CI smoke start a daemon on a test channel that replays a link or service recording **matched** (`--mode replay --fixtures <dir>`, matched by default): each request gets the recorded reply to an equal one, with the message counter rewritten.
- Each fixture's `scenario.md` says how to record it again.
- A request with no recorded reply left fails with `replay_unmatched`, so a stale recording shows. A runtime change that changes exchanges is answered by re-recording on hardware (`--mode record`), never by editing a fixture. The recorder replaces identifiers with the repository's placeholders as it writes.

**TypeScript** (`src/__tests__/*.test.ts`, compiled to `out/__tests__/`): the client library against a replay daemon (`clientNativeDaemon`, `clientNativeLaunch`, `clientChannel`), the contract and its vectors (`contractGenerated`, `rustDaemonWire`), the CLI and MCP (`cliCommands`, `mcpTools`, …), the extension's flows (`daemonBridge`, `forgetBrickCommand`, …), packaging (`packaging`, `packageNpm`), and `clientBoundary` (the client and the contract run without VS Code).

**Test utilities** in `src/test/`: `vscodeStub.cjs` (shims `vscode` outside the extension host) and `emitterScenarios.ts` (the emitter characterization, [events](events.md)).

**Runners:**

- `npm run test:unit` — Node's built-in runner, `assert/strict`; tests that start a daemon need `npm run daemon:build` first
- `npm run test:host` — VS Code extension host tests (`src/vscode/integration/`)
- `npm run test:ci` — compile, lint, contract check, unit, host
- `npm run smoke:daemon` — a daemon build serving a recorded brick through the client library
- `npm run test:pw:smoke` — Playwright (placeholder until the panel)

CI (`.github/workflows/`): `ci.yml` builds the development daemon and runs `test:ci`; `native-daemon.yml` runs `cargo fmt`, `clippy -D warnings` and `cargo test` on Windows and Linux for x64, arm64 and 32-bit x86 (built on the x64 runners), with the Windows tests run a second time as a standard user because the runner is elevated; then a release build, the VSIX (not for 32-bit x86) with its smoke on a recording, the npm packages and the build attestation.

## Key Decisions [coverage: medium — 3 sources]

- **Recordings, not a mock** — a recording is what the brick really answered, and a stale one fails loudly.
- **Test channels** — a test daemon runs on a private channel with its own state root, never on the user's.
- **Check that a test discriminates** — revert the fix and see the test fail before trusting it.

## Gotchas [coverage: low — 1 source]

- A test that leaves a brick held with `ev3 connect` keeps its daemon alive; release holds when the test ends.
- An elevated runner cannot start a daemon (it refuses to run as administrator); those tests skip themselves there.

## Sources

- [daemon/crates/transports/src/replay.rs](../../daemon/crates/transports/src/replay.rs)
- [daemon/crates/transports/src/fixture.rs](../../daemon/crates/transports/src/fixture.rs)
- [docs/channel.md](../../docs/channel.md)
- [.github/workflows/ci.yml](../../.github/workflows/ci.yml)
- [.github/workflows/native-daemon.yml](../../.github/workflows/native-daemon.yml)
- [package.json](../../package.json)
