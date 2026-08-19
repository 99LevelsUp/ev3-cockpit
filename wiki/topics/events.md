---
topic: Events
last_compiled: 2026-04-13
status: active
---

# Events

## Purpose [coverage: high — 2 sources]

The `src/events/` module provides two foundational utilities used throughout the codebase: `TypedEvent<T>` (a strongly-typed wrapper around VS Code's `EventEmitter`) and `DisposableStore` (a lifecycle container that collects disposables and releases them in reverse order).

## Architecture [coverage: high — 2 sources]

Single file `index.ts` with two exports:

- **`TypedEvent<T>`** — interface + factory function `createTypedEvent<T>()`. Wraps `vscode.EventEmitter<T>` and exposes `.event` (for consumers to subscribe), `.fire(data)` (for producers to emit), and `.dispose()`.
- **`DisposableStore`** — collects `vscode.Disposable` items via `.add()`, disposes them all in reverse order on `.dispose()`. Used in `extension.ts activate()` as the central service registry.

## Talks To [coverage: high — 5 sources]

- **extension.ts** — creates a `DisposableStore` as the service registry; all services are registered via `.add()`
- **runtime/presenceAggregator.ts** — uses `createTypedEvent` for `listChanged` and `presenceChanged` events
- **runtime/discoveryScheduler.ts** — uses `createTypedEvent` for presence change and scan completion events
- **runtime/sessionManager.ts** — uses `vscode.EventEmitter` directly (same pattern, without the wrapper)

## API Surface [coverage: high — 2 sources]

| Export | Description |
|--------|-------------|
| `TypedEvent<T>` | Interface: `event`, `fire(data)`, `dispose()` |
| `createTypedEvent<T>()` | Factory function creating a `TypedEvent<T>` |
| `DisposableStore` | Container: `add(item)`, `dispose()` |

## Data [coverage: low — 0 sources]

No persistent data. `DisposableStore` maintains an in-memory array of disposables.

## Key Decisions [coverage: medium — 1 source]

- **Reverse-order disposal** — `DisposableStore.dispose()` releases items in LIFO order, ensuring dependent services are torn down before their dependencies.
- **Thin wrapper over VS Code API** — `TypedEvent` does not add behavior beyond type safety; it delegates entirely to `vscode.EventEmitter`.

## Gotchas [coverage: low — 1 source]

- `DisposableStore.dispose()` uses `splice(0)` to atomically take ownership of the array, preventing double-dispose issues if called concurrently.

## Sources

- [src/events/index.ts](../../src/events/index.ts)
- [src/extension.ts](../../src/extension.ts)
