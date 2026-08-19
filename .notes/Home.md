---
tags:
  - ev3-cockpit
  - moc
  - home
popis: Hlavní rozcestník projektu EVƎ Cockpit
---

# EVƎ Cockpit

> VS Code extension pro discovery, připojení a monitoring LEGO Mindstorms EV3 bricks.  
> Publisher: `99LevelsUp` · TypeScript · Windows + Linux

## Aktuální stav

> [!info] Právě probíhá: **[[fáze/Fáze 3 - Telemetrie|Fáze 3 — Telemetrie a adaptive throttling]]**
> Fáze 0–2 jsou kompletní (197 testů passing). Telemetrie, Public API a UI panel jsou naplánované.

| Fáze | Název | Stav |
| ---- | ----- | ---- |
| 0 | Základ a contracts | ✅ |
| 1 | Transport a discovery | ✅ |
| 2 | Session runtime | ✅ |
| **3** | **Telemetrie a adaptive throttling** | ⬜ ← |
| 4 | Public API a filesystem | ⬜ |
| 5 | Cockpit panel a UX | ⬜ |
| 6 | Persistence, favorites, remembered | ⬜ |
| 7 | Hardening, testy, release | ⬜ |

## Projekt

- [[Požadavky]] — co extension musí umět
- [[Architektura]] — jak je to postaveno
- [[Plán implementace]] — pořadí a stav fází

Zdrojové dokumenty: [[REQUIREMENTS.md]] · [[DESIGN.md]] · [[IMPLEMENTATION_PLAN.md]] · [[wiki/INDEX.md]]

## Fáze implementace

- [[fáze/Fáze 0 - Základ|Fáze 0 — Základ a contracts]] ✅
- [[fáze/Fáze 1 - Transport a discovery|Fáze 1 — Transport a discovery]] ✅
- [[fáze/Fáze 2 - Session runtime|Fáze 2 — Session runtime]] ✅
- [[fáze/Fáze 3 - Telemetrie|Fáze 3 — Telemetrie]] ⬜ ← aktuálně
- [[fáze/Fáze 4 - Public API|Fáze 4 — Public API]] ⬜
- [[fáze/Fáze 5 - Cockpit panel|Fáze 5 — Cockpit panel]] ⬜
- [[fáze/Fáze 6 - Persistence|Fáze 6 — Persistence]] ⬜
- [[fáze/Fáze 7 - Hardening|Fáze 7 — Hardening]] ⬜

## Moduly

- [[moduly/Contracts|Contracts]] — sdílené typy, enums, interfaces
- [[moduly/Errors|Errors]] — chybový model, CockpitError
- [[moduly/Events|Events]] — TypedEvent, DisposableStore
- [[moduly/Protocol|Protocol]] — EV3 bytecode, packet framing
- [[moduly/Transports|Transports]] — USB / TCP / BT adaptéry a providery
- [[moduly/Runtime|Runtime]] — SessionManager, PresenceAggregator, discovery
- [[moduly/Mock|Mock]] — simulovaný transport pro vývoj a testy
- [[moduly/Extension|Extension]] — vstupní bod `src/extension.ts`

## Klíčové koncepty

- [[koncepty/BrickKey|BrickKey]] — stabilní identita briku per transport
- [[koncepty/Presence State Machine|Presence State Machine]] — stavový automat discovery
- [[koncepty/Transport Contract Pattern|Transport Contract Pattern]] — unified transport interface
- [[koncepty/Firmware Safety|Firmware Safety]] — ochrana firmware EV3 před přetížením

## Zápisky

- [[zápisky/Šablona zápisku|Šablona zápisku]] — template pro zápisky z vývoje
