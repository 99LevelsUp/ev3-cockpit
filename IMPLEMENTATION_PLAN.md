# EVƎ Cockpit - Implementation Plan

> Version: 2026-04-02
> Repository state: after cleanup, only documentation remains; implementation starts fresh from scratch

This document translates `REQUIREMENTS.md` and `DESIGN.md` into a concrete implementation order.

## 1. Implementation Principles

- implementation proceeds from runtime and contracts toward UI,
- the Cockpit panel is built only on top of a finished runtime model,
- physical connect/disconnect stays exclusively in Cockpit,
- mock is implemented early, as it will be used for debugging all other layers,
- filesystem is built in the first version as a service and API, not as a GUI explorer.

## 2. Current Starting State

Phase 0 is complete. All foundation work is done; implementation of Phase 1 starts from here.

- extension skeleton ✅
- build and lint pipeline ✅
- test runner infrastructure ✅
- base folder structure (`src/contracts/`, etc.) ✅
- shared contracts, error model, and event infrastructure ✅
- implementation of transports, runtime, API, and UI ⬜ starts in Phase 1

## 3. Phase Overview

| Phase | Name | Status |
| :--- | :--- | :--- |
| 0 | Project foundation and contracts | ✅ done |
| 1 | Transport contracts and discovery | 🔄 in progress |
| 2 | Session runtime and lifecycle | ⬜ planned |
| 3 | Telemetry and adaptive throttling | ⬜ planned |
| 4 | Public API and filesystem services | ⬜ planned |
| 5 | Cockpit panel and UX | ⬜ planned |
| 6 | Persistence, favorites, and remembered devices | ⬜ planned |
| 7 | Hardening, tests, and release discipline | ⬜ planned |

## 4. Phase 0 — Project Foundation and Contracts

### Goal

Create a clean technical foundation on which further implementations can be layered.

### Tasks

- [x] **0.1 Extension skeleton**
  - [x] 0.1.1 `package.json` with metadata, scripts, and dependencies
  - [x] 0.1.2 `src/extension.ts` entry point (`activate` / `deactivate`)
  - [x] 0.1.3 `.gitignore`, `.eslintrc.json`
- [x] **0.2 Build pipeline**
  - [x] 0.2.1 TypeScript compilation (`npm run compile`)
  - [x] 0.2.2 ESLint configuration (`npm run lint`)
  - [x] 0.2.3 Watch mode (`npm run watch`)
  - [x] 0.2.4 Production bundle via esbuild (`npm run package`)
  - [x] 0.2.5 VSIX packaging (`npm run package:vsix`)
- [x] **0.3 Test infrastructure**
  - [x] 0.3.1 Node built-in test runner for unit tests (`npm run test:unit`)
  - [x] 0.3.2 VS Code extension host test runner (`npm run test:host`)
  - [x] 0.3.3 CI pipeline script (`npm run test:ci`)
  - [x] 0.3.4 Placeholder Playwright setup (`npm run test:pw:smoke`)
- [x] **0.4 Base folder structure**
  - [x] 0.4.1 `src/contracts/` — shared types and contracts
  - [x] 0.4.2 `src/runtime/` — session manager, presence aggregator
  - [x] 0.4.3 `src/transports/` — transport providers
  - [x] 0.4.4 `src/api/` — public API layer
  - [x] 0.4.5 `src/ui/` — webview panel
  - [x] 0.4.6 `src/mock/` — mock runtime
  - [x] 0.4.7 `src/persistence/` — globalState adapter
  - [x] 0.4.8 `src/test/` — test utilities
- [x] **0.5 Shared type definitions**
  - [x] 0.5.1 `Transport` enum (`mock`, `usb`, `tcp`, `bt`)
  - [x] 0.5.2 `BrickKey` type (branded string per transport)
  - [x] 0.5.3 `PresenceState` enum (`remembered`, `available`, `unavailable`, `removed`)
  - [x] 0.5.4 `ConnectionState` enum (`connecting`, `connected`, `reconnecting`, `disconnected`)
  - [x] 0.5.5 `ActivityMode` enum (`foreground`, `subscribed`, `minimal`, `none`)
  - [x] 0.5.6 `TelemetryCategory` enum (`ports`, `filesystem`, `system`)
  - [x] 0.5.7 `DiscoveryItem` interface (brickKey, displayName, transport, presenceState, etc.)
  - [x] 0.5.8 `ConnectedSession` interface (brickKey, connectionState, activeMode, etc.)
  - [x] 0.5.9 `ActiveBrickViewModel` interface (identity, battery, ports, buttons, etc.)
- [x] **0.6 Error model**
  - [x] 0.6.1 Base `CockpitError` class with error codes
  - [x] 0.6.2 Transport-specific errors (`TransportError`, `ConnectionError`, `TimeoutError`)
  - [x] 0.6.3 Session-specific errors (`SessionError`, `HeartbeatError`)
  - [x] 0.6.4 API errors (`ConsumerError`, `SubscriptionError`)
- [x] **0.7 Event infrastructure**
  - [x] 0.7.1 Typed event emitter (compatible with VS Code `EventEmitter` pattern)
  - [x] 0.7.2 Disposable lifecycle pattern (implement `vscode.Disposable`)
- [x] **0.8 Composition root skeleton**
  - [x] 0.8.1 Service registry pattern or minimal DI container
  - [x] 0.8.2 Wiring in `activate()` — instantiate and connect layers
  - [x] 0.8.3 Cleanup in `deactivate()` — dispose all services

### Definition of Done

- extension activates and deactivates cleanly,
- `npm run compile` and `npm run lint` pass with zero errors,
- shared contracts exist in `src/contracts/` with no dependency on UI or runtime,
- unit tests validate basic type correctness.

## 5. Phase 1 — Transport Contracts and Unified Discovery

### Goal

Design the unified `TransportProvider` contract and apply it to all channels, starting with Mock.

### Tasks

- [x] **1.1 TransportProvider interface**
  - [x] 1.1.1 `discover()` — returns a list of discovered bricks for this transport
  - [x] 1.1.2 `connect(brickKey)` — establishes a connection, returns a session handle
  - [x] 1.1.3 `disconnect(brickKey)` — terminates the connection
  - [x] 1.1.4 `send(brickKey, command)` — sends a command to a connected brick
  - [x] 1.1.5 `recover(brickKey)` — attempts to re-establish a lost connection
  - [x] 1.1.6 `forget(brickKey)` — removes OS-level evidence where applicable (optional)
  - [x] 1.1.7 Transport capability flags (supports forget, supports signal info, etc.)
- [x] **1.2 DiscoveryItem data model**
  - [x] 1.2.1 Implement `DiscoveryItem` from contracts with all required fields
  - [x] 1.2.2 Transport-specific metadata extensions
- [x] **1.3 Provider registry**
  - [x] 1.3.1 Register/unregister transport providers
  - [x] 1.3.2 Enumerate active providers
  - [x] 1.3.3 Lookup provider by transport type
- [x] **1.4 Discovery scheduler**
  - [x] 1.4.1 Periodic polling loop per provider
  - [x] 1.4.2 Configurable scan interval per transport
  - [x] 1.4.3 Deduplication of discovery results
  - [x] 1.4.4 Timeout handling (`available` → `unavailable` after missed scans)
  - [x] 1.4.5 Removal timeout (`unavailable` → `removed` after extended absence)
- [x] **1.5 Presence Aggregator**
  - [x] 1.5.1 Unified discovery model across all providers
  - [x] 1.5.2 State machine per brick: `remembered` / `available` / `unavailable` / `removed`
  - [x] 1.5.3 Merge with remembered bricks from persistence
  - [x] 1.5.4 Stable ordering algorithm (by transport group, then by signal or brickKey)
  - [x] 1.5.5 Event emission on presence state changes
  - [x] 1.5.6 Read model for the discovery list (single observable collection)
- [x] **1.6 Mock Transport**
  - [x] 1.6.1 JSON configuration file schema (brick identity, sensors, motors, dynamics)
  - [x] 1.6.2 Configuration file loading and validation
  - [x] 1.6.3 Mock discovery (enumerate bricks from config)
  - [x] 1.6.4 Mock connect / disconnect
  - [x] 1.6.5 Mock value dynamics (static values, sine/triangle/square oscillators)
  - [x] 1.6.6 Mock error state simulation (configurable failures)
  - [x] 1.6.7 Mock loss and recovery simulation (configurable disappearance/reappearance)
  - [x] 1.6.8 Mock filesystem (in-memory file tree for API testing)
  - [x] 1.6.9 Mock brickKey generation (`mock:<id>` from config)
- [ ] **1.7 USB Transport (initial)**
  - [ ] 1.7.1 Library selection and platform testing (Windows + Linux)
  - [ ] 1.7.2 USB device enumeration for EV3
  - [ ] 1.7.3 Implement `discover()` and `connect()`
  - [ ] 1.7.4 Basic `send()` for command execution
  - [ ] 1.7.5 brickKey from serial number
- [ ] **1.8 TCP Transport (initial)**
  - [ ] 1.8.1 mDNS / network discovery strategy
  - [ ] 1.8.2 TCP socket connection to ev3dev
  - [ ] 1.8.3 Implement `discover()` and `connect()`
  - [ ] 1.8.4 Basic `send()` for command execution
  - [ ] 1.8.5 brickKey from IP address or mDNS hostname
- [ ] **1.9 BT Transport (initial)**
  - [ ] 1.9.1 Library selection and platform testing (Windows + Linux)
  - [ ] 1.9.2 BT device enumeration for EV3
  - [ ] 1.9.3 Implement `discover()` and `connect()`
  - [ ] 1.9.4 Basic `send()` for command execution
  - [ ] 1.9.5 brickKey from MAC address
  - [ ] 1.9.6 Signal strength reporting where available
- [x] **1.10 Unit tests**
  - [x] 1.10.1 TransportProvider contract compliance tests (run against Mock)
  - [x] 1.10.2 Discovery scheduler tests (timing, dedup, timeout)
  - [x] 1.10.3 Presence Aggregator state machine tests
  - [x] 1.10.4 Stable ordering tests
  - [x] 1.10.5 Mock configuration loading tests

### Definition of Done

- runtime can simultaneously display mock and real items,
- the discovery list is stable and correctly ordered,
- mock transport passes all contract compliance tests,
- presence state transitions are fully tested.

## 6. Phase 2 — Session Runtime and Lifecycle

### Goal

Build the source of truth for connected bricks.

### Tasks

- [ ] **2.1 Session data model**
  - [ ] 2.1.1 `ConnectedSession` implementation with all fields from contracts
  - [ ] 2.1.2 Session identity (brickKey + transport pair)
  - [ ] 2.1.3 Session metadata (display name, last error, heartbeat state)
- [ ] **2.2 Session Manager**
  - [ ] 2.2.1 Session store (map of active sessions)
  - [ ] 2.2.2 `connect(brickKey, transport)` flow — create session, call provider, transition states
  - [ ] 2.2.3 `disconnect(brickKey)` flow — cleanup subscriptions, call provider, remove session
  - [ ] 2.2.4 State machine enforcement (`connecting` → `connected` → `reconnecting` → `disconnected`)
  - [ ] 2.2.5 Guard: only Cockpit UI can trigger connect/disconnect
  - [ ] 2.2.6 Event emission on session state changes
- [ ] **2.3 Foreground / background switching**
  - [ ] 2.3.1 `setActiveBrick(brickKey)` — promote to foreground, demote previous
  - [ ] 2.3.2 `clearActiveBrick()` — no brick is foreground (discovery tab shown)
  - [ ] 2.3.3 Activity mode transitions (`foreground` ↔ `subscribed` ↔ `minimal`)
  - [ ] 2.3.4 At most one foreground brick invariant
- [ ] **2.4 Heartbeat**
  - [ ] 2.4.1 Periodic heartbeat loop per connected session
  - [ ] 2.4.2 Configurable heartbeat interval
  - [ ] 2.4.3 Timeout detection — transition to `reconnecting` on missed heartbeats
  - [ ] 2.4.4 Heartbeat state tracking in session model
- [ ] **2.5 Reconnect logic**
  - [ ] 2.5.1 Automatic reconnect on transport failure
  - [ ] 2.5.2 Exponential backoff strategy
  - [ ] 2.5.3 Maximum retry count or timeout
  - [ ] 2.5.4 Transition to `disconnected` on permanent failure
  - [ ] 2.5.5 Explicit disconnect always takes precedence over reconnect
- [ ] **2.6 Command queue per brick**
  - [ ] 2.6.1 FIFO queue implementation
  - [ ] 2.6.2 Shared across all transport providers for the same brick
  - [ ] 2.6.3 Queue depth tracking (for telemetry throttling in Phase 3)
  - [ ] 2.6.4 Queue drain on disconnect
- [ ] **2.7 Auto-connect suppression**
  - [ ] 2.7.1 Track explicit disconnect per brick within the session
  - [ ] 2.7.2 Suppress auto-connect for explicitly disconnected bricks
  - [ ] 2.7.3 Reset suppression on new VS Code session
- [ ] **2.8 Unit tests**
  - [ ] 2.8.1 Session state machine transition tests
  - [ ] 2.8.2 Connect / disconnect lifecycle tests (using Mock)
  - [ ] 2.8.3 Multi-brick concurrent session tests
  - [ ] 2.8.4 Foreground switching tests
  - [ ] 2.8.5 Heartbeat timeout and reconnect tests
  - [ ] 2.8.6 Explicit disconnect vs reconnect precedence tests
  - [ ] 2.8.7 Command queue ordering and drain tests

### Definition of Done

- multiple bricks can be connected simultaneously,
- switching the active brick does not interrupt other sessions,
- reconnecting one brick does not break others,
- explicit disconnect cleanly terminates all subscriptions,
- all state transitions are covered by unit tests.

## 7. Phase 3 — Telemetry and Adaptive Throttling

### Goal

Introduce a controlled telemetry architecture for Cockpit and other extensions.

### Tasks

- [ ] **3.1 Telemetry category definitions**
  - [ ] 3.1.1 `ports` category — sensor types, motor types, port mapping, measured values
  - [ ] 3.1.2 `filesystem` category — filesystem state relevant to API consumers
  - [ ] 3.1.3 `system` category — firmware version, battery, available transports, BT visibility
- [ ] **3.2 Telemetry data models**
  - [ ] 3.2.1 `TelemetrySnapshot` — full state at a point in time for a category
  - [ ] 3.2.2 `TelemetryEvent` — incremental change within a category
  - [ ] 3.2.3 Per-port value model (peripheral type, value, unit, timestamp)
- [ ] **3.3 Telemetry scheduler**
  - [ ] 3.3.1 Foreground loop — fastest frequency, full `ports` + `system` data
  - [ ] 3.3.2 Subscribed loop — per-category, reduced frequency
  - [ ] 3.3.3 Minimal loop — heartbeat only, no extended telemetry
  - [ ] 3.3.4 Mode switching on foreground/background transitions
  - [ ] 3.3.5 Subscription registry — track which categories are subscribed per brick
- [ ] **3.4 Adaptive Throttling**
  - [ ] 3.4.1 Response latency measurement per command
  - [ ] 3.4.2 Queue depth monitoring from the command queue
  - [ ] 3.4.3 Frequency scaling algorithm (increase interval when latency/depth grows)
  - [ ] 3.4.4 Separate throttling per brick (one slow brick must not throttle others)
  - [ ] 3.4.5 Diagnostic output — current telemetry speed observable for the UI
- [ ] **3.5 Read model for the active brick**
  - [ ] 3.5.1 `ActiveBrickViewModel` aggregation from telemetry snapshots
  - [ ] 3.5.2 Port state (A–D motors, 1–4 sensors)
  - [ ] 3.5.3 Peripheral detection and type identification
  - [ ] 3.5.4 Button state
  - [ ] 3.5.5 Battery state
  - [ ] 3.5.6 System information for config mode
- [ ] **3.6 Stale snapshot policy**
  - [ ] 3.6.1 After a subscription ends, hold last snapshot briefly as `stale`
  - [ ] 3.6.2 Configurable stale timeout
  - [ ] 3.6.3 Clear stale data after timeout
- [ ] **3.7 Unit tests**
  - [ ] 3.7.1 Telemetry scheduler mode switching tests
  - [ ] 3.7.2 Adaptive throttling response to latency changes
  - [ ] 3.7.3 Category subscription add/remove tests
  - [ ] 3.7.4 Stale snapshot expiry tests
  - [ ] 3.7.5 Read model aggregation tests
  - [ ] 3.7.6 Multi-brick concurrent telemetry tests

### Definition of Done

- foreground brick has the fastest telemetry,
- subscribed brick receives telemetry only while a subscription is active,
- minimal brick maintains only heartbeat and reconnect,
- Cockpit remains responsive even with concurrent subscriptions,
- adaptive throttling demonstrably scales frequency based on load.

## 8. Phase 4 — Public API and Filesystem Services

### Goal

Export a stable API for other extensions without giving them direct access to the physical lifecycle.

### Tasks

- [ ] **4.1 API surface type definitions**
  - [ ] 4.1.1 `ConnectedBrickSnapshot` — public representation of a connected brick
  - [ ] 4.1.2 `BrickStateChangeEvent` — state transition event for consumers
  - [ ] 4.1.3 `ActiveBrickSnapshot` — currently active brick or null
  - [ ] 4.1.4 `TelemetrySnapshot` (API version) — category-specific data snapshot
  - [ ] 4.1.5 `TelemetryEvent` (API version) — incremental telemetry update
  - [ ] 4.1.6 `FilesystemEvent` — filesystem operation result
- [ ] **4.2 Consumer registration**
  - [ ] 4.2.1 `registerConsumer(name)` — register a dependent extension, return consumer handle
  - [ ] 4.2.2 `unregisterConsumer(handle)` — cleanup all subscriptions for this consumer
  - [ ] 4.2.3 Consumer lifecycle management — auto-cleanup on extension deactivation
- [ ] **4.3 State query methods**
  - [ ] 4.3.1 `getConnectedBricks()` — snapshot of all connected sessions
  - [ ] 4.3.2 `getActiveBrick()` — currently active brick or null
- [ ] **4.4 Event subscriptions**
  - [ ] 4.4.1 `onBrickStateChanged(callback)` — subscribe to session state changes
  - [ ] 4.4.2 `onActiveBrickChanged(callback)` — subscribe to active brick switching
  - [ ] 4.4.3 Disposable pattern for all subscriptions
- [ ] **4.5 Telemetry subscriptions**
  - [ ] 4.5.1 `subscribeTelemetry(brickKey, category)` — create a telemetry subscription
  - [ ] 4.5.2 Initial snapshot delivery before events
  - [ ] 4.5.3 `unsubscribeTelemetry(subscriptionId)` — cancel a subscription
  - [ ] 4.5.4 Auto-cancel on brick disconnect
  - [ ] 4.5.5 Integration with telemetry scheduler mode transitions
- [ ] **4.6 Filesystem services**
  - [ ] 4.6.1 `uploadFile(brickKey, localPath, remotePath)` — upload a file to the brick
  - [ ] 4.6.2 `downloadFile(brickKey, remotePath, localPath)` — download a file from the brick
  - [ ] 4.6.3 `executeRbf(brickKey, remotePath)` — execute a program on the brick
  - [ ] 4.6.4 `listFiles(brickKey, remotePath)` — list files in a directory
  - [ ] 4.6.5 `readFile(brickKey, remotePath)` — read file content
  - [ ] 4.6.6 Error handling for unavailable bricks or failed operations
- [ ] **4.7 API export**
  - [ ] 4.7.1 Export typed API object from `extension.ts` `activate()` return value
  - [ ] 4.7.2 Ensure API is fully initialized before any consumer can use it
  - [ ] 4.7.3 Versioned API object (for future backward compatibility)
- [ ] **4.8 Integration tests**
  - [ ] 4.8.1 Mock consumer registers and receives snapshot
  - [ ] 4.8.2 Mock consumer receives state change events
  - [ ] 4.8.3 Telemetry subscription lifecycle (subscribe → receive → unsubscribe)
  - [ ] 4.8.4 Filesystem operations against mock transport
  - [ ] 4.8.5 Consumer cleanup on unregister
  - [ ] 4.8.6 Multi-consumer concurrent access

### Explicitly Not Implemented in This Phase

- public `connect` / `disconnect`,
- file explorer GUI,
- full-folder deployment workflow as a primary scenario.

### Definition of Done

- another extension can register as a consumer,
- it receives a snapshot of connected bricks,
- it receives state change events,
- it can create a telemetry subscription,
- it can use the basic filesystem API,
- all API methods are covered by integration tests.

## 9. Phase 5 — Cockpit Panel and UX

### Goal

Build the main product UX on top of the finished runtime.

### Tasks

- [ ] **5.1 Webview panel infrastructure**
  - [ ] 5.1.1 Panel provider registration (right secondary panel)
  - [ ] 5.1.2 Panel lifecycle (show / hide / dispose)
  - [ ] 5.1.3 Asset pipeline (CSS, images, fonts)
  - [ ] 5.1.4 Content Security Policy for webview
- [ ] **5.2 Extension ↔ Webview messaging protocol**
  - [ ] 5.2.1 Message type definitions (actions from webview, events from runtime)
  - [ ] 5.2.2 Snapshot request/response (pull model)
  - [ ] 5.2.3 Event push (state changes, telemetry updates)
  - [ ] 5.2.4 Action dispatch (connect, disconnect, focus, forget, toggle favorite, etc.)
  - [ ] 5.2.5 Webview recovery after reload — request fresh snapshot
- [ ] **5.3 Discovery tab**
  - [ ] 5.3.1 Unified brick list rendering (available + connected + remembered)
  - [ ] 5.3.2 Transport icons per provider type
  - [ ] 5.3.3 Color-coded status indicators (available, connected, unavailable, remembered)
  - [ ] 5.3.4 Supplementary icons — signal strength, favorite star (display only), trash
  - [ ] 5.3.5 Quick actions: connect (available brick), focus/open (connected brick), forget (remembered offline)
  - [ ] 5.3.6 Stable ordering (by transport group, then by signal or brickKey)
  - [ ] 5.3.7 Efficient rendering for dozens of items
- [ ] **5.4 Brick tab**
  - [ ] 5.4.1 Tab creation on connect, removal on disconnect
  - [ ] 5.4.2 Tab header: transport icon with status color, brick name, gear icon, X icon
  - [ ] 5.4.3 Status bar — left: available transport icons; center: battery state; right: favorite star (clickable toggle)
  - [ ] 5.4.4 Brick image with interactive buttons (display presses, relay presses)
  - [ ] 5.4.5 Motor ports (A–D) — peripheral icon + measured value
  - [ ] 5.4.6 Sensor ports (1–4) — peripheral icon + measured value
  - [ ] 5.4.7 Disconnected peripheral indication
- [ ] **5.5 Value display modes**
  - [ ] 5.5.1 Numeric style — exact text value as returned by the sensor
  - [ ] 5.5.2 Visual style — per-peripheral graphical elements:
    - [ ] Color sensor → color target
    - [ ] Touch sensor → press state indicator
    - [ ] Gyro → arc with indicator
    - [ ] Ultrasonic → distance bar
    - [ ] Motor → schematic rotation
  - [ ] 5.5.3 Style preference stored per brick
- [ ] **5.6 Foreground activation**
  - [ ] 5.6.1 Tab switching triggers `setActiveBrick()` / `clearActiveBrick()`
  - [ ] 5.6.2 Discovery tab = no active brick
  - [ ] 5.6.3 Active brick read model drives tab content
- [ ] **5.7 Config mode**
  - [ ] 5.7.1 Gear icon toggles between normal and config mode (same tab)
  - [ ] 5.7.2 Editable brick name with auto-save
  - [ ] 5.7.3 System and technical information display (read-only)
  - [ ] 5.7.4 Visual style toggle (`numeric` / `visual`)
  - [ ] 5.7.5 Status bar configuration
  - [ ] 5.7.6 Auto-save debounce — timer per field, save on focus loss or after 1s
  - [ ] 5.7.7 Optimistic updates — local event emitted immediately, telemetry confirms
  - [ ] 5.7.8 No star toggle in config mode
  - [ ] 5.7.9 No port/sensor display in config mode
- [ ] **5.8 CSS and visual design**
  - [ ] 5.8.1 VS Code theme integration (respect dark/light/high contrast)
  - [ ] 5.8.2 Responsive layout for different panel sizes
  - [ ] 5.8.3 Icon set for transports, peripherals, status indicators
- [ ] **5.9 Smoke tests**
  - [ ] 5.9.1 Panel opens and renders discovery tab
  - [ ] 5.9.2 Connect to mock brick creates a brick tab
  - [ ] 5.9.3 Tab switching updates foreground brick
  - [ ] 5.9.4 Config mode toggle works
  - [ ] 5.9.5 Disconnect removes brick tab

### UX Rules

- panel only displays the runtime read model,
- no domain logic for reconnects in the webview,
- no filesystem browser in the panel.

### Definition of Done

- user can operate entirely through the panel,
- active brick matches the tabs,
- discovery tab supports connect/focus/forget,
- config mode changes runtime data through defined actions,
- all smoke tests pass.

## 10. Phase 6 — Persistence, Favorites, and Remembered Devices

### Goal

Complete long-term Cockpit behavior across restarts.

### Tasks

- [ ] **6.1 globalState adapter**
  - [ ] 6.1.1 Schema definition for persisted data
  - [ ] 6.1.2 Type-safe read/write operations over `ExtensionContext.globalState`
  - [ ] 6.1.3 Schema versioning and migration strategy
  - [ ] 6.1.4 Initialization at activation
- [ ] **6.2 Per-brick metadata storage**
  - [ ] 6.2.1 `favorite` flag per (brickKey, transport) pair
  - [ ] 6.2.2 Preferred visual style (`numeric` / `visual`) per brick
  - [ ] 6.2.3 Status bar configuration per brick
  - [ ] 6.2.4 Remembered display metadata (name, transport, last seen)
- [ ] **6.3 Favorite toggle flow**
  - [ ] 6.3.1 Toggle from brick tab status bar (star click)
  - [ ] 6.3.2 Persist immediately to globalState
  - [ ] 6.3.3 Update discovery list star indicator
  - [ ] 6.3.4 Favorite is bound to (brickKey, transport) — not cross-transport
- [ ] **6.4 Auto-connect on favorite discovery**
  - [ ] 6.4.1 Trigger on `removed` → `available` (rediscovery within session)
  - [ ] 6.4.2 Trigger on `remembered` → `available` (session start)
  - [ ] 6.4.3 Trigger on `[*]` → `available` (first discovery in session)
  - [ ] 6.4.4 Suppression after explicit disconnect within the current session
  - [ ] 6.4.5 Suppression reset on new VS Code session
- [ ] **6.5 Remembered brick merge with OS evidence**
  - [ ] 6.5.1 BT pairing detection — read OS-level paired devices
  - [ ] 6.5.2 Merge algorithm — combine persisted metadata with OS evidence
  - [ ] 6.5.3 Handle conflicts (persisted name vs OS name)
  - [ ] 6.5.4 Remembered bricks visible in discovery list even when offline
- [ ] **6.6 Forget flow**
  - [ ] 6.6.1 Trash action in discovery list for remembered offline bricks
  - [ ] 6.6.2 Delete all local persisted metadata (including `favorite`)
  - [ ] 6.6.3 OS-level unpair where the provider supports it
  - [ ] 6.6.4 Provider capability check before offering forget action
- [ ] **6.7 Unit tests**
  - [ ] 6.7.1 globalState adapter read/write/migration tests
  - [ ] 6.7.2 Favorite toggle persistence tests
  - [ ] 6.7.3 Auto-connect trigger and suppression tests
  - [ ] 6.7.4 Remembered brick merge tests
  - [ ] 6.7.5 Forget flow cleanup tests

### Definition of Done

- a favorite brick auto-connects only in the defined scenarios,
- remembered bricks are visible even offline,
- forget correctly removes both local and OS metadata where the provider supports it,
- auto-connect suppression works correctly after explicit disconnect,
- all persistence operations are covered by unit tests.

## 11. Phase 7 — Hardening, Tests, and Release Discipline

### Goal

Stabilize the system for long-term use and further development.

### Tasks

- [ ] **7.1 Unit test coverage expansion**
  - [ ] 7.1.1 Contract and type validation tests
  - [ ] 7.1.2 State machine transition tests (presence, connection, activity)
  - [ ] 7.1.3 Telemetry scheduler and throttling tests
  - [ ] 7.1.4 API consumer lifecycle tests
  - [ ] 7.1.5 Error model and error propagation tests
- [ ] **7.2 Integration tests**
  - [ ] 7.2.1 Full connect → monitor → disconnect lifecycle (using Mock)
  - [ ] 7.2.2 Multi-brick concurrent sessions
  - [ ] 7.2.3 Reconnect under various failure modes
  - [ ] 7.2.4 API consumer registration → telemetry subscription → disconnect cleanup
  - [ ] 7.2.5 Persistence across simulated session restarts
- [ ] **7.3 Stress tests (`test-stress`)**
  - [ ] 7.3.1 Hundreds of connect / reconnect / lost cycles
  - [ ] 7.3.2 High telemetry load on multiple bricks simultaneously
  - [ ] 7.3.3 Many simultaneous mock bricks in discovery (dozens)
  - [ ] 7.3.4 Rapid subscribe/unsubscribe cycling
  - [ ] 7.3.5 Command queue under sustained high load
- [ ] **7.4 Panel smoke tests (Playwright)**
  - [ ] 7.4.1 Discovery tab renders correctly with mock bricks
  - [ ] 7.4.2 Connect flow creates a brick tab
  - [ ] 7.4.3 Tab switching updates foreground brick
  - [ ] 7.4.4 Config mode opens and edits work
  - [ ] 7.4.5 Disconnect removes brick tab
  - [ ] 7.4.6 Favorite toggle persists
- [ ] **7.5 Performance checkpoints**
  - [ ] 7.5.1 Extension activation time measurement
  - [ ] 7.5.2 Telemetry latency under normal and high load
  - [ ] 7.5.3 UI responsiveness during concurrent telemetry
  - [ ] 7.5.4 Memory usage over extended sessions
  - [ ] 7.5.5 Discovery list rendering performance with dozens of items
- [ ] **7.6 Diagnostic and observability**
  - [ ] 7.6.1 Telemetry speed diagnostic display in the panel
  - [ ] 7.6.2 Logging strategy (structured logs, log levels)
  - [ ] 7.6.3 Debug commands in Command Palette
- [ ] **7.7 Release checklist and discipline**
  - [ ] 7.7.1 Minimum validation set: `compile` → `lint` → `test-smoke` (after every change)
  - [ ] 7.7.2 Full test suite: unit + host + integration + stress (regularly)
  - [ ] 7.7.3 Performance review cadence
  - [ ] 7.7.4 Refactoring and coverage improvement cycle
  - [ ] 7.7.5 VSIX packaging and manual validation
  - [ ] 7.7.6 Documentation update checklist

### Minimum Validation Set

After every change:

- `compile`
- `lint`
- `test-smoke`

Regularly:

- full tests,
- performance review,
- refactoring and increased coverage.

### Definition of Done

- changes are automatically verifiable,
- main lifecycle flows are covered by tests,
- stress tests confirm stability under high load,
- the team has a clear operational discipline,
- release checklist is documented and followed.

## 12. Recommended Implementation Order

Practical order:

1. Phase 0
2. Phase 1
3. Phase 2
4. Phase 3
5. Phase 4
6. Phase 5
7. Phase 6
8. Phase 7

This order ensures:

- mock is available early for further development,
- UI is not built on an unstable runtime,
- the public API is consistent with the internal model from the start.

## 13. Intentionally Deferred to the Next Version

See `REQUIREMENTS.md §4`. During implementation, consider these areas only to the extent that they can be added later without a major rewrite.

## 14. Maybe Someday

See `REQUIREMENTS.md §16`. Do not design against these areas, but do not block them either.
