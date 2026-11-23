---
concept: Firmware Safety Constraints
last_compiled: 2026-11-23
topics_connected: [transports, runtime, protocol]
status: active
---

# Firmware Safety Constraints

## Pattern

The EV3 firmware has limits that, when crossed, freeze the brick, leave a resource taken, or lock a Bluetooth link out for minutes. They shape several layers. Most of them were measured on three bricks and two firmware versions; several rules once believed were removed when measurement refuted them. A workaround must hold on the original firmware and on a fixed one.

## Instances

- **Rate guard** in [runtime](../topics/runtime.md) (`guard.rs`): a window of 1000 commands per second per brick, shared by all its channels. A full window waits rather than refuses, because a refused file chunk leaves a half-written file. It is a backstop against a runaway loop; commands are strictly serial, so a working caller is limited by the round trip (about 176, 62 and 11 commands/s on USB, TCP and Bluetooth).
- **No "one transport at a time"**: USB and Bluetooth open to one brick with commands on both froze nothing; that rule and its 2 s switch cooldown are gone.
- **Bluetooth pacing** in [transports](../topics/transports.md) (`bt/queue.rs`): opening connections, pairing and presence checks take turns on the radio, 15 s apart, 30 s after a failure; a brick gets 5 s after its own close before it is connected again (an earlier reconnect gave WSA 10064 and locked the brick out).
- **Transfer slots** in [runtime](../topics/runtime.md) (`ledger.rs`): the firmware keeps a cut transfer's file slot taken; the ledger records the debt and settles it before the brick's next transfer.
- **Reply validation** in [protocol](../topics/protocol.md): an error reply carries whatever the previous command left in the buffer, so the reply type is checked before any data is read.
- **Frame sizes**: libusb reaches the 1024-byte frame and must send exactly that size; HID delivers 64 bytes. The brick advances its file pointer by the length the host declares, so a truncated USB write would land padding silently; the link checks what was written.

## What This Means

Every layer that sends bytes to a brick respects these limits, and each one cites its measurement. A rule without a measurement behind it is suspect: two of the original ones (≤10 commands/s and the transport switch cooldown) were wrong.

## Sources

- [transports](../topics/transports.md)
- [runtime](../topics/runtime.md)
- [protocol](../topics/protocol.md)
- [DESIGN.md](../../DESIGN.md) §4.1
