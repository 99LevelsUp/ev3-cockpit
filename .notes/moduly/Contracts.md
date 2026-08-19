---
tags:
  - ev3-cockpit
  - modul
modul: contracts
složka: src/contracts/
stav: hotovo
---

# Contracts

**Složka:** `src/contracts/`  
**Účel:** Sdílené typy, enums, interfaces a data modely — základ, na kterém stojí celý projekt. Žádná závislost na UI nebo runtime.

## Klíčové soubory

- [[src/contracts/index.ts]] — hlavní export

## Enums

| Enum | Hodnoty |
| ---- | ------- |
| `Transport` | `mock` · `usb` · `tcp` · `bt` |
| `PresenceState` | `remembered` · `available` · `unavailable` · `removed` |
| `ConnectionState` | `connecting` · `connected` · `reconnecting` · `disconnected` |
| `ActivityMode` | `foreground` · `subscribed` · `minimal` · `none` |
| `TelemetryCategory` | `ports` · `filesystem` · `system` |

## Klíčové typy

### BrickKey

Branded string — stabilní identita briku per transport.  
Formát: `transport:id` (např. `usb:ABC123`, `bt:11:22:33:44:55:66`, `mock:my-brick`)  
Viz [[koncepty/BrickKey]]

### DiscoveryItem

Jeden řádek v discovery listu:

```typescript
interface DiscoveryItem {
  brickKey: BrickKey;
  displayName: string;
  transport: Transport;
  presenceState: PresenceState;
  remembered: boolean;
  connected: boolean;
  favorite: boolean;
  signalInfo?: SignalInfo;
  availableTransports: Transport[];
  btVisible?: boolean;
  lastSeenAt: number;
}
```

### ConnectedSession

Model připojené session:

```typescript
interface ConnectedSession {
  brickKey: BrickKey;
  displayName: string;
  transport: Transport;
  connectionState: ConnectionState;
  activeMode: ActivityMode;
  lastError?: CockpitError;
  subscribedCategories: TelemetryCategory[];
  heartbeatState: HeartbeatState;
}
```

### ActiveBrickViewModel

Model pro foreground panel (plné data aktivního briku):
- identity, battery, available transports, BT visibility
- porty A–D (motory) + 1–4 (senzory): peripheral type + live value
- button state, system info, favorite, valueDisplayStyle, status bar config

### TransportProvider interface

Unified contract pro všechny transporty:

```typescript
interface TransportProvider {
  readonly transport: Transport;
  discover(): Promise<DiscoveryItem[]>;
  connect(brickKey: BrickKey): Promise<void>;
  disconnect(brickKey: BrickKey): Promise<void>;
  send(brickKey: BrickKey, command: BrickCommand): Promise<BrickResponse>;
  recover?(brickKey: BrickKey): Promise<void>;
  forget?(brickKey: BrickKey): Promise<void>;
  readonly capabilities: TransportCapabilities;
}
```

Viz [[koncepty/Transport Contract Pattern]]

## Závislosti

- Žádné (contracts jsou základ, na kterém závisí vše ostatní)

## Viz také

- [[moduly/Errors]] — CockpitError (používáno v ConnectedSession)
- [[moduly/Events]] — event infrastruktura nad contracts
- [[koncepty/BrickKey]]
- [[koncepty/Transport Contract Pattern]]
- [[fáze/Fáze 0 - Základ]] — kdy bylo implementováno
