---
tags:
  - ev3-cockpit
  - fáze
fáze: 1
název: Transport a discovery
stav: hotovo
---

# Fáze 1 — Transport a discovery

**Stav:** ✅ hotovo  
**Cíl:** Unified `TransportProvider` contract pro všechny kanály, počínaje Mockem.

## Hotové úkoly

- [x] **1.1 TransportProvider interface** — `discover`, `connect`, `disconnect`, `send`, `recover`, `forget`, capability flags
- [x] **1.2 DiscoveryItem data model** — implementace s transport-specific metadata
- [x] **1.3 Provider registry** — register/unregister/enumerate/lookup per transport type
- [x] **1.4 Discovery scheduler** — polling loop per provider, konfigurovatelný interval, deduplication, timeout handling (`available → unavailable → removed`)
- [x] **1.5 Presence Aggregator** — unified discovery model, state machine per brik, merge s remembered, stabilní řazení, event emission
- [x] **1.6 Mock Transport** — JSON konfigurace (identity, senzory, motory, dynamics), discovery, connect/disconnect, value dynamics (static/sine/triangle/square), error simulation, loss/recovery simulation, mock filesystem, brickKey `mock:<id>`
- [x] **1.7 EV3 Protocol layer** — bytecode primitives, packet framing, command builder, response parser, unit testy
- [x] **1.8 Transport adapter interface** — `open`, `close`, `sendPacket`; timing constants; TransportGuard (≤10 cmd/s, cooldown, degradation tracking)
- [x] **1.9 USB Transport** — `UsbHidAdapter` (node-hid, VID 0x0694 PID 0x0005, 1025-byte HID reports), `UsbTransportProvider`, brickKey `usb:<serial>`, lazy-load
- [x] **1.10 TCP Transport** — `TcpSocketAdapter` (TCP, length-prefixed), `TcpTransportProvider` (UDP beacon port 3015, TCP port 5555, VMTP1.0 handshake), brickKey `tcp:<serial>` nebo `tcp:<ip>`, hybrid recovery
- [x] **1.11 BT Transport** — `BtRfcommAdapter` (multi-backend: WinRT → WinSock2 koffi → SPP serialport), BtConnectionQueue (1 slot, 15s cooldown, exponential backoff), `BtTransportProvider` (koffi bthprops.cpl + registry), brickKey `bt:<mac>`, signal strength
- [x] **1.12 Transport unit testy** — protocol encoding/decoding, TransportGuard rate limiting, BtConnectionQueue serialization, contract compliance
- [x] **1.13 Mock + infrastruktura testy** — contract compliance, discovery scheduler, PresenceAggregator state machine, stabilní řazení, mock konfigurace

## Definition of Done

- Runtime může zobrazit mock i fyzické briky simultánně
- Discovery list stabilní a správně seřazený
- Mock transport projde všemi contract compliance testy
- Antipattern cleanup

## Klíčové soubory

- [[src/transports/index.ts]] — export všech transport komponent
- [[src/transports/providerRegistry.ts]] — ProviderRegistry
- [[src/transports/transportGuard.ts]] — rate limiting, firmware protection
- [[src/transports/btConnectionQueue.ts]] — BT RFCOMM serialization
- [[src/runtime/presenceAggregator.ts]] — unified discovery
- [[src/runtime/discoveryScheduler.ts]] — polling loop
- [[src/mock/index.ts]] — MockTransportProvider

## Viz také

- [[moduly/Transports]] · [[moduly/Mock]] · [[moduly/Protocol]] · [[moduly/Runtime]]
- [[koncepty/Transport Contract Pattern]] · [[koncepty/Firmware Safety]] · [[koncepty/Presence State Machine]]
- [[Plán implementace]]
