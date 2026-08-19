---
tags:
  - ev3-cockpit
  - modul
modul: transports
složka: src/transports/
stav: hotovo
---

# Transports

**Složka:** `src/transports/`  
**Účel:** Fyzická I/O vrstva — transport adaptéry, transport providery, ProviderRegistry, a infrastruktura (TransportGuard, BtConnectionQueue).

## Klíčové soubory

| Soubor | Třída / Interface |
| ------ | ----------------- |
| [[src/transports/index.ts]] | hlavní export |
| [[src/transports/providerRegistry.ts]] | `ProviderRegistry` |
| [[src/transports/transportGuard.ts]] | `TransportGuard` |
| [[src/transports/btConnectionQueue.ts]] | `BtConnectionQueue` |
| [[src/transports/usbHidAdapter.ts]] | `UsbHidAdapter` |
| [[src/transports/tcpSocketAdapter.ts]] | `TcpSocketAdapter` |
| [[src/transports/btSppAdapter.ts]] | `BtSppAdapter` |
| [[src/transports/usbTransportProvider.ts]] | `UsbTransportProvider` |
| [[src/transports/tcpTransportProvider.ts]] | `TcpTransportProvider` |
| [[src/transports/btTransportProvider.ts]] | `BtTransportProvider` |
| [[src/transports/protocolBridge.ts]] | `ProtocolBridge` |
| [[src/transports/pendingReply.ts]] | `PendingReply` |
| [[src/transports/transportConstants.ts]] | timing constants |

## Dvouvrstvá architektura

### Transport Adapters — raw I/O

Interface: `open()` · `close()` · `sendPacket(packet: Uint8Array): Promise<Uint8Array>`

| Adaptér | Technologie | Detaily |
| ------- | ----------- | ------- |
| `UsbHidAdapter` | `node-hid` | VID `0x0694`, PID `0x0005`; 1025-byte HID reports (1B report ID + 1024B payload) |
| `TcpSocketAdapter` | Node.js `net` | Length-prefixed stream; port 5555 |
| `BtSppAdapter` | `serialport` | SPP fallback; COM port |

### Transport Providers — full lifecycle

Implementují `TransportProvider` interface z [[moduly/Contracts]]:

| Provider | Discovery | BrickKey | Poznámka |
| -------- | --------- | -------- | -------- |
| `UsbTransportProvider` | node-hid device enumeration | `usb:<serial>` | lazy-load node-hid |
| `TcpTransportProvider` | UDP beacon port 3015 | `tcp:<serial>` nebo `tcp:<ip>` | VMTP1.0 unlock handshake; hybrid recovery |
| `BtTransportProvider` | koffi bthprops.cpl + registry | `bt:<mac>` | multi-backend (viz níže); signal strength |

## BT multi-backend (Windows)

Pořadí priorit:

```
1. WinRT StreamSocket   (pokud je dostupné .NET runtime)
2. WinSock2 via koffi   (FFI na ws2_32.dll AF_BTH)
3. SPP via serialport   (fallback COM port)
```

Bez detekce .NET: automaticky WinSock2 → SPP.

## Infrastruktura

### ProviderRegistry

Registrace/deregistrace/enumerace transport providerů. `DiscoveryScheduler` a `SessionManager` ho používají pro přístup k providerům.

### TransportGuard

Viz [[koncepty/Firmware Safety]]

- Rate limit: ≤ 10 příkazů/s per brik
- Firmware freeze protection: 2s cooldown při přepnutí transportu
- Degradation tracking

### BtConnectionQueue

Windows RFCOMM: pouze 1 aktivní spojení najednou.

- Serializovaná fronta (1 slot)
- 15s inter-connection cooldown
- Exponential backoff při chybách

### ProtocolBridge

Drátuje adaptér + protocol vrstvu do unified `send(BrickCommand) → BrickResponse` pipeline.

### PendingReply

Koreluje odchozí příkazy s jejich reply promises (matching přes counter/sequence number).

## Timing constants (`transportConstants.ts`)

| Konstanta | Hodnota |
| --------- | ------- |
| `FIRMWARE_SAFETY.MAX_COMMANDS_PER_SECOND` | 10 |
| `FIRMWARE_SAFETY.TRANSPORT_SWITCH_COOLDOWN_MS` | 2000 |
| USB discovery interval | ~500ms |
| TCP beacon timeout | ~5s |
| BT reconnect base delay | dle FIRMWARE_SAFETY |

## Lazy loading nativních modulů

`node-hid`, `serialport`, `koffi` jsou načítány přes `require()` uvnitř `try-catch`. Pokud modul není dostupný, provider vrátí prázdný discovery list.

## Viz také

- [[moduly/Protocol]] — ev3Commands/ev3Responses/ev3Packet pipeline
- [[moduly/Runtime]] — ProviderRegistry consumer, SessionManager
- [[moduly/Mock]] — MockTransportProvider (v src/mock/, ne transports/)
- [[koncepty/Transport Contract Pattern]]
- [[koncepty/Firmware Safety]]
- [[fáze/Fáze 1 - Transport a discovery]] — kdy bylo implementováno
