---
topic: Runtime
last_compiled: 2026-04-13
status: active
---

# Runtime

## Purpose [coverage: high — 7 sources]

The `src/runtime/` module is the central coordination layer of EVƎ Cockpit. It manages the lifecycle of connected brick sessions (connect, disconnect, heartbeat, reconnect), unified discovery (aggregating results from all transport providers), foreground/background switching, and command dispatch. The runtime is the single source of truth for connection state — the webview and public API are strictly read-only consumers.

## Architecture [coverage: high — 7 sources]

Six classes, re-exported via `index.ts`:

- **SessionManager** — central coordinator for all connected brick sessions. Manages connect/disconnect flows, foreground switching (at most one `ActivityMode.Foreground`), command dispatch via per-brick queues, heartbeat monitoring, and automatic reconnect with exponential backoff. Owns a `Map<BrickKey, SessionResources>` where each entry bundles `SessionEntry`, `CommandQueue`, `HeartbeatMonitor`, and `ReconnectStrategy`.

- **PresenceAggregator** — unifies discovery output from the `DiscoveryScheduler` with remembered bricks from persistence into a single, stably-ordered discovery list. Uses `TRANSPORT_ORDER` (Mock=0, USB=1, TCP=2, BT=3) for primary sorting, then signal strength descending, then brickKey lexicographic. Maintains a sorted cache that's invalidated on any mutation. Exposes `onListChanged` and `onPresenceChanged` events.

- **DiscoveryScheduler** — drives periodic discovery polling across all registered transport providers. Manages per-brick state machines (`available` → `unavailable` → `removed`), emits `onPresenceChanged` and `onScanCompleted` events. Supports `start()`, `stop()`, `scanOnce()`.

- **SessionEntry** — data holder for one connected session. Tracks `brickKey`, `transport`, `displayName`, `connectionState`, `activeMode`, `heartbeatState`, `lastError`, `subscribedCategories`, `explicitlyDisconnected`. Provides `transition()` for state machine enforcement and `toConnectedSession()` for snapshot generation.

- **CommandQueue** — per-brick FIFO command queue with executor pattern. `send(command)` enqueues and resolves when the executor completes. `drainWith(error)` rejects all pending promises on disconnect. Tracks queue depth for future adaptive throttling (Phase 3).

- **HeartbeatMonitor** — periodic heartbeat probe per connected session. Configurable interval and miss threshold. Calls `probe()` (typically `send({ kind: 'battery' })`) and fires `onSuccess`/`onFailure` callbacks.

- **ReconnectStrategy** — exponential backoff calculator. `nextDelay()` returns the next wait time or `undefined` when `maxAttempts` is exhausted. `reset()` after successful reconnect.

## Talks To [coverage: high — 6 sources]

- **transports/ProviderRegistry** — `SessionManager` looks up providers for connect/disconnect/send; `DiscoveryScheduler` iterates all providers for discovery polling
- **contracts/** — uses all enums, `BrickKey`, `DiscoveryItem`, `ConnectedSession`, `BrickCommand`/`BrickResponse`
- **events/** — `PresenceAggregator` uses `createTypedEvent`; `SessionManager` uses `vscode.EventEmitter` directly
- **extension.ts** — instantiates `SessionManager`, `DiscoveryScheduler`, `PresenceAggregator`; subscribes to events for logging

## API Surface [coverage: high — 7 sources]

**SessionManager:**
| Method | Description |
|--------|-------------|
| `connect(brickKey, transport, displayName?)` | Connect to a brick via specified transport |
| `disconnect(brickKey, explicit?)` | Disconnect; explicit=true suppresses auto-reconnect |
| `send(brickKey, command)` | Send command via per-brick queue |
| `setActiveBrick(brickKey)` | Promote to foreground (demotes previous) |
| `clearActiveBrick()` | No foreground brick |
| `getActiveBrickKey()` | Current foreground brick or undefined |
| `getSession(brickKey)` | Snapshot of one session |
| `getAllSessions()` | Snapshot of all sessions |
| `isSuppressed(brickKey)` | Check auto-connect suppression |
| `onSessionStateChange` | Event: connection state transitions |
| `onActiveBrickChange` | Event: foreground brick switches |

**PresenceAggregator:**
| Method | Description |
|--------|-------------|
| `getDiscoveryList()` | Stably-ordered discovery list |
| `getBrick(brickKey)` | Single brick lookup |
| `mergeRemembered(items)` | Import remembered bricks from persistence |
| `updateBrick(brickKey, patch)` | Patch connected/favorite/remembered flags |
| `onListChanged` | Event: any list mutation |
| `onPresenceChanged` | Event: individual presence transitions |

**DiscoveryScheduler:** `start()`, `stop()`, `scanOnce()`, `getTrackedBricks()`, `onPresenceChanged`, `onScanCompleted`.

## Data [coverage: high — 5 sources]

`SessionResources` per brick: `{ entry: SessionEntry, commandQueue: CommandQueue, heartbeat: HeartbeatMonitor, reconnect: ReconnectStrategy, reconnectTimer?: NodeJS.Timeout }`.

Default configuration values (from `FIRMWARE_SAFETY` constants): heartbeat interval, miss threshold=2, reconnect base/max delays, max reconnect attempts.

## Key Decisions [coverage: high — 5 sources]

- **Session Manager is the exclusive session owner** — only Cockpit can trigger connect/disconnect. The public API is read-only for session state.
- **Per-brick command queue** — shared across all transport providers for the same brick, preventing conflicts between transport layers.
- **Auto-connect suppression** — after explicit disconnect, the brick is added to `suppressedBricks` set to prevent auto-reconnect from favorites for the rest of the session.
- **Reconnect vs explicit disconnect precedence** — explicit disconnect always wins. During reconnect backoff, if `explicitlyDisconnected` becomes true, reconnect is aborted.
- **Heartbeat uses battery command** — the battery query is lightweight and serves double duty: keep-alive probe and battery level monitoring.

## Gotchas [coverage: medium — 3 sources]

- **Reconnect timer uses `.unref()`** — prevents the timer from keeping the Node.js event loop alive, allowing clean extension deactivation.
- **Demoted brick gets `Subscribed` mode, not `Minimal`** — when a foreground brick is demoted, it transitions to `Subscribed`, not `Minimal`, even if no subscriptions exist. This may change with Phase 3 telemetry implementation.
- **`drainWith(error)` on disconnect** — all pending command promises are rejected when a session disconnects, ensuring no promises hang indefinitely.

## Sources

- [src/runtime/index.ts](../../src/runtime/index.ts)
- [src/runtime/sessionManager.ts](../../src/runtime/sessionManager.ts)
- [src/runtime/presenceAggregator.ts](../../src/runtime/presenceAggregator.ts)
- [src/runtime/discoveryScheduler.ts](../../src/runtime/discoveryScheduler.ts)
- [src/runtime/sessionEntry.ts](../../src/runtime/sessionEntry.ts)
- [src/runtime/commandQueue.ts](../../src/runtime/commandQueue.ts)
- [src/runtime/heartbeatMonitor.ts](../../src/runtime/heartbeatMonitor.ts)
- [src/runtime/reconnectStrategy.ts](../../src/runtime/reconnectStrategy.ts)
