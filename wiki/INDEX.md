# ev3-cockpit Knowledge Base

Last compiled: 2026-04-13
Total topics: 9 | Total sources: 53

## Topics

| Topic | Also Known As | Sources | Last Updated | Status |
|-------|--------------|---------|-------------|--------|
| [Project Overview](topics/project-overview.md) | ev3-cockpit, EVƎ Cockpit, architecture, design, requirements, implementation plan | 8 | 2026-04-13 | active |
| [Contracts](topics/contracts.md) | types, enums, models, interfaces, BrickKey, TransportProvider | 6 | 2026-04-13 | active |
| [Errors](topics/errors.md) | CockpitError, error codes, exceptions | 2 | 2026-04-13 | active |
| [Events](topics/events.md) | TypedEvent, DisposableStore, lifecycle, disposable | 2 | 2026-04-13 | active |
| [Protocol](topics/protocol.md) | EV3 bytecode, packet framing, ev3Commands, ev3Responses, ev3Packet | 5 | 2026-04-13 | active |
| [Transports](topics/transports.md) | USB HID, TCP socket, Bluetooth RFCOMM, ProviderRegistry, TransportGuard, BtConnectionQueue | 14 | 2026-04-13 | active |
| [Runtime](topics/runtime.md) | SessionManager, PresenceAggregator, DiscoveryScheduler, CommandQueue, HeartbeatMonitor, ReconnectStrategy | 8 | 2026-04-13 | active |
| [Mock](topics/mock.md) | MockTransportProvider, mock bricks, dynamics, simulation, testing | 6 | 2026-04-13 | active |
| [Testing](topics/testing.md) | unit tests, test runner, CI, Playwright, test:unit, test:host | 11 | 2026-04-13 | active |
| [Development Environment](topics/dev-environment.md) | VS Code setup, F5 launch, EMFILE bug, Copilot Chat, launch.json, tasks.json | 4 | 2026-04-13 | active |

## Concepts

| Concept | Connects | Last Updated |
|---------|----------|-------------|
| [Transport Contract Pattern](concepts/transport-contract-pattern.md) | contracts, transports, mock, runtime | 2026-04-13 |
| [Firmware Safety Constraints](concepts/firmware-safety-constraints.md) | transports, runtime, protocol | 2026-04-13 |

## Recent Changes
- 2026-04-13: Added dev-environment topic — VS Code workspace setup, Copilot Chat EMFILE bug, launch.json fix
- 2026-04-13: Initial compilation — 9 topics and 2 concepts from 53 source files
