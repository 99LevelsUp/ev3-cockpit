# Wiki Schema

Canonical list of topics and concepts. The compiler respects manual edits between compiles.

## Topics

| Slug | Description | Status |
|------|-------------|--------|
| project-overview | Root-level project documentation, architecture, and implementation plan | active |
| daemon | The native daemon `ev3-cockpitd` (`daemon/crates/daemon`, `crates/channel`) and its clients | active |
| contracts | The contract: JSON Schema in `contract/`, generated into Rust and TypeScript | active |
| errors | Error codes and families on the wire, and how each side represents them | active |
| protocol | EV3 bytecode, packet framing, commands and replies (`daemon/crates/protocol`) | active |
| transports | Providers and links for USB, TCP and Bluetooth, record and replay (`daemon/crates/transports`) | active |
| runtime | Sessions, queue and guard, discovery, presence, brick layer, services (`daemon/crates/runtime`) | active |
| testing | Rust and TypeScript suites, recorded fixtures, CI | active |
| events | The extension's event emitter (`src/vscode/events.ts`) | active |
| dev-environment | Running from source, VS Code workspace setup, known issues | active |

## Concepts

| Slug | Description | Connected Topics |
|------|-------------|-----------------|
| transport-contract-pattern | One byte-level provider trait for every transport and for replay | contracts, transports, runtime, testing |
| firmware-safety-constraints | EV3 firmware limits behind the rate guard, Bluetooth pacing, the ledger and reply checks | transports, runtime, protocol |

## Naming Conventions

- Topic slugs: lowercase-kebab-case matching the crate or `src/` directory name where possible
- Concept slugs: lowercase-kebab-case describing the cross-cutting pattern

## Evolution Log

- 2026-11-23: The switch to the native daemon: topics re-pointed at the Rust crates; mock removed (no successor; recordings are in testing); daemon added to the schema
- 2026-04-13: Initial schema generated from 9 topics, 2 concepts
