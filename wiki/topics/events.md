---
topic: Events
last_compiled: 2026-11-23
status: active
---

# Events

## Purpose [coverage: high — 3 sources]

`src/vscode/events.ts` is the extension's own event emitter. The parts of the extension that are free of `vscode` (the daemon bridge and the command flows, tested in plain Node) fire their events through it, and it delivers as VS Code's `EventEmitter` does. Events across the process boundary are the daemon's notifications ([daemon](daemon.md)), not this.

## Architecture [coverage: high — 3 sources]

Single file, four exports:

- **`EventEmitter<T>`** — `event`, `fire(data)`, `dispose()`. Delivers as VS Code's does, observed on the real one: a listener that throws does not stop the others; a listener added during a fire first hears the next one; a listener removed during a fire, or every listener once the emitter is disposed, is not called again in that fire; a fire from inside a listener first finishes the fire in progress, then delivers its own, all before it returns.
- **`Event<T>`** — VS Code's call shape (listener, optional `this`, optional disposables collection), so an event can be handed to a VS Code API that expects one.
- **`Disposable`** — anything with `dispose()`.
- **`setListenerErrorHandler`** — where a listener's error goes: the console by default. Returns the previous handler.

## Talks To [coverage: high — 3 sources]

- **`src/vscode/daemonBridge.ts`**, **`src/vscode/ui/commandTypes.ts`** — fire their events through it.
- **`src/vscode/integration/`** — the host suite compares it with VS Code's emitter live.
- **`scripts/test-setup`** — the unit-test preload installs a listener-error handler that fails the running test.

## Key Decisions [coverage: high — 2 sources]

- **Own emitter, characterized against VS Code's** — the scenarios in `src/test/emitterScenarios.ts` run against both; the unit suite checks against a recording, the host suite compares live.

## Gotchas [coverage: medium — 1 source]

- A disposed subscription, or every subscription of a disposed emitter, drops its listener and its way back to the emitter, so a handle kept afterwards holds neither.
- An assertion inside a listener fails its test only because the preload's recorder does so; production sends the error to the console.

## Sources

- [src/vscode/events.ts](../../src/vscode/events.ts)
- [src/test/emitterScenarios.ts](../../src/test/emitterScenarios.ts)
- [src/vscode/daemonBridge.ts](../../src/vscode/daemonBridge.ts)
