---
tags:
  - ev3-cockpit
  - koncept
koncept: Transport Contract Pattern
---

# Transport Contract Pattern

Všechny transport kanály (USB, TCP, BT, Mock) implementují **stejný `TransportProvider` interface**. Runtime neví nic o specifické technologii — pracuje výhradně přes contract.

## Interface

```typescript
interface TransportProvider {
  readonly transport: Transport;

  // Discovery — vrátí aktuálně viditelné briky
  discover(): Promise<DiscoveryItem[]>;

  // Session lifecycle
  connect(brickKey: BrickKey): Promise<void>;
  disconnect(brickKey: BrickKey): Promise<void>;

  // Komunikace
  send(brickKey: BrickKey, command: BrickCommand): Promise<BrickResponse>;

  // Volitelné
  recover?(brickKey: BrickKey): Promise<void>;   // pokus o reconnect
  forget?(brickKey: BrickKey): Promise<void>;    // OS-level cleanup

  // Co provider umí
  readonly capabilities: TransportCapabilities;
}
```

## TransportCapabilities

Každý provider deklaruje, co podporuje:

```typescript
interface TransportCapabilities {
  supportsForget: boolean;        // lze smazat OS-level evidenci
  supportsSignalInfo: boolean;    // vrací signal strength
  supportsRecover: boolean;       // má vlastní recover logiku
}
```

## Výhody

1. **Runtime je transport-agnostický** — SessionManager, DiscoveryScheduler pracují přes interface, nezáleží jim na implementaci.

2. **Mock je rovnocenný** — MockTransportProvider implementuje stejný interface → testy jsou realistické.

3. **Nové transporty bez změny runtime** — přidat BT2, WiFi Direct, USB2 = nová třída + registrace v `activate()`.

4. **Testování přes contract** — contract compliance testy běží na všech providerech se stejným test suite.

## Interní struktura fyzického provideru

Fyzické providery (USB, TCP, BT) sdílejí vnitřní dvouvrstvou strukturu:

```
TransportProvider
  └── ProtocolBridge
        ├── ev3Commands      (BrickCommand → bytecode)
        ├── ev3Packet        (framing)
        ├── TransportAdapter (raw I/O: open/close/sendPacket)
        ├── ev3Packet        (decode)
        └── ev3Responses     (raw → BrickResponse)
```

Mock tuto strukturu bypasuje — simuluje odpovědi přímo bez fyzického I/O.

## Provider Registry

```typescript
registry.register(provider);      // přidá provider
registry.get(Transport.USB);      // lookup podle typu
registry.getAll();                // všechny aktivní providery
```

`DiscoveryScheduler` iteruje přes `registry.getAll()` při každém scanu.  
`SessionManager` lookupuje `registry.get(transport)` pro connect/disconnect/send.

## Viz také

- [[moduly/Contracts]] — TransportProvider interface definition
- [[moduly/Transports]] — konkrétní implementace
- [[moduly/Mock]] — Mock jako first-class provider
- [[moduly/Runtime]] — consumer pattern (DiscoveryScheduler, SessionManager)
- [[wiki/concepts/transport-contract-pattern.md]] — zkompilovaný wiki artikel
