---
tags:
  - ev3-cockpit
  - plán
  - tracking
zdroj: "[[IMPLEMENTATION_PLAN.md]]"
verze: 2026-04-02
---

# Plán implementace

> Kanonická verze: [[IMPLEMENTATION_PLAN.md]]

## Přehled fází

| Fáze | Název | Stav | Detail |
| ---- | ----- | ---- | ------ |
| 0 | Základ a contracts | ✅ hotovo | [[fáze/Fáze 0 - Základ]] |
| 1 | Transport a discovery | ✅ hotovo | [[fáze/Fáze 1 - Transport a discovery]] |
| 2 | Session runtime | ✅ hotovo | [[fáze/Fáze 2 - Session runtime]] |
| **3** | **Telemetrie a adaptive throttling** | ⬜ **aktuálně** | [[fáze/Fáze 3 - Telemetrie]] |
| 4 | Public API a filesystem | ⬜ plánováno | [[fáze/Fáze 4 - Public API]] |
| 5 | Cockpit panel a UX | ⬜ plánováno | [[fáze/Fáze 5 - Cockpit panel]] |
| 6 | Persistence, favorites, remembered | ⬜ plánováno | [[fáze/Fáze 6 - Persistence]] |
| 7 | Hardening, testy, release | ⬜ plánováno | [[fáze/Fáze 7 - Hardening]] |

## Pořadí a logika

```
Phase 0 (základ)
    → Phase 1 (transport + mock — pro testování všeho dalšího)
        → Phase 2 (session runtime — zdroj pravdy)
            → Phase 3 (telemetrie — data pro UI a API)
                → Phase 4 (public API — stable interface)
                    → Phase 5 (UI panel — nad hotovým runtimem)
                        → Phase 6 (persistence — long-term behavior)
                            → Phase 7 (hardening)
```

> [!tip] Proč tento pořadí?
> - Mock je dostupný brzy → vývoj bez fyzického HW
> - UI se staví až nad hotovým runtimem, ne naopak
> - Public API je konzistentní s interním modelem od začátku

## Princip implementace

Viz [[IMPLEMENTATION_PLAN.md]] §1:

- od runtime a contracts směrem k UI
- Cockpit panel se staví jen nad hotovým runtime modelem
- fyzický connect/disconnect zůstává výhradně v Cockpitu
- mock je implementovaný brzy — pro debugování všech dalších vrstev
- filesystem je service a API, ne GUI explorer

## Hotová základna (Phase 0–2)

```
✅ Extension skeleton
✅ Build + lint pipeline
✅ Test runner infrastruktura
✅ src/contracts/, src/errors/, src/events/
✅ EV3 protocol layer (bytecode, packets, commands, responses)
✅ Transport adaptery + providery (USB, TCP, BT)
✅ TransportGuard, BtConnectionQueue
✅ Session runtime (SessionEntry, SessionManager, heartbeat, reconnect, CommandQueue)
✅ 197 unit testů passing
```

## Co chybí

```
⬜ Telemetrie a adaptive throttling     → Phase 3
⬜ Public API + filesystem services      → Phase 4
⬜ Cockpit panel (webview UI)            → Phase 5
⬜ Persistence + favorites               → Phase 6
⬜ Hardening + stress testy + release    → Phase 7
```

## Minimum po každé změně

1. `npm run compile`
2. `npm run lint`
3. `npm run test:unit` (nebo aspoň smoke)

Pravidelně: full test suite · performance review · refactoring
