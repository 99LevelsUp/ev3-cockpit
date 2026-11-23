# AGENTS.md

## Purpose

Single source of truth for agent instructions in this repository.

The primary project documents are:

- `REQUIREMENTS.md` — product requirements
- `DESIGN.md` — architecture decisions
- `IMPLEMENTATION_PLAN.md` — implementation order

Agents must treat these as authoritative and keep them up to date with every change.

## Language

**Everything in this project must be in English — without exception.**

This includes: source code, comments, strings, identifiers, documentation files, commit messages, PR descriptions, issue titles, and any other text that ends up in the repository.

The only exception is conversation with the user, which is conducted in the user's preferred language.

## Document Rules

- When the product intent changes, update `REQUIREMENTS.md`.
- When an architecture decision changes, update `DESIGN.md`.
- When the step order or scope changes, update `IMPLEMENTATION_PLAN.md`.

## Workflow

- Prefer small, incremental changes.
- Keep scope aligned with `IMPLEMENTATION_PLAN.md`.
- Do not introduce new top-level files unless the plan explicitly requires them.
- The repository was intentionally cleaned; do not restore old code or tests unless the user explicitly requests it.

## Project Structure

The repository has two languages: Rust for everything that works with bricks, TypeScript for the
VS Code extension and the clients (plan `docs/plans/2026-11-20-1845-refactor-native-daemon-plan.md`).

The per-user daemon `ev3-cockpitd` and the native `ev3` command are a Cargo workspace in `daemon/`:

- `daemon/crates/protocol/` — EV3 packets, bytecode, commands and replies, with no I/O
- `daemon/crates/transports/` — the provider trait, USB (libusb, HID fallback), TCP and its beacon, Bluetooth on Windows (Winsock RFCOMM, SDP presence, WinRT pairing) and Linux (BlueZ over zbus, RFCOMM and L2CAP sockets), record and replay
- `daemon/crates/runtime/` — sessions, the per-brick queue and guard, bricks across channels, discovery and presence, files, transfers and the ledger, programs, telemetry, forget and clear, the consent and activity ports
- `daemon/crates/daemon/` — the `ev3-cockpitd` binary: channel, key, lock, JSON-RPC, hello, holders and write leases, questions, settings, lifecycle, the state migration, the contract surface
- `daemon/crates/channel/` — what the daemon and its native clients share: state root, key, `channel.json`, framing (`docs/channel.md`)
- `daemon/crates/contract/` — the contract generated from `contract/`
- `daemon/crates/client/` — `ev3-client`, the native client of the daemon (find or start it, the hello, typed requests); `ev3`, `ev3 mcp` and Rust add-ons such as EVƎ C use it
- `daemon/crates/cli/` — the native `ev3` command and `ev3 mcp`
- `daemon/fixtures/` — recorded brick sessions the tests replay

The contract is JSON Schema in `contract/` (`schema/`, the method table `methods.json`, test vectors in `vectors/`), generated into Rust and into `src/contract/generated/` (`npm run contract:generate`).

TypeScript under `src/`:

- `src/contract/` — the generated contract (`generated/`) and the wire error codes (`errors.ts`)
- `src/client/` — the client library `@ev3-cockpit/client`: finds the user's daemon or starts a verified copy of it, proves the key, keeps state, renews subscriptions
- `src/npm/ev3.ts` — the npm package's `ev3` launcher: starts the native `ev3` of the platform package npm installed (`@ev3-cockpit/<platform>`, which carries `ev3` and the daemon side by side) there.
- `src/vscode/` — the extension: the entry point `src/vscode/extension.ts` (a client of the daemon), the bridge its commands run on (`daemonBridge.ts`), its event emitter (`events.ts`), the `ui/` flows, and the extension-host tests in `integration/`
- `src/persistence/` — globalState adapter (placeholder)
- `src/test/` — test utilities: the `vscode` stub and the shared emitter scenarios

The client library and the contract run without VS Code; lint and `src/__tests__/clientBoundary.test.ts` enforce it.

`native/linux/` holds the udev and polkit rules the Linux packages ship.

Unit tests: `src/__tests__/*.test.ts`, compiled to `out/__tests__`; Rust tests under `daemon/crates/*/tests/`.  
Playwright tests: `tests/*.spec.ts`.  
Scripts and outputs: `scripts/`, `out/`, `artifacts/`.

## Build and Test Commands

- `npm install` — install dependencies (Node 20+)
- `npm run daemon:build` — debug build of `ev3-cockpitd` and `ev3`, with the manifest the development clients and the tests read; needs a Rust toolchain
- `cargo test --locked --workspace`, `cargo clippy --locked --workspace --all-targets -- -D warnings`, `cargo fmt --all --check` — in `daemon/`, the Rust gate CI runs
- `npm run contract:generate` / `contract:check` — regenerate the contract, or check it is current
- `npm run smoke:daemon` — a daemon build serving a recorded brick through the client library
- `npm run compile` — TypeScript compilation to `out/`
- `npm run watch` — incremental watch mode
- `npm run lint` — ESLint on `src/**/*.ts`
- `npm run test:unit` — unit tests (Node built-in runner)
- `npm run test:host` — VS Code extension host tests
- `npm run test:pw:smoke` — Playwright smoke tests
- `npm run test:ci` — compile + lint + unit + host
- `npm run test:ci:release` — full release gate (bundle + VSIX + smoke)
- `npm run package` — production bundle via esbuild
- `npm run package:vsix` — installable VSIX into `artifacts/vsix/`

### Cheat Sheet

| Need | Command |
|---|---|
| Quick validation | `npm run test:ci` |
| Unit tests only | `npm run test:unit` |
| Host tests only | `npm run test:host` |
| UI smoke | `npm run test:pw:smoke` |
| Before commit | `npm run test:ci:release` |

## Coding Conventions

TypeScript, `strict` mode, ES2022, CommonJS. Indent with tabs, use semicolons, single-quote imports.

Rust: edition 2024, `rustfmt` defaults, clippy warnings are errors.

Naming:

- `PascalCase` — classes, interfaces, types
- `camelCase` — functions, methods, variables
- `SCREAMING_SNAKE_CASE` — environment variables (`EV3_COCKPIT_*`)
- Files: `camelCase.ts` (example: `daemonBridge.ts`); Rust files `snake_case.rs`

## Testing Rules

Unit tests: Node built-in runner, `assert/strict`. Files in `src/__tests__/`, named `*.test.ts`.  
Playwright tests: `tests/*.spec.ts`.

## Commit Rules

- Short, imperative commit subject.
- One commit = one logical change.
- PRs must include: motivation, commands run, screenshots for UI changes.

## Security

Do not commit machine-specific hardware values, private endpoints, or local artifact logs. Use environment variables for overrides (`EV3_COCKPIT_*`).

## Agent Workflow

After every code or configuration change:

1. `npm run compile`
2. `npm run lint`
3. `npm run test:unit` + `npm run test:host`
4. after a change under `daemon/`: the Rust gate above, then `npm run daemon:build`

If the change touches UI/webview, also run: `npm run test:pw:smoke`.

Before committing: `npm run test:ci:release`.
