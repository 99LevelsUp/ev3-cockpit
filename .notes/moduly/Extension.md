---
tags:
  - ev3-cockpit
  - modul
modul: extension
soubor: src/extension.ts
stav: hotovo
---

# Extension

**Soubor:** [[src/extension.ts]]  
**Účel:** Vstupní bod VS Code extension. `activate()` drátuje všechny služby dohromady, `deactivate()` je čistě dispose.

## Composition root

`activate()` je composition root — jediné místo, kde se instantiují a propojují všechny vrstvy:

```typescript
export function activate(ctx: vscode.ExtensionContext): CockpitApi {
  const store = new DisposableStore();

  // 1. Infrastructure
  const logger = store.add(new OutputChannelLogger('EVƎ Cockpit'));
  const registry = store.add(new ProviderRegistry());

  // 2. Transport providers
  store.add(registry.register(new MockTransportProvider(...)));
  store.add(registry.register(new UsbTransportProvider(logger)));
  store.add(registry.register(new TcpTransportProvider(logger)));
  store.add(registry.register(new BtTransportProvider(logger)));

  // 3. Runtime
  const aggregator = store.add(new PresenceAggregator());
  const scheduler = store.add(new DiscoveryScheduler(registry, aggregator, logger));
  const sessionManager = store.add(new SessionManager(registry, logger));

  // 4. Spuštění
  scheduler.start();

  // 5. VS Code lifecycle
  ctx.subscriptions.push(store);

  // 6. Return public API (Phase 4+)
  return buildApi(sessionManager, aggregator);
}

export function deactivate(): void {
  // Vše cleanup přes DisposableStore v ctx.subscriptions
}
```

## Pořadí cleanup (LIFO)

DisposableStore dispose v opačném pořadí → scheduler se stopne před tím, než se odregistrují providery → žádný dangling callback.

## Logging

`OutputChannelLogger` zapisuje do VS Code Output Channel "EVƎ Cockpit" — viditelný v Output tabu editoru.

## Co extension exportuje

Aktuálně (Phase 0–2): základní internal API  
Phase 4+: plný `CockpitApi` objekt pro cizí extensions

```typescript
// Cizí extension:
const api = vscode.extensions.getExtension('99LevelsUp.ev3-cockpit')?.exports;
```

## Viz také

- [[moduly/Events]] — DisposableStore lifecycle
- [[moduly/Runtime]] — SessionManager, PresenceAggregator, DiscoveryScheduler
- [[moduly/Transports]] — ProviderRegistry, všechny providery
- [[moduly/Mock]] — MockTransportProvider
- [[fáze/Fáze 0 - Základ]] §0.8 — composition root skeleton
- [[fáze/Fáze 4 - Public API]] §4.7 — API export
