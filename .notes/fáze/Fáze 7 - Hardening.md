---
tags:
  - ev3-cockpit
  - fáze
fáze: 7
název: Hardening, testy, release
stav: plánováno
---

# Fáze 7 — Hardening, testy a release discipline

**Stav:** ⬜ plánováno  
**Cíl:** Stabilizace systému pro dlouhodobé použití a další vývoj.

## Úkoly

### 7.1 Unit test coverage expansion
- [ ] Contract a type validation testy
- [ ] State machine transition testy (presence, connection, activity)
- [ ] Telemetry scheduler + throttling testy
- [ ] API consumer lifecycle testy
- [ ] Error model a error propagation testy

### 7.2 Integration testy
- [ ] Full connect → monitor → disconnect lifecycle (Mock)
- [ ] Multi-brick concurrent sessions
- [ ] Reconnect pod různými failure modes
- [ ] API consumer registration → telemetry subscription → disconnect cleanup
- [ ] Persistence přes simulované session restarty

### 7.3 Stress testy (`test-stress`)
- [ ] Stovky connect / reconnect / lost cyklů
- [ ] Vysoká telemetry load na více bricích simultánně
- [ ] Mnoho simultánních mock briků v discovery (desítky)
- [ ] Rapid subscribe/unsubscribe cycling
- [ ] Command queue pod sustained high load

### 7.4 Panel smoke testy (Playwright)
- [ ] Discovery tab vykreslí správně s mock briky
- [ ] Connect flow vytvoří brick tab
- [ ] Tab switching aktualizuje foreground brik
- [ ] Config mode otevře a edity fungují
- [ ] Disconnect odstraní brick tab
- [ ] Favorite toggle se uloží

### 7.5 Performance checkpoints
- [ ] Extension activation time measurement
- [ ] Telemetry latency pod normální a vysokou zátěží
- [ ] UI responsiveness při concurrent telemetry
- [ ] Memory usage přes extended sessions
- [ ] Discovery list rendering výkon s desítkami položek

### 7.6 Diagnostika a observability
- [ ] Telemetry speed diagnostic display v panelu
- [ ] Logging strategy (structured logs, log levels)
- [ ] Debug commands v Command Palette

### 7.7 Release checklist
- [ ] Minimum validation set: `compile` → `lint` → `test-smoke` (po každé změně)
- [ ] Full test suite: unit + host + integration + stress (pravidelně)
- [ ] Performance review cadence
- [ ] Refactoring a coverage improvement cycle
- [ ] VSIX packaging a manuální validace
- [ ] Documentation update checklist

## Definition of Done

- Změny jsou automaticky verifikovatelné
- Hlavní lifecycle flows pokryty testy
- Stress testy potvrzují stabilitu pod vysokou zátěží
- Jasná operační disciplína
- Release checklist dokumentovaný a dodržovaný
- Antipattern cleanup

## Minimum validation set

```
Po každé změně:
  1. npm run compile
  2. npm run lint
  3. npm run test:unit  (nebo test:smoke)

Pravidelně:
  - full tests (unit + host + integration + stress)
  - performance review
  - refactoring + increased coverage
```

## Viz také

- [[fáze/Fáze 6 - Persistence]] — předchozí fáze
- [[Plán implementace]]
