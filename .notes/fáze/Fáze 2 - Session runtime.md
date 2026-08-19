---
tags:
  - ev3-cockpit
  - fáze
fáze: 2
název: Session runtime
stav: hotovo
---

# Fáze 2 — Session runtime

**Stav:** ✅ hotovo  
**Cíl:** Zdroj pravdy pro připojené briky.

## Hotové úkoly

- [x] **2.1 Session data model** — `ConnectedSession` implementace, session identity (brickKey + transport), metadata (displayName, lastError, heartbeatState)
- [x] **2.2 Session Manager** — session store (Map aktivních sessions), `connect()` flow, `disconnect()` flow, state machine enforcement (`connecting → connected → reconnecting → disconnected`), guard (jen Cockpit UI může triggerovat connect/disconnect), event emission
- [x] **2.3 Foreground / background switching** — `setActiveBrick()`, `clearActiveBrick()`, activity mode transitions (`foreground ↔ subscribed ↔ minimal`), invariant: nejvýše jeden foreground
- [x] **2.4 Heartbeat** — periodic loop per session, konfigurovatelný interval, timeout → `reconnecting`, heartbeat state tracking
- [x] **2.5 Reconnect logic** — automatický reconnect po transport failure, exponential backoff, max retry count / timeout, přechod do `disconnected` při permanent failure, explicit disconnect má přednost
- [x] **2.6 Command queue per brik** — FIFO fronta, shared across providers pro stejný brik, queue depth tracking (pro Phase 3 throttling), drain on disconnect
- [x] **2.7 Auto-connect suppression** — tracking explicit disconnect per brik v session, suppress auto-connect, reset na novou VS Code session
- [x] **2.8 Unit testy** — state machine transitions, connect/disconnect lifecycle (Mock), multi-brick concurrent sessions, foreground switching, heartbeat timeout + reconnect, explicit disconnect vs reconnect precedence, command queue ordering + drain

## Definition of Done

- Více briků lze připojit simultánně
- Přepnutí aktivního briku neruší ostatní session
- Reconnect jednoho briku nenarušuje ostatní
- Explicit disconnect čistě ukončí všechny subscriptions
- Všechny state transitions pokryty testy

## Klíčové soubory

- [[src/runtime/sessionManager.ts]] — SessionManager, hlavní koordinátor
- [[src/runtime/sessionEntry.ts]] — SessionEntry, data holder + state machine
- [[src/runtime/commandQueue.ts]] — CommandQueue, FIFO per brik
- [[src/runtime/heartbeatMonitor.ts]] — HeartbeatMonitor, periodic probe
- [[src/runtime/reconnectStrategy.ts]] — ReconnectStrategy, exponential backoff

## Viz také

- [[moduly/Runtime]]
- [[koncepty/Presence State Machine]]
- [[fáze/Fáze 3 - Telemetrie]] — další fáze
- [[Plán implementace]]
