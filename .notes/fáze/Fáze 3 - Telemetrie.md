---
tags:
  - ev3-cockpit
  - fáze
fáze: 3
název: Telemetrie a adaptive throttling
stav: aktuálně
---

# Fáze 3 — Telemetrie a adaptive throttling

**Stav:** ⬜ aktuálně  
**Cíl:** Controlled telemetry architektura pro Cockpit i jiné extensions.

## Úkoly

### 3.1 Telemetry category definitions
- [ ] `ports` — sensor types, motor types, port mapping, measured values
- [ ] `filesystem` — filesystem state relevant to API consumers
- [ ] `system` — firmware version, battery, available transports, BT visibility

### 3.2 Telemetry data models
- [ ] `TelemetrySnapshot` — full state at a point in time for a category
- [ ] `TelemetryEvent` — incremental change within a category
- [ ] Per-port value model (peripheral type, value, unit, timestamp)

### 3.3 Telemetry scheduler
- [ ] Foreground loop — nejrychlejší frekvence, full `ports` + `system`
- [ ] Subscribed loop — per-category, redukovaná frekvence
- [ ] Minimal loop — heartbeat only
- [ ] Mode switching na foreground/background transitions
- [ ] Subscription registry — track which categories are subscribed per brik

### 3.4 Adaptive Throttling
- [ ] Response latency measurement per command
- [ ] Queue depth monitoring z CommandQueue
- [ ] Frequency scaling algorithm (zvýšit interval při růstu latency/depth)
- [ ] Separate throttling per brik (jeden pomalý brik nesmí zpomalit ostatní)
- [ ] Diagnostic output — current telemetry speed observable pro UI

### 3.5 Read model pro aktivní brik
- [ ] `ActiveBrickViewModel` agregace z telemetry snapshots
- [ ] Port state (A–D motory, 1–4 senzory)
- [ ] Peripheral detection a type identification
- [ ] Button state
- [ ] Battery state
- [ ] System info pro config mode

### 3.6 Stale snapshot policy
- [ ] Po skončení subscription: hold last snapshot jako `stale`
- [ ] Konfigurovatelný stale timeout
- [ ] Clear stale data po timeoutu

### 3.7 Unit testy
- [ ] Telemetry scheduler mode switching
- [ ] Adaptive throttling response to latency changes
- [ ] Category subscription add/remove
- [ ] Stale snapshot expiry
- [ ] Read model aggregation
- [ ] Multi-brick concurrent telemetry

## Definition of Done

- Foreground brik má nejrychlejší telemetrii
- Subscribed brik dostává telemetrii jen při aktivní subscription
- Minimal brik: jen heartbeat + reconnect
- Cockpit zůstane responsivní i při concurrent subscriptions
- Adaptive throttling prokazatelně škáluje frekvenci podle zátěže
- Antipattern cleanup

## Telemetrie vs. aktivita (session mode)

```
foreground  → plná data, nejvyšší frekvence
subscribed  → jen požadované kategorie, nižší frekvence
minimal     → heartbeat only, žádná extended telemetrie
none        → po disconnect
```

## Viz také

- [[moduly/Runtime]] — Session Manager, CommandQueue (queue depth)
- [[moduly/Contracts]] — TelemetryCategory, ActivityMode enums
- [[koncepty/Firmware Safety]] — throttling nesmí obejít rate limit
- [[fáze/Fáze 2 - Session runtime]] — předchozí fáze
- [[fáze/Fáze 4 - Public API]] — navazující fáze
- [[Plán implementace]]
