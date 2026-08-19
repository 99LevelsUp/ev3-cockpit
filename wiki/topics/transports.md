---
topic: Transports
last_compiled: 2026-04-13
status: active
---

# Transports

## Purpose [coverage: high — 8 sources]

The `src/transports/` module provides the physical I/O layer for communicating with EV3 bricks over USB, TCP, and Bluetooth. It contains transport adapters (raw I/O), transport providers (implementing the `TransportProvider` contract), a provider registry, and infrastructure components (TransportGuard, BtConnectionQueue, PendingReply, ProtocolBridge). Mock transport is handled separately in `src/mock/`.

## Architecture [coverage: high — 8 sources]

The module follows a two-layer architecture per transport:

**Transport Adapters** (`TransportAdapter` interface): `open()`, `close()`, `sendPacket(packet)` — raw I/O only.
- `UsbHidAdapter` — USB HID via `node-hid`. VID `0x0694`, PID `0x0005`. 1025-byte reports (1 byte report ID + 1024 payload).
- `TcpSocketAdapter` — TCP via Node.js `net`. Length-prefixed stream. Connects on port 5555.
- `BtSppAdapter` — Bluetooth RFCOMM via `serialport` (SPP fallback).

**Transport Providers** (`TransportProvider` interface): compose adapter + protocol for full `discover/connect/disconnect/send/recover/forget`.
- `UsbTransportProvider` — USB device enumeration via `node-hid`. BrickKey: `usb:<serial>`. Lazy-loads node-hid with try-catch fallback.
- `TcpTransportProvider` — UDP beacon discovery on port 3015 (`dgram`), TCP connection on port 5555. VMTP1.0 unlock handshake. BrickKey: `tcp:<serial>` or `tcp:<ip>`. Hybrid beacon + direct-IP recovery.
- `BtTransportProvider` — multi-backend architecture on Windows: WinRT StreamSocket (if .NET available) → WinSock2 via `koffi` FFI → SPP via `serialport`. On Linux: BlueZ D-Bus. BrickKey: `bt:<mac>`. Supports signal strength reporting.

**Infrastructure:**
- `ProviderRegistry` — register/unregister/enumerate/lookup transport providers by type
- `TransportGuard` — rate limiting (≤10 commands/second per brick), firmware freeze protection (one active transport at a time, 2-second switch cooldown), degradation tracking
- `BtConnectionQueue` — serialized RFCOMM connections (1 slot, 15-second inter-connection cooldown, exponential backoff on errors)
- `PendingReply` — correlates outgoing commands with their reply promises
- `ProtocolBridge` — wires adapter + protocol layer into a unified `send(BrickCommand) → BrickResponse` pipeline
- `transportConstants.ts` — empirical timing values (`USB`, `TCP`, `BT`, `FIRMWARE_SAFETY`)

## Talks To [coverage: high — 6 sources]

- **contracts/** — implements `TransportProvider`, `TransportAdapter` interfaces; uses `BrickCommand`, `BrickResponse`
- **protocol/** — uses `buildCommand`, `encodeEv3Packet`, `decodeEv3Packet`, `parseResponse` for all physical transports
- **runtime/** — `ProviderRegistry` is consumed by `DiscoveryScheduler` (for discovery polling) and `SessionManager` (for connect/disconnect/send)
- **extension.ts** — all providers are instantiated and registered in `activate()`
- **External native modules** — `node-hid` (USB), Node.js `net`/`dgram` (TCP), `serialport`/`koffi` (BT)

## API Surface [coverage: high — 8 sources]

| Export | Description |
|--------|-------------|
| `ProviderRegistry` | Register/unregister/enumerate/get providers |
| `UsbTransportProvider` | USB HID transport provider |
| `TcpTransportProvider` | TCP/UDP transport provider |
| `BtTransportProvider` | Bluetooth RFCOMM transport provider |
| `UsbHidAdapter` | Raw USB HID I/O adapter |
| `TcpSocketAdapter` | Raw TCP socket I/O adapter |
| `BtSppAdapter` | Raw BT SPP I/O adapter |
| `TransportGuard` | Rate limiting and firmware safety |
| `BtConnectionQueue` | Serialized BT RFCOMM connection queue |
| `USB`, `TCP`, `BT`, `FIRMWARE_SAFETY` | Timing constants |

## Data [coverage: medium — 3 sources]

Transport timing constants (from `transportConstants.ts`):
- `FIRMWARE_SAFETY.MAX_COMMANDS_PER_SECOND` = 10
- `FIRMWARE_SAFETY.TRANSPORT_SWITCH_COOLDOWN_MS` = 2000
- `FIRMWARE_SAFETY.MIN_HEARTBEAT_INTERVAL_MS`, `RECONNECT_BASE_MS`, `RECONNECT_MAX_MS`, `MAX_RECONNECT_ATTEMPTS`
- Per-transport discovery intervals, timeouts, and retry parameters

## Key Decisions [coverage: high — 5 sources]

- **Adapter/provider separation** — adapters handle only raw I/O; providers compose adapter + protocol + discovery. This keeps adapters thin and testable.
- **Multi-backend BT** — Windows BT has three backends (WinRT, WinSock2, SPP) tried in priority order, because no single approach works reliably on all Windows configurations.
- **Lazy native loading** — `node-hid` and other native modules are loaded with `require()` inside try-catch, allowing the extension to function without native dependencies installed.
- **Serialized BT connections** — Windows RFCOMM allows only one active connection at a time; the `BtConnectionQueue` enforces this with a 15-second inter-connection cooldown.
- **Rate limiting at transport guard level** — ≤10 commands/second protects EV3 firmware from freezes; applied per-brick regardless of how many consumers send commands.

## Gotchas [coverage: medium — 3 sources]

- **Native module availability** — `node-hid`, `serialport`, `koffi` may not load in VS Code extension host depending on the platform and build. Providers return empty discovery results if their native module is unavailable.
- **TCP VMTP1.0 unlock** — the EV3 brick requires a specific handshake string before it accepts TCP commands.
- **Firmware freeze** — sending commands too fast or switching transports without cooldown can freeze the EV3 firmware, requiring a physical reboot.

## Sources

- [src/transports/index.ts](../../src/transports/index.ts)
- [src/transports/transportAdapter.ts](../../src/transports/transportAdapter.ts)
- [src/transports/providerRegistry.ts](../../src/transports/providerRegistry.ts)
- [src/transports/usbHidAdapter.ts](../../src/transports/usbHidAdapter.ts)
- [src/transports/tcpSocketAdapter.ts](../../src/transports/tcpSocketAdapter.ts)
- [src/transports/btSppAdapter.ts](../../src/transports/btSppAdapter.ts)
- [src/transports/usbTransportProvider.ts](../../src/transports/usbTransportProvider.ts)
- [src/transports/tcpTransportProvider.ts](../../src/transports/tcpTransportProvider.ts)
- [src/transports/btTransportProvider.ts](../../src/transports/btTransportProvider.ts)
- [src/transports/transportGuard.ts](../../src/transports/transportGuard.ts)
- [src/transports/btConnectionQueue.ts](../../src/transports/btConnectionQueue.ts)
- [src/transports/pendingReply.ts](../../src/transports/pendingReply.ts)
- [src/transports/protocolBridge.ts](../../src/transports/protocolBridge.ts)
- [src/transports/transportConstants.ts](../../src/transports/transportConstants.ts)
