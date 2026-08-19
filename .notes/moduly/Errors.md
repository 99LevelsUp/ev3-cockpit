---
tags:
  - ev3-cockpit
  - modul
modul: errors
složka: src/errors/
stav: hotovo
---

# Errors

**Složka:** `src/errors/`  
**Účel:** Typovaný chybový model s hierarchií error kódů.

## Klíčové soubory

- [[src/errors/index.ts]] — export hierarchie + error kódů

## Hierarchie

```
CockpitError (base)
├── TransportError     — chyby na úrovni transport adaptéru
│   ├── ConnectionError  — nepodařilo se připojit
│   └── TimeoutError     — timeout při čekání na odpověď
├── SessionError       — chyby session lifecycle
│   └── HeartbeatError   — heartbeat selhal
└── ApiError
    ├── ConsumerError    — consumer registrace nebo lifecycle
    └── SubscriptionError — telemetry subscription chyba
```

## CockpitError

Bázová třída pro všechny chyby v projektu:

```typescript
class CockpitError extends Error {
  readonly code: ErrorCode;
  readonly context?: Record<string, unknown>;
}
```

- Každá chyba má typovaný `ErrorCode` enum
- `context` může obsahovat diagnostická data (brickKey, transport, …)
- Propaguje se přes CommandQueue — rejected promises při disconnect

## Použití

- `ConnectedSession.lastError?` drží poslední chybu session
- `CommandQueue.drainWith(error)` — rejected všechny pending promises s chybou při disconnect
- Transport providery hážou TypedError na I/O selhání

## Viz také

- [[moduly/Contracts]] — ConnectedSession.lastError
- [[moduly/Runtime]] — CommandQueue, SessionEntry
- [[fáze/Fáze 0 - Základ]] — kdy bylo implementováno
