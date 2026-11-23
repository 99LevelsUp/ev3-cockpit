---
topic: Protocol
last_compiled: 2026-11-23
status: active
---

# Protocol

## Purpose [coverage: high — 5 sources]

`daemon/crates/protocol` (`ev3-protocol`) implements the EV3 communication protocol with no I/O: bytecode encoding, packet framing, building commands and parsing replies. Nothing in it opens a link, reads a clock or waits. It is a rule-by-rule port of the TypeScript protocol layer. It sits between the [transports](transports.md), which carry bytes, and the [runtime](runtime.md), which sends commands.

## Architecture [coverage: high — 5 sources]

`src/`:

- **`bytecode.rs`** — encoding primitives: local constants (LC0/LC1/LC2/LCS), global variable indexes, little-endian integers, C strings.
- **`packet.rs`** — framing `[length:2LE][counter:2LE][type:1B][payload]`: `encode_ev3_packet`, `decode_ev3_packet`, `extract_length_prefixed_packet`, and the command, opcode and subcode constants of firmware 1.09d.
- **`commands.rs`** — `build_command(&BrickCommand)` → `EncodedCommand`. `BrickCommand` covers telemetry frames, battery, ports, buttons, info, the brick's name and Bluetooth settings and peer list, program run/stop/status/emergency stop, system run, and the file system (list, read, write, exists, delete, chunked begin/continue for reads and writes, size, free space, make directory, copy, remove tree, close handle).
- **`responses.rs`** — `parse_response` → `BrickResponse`; `validate_reply` checks the reply type first, so an error reply is never read as data.
- **`peripherals.rs`** — what is plugged into a port, from the firmware's type code.
- **`error.rs`** — `ProtocolError`, the one error the crate returns.

## Talks To [coverage: medium — 3 sources]

- **runtime** — `session.rs` builds, frames, sends through the transport and parses; the brick layer reads a brick's info the same way.
- **transports** — only bytes cross; the links know framing lengths, not commands.

## Data [coverage: medium — 2 sources]

Packet format: `[length:2 bytes LE][counter:2 bytes LE][type:1 byte][payload:N bytes]`. Direct commands carry a global-variable reservation; system commands carry their own subcodes. Opcodes and subcodes are taken from the firmware sources (`bytecodes.h`, `c_com.h`), never guessed.

## Key Decisions [coverage: medium — 2 sources]

- **Pure functions, no I/O** — testable without hardware or fakes (`daemon/crates/protocol/tests/`: `ev3_protocol.rs`, `firmware_codes.rs`, `transfer_limits.rs`, …).
- **Typed pipeline** — `BrickCommand` → `build_command` → `encode_ev3_packet` → wire → `decode_ev3_packet` → `parse_response` → `BrickResponse`.
- **Separate from transport** — links handle raw I/O; the codec and the message counter belong to the command layer (DESIGN §4.3a).

## Gotchas [coverage: medium — 2 sources]

- USB through libusb carries 1024-byte frames and reads come back full-length, so a reply is found by its own length prefix; the HID fallback carries 64 bytes per packet. The link handles padding, not the protocol.
- TCP is a length-prefixed stream; `extract_length_prefixed_packet` finds the first complete packet in a buffer.

## Sources

- [daemon/crates/protocol/src/lib.rs](../../daemon/crates/protocol/src/lib.rs)
- [daemon/crates/protocol/src/packet.rs](../../daemon/crates/protocol/src/packet.rs)
- [daemon/crates/protocol/src/commands.rs](../../daemon/crates/protocol/src/commands.rs)
- [daemon/crates/protocol/src/responses.rs](../../daemon/crates/protocol/src/responses.rs)
- [docs/protocol.md](../../docs/protocol.md) is the daemon's protocol, not this one
