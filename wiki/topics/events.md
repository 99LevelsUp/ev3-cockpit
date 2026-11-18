---
topic: Events
last_compiled: 2026-11-18
status: active
---

# Events

## Purpose [coverage: high — 3 sources]

The `src/core/events/` module gives the core its own event primitives, so it runs without VS Code: `EventEmitter`, `Event` and `Disposable`, the `TypedEvent<T>` wrapper over them, `DisposableStore` (a lifecycle container that releases disposables in reverse order) and `setListenerErrorHandler`.

## Architecture [coverage: high — 3 sources]

Single file `index.ts`:

- **`EventEmitter<T>`** — delivers as VS Code's `EventEmitter` does, observed on the real one: a listener that throws does not stop the others; a listener added during a fire first hears the next one; a listener removed during a fire, or every listener once the emitter is disposed, is not called again in that fire; a fire from inside a listener first finishes the fire in progress, then delivers its own event, all before it returns. `Event<T>` keeps VS Code's call shape (listener, optional `this`, optional disposables collection).
- **`setListenerErrorHandler`** — where a listener's error goes: the console by default. The unit-test preload replaces it with a recorder that fails the running test.
- **`TypedEvent<T>`** / **`createTypedEvent<T>()`** — `.event`, `.fire(data)`, `.dispose()` over the core's emitter.
- **`DisposableStore`** — collects disposables via `.add()`, disposes them in reverse order. Used in `extension.ts activate()` as the central service registry; it holds VS Code disposables too, since a `Disposable` is only `dispose()`.

## Talks To [coverage: high — 5 sources]

- **extension.ts** — creates a `DisposableStore` as the service registry
- **runtime/** and **telemetry/** — `SessionManager`, `BrickManager`, `TelemetryService`, `TelemetryReadModel` use `EventEmitter` directly; `PresenceAggregator` and `DiscoveryScheduler` use `createTypedEvent`
- **transports/providerRegistry.ts** — `EventEmitter` for provider registration

## API Surface [coverage: high — 2 sources]

| Export | Description |
|--------|-------------|
| `EventEmitter<T>` | `event`, `fire(data)`, `dispose()` |
| `Event<T>` / `Disposable` | VS Code's shapes, without VS Code |
| `setListenerErrorHandler(handler)` | Replaces the listener-error handler; returns the previous one |
| `TypedEvent<T>`, `createTypedEvent<T>()` | Wrapper over the emitter |
| `DisposableStore` | Container: `add(item)`, `dispose()` |

## Key Decisions [coverage: high — 2 sources]

- **Own emitter, characterized against VS Code's** (plan `docs/plans/2026-11-18-1008-refactor-core-without-vscode-plan.md`) — the scenarios in `src/test/emitterScenarios.ts` run against VS Code's emitter in the extension host and against the core's, compared live; the unit suite checks the core's against the recording.
- **Reverse-order disposal** — `DisposableStore.dispose()` releases items in LIFO order.

## Gotchas [coverage: medium — 1 source]

- A disposed subscription, or every subscription of a disposed emitter, drops its listener and its way back to the emitter, so a handle kept afterwards holds neither.
- The unit suite used to run core events on the `vscode` stub, which rethrew a listener's error; production never did. Since the switch, an assertion inside a listener fails its test only because the preload's recorder does so.

## Sources

- [src/core/events/index.ts](../../src/core/events/index.ts)
- [src/test/emitterScenarios.ts](../../src/test/emitterScenarios.ts)
- [src/vscode/extension.ts](../../src/vscode/extension.ts)
