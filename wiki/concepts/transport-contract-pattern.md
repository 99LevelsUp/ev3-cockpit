---
concept: Transport Contract Pattern
last_compiled: 2026-04-13
topics_connected: [contracts, transports, mock, runtime]
status: active
---

# Transport Contract Pattern

## Pattern

A single `TransportProvider` interface governs all communication channels — Mock, USB, TCP, and Bluetooth. Every provider implements the same 6-method contract (`discover`, `connect`, `disconnect`, `send`, optional `recover` and `forget`), and the runtime layer consumes them interchangeably through the `ProviderRegistry`. This means the entire session lifecycle, discovery aggregation, and command dispatch are transport-agnostic: the `SessionManager` does not know or care whether it is talking to a simulated brick or a physical one connected via Bluetooth.

This pattern enabled the project's "runtime-first" implementation strategy — Mock was built early as a first-class transport, and all runtime infrastructure (PresenceAggregator, SessionManager, HeartbeatMonitor, ReconnectStrategy) was developed and tested against it before any physical transport existed.

## Instances

- **Phase 0** in [contracts](../topics/contracts.md): `TransportProvider` interface defined with `BrickCommand`/`BrickResponse` discriminated unions, establishing the contract that all transports must satisfy.
- **Phase 1** in [mock](../topics/mock.md): `MockTransportProvider` was the first implementation, used as the reference for contract compliance testing.
- **Phase 1** in [transports](../topics/transports.md): USB, TCP, and BT providers each implement the same contract with transport-specific adapters underneath. The two-layer architecture (adapter for raw I/O, provider for contract compliance) keeps each implementation thin.
- **Phase 2** in [runtime](../topics/runtime.md): `SessionManager` and `DiscoveryScheduler` consume providers purely through the `TransportProvider` interface and `ProviderRegistry`, with no transport-specific logic.

## What This Means

The transport contract is the architectural seam that makes the entire codebase modular. Adding a new transport (e.g., Wi-Fi Direct, mDNS) requires only implementing the `TransportProvider` interface and registering it — zero changes to runtime, discovery, or session management. Similarly, the mock transport provides an exact behavioral replica of real hardware, making the test suite reliable without physical devices. This is a deliberate inversion: the protocol and I/O complexity is pushed down into adapters, while the contract keeps everything above simple and composable.

## Sources

- [contracts](../topics/contracts.md)
- [transports](../topics/transports.md)
- [mock](../topics/mock.md)
- [runtime](../topics/runtime.md)
