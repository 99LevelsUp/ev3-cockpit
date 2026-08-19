---
tags:
  - ev3-cockpit
  - modul
modul: runtime
složka: src/runtime/
stav: hotovo
---

# Runtime

**Složka:** `src/runtime/`  
**Účel:** Centrální koordinační vrstva — lifecycle připojených sessions, unified discovery, foreground/background switching, command dispatch. **Zdroj pravdy** pro connection state.

## Klíčové soubory

| Soubor | Třída | Účel |
| ------ | ----- | ---- |
| [[src/runtime/index.ts]] | — | export |
| [[src/runtime/sessionManager.ts]] | `SessionManager` | hlavní koordinátor |
| [[src/runtime/presenceAggregator.ts]] | `PresenceAggregator` | unified discovery list |
| [[src/runtime/discoveryScheduler.ts]] | `DiscoveryScheduler` | polling loop |
| [[src/runtime/sessionEntry.ts]] | `SessionEntry` | data holder + state machine |
| [[src/runtime/commandQueue.ts]] | `CommandQueue` | per-brick FIFO fronta |
| [[src/runtime/heartbeatMonitor.ts]] | `HeartbeatMonitor` | periodic probe |
| [[src/runtime/reconnectStrategy.ts]] | `ReconnectStrategy` | exponential backoff |

## SessionManager

Hlavní koordinátor. Owns `Map<BrickKey, SessionResources>`.

```typescript
// SessionResources per brik:
{
  entry: SessionEntry,
  commandQueue: CommandQueue,
  heartbeat: HeartbeatMonitor,
  reconnect: ReconnectStrategy,
  reconnectTimer?: NodeJS.Timeout,  // .unref() — nedrží event loop
}
```

**API:**

| Metoda | Popis |
| ------ | ----- |
| `connect(brickKey, transport, displayName?)` | Připojí brik přes specified transport |
| `disconnect(brickKey, explicit?)` | Odpojí; `explicit=true` potlačí auto-reconnect |
| `send(brickKey, command)` | Odešle command přes per-brick queue |
| `setActiveBrick(brickKey)` | Promote to foreground (demotuje předchozí) |
| `clearActiveBrick()` | Žádný foreground brik |
| `getActiveBrickKey()` | Aktuální foreground nebo undefined |
| `getSession(brickKey)` | Snapshot jedné session |
| `getAllSessions()` | Snapshot všech sessions |
| `isSuppressed(brickKey)` | Check auto-connect suppression |
| `onSessionStateChange` | Event: state transitions |
| `onActiveBrickChange` | Event: foreground switching |

## PresenceAggregator

Sloučí výstup z `DiscoveryScheduler` a persisted remembered briků do jediného, stabilně seřazeného discovery listu.

**Řazení:** `TRANSPORT_ORDER` (Mock=0, USB=1, TCP=2, BT=3) → signal strength desc → brickKey lexicographic

**API:** `getDiscoveryList()` · `getBrick(brickKey)` · `mergeRemembered(items)` · `updateBrick(brickKey, patch)` · `onListChanged` · `onPresenceChanged`

## DiscoveryScheduler

Periodic polling přes všechny registrované transport providery. Per-brick state machine: `available → unavailable → removed`.

**API:** `start()` · `stop()` · `scanOnce()` · `getTrackedBricks()` · `onPresenceChanged` · `onScanCompleted`

## SessionEntry

Data holder pro jednu connected session:
- `brickKey`, `transport`, `displayName`
- `connectionState`, `activeMode`, `heartbeatState`
- `lastError`, `subscribedCategories`, `explicitlyDisconnected`
- `transition()` — state machine enforcement
- `toConnectedSession()` — snapshot generation

## CommandQueue

Per-brick FIFO fronta s executor pattern:
- `send(command)` — enqueue + resolve až executor dokončí
- `drainWith(error)` — reject všechny pending promises při disconnect
- Tracks queue depth (pro Phase 3 adaptive throttling)

## HeartbeatMonitor

Periodic heartbeat probe per session:
- Konfigurabilní interval + miss threshold
- `probe()` = typicky `send({ kind: 'battery' })` — dual purpose (keepalive + battery monitoring)
- Callbacks: `onSuccess` / `onFailure`

## ReconnectStrategy

Exponential backoff kalkulátor:
- `nextDelay()` → next wait time nebo `undefined` (max attempts vyčerpány)
- `reset()` po úspěšném reconnectu

## Klíčová rozhodnutí

> [!important] SessionManager je exkluzivní vlastník session lifecycle
> Jen Cockpit může triggerovat connect/disconnect. Public API je read-only.

- **Per-brick command queue** — sdílená přes všechny transport providery pro stejný brik
- **Auto-connect suppression** — po explicit disconnect → `suppressedBricks` set, reset na novou session
- **Reconnect timer `.unref()`** — nedrží Node.js event loop → čistý deactivate
- **Demoted brik dostane `Subscribed` mode** — ne `Minimal` (může se změnit v Phase 3)

## Viz také

- [[moduly/Transports]] — ProviderRegistry, kterou SessionManager používá
- [[moduly/Contracts]] — enums, BrickKey, DiscoveryItem, ConnectedSession
- [[moduly/Events]] — TypedEvent pro events
- [[koncepty/Presence State Machine]] — presence state transitions
- [[koncepty/Firmware Safety]] — rate limiting nad command queue
- [[fáze/Fáze 2 - Session runtime]] — kdy bylo implementováno
- [[fáze/Fáze 3 - Telemetrie]] — Phase 3 rozšíří SessionManager o telemetry
