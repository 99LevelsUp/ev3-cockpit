---
topic: Protocol
last_compiled: 2026-04-13
status: active
---

# Protocol

## Purpose [coverage: high — 5 sources]

The `src/protocol/` module implements the EV3 communication protocol as pure functions with no I/O. It handles bytecode encoding primitives, packet framing, command building (from `BrickCommand` to raw bytes), and response parsing (from raw bytes to typed `BrickResponse`). This layer sits between the transport adapters (raw I/O) and the higher-level transport providers.

## Architecture [coverage: high — 5 sources]

Four files, re-exported via `index.ts`:

- **ev3Bytecode.ts** — low-level encoding primitives: `lc0`/`lc1`/`lc2`/`lcs` (local constants), `gv0`/`gv1` (global variables), `uint16le`/`uint32le`/`readUint16le`/`readUint32le`/`readInt32le`/`readFloat32le`, `concatBytes`, `cString`, `readFixedCString`
- **ev3Packet.ts** — packet framing: `[length:2LE][counter:2LE][type:1B][payload]`. Exports `encodeEv3Packet`, `decodeEv3Packet`, `extractLengthPrefixedPacket`. Defines constants: `EV3_COMMAND`, `EV3_REPLY`, `EV3_SYSTEM`, `EV3_OPCODE`, `UI_READ_SUB`, `INPUT_DEVICE_SUB`, `EV3_SYSTEM_STATUS`
- **ev3Commands.ts** — `buildCommand(command: BrickCommand)` maps typed commands to `{ type, payload }` encoded bytes. Exports `INFO_LAYOUT` for brick info field definitions
- **ev3Responses.ts** — `parseResponse(kind, replyPayload)` converts raw EV3 reply bytes into typed `BrickResponse` objects

## Talks To [coverage: medium — 3 sources]

- **transports/** — transport providers (`UsbTransportProvider`, `TcpTransportProvider`, `BtTransportProvider`) use `buildCommand` + `encodeEv3Packet` to send, and `decodeEv3Packet` + `parseResponse` to receive
- **contracts/** — consumes `BrickCommand` and produces `BrickResponse` types
- **mock/** — mock transport bypasses the protocol layer entirely, simulating responses directly

## API Surface [coverage: high — 5 sources]

| Export | Description |
|--------|-------------|
| `buildCommand(cmd)` | `BrickCommand` → `EncodedCommand { type, payload }` |
| `parseResponse(kind, data)` | raw bytes → typed `BrickResponse` |
| `encodeEv3Packet(packet)` | `Ev3Packet` → `Uint8Array` with length-prefixed framing |
| `decodeEv3Packet(data)` | `Uint8Array` → `Ev3Packet` |
| `extractLengthPrefixedPacket(buf)` | extract first complete packet from a stream buffer |
| `lc0`, `lc1`, `lc2`, `lcs` | local constant encoders (1/2/3/N bytes) |
| `gv0`, `gv1` | global variable index encoders |
| `uint16le`, `uint32le` | little-endian integer encoders |
| `concatBytes` | concatenate multiple `Uint8Array` fragments |
| `INFO_LAYOUT` | field layout definition for brick info queries |

## Data [coverage: medium — 2 sources]

Packet format: `[length:2 bytes LE][counter:2 bytes LE][type:1 byte][payload:N bytes]`.

EV3 opcodes and sub-commands are defined as numeric constants (`EV3_OPCODE`, `UI_READ_SUB`, `INPUT_DEVICE_SUB`). System command status codes in `EV3_SYSTEM_STATUS`.

## Key Decisions [coverage: medium — 2 sources]

- **Pure functions, no I/O** — the protocol layer is completely stateless and testable without mocks or hardware.
- **Typed command/response pipeline** — `BrickCommand` → `buildCommand` → `encodeEv3Packet` → wire → `decodeEv3Packet` → `parseResponse` → `BrickResponse`. Each step is independently testable.
- **Separate from transport** — adapters handle raw I/O; protocol handles encoding/decoding. This keeps transport adapters thin and protocol logic reusable.

## Gotchas [coverage: medium — 2 sources]

- USB HID packets are 1025 bytes (1 byte report ID + 1024 payload) — the adapter layer handles this padding, not the protocol.
- TCP uses length-prefixed streaming while USB uses fixed-size HID reports — `extractLengthPrefixedPacket` handles the TCP case; USB reads are always exactly one report.

## Sources

- [src/protocol/index.ts](../../src/protocol/index.ts)
- [src/protocol/ev3Bytecode.ts](../../src/protocol/ev3Bytecode.ts)
- [src/protocol/ev3Packet.ts](../../src/protocol/ev3Packet.ts)
- [src/protocol/ev3Commands.ts](../../src/protocol/ev3Commands.ts)
- [src/protocol/ev3Responses.ts](../../src/protocol/ev3Responses.ts)
