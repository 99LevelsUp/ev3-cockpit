# Wiki Schema

Canonical list of topics and concepts. The compiler respects manual edits between compiles.

## Topics

| Slug | Description | Status |
|------|-------------|--------|
| project-overview | Root-level project documentation, architecture, and implementation plan | active |
| contracts | Shared types, enums, models, and the TransportProvider interface | active |
| errors | CockpitError hierarchy with typed error codes | active |
| events | TypedEvent wrapper and DisposableStore lifecycle utility | active |
| protocol | EV3 bytecode encoding, packet framing, command building, response parsing | active |
| transports | Transport adapters, providers (USB, TCP, BT), registry, guard, BT queue | active |
| runtime | SessionManager, PresenceAggregator, DiscoveryScheduler, CommandQueue, Heartbeat, Reconnect | active |
| mock | MockTransportProvider, mock filesystem, dynamics engine, configuration | active |
| testing | Unit tests, test utilities, CI pipeline | active |
| dev-environment | VS Code workspace setup, known issues, how to run F5 | active |

## Concepts

| Slug | Description | Connected Topics |
|------|-------------|-----------------|
| transport-contract-pattern | Unified TransportProvider interface enabling transport-agnostic runtime | contracts, transports, mock, runtime |
| firmware-safety-constraints | EV3 firmware limits that permeate rate limiting, cooldowns, and heartbeat | transports, runtime, protocol |

## Naming Conventions

- Topic slugs: lowercase-kebab-case matching the src/ directory name where possible
- Concept slugs: lowercase-kebab-case describing the cross-cutting pattern

## Evolution Log

- 2026-04-13: Initial schema generated from 9 topics, 2 concepts
