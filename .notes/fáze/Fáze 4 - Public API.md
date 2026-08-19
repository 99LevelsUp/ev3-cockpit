---
tags:
  - ev3-cockpit
  - fáze
fáze: 4
název: Public API a filesystem
stav: plánováno
---

# Fáze 4 — Public API a filesystem services

**Stav:** ⬜ plánováno  
**Cíl:** Stable API pro jiné extensions bez přímého přístupu k fyzickému lifecycle.

## Úkoly

### 4.1 API surface type definitions
- [ ] `ConnectedBrickSnapshot` — veřejná reprezentace připojeného briku
- [ ] `BrickStateChangeEvent` — state transition event pro consumery
- [ ] `ActiveBrickSnapshot` — aktuálně aktivní brik nebo null
- [ ] `TelemetrySnapshot` (API verze) — category-specific data snapshot
- [ ] `TelemetryEvent` (API verze) — incremental telemetry update
- [ ] `FilesystemEvent` — filesystem operation result

### 4.2 Consumer registrace
- [ ] `registerConsumer(name)` → consumer handle
- [ ] `unregisterConsumer(handle)` → cleanup všech subscriptions
- [ ] Consumer lifecycle management — auto-cleanup při deaktivaci extension

### 4.3 State query methods
- [ ] `getConnectedBricks()` — snapshot všech connected sessions
- [ ] `getActiveBrick()` — aktuálně aktivní brik nebo null

### 4.4 Event subscriptions
- [ ] `onBrickStateChanged(callback)` — session state changes
- [ ] `onActiveBrickChanged(callback)` — active brick switching
- [ ] Disposable pattern pro všechny subscriptions

### 4.5 Telemetrie subscriptions
- [ ] `subscribeTelemetry(brickKey, category)` → subscription
- [ ] Initial snapshot delivery před events
- [ ] `unsubscribeTelemetry(subscriptionId)` — cancel subscription
- [ ] Auto-cancel po brick disconnect
- [ ] Integrace s telemetry scheduler mode transitions

### 4.6 Filesystem services
- [ ] `uploadFile(brickKey, localPath, remotePath)`
- [ ] `downloadFile(brickKey, remotePath, localPath)`
- [ ] `executeRbf(brickKey, remotePath)` — spustit program na briku
- [ ] `listFiles(brickKey, remotePath)` — seznam souborů
- [ ] `readFile(brickKey, remotePath)` — obsah souboru
- [ ] Error handling pro unavailable briky nebo failed operace

### 4.7 API export
- [ ] Export typed API z `extension.ts` `activate()` return value
- [ ] API plně inicializované před prvním consumerem
- [ ] Versioned API object (budoucí backward compatibility)

### 4.8 Integration testy
- [ ] Mock consumer registruje + dostává snapshot
- [ ] Mock consumer dostává state change events
- [ ] Telemetry subscription lifecycle
- [ ] Filesystem operace vs. mock transport
- [ ] Consumer cleanup při unregister
- [ ] Multi-consumer concurrent access

## Explicitně NENÍ v této fázi

- `connect` / `disconnect` v public API
- File explorer GUI
- Full-folder deploy workflow

## Definition of Done

- Cizí extension se může registrovat jako consumer
- Dostane snapshot připojených briků
- Dostává state change events
- Může vytvořit telemetry subscription
- Může používat základní filesystem API
- Antipattern cleanup

## Integrace cizí extension

```typescript
// V cizí extension:
const cockpit = vscode.extensions.getExtension('ev3-cockpit')?.exports;
const consumer = cockpit.registerConsumer('my-extension');
const bricks = await cockpit.getConnectedBricks();
cockpit.onBrickStateChanged(ev => { /* ... */ });
const sub = cockpit.subscribeTelemetry(brickKey, 'ports');
```

## Viz také

- [[moduly/Contracts]] — API type definitions
- [[fáze/Fáze 3 - Telemetrie]] — předchozí fáze
- [[fáze/Fáze 5 - Cockpit panel]] — navazující fáze
- [[Plán implementace]]
