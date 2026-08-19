---
tags:
  - ev3-cockpit
  - modul
modul: mock
složka: src/mock/
stav: hotovo
---

# Mock

**Složka:** `src/mock/`  
**Účel:** Plnohodnotný simulovaný transport. Implementuje stejný `TransportProvider` contract jako fyzické transporty — bez fyzického HW. Používá se pro vývoj, debugging a testy.

## Klíčové soubory

| Soubor | Obsah |
| ------ | ----- |
| [[src/mock/index.ts]] | MockTransportProvider |
| [[src/mock/mockCatalog.ts]] | načítání + validace JSON konfigurace |
| [[src/mock/mockSession.ts]] | simulovaná session (odpovědi na příkazy) |
| [[src/mock/mockFilesystem.ts]] | in-memory file tree |
| [[src/mock/dynamics.ts]] | value dynamics engine (oscillators) |
| [[src/mock/mockWorld.ts]] | MockWorld.create(config) |

## Konfigurace

Mock briky jsou definovány v JSON souboru v workspace:

```json
{
  "bricks": [
    {
      "id": "my-brick",
      "name": "Testovací brik",
      "sensors": {
        "port1": { "type": "touch", "value": 0 },
        "port2": { "type": "color", "dynamics": { "mode": "sine", "min": 0, "max": 100, "period": 5000 } }
      },
      "motors": {
        "portA": { "type": "large", "dynamics": { "mode": "triangle", "min": -100, "max": 100, "period": 3000 } }
      },
      "simulation": {
        "loss": { "after": 30000, "duration": 5000 },
        "errors": []
      }
    }
  ]
}
```

BrickKey: `mock:<id>`

## Value Dynamics

Engine pro simulaci měnících se hodnot:

| Mode | Popis |
| ---- | ----- |
| `static` | konstantní hodnota |
| `sine` | sinusový průběh mezi min a max |
| `triangle` | trojúhelníkový průběh |
| `square` | obdélníkový průběh |

## Co Mock simuluje

- ✅ Discovery (statický seznam z konfigurace)
- ✅ Connect / disconnect
- ✅ Reconnect (loss + recovery simulation)
- ✅ Telemetrie (port values via dynamics)
- ✅ Filesystem API (in-memory file tree)
- ✅ Error states (konfigurovatelné selhání)
- ✅ Battery level
- ✅ System info (firmware version, atd.)

## Použití

Mock je první-class transport — vždy dostupný, nepotřebuje nativní závislosti. Základní workflow vývoje = vyvíjet s Mock, pak ověřit na fyzickém HW.

Per-brick world config (od Phase 1.6.8+):
- Každý mock brik může mít vlastní `world` config místo sdíleného defaultu
- Flow: `brickId → resolveMockWorldConfig() → MockWorld.create(config)`

## Viz také

- [[moduly/Contracts]] — TransportProvider interface, BrickCommand, BrickResponse
- [[moduly/Transports]] — fyzické transport providery (stejný contract)
- [[koncepty/Transport Contract Pattern]] — proč mock implementuje stejný interface
- [[fáze/Fáze 1 - Transport a discovery]] §1.6 — kdy bylo implementováno
