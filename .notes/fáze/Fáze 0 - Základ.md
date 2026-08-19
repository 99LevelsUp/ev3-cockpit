---
tags:
  - ev3-cockpit
  - fáze
fáze: 0
název: Základ a contracts
stav: hotovo
---

# Fáze 0 — Základ a contracts

**Stav:** ✅ hotovo  
**Cíl:** Čistá technická základna, na které lze vrstvit další implementaci.

## Hotové úkoly

- [x] **0.1 Extension skeleton** — `package.json`, `src/extension.ts`, `.gitignore`, `.eslintrc.json`
- [x] **0.2 Build pipeline** — `compile`, `lint`, `watch`, `package` (esbuild), `package:vsix`
- [x] **0.3 Test infrastruktura** — unit testy (Node built-in runner), VS Code host testy, CI pipeline, Playwright placeholder
- [x] **0.4 Folder struktura** — `src/contracts/`, `src/runtime/`, `src/transports/`, `src/api/`, `src/ui/`, `src/mock/`, `src/persistence/`, `src/test/`
- [x] **0.5 Sdílené typy** — `Transport`, `BrickKey`, `PresenceState`, `ConnectionState`, `ActivityMode`, `TelemetryCategory`, `DiscoveryItem`, `ConnectedSession`, `ActiveBrickViewModel`
- [x] **0.6 Error model** — `CockpitError`, `TransportError`, `ConnectionError`, `TimeoutError`, `SessionError`, `HeartbeatError`, `ConsumerError`, `SubscriptionError`
- [x] **0.7 Event infrastruktura** — typed event emitter, disposable lifecycle pattern
- [x] **0.8 Composition root** — service registry, wiring v `activate()`, cleanup v `deactivate()`

## Definition of Done

- Extension se aktivuje a deaktivuje čistě
- `compile` + `lint` bez chyb
- Contracts v `src/contracts/` bez závislosti na UI nebo runtime
- Antipattern cleanup: žádné code smells

## Klíčové soubory

- [[src/extension.ts]] — vstupní bod, activate/deactivate
- [[src/contracts/index.ts]] — všechny sdílené typy
- [[src/errors/index.ts]] — CockpitError hierarchie
- [[src/events/index.ts]] — TypedEvent, DisposableStore

## Viz také

- [[moduly/Contracts]] · [[moduly/Errors]] · [[moduly/Events]] · [[moduly/Extension]]
- [[Plán implementace]]
