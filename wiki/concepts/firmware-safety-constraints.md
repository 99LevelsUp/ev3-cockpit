---
concept: Firmware Safety Constraints
last_compiled: 2026-04-13
topics_connected: [transports, runtime, protocol]
status: active
---

# Firmware Safety Constraints

## Pattern

The EV3 firmware has hard operational limits that, if violated, cause the brick to freeze and require a physical reboot. These constraints permeate multiple layers of the codebase: rate limiting in the transport guard, cooldown timers in session management, serialized BT connections, and heartbeat intervals. The same set of empirical values (`FIRMWARE_SAFETY` constants) governs behavior across transports and runtime — they are not per-transport quirks but fundamental brick limitations.

## Instances

- **Transport guard** in [transports](../topics/transports.md): `TransportGuard` enforces ≤10 commands/second per brick and a 2-second cooldown when switching between transports for the same brick. Degradation tracking detects when a brick becomes unresponsive.
- **BT connection queue** in [transports](../topics/transports.md): Windows RFCOMM allows only one active connection at a time. The `BtConnectionQueue` serializes connection attempts with a 15-second inter-connection cooldown and exponential backoff on errors.
- **Heartbeat monitor** in [runtime](../topics/runtime.md): heartbeat interval defaults to `FIRMWARE_SAFETY.MIN_HEARTBEAT_INTERVAL_MS` — too-frequent heartbeats would count against the rate limit.
- **Reconnect strategy** in [runtime](../topics/runtime.md): backoff base and max delays are derived from `FIRMWARE_SAFETY` constants to avoid hammering a recovering brick.
- **Protocol layer** in [protocol](../topics/protocol.md): USB HID reports are fixed at 1025 bytes; TCP uses length-prefixed framing — these are EV3 firmware requirements, not design choices.

## What This Means

Every layer that sends bytes to a brick must respect firmware safety. This is not a "nice to have" — violating rate limits causes user-visible hardware freezes. The centralized `FIRMWARE_SAFETY` constants and the `TransportGuard` ensure that command flow stays within safe bounds regardless of how many consumers (foreground telemetry, subscriptions, heartbeat, user commands) compete for the brick's attention. Future telemetry adaptive throttling (Phase 3) will build on this foundation, using queue depth and response latency to dynamically scale back when the brick shows signs of stress.

## Sources

- [transports](../topics/transports.md)
- [runtime](../topics/runtime.md)
- [protocol](../topics/protocol.md)
