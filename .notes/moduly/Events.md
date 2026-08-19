---
tags:
  - ev3-cockpit
  - modul
modul: events
složka: src/events/
stav: hotovo
---

# Events

**Složka:** `src/events/`  
**Účel:** Typovaná event infrastruktura a disposable lifecycle pattern kompatibilní s VS Code API.

## Klíčové soubory

- [[src/events/index.ts]] — TypedEvent, DisposableStore

## TypedEvent

Typovaný wrapper nad VS Code `EventEmitter` vzorem:

```typescript
// Vytvoření eventu
const { event, fire, dispose } = createTypedEvent<T>();

// Subscription
const sub = event(handler);  // vrací vscode.Disposable

// Emit
fire(payload);
```

- Plně type-safe — handler dostane správný typ
- Kompatibilní s `vscode.EventEmitter` API
- Automatický cleanup přes Disposable

## DisposableStore

Kolekce disposable objektů s lifecycle managementem:

```typescript
const store = new DisposableStore();
store.add(someDisposable);
store.add(event(handler));

// Cleanup
store.dispose();  // dispose všechno v opačném pořadí
```

- Reverse-order teardown (LIFO)
- Používá se v `activate()` / `deactivate()` v [[src/extension.ts]]
- Používají ho SessionManager, PresenceAggregator a další runtime komponenty

## Lifecycle pattern v extension.ts

```typescript
export function activate(ctx: vscode.ExtensionContext) {
  const store = new DisposableStore();
  
  const sessionManager = store.add(new SessionManager(...));
  const scheduler = store.add(new DiscoveryScheduler(...));
  // ...
  
  ctx.subscriptions.push(store);
}
```

## Viz také

- [[moduly/Contracts]] — events používají typy z contracts
- [[moduly/Runtime]] — PresenceAggregator, SessionManager používají TypedEvent
- [[moduly/Extension]] — DisposableStore v activate()
- [[fáze/Fáze 0 - Základ]] — kdy bylo implementováno
