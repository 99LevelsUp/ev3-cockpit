---
concept: Transport Contract Pattern
last_compiled: 2026-11-23
topics_connected: [contracts, transports, runtime, testing]
status: active
---

# Transport Contract Pattern

## Pattern

One trait, `TransportProvider` (`daemon/crates/transports/src/provider.rs`), governs every channel to a brick — USB, TCP and Bluetooth. Every provider discovers, connects, disconnects and exchanges packets through the same calls, and offers `recover`, `forget`, `pair` and `check_presence` where its transport has them. The runtime consumes providers interchangeably: sessions, discovery and the brick layer do not know whether they talk to a cable, a radio or a recording.

The trait is byte level. A provider carries frames and knows nothing about what a command means; the codec and the message counter belong to the command layer in the runtime. An earlier version handed providers typed commands, which made the lowest layer own the vocabulary of every layer above it.

## Instances

- In [transports](../topics/transports.md): the USB, TCP and Bluetooth providers (Windows and Linux), each over its own links; the recorder wraps any provider, and replay implements the trait from a recording.
- In [runtime](../topics/runtime.md): `session.rs`, `discovery.rs` and `bricks.rs` use providers only through the trait; routing picks a channel by the provider's declared priority (USB 30, Bluetooth 20, TCP 10).
- In [testing](../topics/testing.md): recorded sessions replayed at the trait stand in for hardware, so everything above runs unchanged in tests.

## What This Means

The trait is the seam that keeps the runtime transport-agnostic. A new transport implements the trait and is built in the daemon's runtime composition, with no change to sessions, discovery or the brick layer. The same seam is where recording and replay sit, which replaced the TypeScript mock as the way to test without bricks.

## Sources

- [transports](../topics/transports.md)
- [runtime](../topics/runtime.md)
- [testing](../topics/testing.md)
