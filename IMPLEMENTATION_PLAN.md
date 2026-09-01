# EVƎ Cockpit - Implementation Plan

> Version: 2026-08-20
> Repository state: Phases 0-2 implemented; Phase 3 is the next work item.

This document translates `REQUIREMENTS.md` and `DESIGN.md` into a concrete implementation order.

## 1. Implementation Principles

- implementation proceeds from runtime and contracts toward UI,
- the Cockpit panel is built only on top of a finished runtime model,
- physical connect/disconnect stays exclusively in Cockpit,
- mock is implemented early, as it will be used for debugging all other layers,
- filesystem is built in the first version as a service and API, not as a GUI explorer.

## 2. Current Starting State

Phase 0 and Phase 2 are complete. Phase 1 is substantially complete but carries named gaps:
1.6.10 mock config loading, 1.8.4 transport guard wiring,
1.11 BT backends and discovery (1.11.7a discovery wiring,
1.11.12 bounded ceiling failure), 1.12.4 per-transport contract tests. Phase 3 work starts
from here; those gaps are carried, not closed.

This list is the single enumeration of Phase 1's open work — the Phase Overview table below
points here rather than repeating it, because the duplicate copy drifted twice during review.

- extension skeleton ✅
- build and lint pipeline ✅
- test runner infrastructure ✅
- base folder structure (`src/contracts/`, etc.) ✅
- shared contracts, error model, and event infrastructure ✅
- EV3 protocol layer (bytecode, packets, commands, responses) ✅
- transport adapters and providers (USB, TCP; BT is SPP-only — see 1.11) ✅
- transport guard (built, not yet wired into any provider — see 1.8.4), BT connection queue, pending reply utilities ✅
- session runtime (session entry, session manager, heartbeat, reconnect, command queue) ✅
- 207 unit tests + 3 extension-host integration tests passing ✅
- implementation of telemetry, API, and UI ⬜ starts in Phase 3

## 3. Phase Overview

| Phase | Name | Status |
| :--- | :--- | :--- |
| 0 | Project foundation and contracts | ✅ done |
| 1 | Transport contracts and discovery | ⚠ gaps (see §2) |
| 2 | Session runtime and lifecycle | ✅ done |
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
  - [x] 0.3.5 `npm run test-smoke` — the per-change gate named in REQUIREMENTS §15 and 7.7.1
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
- unit tests validate basic type correctness,
- **antipattern cleanup**: scan the code this phase touched for code smells and anti-patterns (DRY violations, hardcoded config, silent catches, magic numbers, dead code, YAGNI, etc.); every detected issue is recorded as either fixed or explicitly accepted with a stated reason.

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
  - [x] 1.1.7 Transport capability flags (`supportsSignalInfo`, `supportsForget`)
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
- [ ] **1.6 Mock Transport** — config loading outstanding (1.6.10)
  - [x] 1.6.1 JSON configuration file schema (brick identity, sensors, motors, dynamics)
  - [x] 1.6.2 Configuration schema validation (`validateMockConfig`)
  - [ ] 1.6.10 Load the mock configuration from a workspace JSON file (REQUIREMENTS §13) — today `extension.ts` always uses `DEFAULT_MOCK_CONFIG`
  - [x] 1.6.3 Mock discovery (enumerate bricks from config)
  - [x] 1.6.4 Mock connect / disconnect
  - [x] 1.6.5 Mock value dynamics (static values, sine/triangle/square oscillators)
  - [x] 1.6.6 Mock error state simulation (configurable failures)
  - [x] 1.6.7 Mock loss and recovery simulation (configurable disappearance/reappearance)
  - [x] 1.6.8 Mock filesystem (in-memory file tree for API testing)
  - [x] 1.6.9 Mock brickKey generation (`mock:<id>` from config)
- [x] **1.7 EV3 Protocol layer**
  - [x] 1.7.1 Bytecode encoding primitives (`ev3Bytecode.ts` — lc0/lc1/lc2/lcs, gv0/gv1, uint16le/uint32le, concatBytes)
  - [x] 1.7.2 Packet framing (`ev3Packet.ts` — encode/decode, command/reply type constants)
  - [x] 1.7.3 Command builder (`ev3Commands.ts` — BrickCommand → { type, payload } for each kind)
  - [x] 1.7.4 Response parser (`ev3Responses.ts` — raw reply → BrickResponse for each kind)
  - [x] 1.7.5 Unit tests for encoding/decoding round-trips
  - [x] 1.7.6 Battery: charge level from `GET_LBATT` (0x12), voltage from `GET_VBATT` (0x01), current from `GET_IBATT` (0x02) — all three verified on a real brick (100 %, 8.36 V, 0.143 A; the old `current * 200` heuristic reported 29 % for the same brick)
  - [x] 1.7.8 `OUTPUT_GET_COUNT`'s second argument is an **output number** (0-3), not an `NOS` bit field. Resolved with a large motor on port A: the shipped `buildPortsCommand` reported `{ port: 'A', peripheralType: 'large-motor', value: 342, unit: 'deg' }`, which is the tacho read with argument 0. The reviewer claim is refuted and the code stands unchanged
  - [x] 1.7.7 System reply header is 7 bytes — command echo, status, uint32 size, handle — measured on a real brick (`99 08 42 00 00 00 00` before the listing). `parseFsList` skipped 4 and glued three stray bytes to the first entry; `parseFsRead` skipped 6 and glued the handle to the content. Both now use one named constant
  - [x] 1.7.9 Buttons: `opUI_BUTTON` (0x83) subcode `PRESSED` (0x09). The shipped command asked `opUI_READ` for 0x0d, which is `GET_ADDRESS` — a real brick answered the whole command with an error, so button telemetry never worked outside the mock
  - [x] 1.7.10 The info command reads the brick's own name via `opCOM_GET` (0xD3) / `GET_BRICKNAME` (0x0D), and `InfoResponse` gained `osVersion` so the kernel string keeps a home of its own. Verified on three bricks, each reporting its own name. The earlier failed probe used 0xD5, which is `opCOM_TEST`
- [x] **1.13 Command layer** — `src/commands/` owns the codec, message counters, reply
  matching and command typing, above the session manager and below telemetry and the
  filesystem (DESIGN §4.3a). Transports carry bytes: `TransportProvider.sendPacket`
  replaced the typed `send`, which had the lowest layer owning the protocol every layer
  above it was defined in terms of
  - [x] 1.13.1 `PacketCommandChannel` — session-scoped, because the message counter is
  - [x] 1.13.2 `protocolBridge` moved out of `src/transports/` and deleted
  - [x] 1.13.3 Mock keeps command semantics via optional `createCommandChannel`
  - [x] 1.13.4 `SendCommandOptions` carried through `CommandQueue` — the timeout and abort
    signal plumbed through the providers earlier had no path from a caller until this
- [x] **1.8 Transport adapter interface and constants**
  - [x] 1.8.1 `TransportAdapter` interface (`open`, `close`, `send`)
  - [x] 1.8.2 Transport timing constants (empirical values from lab measurements)
  - [x] 1.8.3 Transport guard (pathological-caller backstop, firmware freeze protection, degradation tracking). The ≤ 10 cmd/s figure it was built against had no basis and is retired: measured sustained rates are USB 176, TCP 62, BT 11 per second with no degradation at any of them (DESIGN §9.2)
  - [x] 1.8.4a **Resolved: reject.** Measurement showed commands are strictly serial, so no
    transport can be pushed past its own round trip — pacing would only mask a caller bug.
    Where the backstop is enforced is still open while `TransportGuard` is unwired (1.8.4)
  - [x] 1.8.4 **Wired into `SessionManager`, 28.08.2026** — one layer above the individual
    USB/TCP/BT providers rather than into each one, since that is the single place every
    transport's connects and sends already pass through. `connect()` calls
    `openTransport()`/`closeTransport()`; `wireExecutor()`'s command wrapper calls
    `checkRateLimit()` before every send and `recordSuccess()`/`recordFailure()` after.
    Guarded by the brick's **physical** id (`brickKeyId()`, e.g. the bare MAC or serial),
    not the transport-qualified `BrickKey` — so a brick reachable over two transports is
    covered by the one-active-transport rule even though each transport gives it a
    different key.

    Two defects surfaced by wiring it, neither present in the class in isolation:
    - **The switch cooldown blocked an ordinary reconnect.** `openTransport()` fired its
      cooldown on *any* reopen after a close, not only when the new transport differed
      from the last one — so a plain disconnect-then-reconnect on the same transport ate
      the 2 s wait DESIGN §4.1 means for an actual transport switch. Fixed by remembering
      `lastTransport` past the close and gating the cooldown on it changing.
    - **A degraded brick had no way back.** `checkRateLimit()` refuses every send once
      `degraded` is set, and the only thing that clears it is `recordSuccess()` — which a
      degraded brick can never reach, since every send is refused before it touches the
      transport. Added `TransportGuard.resetHealth()`, called from
      `SessionManager.disconnect()` alongside `closeTransport()`: it drops the failure
      count and rate window but — unlike `forget()` — keeps `lastCloseTs`, so the switch
      cooldown still applies to whatever connects next.
  - [x] 1.8.5a Round-trip and receive timeouts in every adapter, with recovery. Shared `createPendingReply` arms the timer and abort wiring; `send()` discards the receive buffer so an abandoned exchange cannot desync the next one. Verified on hardware: a forced timeout is followed by three successful commands on the same adapter
  - [x] 1.8.5b **Reframed as stall detection** (4.6.3): with per-chunk progress reporting, a
    total-time cap would reject legitimately slow Bluetooth transfers, so the signal is “no
    progress for N seconds” instead — which also keeps it in the transfer service rather than
    the adapter, where 100 chunks each inside their own budget added up to minutes of
    apparent success
- [x] **1.9 USB Transport**
  - [x] 1.9.1 `UsbHidAdapter` — node-hid, VID 0x0694 PID 0x0005, 1025-byte HID reports
  - [x] 1.9.2 `UsbTransportProvider` — USB discovery (device enumeration), compose adapter + protocol
  - [x] 1.9.3 brickKey from serial number (`usb:<serial>`)
  - [x] 1.9.4 Lazy-load node-hid with try-catch fallback
- [x] **1.10 TCP Transport**
  - [x] 1.10.1 `TcpSocketAdapter` — TCP socket via Node.js `net`, length-prefixed stream
  - [x] 1.10.2 `TcpTransportProvider` — UDP beacon discovery (port 3015, `dgram`), TCP connection (port 5555), VMTP1.0 unlock handshake
  - [x] 1.10.3 brickKey from serial number or IP (`tcp:<serial>` or `tcp:<ip>`)
  - [x] 1.10.5 Beacon path priming — a one-byte datagram to each interface's broadcast address every few seconds. Without it a host firewall filtering unsolicited inbound UDP drops the brick's announcement and discovery finds nothing; see DESIGN §9.2
  - [x] 1.10.4 Hybrid beacon + direct-IP recovery. Connect now resolves the address from the
        provider's own beacon cache; it used to hand the adapter a bare serial with
        `useDiscovery: true`, and the adapter could never bind the beacon port because the
        provider already held it — so connecting to a brick found by discovery always failed
- [ ] **1.11 BT Transport** — connect, discovery, pairing and the queue are built and wired;
  remaining open items are a still-unexplained connect failure (2.8.16), signal strength
  (1.11.9, blocked — no Win32 API for classic BT RSSI), and the Linux backend (1.11.11,
  blocked — no Linux host)
  - [~] 1.11.1 ~~`BtRfcommAdapter` — multi-backend orchestrator~~ **Not needed.**
    `BtTransportProvider` already holds the backend map and chooses between them; a second
    orchestrator between it and the adapters would have nothing to do.
  - [~] 1.11.2 ~~`BtWinrtBackend` — .NET helper IPC for WinRT StreamSocket~~ **Dropped
    28.08.2026 by the owner.** It needs a .NET helper process, and the testlab excludes
    `child_process` paths for extension compatibility. See DESIGN §4.1.1.
  - [x] 1.11.3 **`BtWinsockAdapter` — koffi FFI to ws2_32.dll AF_BTH**, 28.08.2026. Ported
    from the testlab, which measured it against live bricks and chose it as the BT runtime.
    Four deliberate departures from the original, each recorded in the source: the connect
    has a deadline and aborts by closing the socket; the adapter does not queue, because
    the provider does; a short `send()` is finished rather than ignored; idle polling drops
    from 5 ms to 250 ms, which a request-reply link can afford and an all-day extension
    host needs. Preferred over SPP in `extension.ts`; falling back to SPP now happens only
    when a backend cannot run at all, never after a connect that touched the radio
  - [x] 1.11.4 `BtSppBackend` — serialport COM port fallback (cross-platform)
  - [~] 1.11.5 ~~.NET runtime detection~~ **Dropped with 1.11.2** — nothing to detect once
    WinRT is out of the chain.
  - [x] 1.11.6 BT connection queue — serialized RFCOMM (1 slot, 15s cooldown, exponential backoff)
  - [x] 1.11.12 **Bounded failure when a transport's session ceiling is reached**, 28.08.2026.
    `BtConnectionQueue.acquire()` now takes `acquireTimeoutMs` (default `BT.QUEUE_ACQUIRE_TIMEOUT_MS`,
    45 s — comfortably above the 30 s cooldown ceiling the queue's own backoff never exceeds,
    so it only fires on a genuine ceiling wait, never an ordinary cooldown). A queued entry
    that times out is spliced out and rejected with a `TransportError` naming the brick and
    the in-use/ceiling counts, instead of sitting forever behind a brick that stays connected.
    The one-slot BT ceiling is unchanged; only the unbounded wait was the defect
  - [x] 1.11.7 `BtTransportProvider` — composes adapter + protocol; accepts an injected discovery function
  - [x] 1.11.7a **BT discovery via `bthprops.cpl`**, 28.08.2026. Reads the Windows Bluetooth
    device cache — the testlab's primary mechanism — with the COM-port scan behind it as a
    fallback and to keep the SPP backend's port map fresh. The two answer different
    questions and only looked alike while the runtime went through a serial port: a paired
    brick whose outgoing port Windows never created is invisible to a scan and perfectly
    reachable over a socket. No inquiry is issued, so it costs no air time
  - [x] 1.11.13 **Pair and unpair, in the discovery layer**, 28.08.2026. The owner asked for
    this on 27.08.2026 — *„zarizeni se maji pripojovat primo k cockpitu bez nutnosti
    ovladat to z windows“* — and placed it on 28.08.2026: pairing belongs to discovery, not
    to a command or a view. It does, and the code agrees: `BluetoothAuthenticateDeviceEx` and
    `BluetoothRemoveDevice` sit in the same DLL as the enumeration, so any other home would
    mean the same FFI in two places.

    `BluetoothAuthenticateDeviceEx` runs off the main thread. With a null window handle
    Windows raises its own dialog and does not return until the user answers it; called
    synchronously that would freeze the extension host for as long as the dialog stood.

    `forget()` now removes the pairing and reports a refusal instead of swallowing it, and
    `capabilities.supportsForget` follows whether an unpair hook was supplied. That closes
    6.6.6: forget used to drop this provider's own bookkeeping and leave the pairing alone,
    so a forgotten brick came back on the next scan.

    **Verified against Windows on all three bricks, 28–30.08.2026 (plan 2.8.17), and the
    finding changed twice.** First: no Windows dialog appears at all — the docstring's
    assumption that "Windows raises its own dialog" is wrong on every host tested. What
    appears is the **brick's own** accept-and-PIN screen, and the user confirmed it there
    (PIN 1234 pre-filled) on CCC. `BluetoothAuthenticateDeviceEx` still returned
    `ERROR_ACCESS_DENIED` — nothing on this side ever answers the legacy-PIN half of the
    exchange, confirming the gap this entry already named.

    Second: the fix was attempted and **withdrawn**. Registering a callback via
    `BluetoothRegisterForAuthenticationEx` (koffi `.register()`, matching its documented
    "registered callback" pattern) and answering with `BluetoothSendAuthenticationResponseEx`
    does get past Access Denied in principle, but **segfaults the extension host on cleanup,
    reproducibly** — isolated down to `BluetoothRegisterForAuthenticationEx` followed by
    `BluetoothUnregisterAuthentication` and `koffi.unregister()`, with a trivial callback that
    is never even invoked and no radio operation of any kind in between. Not a struct-layout
    bug in this file's types: the isolation repro uses none of them. Reverted rather than
    shipped with a known crash.

    **The crash was isolated and fixed, 30–31.08.2026 — and the real cause turned out not to
    be Bluetooth at all.** Bisected down to `koffi.register()` alone: registering *any*
    trivial callback and letting the process exit segfaults on koffi 2.15.1 with Node
    v26.7.0, with zero native calls involved. koffi 2.16.3's changelog names this exact
    defect ("fix crash when trying to run async callback during shutdown"); confirmed fixed
    in isolation on both 2.16.3 and 3.1.6. **Upgraded to 3.1.6** (`^3.1.6`, was `2.15.1`) —
    the newer major version despite its breaking changes (externals → BigInt pointers,
    `koffi.callback()` removed), because this codebase uses neither `koffi.callback()`,
    `koffi.introspect()`, `koffi.resolve()`, nor `koffi.handle()` anywhere (grepped clean),
    and the one thing the BigInt change touches — the opaque handles `findFirst` /
    `registerAuth` return and pass on — was already written to accept `number | bigint`
    (`windowsWinsock.ts`'s `isInvalidSocket`), so there was nothing left to audit. Re-verified
    against real hardware after the upgrade: discovery, Winsock connect (same WSA-10060
    pattern, unchanged), and the full `pairBluetoothDevice` register→authenticate→dispose
    cycle all clean, no regressions, 379/379 unit tests still pass.

    With the crash gone, the callback still never fired — confirmed on real hardware with
    both a device-scoped registration and a catch-all (`pbtdiIn: null`) one, while the
    brick's own accept-and-PIN screen kept appearing normally each time. **Root cause,
    confirmed against `BluetoothRegisterForAuthenticationEx`'s own docs**: *"In scenarios
    where an application registers for authentication more than once, only the first
    callback function registered via this function will be called."* Windows' own Bluetooth
    service registers its callback at boot, for the system's "Add a device" UI, long before
    this extension ever runs — so `registerAuth()` always reports success (the registration
    is recorded) while the *system's* callback, not this one, is the one Windows actually
    invokes. Not a bug in this file; a documented single-slot API this extension cannot win
    a race against.

    Windows Event Viewer corroborates this from another angle: `Microsoft-Windows-
    Bluetooth-Policy/Operational` (disabled by default; enabled for one test run, restored
    to disabled after) logged the attempt as this process's (`node.exe`, correct PID/SID),
    and the failure ~5 s later as `ProcessID 4` (the kernel) — i.e. the negotiation really
    reached the driver, and failed there, at the same ~5.1–5.2 s mark 2.8.16 already measured
    for plain RFCOMM connects. That is the strongest evidence yet that **2.8.16's connect
    failures and this pairing failure are the same underlying link-layer problem** between
    this host's Realtek adapter and the EV3's Bluetooth chip, not two separate defects —
    everything downstream of that link negotiation (RFCOMM connect, and now pairing) inherits
    the same failure, regardless of which host-side API drives it.

    So: no host-side callback registration can make this API pair the brick, because the
    slot belongs to Windows' own service by design — and even if it could, the link-layer
    problem underneath would still need solving first. `registerLegacyPinResponder` is kept
    (correct, crash-free, real prerequisite if the link layer is ever fixed) rather than
    reverted a second time, but pairing from the cockpit stays blocked on hardware, not code.

    **That conclusion was wrong, and disproven on the same adapter, 01.09.2026 — `bthprops.cpl`
    was the wrong API, not Bluetooth pairing itself.** `Windows.Devices.Enumeration
    .DeviceInformationCustomPairing` (WinRT — the same stack Windows' own "Add a device" UI
    drives) does not share the single-callback-slot ceiling: `PairingRequested` is an event on
    the caller's own pairing object, not a process-wide registration, so the "only the first
    registered callback ever fires" limit that defeats `BluetoothRegisterForAuthenticationEx`
    does not apply to it. Confirmed against Microsoft's own docs (Windows requires no package
    identity for this API family) and proved live against CCC with a throwaway C# probe
    (`net10.0-windows10.0.19041.0`, CsWinRT — no extra plumbing): 2 pairings succeeded out of 3
    attempts, the one "failure" being a missed brick-side confirmation window (no code fault)
    rather than a protocol failure.

    Working recipe, learned the hard way:
    - `BluetoothDevice.FromBluetoothAddressAsync` alone hands back a stale cached
      `DeviceInformation` that never raises `PairingRequested` and times out (~20–27 s) with no
      dialog on either side. A live `DeviceWatcher` inquiry — `BluetoothDevice
      .GetDeviceSelectorFromPairingState(false)`, `DeviceInformationKind.AssociationEndpoint` —
      must find the peer fresh immediately before pairing from *that* instance.
    - Offering `DevicePairingKinds.ConfirmOnly | DisplayPin | ProvidePin | ConfirmPinMatch`
      together lets Windows pick `DisplayPin` — asking the human to type an arbitrary
      Windows-generated PIN on the brick's own keypad, which EV3 does not have and cannot
      satisfy (fixed 1234 only). Restricting the offered kinds to `ProvidePin` alone forces the
      only ceremony this brick can actually complete.
    - The brick still shows its own accept-and-PIN screen and needs a physical confirmation —
      expected and unavoidable (independent of host API, per the finding two paragraphs up),
      not a gap in "pair from the cockpit": no Windows Settings navigation is needed, only the
      same on-brick confirmation any Bluetooth pairing requires of its peer.
    - `PairAsync` took between ~7 s and ~46 s across the three successful/attempted runs — plan
      any product-side timeout accordingly (see 2.8.17's note on what this means for the real
      implementation).

    Net effect: 1.11.13's blocker is lifted on Windows. `removeBluetoothDevice` (`bthprops`,
    already working) is unaffected and stays as the unpair path. Embedding this into the
    extension (a helper process — WinRT is not FFI-reachable through koffi the way `bthprops`
    is) is a separate, not-yet-started task; see 2.8.17 for the open questions.

    This does not touch 2.8.16's underlying finding: the *connect* step (Winsock RFCOMM,
    after pairing) still fails at the same ~17–67% rate this session already measured, on a
    freshly-WinRT-paired brick exactly as on a normally-paired one. The link is still flaky;
    only pairing was ever blocked by the wrong API, not by that flakiness
  - [x] 1.11.8 brickKey from MAC address (`bt:<mac>`)
  - [ ] 1.11.9 **Checked 28.08.2026: not available through this backend.** Windows has no
    Win32 API that returns RSSI for an already-open classic (BR/EDR) RFCOMM connection —
    only Bluetooth LE exposes signal strength, through WinRT advertisement watchers
    (`BluetoothLEAdvertisementWatcher.SignalStrengthFilter`,
    `BluetoothLEAdvertisementReceivedEventArgs.RawSignalStrengthInDBm`), confirmed against
    [Microsoft Q&A](https://learn.microsoft.com/en-us/answers/questions/4273960/how-to-check-the-signal-strength-rssi-of-a-bluetoo)
    and the [`BluetoothSignalStrengthFilter`](https://learn.microsoft.com/en-us/uwp/api/windows.devices.bluetooth.bluetoothsignalstrengthfilter?view=winrt-26100)
    docs. `bthprops.cpl` and `ws2_32.dll` — this transport's whole surface — expose neither.
    The remaining path is raw HCI vendor commands against the radio, which is
    adapter-specific and not something `koffi`'s `ws2_32.dll`/`bthprops.cpl` bindings reach.
    WinRT was already dropped for the connection itself (1.11.2, DESIGN §4.1.1) for needing
    a .NET helper process; using it for signal strength alone would reintroduce exactly
    that helper for one field. Stays open pending a reason to accept that cost
  - [~] 1.11.10 ~~BT native helpers — worker threads (bt-discovery, bt-winsock-connect), .NET
    RFCOMM session helper~~ **Not needed, checked 28.08.2026.** The premise was that a
    blocking native call needs a worker thread or a helper process to keep it off the
    extension host's main thread. `koffi` already does that in-process: `windowsWinsock.ts`'s
    `connect` and `windowsBluetooth.ts`'s `authenticate` (`BluetoothAuthenticateDeviceEx`,
    the one call slow enough to matter — it can block for as long as Windows' own pairing
    dialog stands) both go through koffi's `.async()`, which runs the call on libuv's
    thread pool. Everything else touched (`socket`, `send`, `recv`, `closesocket`, the
    zero-timeout `select` poll, `BluetoothFindFirstDevice`/`FindNextDevice`) either reads a
    cache or completes fast enough to call synchronously, the same way `tcpSocketAdapter`
    already does for TCP. A second execution context would have nothing to do that koffi
    is not already doing — the same shape as 1.11.1 and 1.11.2, dropped for the same reason
  - [ ] 1.11.11 `BtBluezBackend` — BlueZ D-Bus RFCOMM (Linux). DESIGN §4.1.1 commits to it and REQUIREMENTS §12 makes Linux a required platform, but no phase owned it. **Blocked by environment, 28.08.2026**: this repo's only hardware host is Windows; nothing here can build or run a D-Bus backend without a Linux host (or a WSL2 setup with working Bluetooth passthrough, which this machine does not have). Stays open until one is available
- [x] **1.12 Transport unit tests**
  - [x] 1.12.1 EV3 protocol encoding/decoding round-trip tests
  - [x] 1.12.2 Transport guard rate limiting tests
  - [x] 1.12.3 BT connection queue serialization tests
  - [x] 1.12.4 **Contract compliance tests for USB/TCP/BT, 28.08.2026** — added a `contract`
    section to `scripts/hardware-matrix.js` (1.13.1's mock coverage — a held session refuses
    a second connect, a disconnected one refuses a send, a second disconnect is a no-op — run
    against the real provider instead of the mock). Also fixed the harness itself: its BT
    provider had no `BtConnectionQueue` and only registered the SPP backend, so it did not
    exercise the transport the product ships (Winsock preferred, paced through the shared
    queue) — every early BT run's contract failures were that gap hammering the one RFCOMM
    channel with no cooldown at all, not a product defect.

    **USB (BBB, AAA, CCC): all pass.** **BT: the contract holds everywhere it could run** — a
    second connect while held is refused — **but most of the section never got there**,
    blocked by the still-open connect failure (2.8.16): only the first of three bricks
    completed its first connect, and its own reconnect then hit the same WSA-10060 pattern.
    **TCP: undiscoverable** — Wi-Fi has been off on every brick since the 26.08.2026
    measurement, so there is nothing to connect to, not a contract gap
- [x] **1.13 Unit tests (Mock and infrastructure)**
  - [x] 1.13.1 TransportProvider contract compliance tests (run against Mock)
  - [x] 1.13.2 Discovery scheduler tests (timing, dedup, timeout)
  - [x] 1.13.3 Presence Aggregator state machine tests
  - [x] 1.13.4 Stable ordering tests
  - [x] 1.13.5 Mock configuration **validation** tests (`validateMockConfig`); loading tests belong with 1.6.10

### Definition of Done

- runtime can simultaneously display mock and real items,
- the discovery list is stable and correctly ordered,
- mock transport passes all contract compliance tests,
- presence state transitions are fully tested,
- **antipattern cleanup**: scan the code this phase touched for code smells and anti-patterns (DRY violations, hardcoded config, silent catches, magic numbers, dead code, YAGNI, etc.); every detected issue is recorded as either fixed or explicitly accepted with a stated reason.

## 6. Phase 2 — Session Runtime and Lifecycle

### Goal

Build the source of truth for connected bricks.

### Tasks

- [x] **2.1 Session data model**
  - [x] 2.1.1 `ConnectedSession` implementation with all fields from contracts
  - [x] 2.1.2 Session identity (brickKey + transport pair)
  - [x] 2.1.3 Session metadata (display name, last error, heartbeat state)
- [x] **2.2 Session Manager**
  - [x] 2.2.1 Session store (map of active sessions)
  - [x] 2.2.2 `connect(brickKey, transport)` flow — create session, call provider, transition states
  - [x] 2.2.3 `disconnect(brickKey)` flow — call provider, drain the command queue, remove session
        (subscription teardown is deferred: the registry is 3.3.5 and the subscribe API is 4.5)
  - [x] 2.2.4 State machine enforcement (`connecting` → `connected` → `reconnecting` → `disconnected`)
  - [x] 2.2.5 Guard: only Cockpit UI can trigger connect/disconnect
  - [x] 2.2.6 Event emission on session state changes
- [x] **2.3 Foreground / background switching**
  - [x] 2.3.1 `setActiveBrick(brickKey)` — promote to foreground, demote previous
  - [x] 2.3.2 `clearActiveBrick()` — no brick is foreground (discovery tab shown)
  - [x] 2.3.3 Activity mode transitions (`foreground` ↔ `subscribed` ↔ `minimal`)
  - [x] 2.3.4 At most one foreground brick invariant
- [x] **2.4 Heartbeat**
  - [x] 2.4.1 Periodic heartbeat loop per connected session
  - [x] 2.4.2 Configurable heartbeat interval
  - [x] 2.4.3 Timeout detection — transition to `reconnecting` on missed heartbeats
  - [x] 2.4.4 Heartbeat state tracking in session model
- [x] **2.5 Reconnect logic**
  - [x] 2.5.1 Automatic reconnect on transport failure
  - [x] 2.5.2 Exponential backoff strategy
  - [x] 2.5.3 Maximum retry count or timeout
  - [x] 2.5.4 Transition to `disconnected` on permanent failure
  - [x] 2.5.5 Explicit disconnect always takes precedence over reconnect
- [x] **2.6 Command queue per brick**
  - [x] 2.6.1 FIFO queue implementation
  - [x] 2.6.2 Shared across all transport providers for the same brick
  - [x] 2.6.3 Queue depth tracking (for telemetry throttling in Phase 3)
  - [x] 2.6.4 Queue drain on disconnect
- [x] **2.7 Auto-connect suppression**
  - [x] 2.7.1 Track explicit disconnect per brick within the session
  - [x] 2.7.2 Suppress auto-connect for explicitly disconnected bricks
  - [x] 2.7.3 Reset suppression on new VS Code session
- [x] **2.8 Unit tests**
  - [x] 2.8.1 Session state machine transition tests
  - [x] 2.8.2 Connect / disconnect lifecycle tests (using Mock)
  - [x] 2.8.3 Multi-brick concurrent session tests
  - [x] 2.8.4 Foreground switching tests
  - [x] 2.8.5 Heartbeat timeout and reconnect tests
  - [x] 2.8.6 Explicit disconnect vs reconnect precedence tests
  - [x] 2.8.7 Command queue ordering and drain tests
  - [x] 2.8.8 **Hardware scenarios, 27.08.2026.** Everything above passed for months while
    three defects sat in the recovery path, because all of them needed a person to switch a
    brick off. Two harnesses now exist for the kinds of check that cannot be simulated:
    `scripts/hardware-matrix.js` (every layer against every reachable transport, no human
    needed) and `scripts/hardware-scenario.js` (one brick watched through `SessionManager`
    while someone unplugs or power-cycles it).

    What a power cycle found, all three now fixed and re-verified on the brick:

    - **A session could never recover from a link that died on its own.** A provider deletes
      its session record only in `disconnect()`, so an unexpected loss left it behind and
      `connect()` answered "already connected" to every reconnect attempt, forever. Explicit
      disconnect — the only case the tests covered — never reached that path.
    - **The bare `catch` in `attemptReconnect` hid it.** Every attempt failed identically and
      left no trace, so a stuck session looked like a brick that had not come back.
    - **Backoff overshot the brick's boot time by ~80 s.** Recovery took 121 s against a brick
      that boots in about 40; discovery now wakes a reconnecting session, and recovery lands in
      the same millisecond as the sighting.

    Why the unit suite could not have caught the first: `MockTransportProvider` implements
    `recover()` and none of the real transports do, so every session test exercised a branch
    USB never takes. **The mock diverges from the product exactly where the product broke** —
    worth remembering the next time a mock-only pass is treated as coverage.

    Measured detection latency, unchanged by the fixes: link loss is reported in 3.1 s as
    `LIBUSB_TRANSFER_NO_DEVICE` — a named cause rather than a timeout, which is what lets the
    heartbeat tell a departed brick from a busy one. Session reaches `Reconnecting` at 5.4 s.
  - [x] 2.8.9 **USB cable pulled and replaced**, 27.08.2026. A different case from a power
    cycle: the brick keeps running and only the link goes, and the two report differently —
    a departed device gives `LIBUSB_TRANSFER_NO_DEVICE` on a read, a pulled cable gives
    `LIBUSB_ERROR_IO` on a write. Both name a cause rather than timing out, which is what lets
    the heartbeat tell a lost link from a busy brick.

    Recovery worked, and worked repeatedly: three separate losses in one run, each recovered in
    the same millisecond as the discovery sighting. That repetition is the part worth having —
    a first reconnect that leaves a handle behind would have broken the second.

    Two findings from the same run:

    - The bricks were on a shared segment: handling one cable took **all three** offline
      within seven seconds of each other. Worth knowing before reading any single brick's
      instability as a brick problem.
    - **After the reconnect budget runs out, nothing ever brings the brick back** — see 2.8.10.
  - [x] 2.8.10 **Sign-in and availability are two states, not one** — settled by the owner
    27.08.2026 and written into DESIGN §6.2. The question was posed as three options for what
    to do when the reconnect budget runs out; the answer was that the budget should not exist,
    because none of the three named the quantity that decides:

    ```
    telemetry runs  ⟺  signed in  ∧  available
    ```

    Signed in is the user's intent and only the user changes it. Available is the world's and
    only discovery changes it. The old vocabulary collapsed both into "disconnect", which is
    why the behaviour was confusing to describe: **unplug** is a cable, **sign out** is a
    choice, and only the second ends a session.

    `MAX_RECONNECT_ATTEMPTS` is now unbounded. The delay still caps at `RECONNECT_MAX_MS` and
    discovery still makes an attempt immediate, so the slow tail only runs where nothing can be
    discovered. Sign-in has no persistence: it lives in the extension host's memory, so closing
    the cockpit signs everything out — which is what makes "nothing is signed in at startup" a
    rule rather than a habit.
  - [ ] 2.8.10a **Gate telemetry on the pair.** §6.2's rule is stated but not yet enforced in
    one place: telemetry should run exactly while a brick is signed in *and* available, and
    stop the moment either drops. Belongs with the telemetry runtime wiring in 3.3
  - [ ] 2.8.11 **Bluetooth cannot yet hold a session, and that blocks its scenarios.** Measured
    27.08.2026 across all three bricks, in a fresh process each time:

    ```
    attempt 1   opens          AAA 10.8 s · BBB 7.5 s · CCC 3.9 s
    attempt 2   times out
    attempt 3+  Access denied, or 1256 ERROR_HOST_DOWN
    ```

    An open succeeds once per process and then the port refuses further connections, sometimes
    taking a full minute to say so. A clean `close()` returns in **73 ms**, so the port is
    released promptly and the refusal is not ours to fix by closing harder.

    Two explanations were tried and both were wrong, which is worth recording because each
    looked convincing: first that a timed-out open poisons the port (it does not — error 121
    does not poison, and the pattern survives a fresh process), then that `close()` leaks the
    handle (it does not — 73 ms, and `PORT_CLOSE_GRACE_MS` of 500 is ample).

    What this does establish: **the adapter's open retry is wrong in kind, not in degree.**
    Three attempts 1.2 s apart cannot help against a peer that refuses for a minute. It also
    explains the matrix result where Bluetooth worked on one brick and failed on the other
    two — what mattered was which one was tried first.

    Open question, being measured: whether the refusal is a cool-down that expires, and how
    long it lasts. Until a BT session can be established twice in a row there is nothing to
    test a link *loss* against.
  - [x] 2.8.14 **Compare the two BT backends on hardware** — P7 of the re-survey brief,
    run here because the code under test is the code that ships. `scripts/bt-backend-comparison.js`
    puts Winsock and SPP through the real provider and one shared `BtConnectionQueue`, so
    every cooldown the product enforces is enforced in the measurement. Round-robin across
    all three bricks, backends alternating per round.

    Note what the existing SPP number is worth: the ~50% open rate measured 27.08.2026 came
    from a 2-second round-robin against a channel with documented 10 s and 30 s recoveries,
    so it measures the pacing violation rather than the backend. Nothing about SPP behind the
    queue is known yet, and the decision between backends is already made — this validates it
    rather than deciding it

    **Pass criteria, written before the run.** Winsock is validated when it opens at or near
    100% on **BBB and CCC** at product pacing. Judge per brick and per backend, never pooled:
    the testlab recorded in April, before any of this code existed, that **AAA has a degraded
    BT runtime on this host** — discovery works, the runtime times out opening. So an
    AAA-only failure confirms that April finding and says nothing about the backend. Only a
    broad failure across healthy bricks reopens the backend decision, which the owner and the
    testlab have already made. Fixing the interpretation in advance is the point: four BT
    diagnoses have been written after the fact and withdrawn

    **Result, 28.08.2026 — 15 attempts per backend, 13.6 minutes.** The criterion was not
    met, and the reason is not the one it was written to catch.

    | | winsock | SPP |
    |---|---|---|
    | opened | 6/15 (40%) | 7/15 (47%) |
    | round trip | 46–117 ms, median **104** | 355–948 ms, median **610** |
    | failure | `WSAETIMEDOUT` (10060) | error 121 |

    **On the round trip the two are not close: Winsock is about six times faster**, and its
    spread is tight where SPP's is not. That is the backend decision confirmed, and it is the
    half of the question that was actually about the backend.

    **On opening there is no difference worth the name.** 40% against 47% at fifteen attempts
    is noise, and both are far from usable. Per brick, Winsock failed 5/5 on CCC, 2/5 on AAA
    and 2/5 on BBB — so the pre-registered "near-100% on BBB and CCC" fails, and it fails on
    the brick the April note did *not* flag. AAA, the one that note called degraded, was
    Winsock's second-best.

    **And it retires a claim made earlier in this file.** The ~50% SPP open rate measured
    27.08.2026 at a 2-second spacing was written off as measuring the pacing violation rather
    than the backend. At 15 and 30 second spacing, through the queue, the rate is 47%. The
    pacing was not what that number measured. Whatever makes an RFCOMM connect fail here is
    untouched by waiting longer, and it is untouched by which API opens the socket — which is
    a real result, and a narrower question than the one that has been asked four times
  - [x] 2.8.15 **BT discovery no longer depends on SPP pairing artifacts**, 28.08.2026 — see
    1.11.7a. Verified against the real DLL: three bricks read out of the cache with correct
    addresses and a Class of Device of 0x000804 each, and the one non-LEGO device on this host
    correctly excluded.

    **It does not help 2.8.13, and this entry said it did for about an hour.** `szName` is
    populated only for a device Windows is currently connected to; every remembered brick
    came back with an empty name. The claim was written from reading the structure and not
    from running it, which is the same mistake as arguing about a wire instead of measuring
    it. 2.8.13 stands as it was: the name has to come from the brick or from the USB identity
  - [x] 2.8.16 **Isolate what makes an RFCOMM connect fail.** 2.8.14 established what it is
    not: not the backend (40% against 47%), and not the wait before trying (47% at 15/30 s
    against ~50% at 2 s). Instrument fixed first: `bt-backend-comparison.js` now separates
    queue wait from adapter-open time (`trackQueueWait`), so a cooldown comparison is not
    confounded with the wait it varies.

    **Measured, 28.08.2026 — one brick (CCC, `00:16:53:42:D9:F2`), Winsock only, 6 attempts
    per step, `scripts/bt-cooldown-sweep.js`:**

    | cooldown | open rate |
    |---|---|
    | 15 s | 67% |
    | 30 s | 17% |
    | 60 s | 17%\* |

    **A longer cooldown does not help, and the trend runs the other way.** That answers the
    question 2.8.11 left open — whether the refusal is a cooldown that eventually expires —
    with no: 60 s is four times the product's default and the rate is worse, not restored.
    Waiting longer is not the fix.

    **A sharper number fell out of the same run: every real failure resolved in 5.12–5.19 s**,
    not the 15 s `CONNECT_TIMEOUT_MS` ceiling our own timer would produce. That is specific
    and reproducible enough to be a real host or radio-side timeout distinct from ours —
    Windows' own answer to an RFCOMM request that goes nowhere — rather than noise. Nothing
    here identifies its source; that is the open thread 2.8.16 hands off, not a solved one.

    \* Three of the six 60 s-step attempts are not clean data: 1.11.12's ceiling-reached
    timeout defaults to 45 s, shorter than a 60 s cooldown, so it fired as a false "no slot"
    failure rather than a real WSA error. `bt-cooldown-sweep.js` now sets its own
    `acquireTimeoutMs` to `2 × stepMs` to prevent that; the two genuine WSA-10060 failures
    at that step are unaffected and still fit the pattern

  - [x] 2.8.17 **Verify pair and unpair against Windows**, 28–30.08.2026, with the owner —
    unpairing changes the machine's pairing state and pairing needs a live brick to confirm.

    `unpair()` (`forget()`) verified clean on CCC: `BluetoothRemoveDevice` returned success,
    the brick dropped out of `listBluetoothDevices()` and out of `Get-PnpDevice` in the same
    call, both checked independently.

    `pair()` did **not** verify clean, across many attempts over two sessions (one interrupted
    by a sleep/wake cycle that needed a reboot to rule out) — full account is 1.11.13's, not
    repeated here. Short version: the assumed Windows dialog never appears; the brick's own
    accept-and-PIN screen does, confirmed by the owner repeatedly, and `BluetoothAuthenticateDeviceEx`
    still returns `ERROR_ACCESS_DENIED`. Chased through a real koffi crash (found, fixed by
    upgrading to 3.1.6) to the actual cause: Windows' own Bluetooth service already holds
    this API's one callback slot, by documented design, so nothing this extension registers
    is ever the callback Windows invokes — and Event Viewer traced the failure itself to the
    kernel, at the same ~5.1–5.2 s mark every plain RFCOMM connect failure has shown all day
    (2.8.16). Pairing from the cockpit stays blocked, now for a specific, evidenced reason
    rather than an open question: a link-layer problem this host's Realtek adapter has with
    the EV3, that a Windows API slot Windows itself already owns cannot route around

    **Superseded 01.09.2026: `pair()` now does verify clean, through a different Win32/WinRT
    entry point.** `bthprops.cpl`'s `BluetoothRegisterForAuthenticationEx` was correctly
    diagnosed above as unwinnable, but that is a property of *that specific API*, not of
    pairing this brick in general. `Windows.Devices.Enumeration.DeviceInformationCustomPairing`
    (full recipe and evidence in 1.11.13) paired CCC live twice out of three attempts, the
    third being a missed on-brick confirmation, not a protocol failure. Still open: this was
    proven with a throwaway C# probe, not shipped code — the extension has no WinRT-reachable
    binding yet (koffi is C-ABI FFI; WinRT is COM/vtable-based), so turning this into a real
    `pairBluetoothDevice` implementation needs a design decision on how the extension calls
    into WinRT (most likely: a small helper process, JSON over stdio, with its own TFM/runtime
    trade-off to choose) — not yet started, and not assumed to be one evening's work

  - [ ] 2.8.18 **Ship the WinRT pairing path in the extension, not just the probe.** Needs: a
    helper-process design (TFM/runtime choice — framework-dependent vs self-contained vs
    NativeAOT, each with a different size/dependency trade-off, owner's call); the helper
    serialized against the same `BtConnectionQueue` the rest of BT already shares, so a pairing
    attempt and a connect attempt never contend for the one radio slot; a bounded retry around
    the live-inquiry step (a single 15 s window missed CCC once already); a UI prompt in place
    of the beep ("confirm on the brick's display") once this leaves manual probing

  - [ ] 2.8.12 **Remaining hardware scenarios.** For Bluetooth there are two, not one — the
    radio can be switched off **on the brick** or **on the computer**, and they are different
    failures: one is a peer that stops answering, the other is a local stack that disappears
    underneath an open handle. Then: a brick reachable over two transports losing one; Wi-Fi
    switched off mid-session on TCP. Use **CCC** for USB scenarios — its cable is the
    accessible one
  - [ ] 2.8.13 **A brick has no name over Bluetooth.** Discovery reports `EV3
    [00:16:53:42:D9:F2]` on BT and `CCC` on USB — the same brick, and nothing tells the user
    so. The identifiers are the same bytes spelled differently: the USB serial is
    `00165342D9F2` and the BT address is `00:16:53:42:D9:F2`, so a name learned on one
    transport can name the brick on the other. Needs a place for cross-transport identity to
    live; `availableTransports` on `DiscoveryItem` already implies one brick can appear twice

### Definition of Done

- multiple bricks can be connected simultaneously, up to each transport's session ceiling (DESIGN §3.3),
- switching the active brick does not interrupt other sessions,
- reconnecting one brick does not break others,
- explicit disconnect drains the command queue and removes the session
  (subscription teardown becomes testable in Phase 4 and is that phase's gate),
- all state transitions are covered by unit tests,
- **antipattern cleanup**: scan the code this phase touched for code smells and anti-patterns (DRY violations, hardcoded config, silent catches, magic numbers, dead code, YAGNI, etc.); every detected issue is recorded as either fixed or explicitly accepted with a stated reason.

## 7. Phase 3 — Telemetry and Adaptive Throttling

### Goal

Introduce a controlled telemetry architecture for Cockpit and other extensions.

### Tasks

- [ ] **3.1 Telemetry category definitions**

  **DESIGN §9.1–9.1c rewrote what telemetry is and what it costs, and the tasks numbered
  below predate it.** Three categories on their own cadence became rows on their own
  interval, and a four-command frame became one composed command. What forced it: a round
  trip costs the same whatever it carries, so a frame's price is the number of commands, not
  their content — and a full frame uses about a quarter of the 1024-byte budget, so there is
  usually nothing to leave out. **Re-read 3.1.1–3.1.5, 3.2, 3.3 and 3.8 against §9.1 before
  starting them** — the multi-engine review of 27.08.2026 found several of those written
  against the superseded shape, and 3.1.14 records what it settled.

  - [ ] 3.1.6 Row registry — every telemetry value as a row with a **tick divider**, a switch,
    a result size and a stable id in a namespace. Three lifetimes, not just an interval: off
    (divider 0), repeating (divider *n*), one-shot (first tick after connect, then retired) —
    the static tier needs *once*, which divider 0 cannot express. Registration **validates and
    refuses**: a row whose result would breach 4-byte alignment for the opcode it uses, the
    1019-byte reply ceiling, or 57 bytes of declared globals on HID fails here rather than
    corrupting a frame at runtime. Rows carry a raw type code alongside the resolved name
  - [x] 3.1.7 **Base-tick scheduler with integer dividers** — `src/telemetry/telemetryScheduler.ts`.
    One command per tick from the rows whose divider comes up. Three invariants, each of which
    the superseded due-list lacked: (a) **at most one telemetry frame in flight per brick** — a
    tick arriving while the previous frame is outstanding is *skipped*, not queued, as Device
    Manager guards with `Interlocked`; (b) **the tick is the only clock** — no per-row next-due
    state, no drift, no pulling rows forward; (c) truncation carries this tick's losers to the
    front of the next. A skipped tick is a later sample, never a gap.

    Verified against a brick, whole stack (rows → assembler → scheduler → libusb):

    - 3 s at a 100 ms tick: 27 ticks, 27 frames, 0 skipped, 0 failed, **0 replies rejected by
      the brick** — so every composed frame was legal bytecode, not just plausible;
    - dividers hold in wall-clock time: sampled rows 27 reads, occupancy rows 6, a ratio of
      4.5 against the nominal 5;
    - the occupancy gate opens and closes on real ports: only 2 (infrared, type 33) and 3
      (ultrasonic, type 30) were populated, and the value rows for the six empty ports stopped
      after their first read while the occupancy rows kept running;
    - **back-pressure holds under load**: at a 5 ms tick the link cannot serve, peak frames in
      flight stayed at **1** and the scheduler declined 32% of ticks rather than queueing them.

    Verified in unit tests that discriminate: removing the in-flight guard does not make the
    suite fail, it makes it hang, which is a stronger signal than a red assertion.

    Still open: the scheduler currently takes a `FrameSender` directly. Routing it through the
    per-brick `commandQueue` (the `telemetry:frame` command variant exists for exactly this) is
    what makes telemetry interleave with the heartbeat rather than run beside it — 3.3
  - [ ] 3.1.7a **Mock telemetry has no answer.** `MockTransportProvider` refuses a
    `telemetry:frame` because it dispatches typed commands and a composed frame is bytecode.
    Refusing is right — a plausible-looking buffer would be parsed into numbers that came from
    nowhere — but it leaves the mock unable to serve the panel. Either give the mock a small
    bytecode interpreter, or let the scheduler take a row-level fake for mock sessions
  - [ ] 3.1.8 Frame assembler — owns global-buffer offsets. Lays out 32-bit results 4-byte
    aligned, because `opINPUT_READSI` (the opcode we use) rejects an unaligned one and answers
    `DIRECT_REPLY_ERROR` carrying the previous buffer. The constraint is per opcode, not
    global: `opINPUT_DEVICE`/`READY_SI` accepts the same unaligned offset, which is how
    LEGOev3's layout works. Both measured 3/3 — see the table in §9.1b.
    Bounds the **declaration** as well as the bytecode: usable globals are 1019 B, not the
    1021 B of `MAX_COMMAND_GLOBALS`, because the reply is globals + 5 B and the firmware never
    checks it. Mode ownership is **per device across frames**, not a per-frame check: at most
    one active mode row per port at any time, with an explicit switch-and-settle policy
    (change mode, discard readings until non-NAN). A per-frame-only refusal just relocates the
    conflict into alternating frames, where each frame forces a mode change and both rows read
    NAN indefinitely. Two reads of the *same* mode are not a conflict — LEGOev3 takes SI, RAW
    and PCT off one port in one frame
  - [ ] 3.1.9 Truncation rule for the HID fallback — 64 bytes fits about nine instructions,
    and it must bound both sides: request bytecode ≤ packet size − 7 (the direct-command
    header) **and** declared globals ≤ packet size − 5. Alignment padding can breach the second
    before the first. Pending 3.1.13, treat an over-long reply as unsupported rather than
    assuming it fragments. Truncation is **rotating, not static**: a row that loses a tick goes
    to the front of the next one. Static priority on a tight budget starves the losers for
    good — with the old mandatory eight-port type sweep costing ~48 of 57 bytes it would have
    shipped a panel that showed ports appearing and disappearing but never a sensor value.
    Occupancy is now a row (3.1.11), which frees the budget, but a user with eight populated
    ports on HID can still overrun a tick, so the rule holds regardless. A test must fill a
    tick past the HID budget and assert every row is eventually served
  - [ ] 3.1.10 Effective interval = the fastest any subscriber asks for, **clamped to the
    transport floor** and reported back: `subscribeTelemetry` returns the interval each row was
    actually granted, because a request is not a guarantee — 10 Hz on Bluetooth would eat the
    brick's whole measured 10.7 commands/second. Subscribers hold an opaque handle, so
    unsubscribing releases one claim and the effective interval is recomputed from the rest.
    That is what makes the promise real: the panel's switches are the cockpit's own
    subscription, so switching a row off must not take it from a dependent extension
  - [ ] 3.1.11 Port state in the read model and the panel: empty (126), identifying (125),
    known, error (127), terminal (124); anything else ≥124 shows as not-readable. The value is
    read only in the *known* state. **Occupancy is a row with its own divider, not a mandatory
    header on every frame** — it is what gates the value rows, so their inclusion decision uses
    the state from the previous tick. State the two consequences in the model's docs: a freshly
    known port shows no value for one extra tick, and a just-emptied port had a slot allocated
    in the frame already in flight. Accept deliberately that a hot-plug is noticed when the
    occupancy row next comes up, not instantly — invisible next to the 1–2 s the device spends
    reporting 125 anyway. `GET_TYPEMODE` never blocks, so the occupancy row is safe at any
    divider; the value read is the one that can stall for 1.2 s (§9.1c)
  - [x] 3.1.12 **Composed frame measured** over libusb, through the real assembler and the
    real row catalogue, with a one-row control in the same run:

    | Rows | Request | Reply | Median |
    |---|---|---|---|
    | 1 | 10 B | 6 B | 10.1 ms |
    | 3 | 25 B | 17 B | 10.9 ms |
    | 14 (sampled tier) | 77 B | 43 B | 10.9 ms |
    | 26 (everything) | 159 B | 96 B | 11.9 ms |

    Twenty-six times the values for 18% more time, so §9.1's central claim holds and is now
    measured rather than extrapolated from a 3-to-16 comparison. The projection it replaces
    (~250 B/~120 B) was high by more than half on the request.

    The control earned its place: the same brick measured 6.0 ms on 26.08, so without a
    one-row baseline in the same run the full frame would have read as twice the cost of a
    narrow command instead of marginally more. Brick state taxes the round trip (§4.5), and
    that tax is larger than the width effect being measured.

    On the 64-byte HID budget the same catalogue places **11 rows of 26** (62 B request,
    40 B reply). Reply payload matched declared globals exactly in every frame, confirming
    reply = declared globals + 5. Still to do on TCP and BT, and once the BT provider is
    wired (3.1.4d)
  - [ ] 3.1.13 **Measure what HID does with an over-long reply.** The reply on the wire is
    always declared globals + 5 B and the firmware never checks it against `MAX_MSG_SIZE`, so a
    frame that satisfies the instruction budget can still declare more globals than a 64-byte
    HID read can carry. Determine whether the firmware fragments such a reply across reports or
    truncates it, then fix the truncation rule in 3.1.9 to bound the declaration as well as the
    bytecode. Our `ports` reply is 48 B and has never crossed the boundary, so this is untested
    rather than known-good
  - [x] 3.1.14 **Three linked decisions the multi-engine review of 27.08.2026 raised, settled
    by the owner the same day.** Recorded here because they changed 3.1.6–3.1.11 and several
    Phase 3 tasks, and because a later reader will want to know these were chosen rather than
    drifted into.

    1. *Is the type sweep mandatory every frame?* **No — occupancy is an event-ish row with
       its own divider.** §9.1a said event-ish, §9.1c said every frame, and on the 64-byte HID
       path the sweep cost ~48 of 57 bytes, leaving room for one value and starving every other
       row permanently. Two vendors reported that independently as the review's only blocker.
       Accepted cost: a hot-plug is noticed when the occupancy row next comes up. Landed in
       §9.1a, §9.1c, 3.1.9, 3.1.11.
    2. *Due-list, or a base tick with dividers?* **Base tick with integer dividers**, at most
       one frame in flight, next tick skipped rather than queued while one is outstanding. Both
       mature references do this — Device Manager 200 ms with `_checkDeviceInfoCounter = 5` and
       an `Interlocked` re-entrancy guard, LEGOev3 awaiting each reply before its delay, which
       makes its "100 ms" a gap and not a period. The due-list fired on wall-clock against a
       serial queue with nothing to stop frames piling up until the heartbeat missed its window
       and tripped reconnect on a healthy brick. Greedy pull-forward from future ticks is
       dropped with it; wide composition *within* a tick stays, and the slow tier keeps its own
       command. Landed in §4.4, §9.1b, §9.5, 3.1.7.
    3. *Rows or categories as the public surface?* **Rows.** Categories survive only as a
       convenience bundle expanded at subscribe time, never as a unit of cadence. Rows gained
       what they needed to be a contract: stable ids in a namespace, `apiVersion`,
       per-row `sampledAt`, a granted interval returned from subscribe (a request is not a
       guarantee — 10 Hz on Bluetooth would consume the brick's entire 10.7 cmd/s), subscriber
       handles with an unsubscribe path, and registration that *refuses* a row breaching
       alignment or buffer limits rather than publishing those limits as API. Landed in §9.1a,
       §9.3, §9.6, §5.4, §10.2, 3.1.6, 3.1.10.

    **Superseded by (3):** 3.2.1, 3.2.2 and 3.3.5 are written against per-category
    subscriptions and snapshots. Rewrite them against rows before implementing.

    Full findings matrix — 25 clusters with verdicts, five vendors, and what was rejected and
    why — in the review notes at `.notes/zápisky/2026-08-27 Multi-oponentní review
    telemetrického návrhu.md`.

  - [ ] 3.1.1 `ports` category — sensor types, motor types, port mapping, measured values
  - [x] 3.1.4a Device-type codes corrected against the firmware, and the `ports` command
    made to read a value at all. Four defects, none of which any test could see:
    - **Two type codes were misnamed.** 16 was `color` and 29 was `color-v2`; 16 is the EV3
      **touch** sensor (firmware `typedata.rcf`: `16 0 TOUCH`) and 29 is the colour sensor
      (`LEGO_EV3_COLOR_TYPE_ID 29` in the ev3dev driver). A brick with a touch sensor
      plugged in therefore reported a colour sensor, and no touch sensor anywhere. Code 1 is
      `NXT-TOUCH` and is now named as such
    - **Sensor values were read with the wrong opcode.** `INPUT_READ_SI` held 0x9A, which is
      `opINPUT_READ` — output parameter `PAR8`, one percent byte. `opINPUT_READSI` is 0x9D
      with `PARF`. The parser read four bytes as a float from a slot the firmware filled one
      byte of, so every sensor value was three bytes of the previous command's leftovers
    - **The firmware does not clear the global buffer.** The unwritten bytes were legible
      ASCII on the wire. Presence must come from the type code and never from the value: a
      brick with no motors at all returns four tacho zeros
    - **125 and 127 were unhandled.** `TYPE_UNKNOWN` ("port not empty but type has not been
      determined") and `TYPE_ERROR`. 125 is not exotic — every sensor plugged in while
      running reports it for a second or two, seen on all three bricks

    Verified on hardware by moving each device and watching the value change: touch 0↔1,
    ultrasonic 3–255 cm, infrared 0–100, colour 0–89 %, gyro −56–+57°, and four motors
    across −243–+212°. Three bricks at once, two firmware versions (V1.10E and V1.09H),
    zero read errors over six minutes
  - [x] 3.1.4c **Telemetry verified identical over USB and TCP**, on the same brick read
    both ways within one run: port map, device types, presence, firmware and button state
    all matched, at 39 frames/s over USB and 43 over TCP. TCP was found by beacon discovery
    rather than by being handed an address. Note for anyone writing a one-shot scan: beacon
    discovery is cache-based and each `discover()` re-primes the path, so a single call
    followed by a long wait comes back empty even with a brick present — poll it.
  - [x] 3.1.4d **BT provider wired** — `src/transports/btSppDiscovery.ts`. `BtSppBackend`
    supplies both halves the provider was missing: a discovery function and an `spp` adapter
    factory. Windows exposes a paired peer as an outgoing COM port whose PnP id carries the
    peer's address, so one enumeration answers "which bricks are paired" and "which port
    reaches each" together — which is why the two live in one object sharing a map, the
    factory being handed only a MAC.

    Deliberate limits, each with a test: the address pattern includes the LEGO OUI so a paired
    headset is not opened as a brick; `connected` is always reported false because a port list
    cannot know whether a link is up, and claiming otherwise would make presence assert a live
    brick from a pairing record; a MAC no scan has seen is refused rather than guessed at.
    Nothing here pairs anything — that is the user's action on their own machine.

    **Not yet exercised against hardware.** No brick is currently paired to this computer:
    the Bluetooth records for all three were deleted on 27.08 and only brick-to-brick pairings
    were made afterward. `SerialPort.list()` returns nothing, and the only Bluetooth peer the
    host knows is a headset. Needs one brick paired with the PC before the BT column of 3.1.4c
    and 3.1.12 can be filled in
  - [ ] 3.1.4e **Round-trip cost is per brick, not per transport — and that un-gates 3.4.**
    Same command, same USB transport, three bricks, 40 reads each. This table is the
    measurement **before** the two anomalies were isolated; the findings below supersede
    its explanations, not its numbers:

    | Brick | median | p95 | note |
    |---|---|---|---|
    | BBB | 6.0 ms | 6.3 ms | tight |
    | CCC | 5.0 ms | **41.0 ms** | fat tail, firmware V1.09H |
    | AAA | **26.0 ms** | 30.1 ms | the brick on Wi-Fi |

    **`ports` costs the same as `battery`** — 16 sub-operations against 3 — so the cost is
    the round trip and batching a telemetry frame into one command is nearly free, which is
    3.1.5's premise confirmed.

    Both anomalies were then isolated, and they are two different phenomena:

    - **An active Wi-Fi stack costs the brick 4× its command throughput.** Switching Wi-Fi
      off in software, with the adapter still physically fitted, took that brick from a
      26 ms median to 6.0 ms — indistinguishable from the others. The tax is the running
      radio and network stack, not the presence of the dongle.
    - **The brick's own on-screen port monitor blocks the command channel.** With Wi-Fi off
      everywhere, the one brick with Port View open showed 17 slow reads in 300 (5.7%),
      spaced a median of **138 ms** apart (range 127–148, a timer rather than jitter) and
      costing ~34 ms each, while the other two showed none. Moving the monitor moved the
      stalls exactly: with it switched off there and on on the other two, that brick went
      to **0 of 300** and the other two to 19 and 17, at 141 and 139 ms. A crossover, so the
      cause is identified rather than correlated — and firmware version is ruled out, since
      the V1.09H brick is the clean one in the second run.

      The mechanism matters more than the number: **the brick polls its own sensors to draw
      that screen, and the host's telemetry competes with it for the same processing.** Its
      median stays 6.0 ms either way — it is not slow, it is intermittently blocked, ~7
      times a second.

    For 3.4 this settles the shape of the problem: **a median-based throttler would see
    nothing wrong** on the stalling brick, since its median matches a healthy one. Only a
    tail-aware measure (p95, or a stall counter) distinguishes them, and the input is the
    brick's own state rather than queue depth or transport latency as DESIGN §4.5 assumed.
    At a 10 Hz telemetry loop that brick would hit a stall roughly every twentieth frame
  - [ ] 3.1.4f **Daisy chain: sensors cross it, motors do not.** Three bricks chained over
    USB, verified 23.08.2026. From the host a chained brick is addressed by the `LAYER`
    argument of an ordinary direct command — the master's firmware does the routing, and no
    daisy-specific command type is needed.

    | | layer 0 (master) | layer 1 | layer 2 |
    |---|---|---|---|
    | sensor type | correct | correct | correct |
    | sensor value | live | live | live |
    | motor occupancy | correct | correct | correct |
    | motor type | correct | **correct** | wrong in the one test so far |
    | motor tacho | live | **always 111616** | **always 111616** |

    The one thing that never crosses is the **tacho**. Everything else does, at least one
    hop: with a large motor on A and a medium on B of the layer-1 brick, layer 1 reported
    exactly that — two different types on two different ports — while layer 2, by then
    empty, correctly reported nothing. Both motors nonetheless read 111616, which two
    physically different motors cannot share.

    An earlier version of this entry claimed the remote motor type was always 8. That was
    wrong, and the mistake is worth keeping: at the time the only remote motors sat on layer
    2, where one of two types did come back wrong (a large motor read as medium). Reading a
    constant out of a single wrong sample is the same error as reading a value out of a
    stale buffer. **Layer 2's motor type is still unconfirmed** — it needs a motor put back
    on the last brick, ideally one whose type differs from anything on layer 1.

    Not an artefact of reading order or of a stale buffer, which was the first hypothesis:
    reading layer 0 immediately before layer 2 still yields 111616 rather than layer 0's
    values, and two consecutive layer-2 reads agree. `opOUTPUT_READ`, a different opcode
    verified working on layer 0 in the same run, returns zeros for every port on both remote
    layers. Every motor was turned by hand; layer 0 tracked it (C 231→381, D 265→382) and
    the remote layers did not move by a unit.

    This contradicts the Hardware Developer Kit, which says all 16 motor and 16 sensor
    values refresh on the master about every 100 ms — and the firmware source agrees with
    the documentation, which is what makes the tacho interesting. The relay is fully
    implemented: `DAISY_MAX_SENSORS_PER_LAYER` is four inputs **plus four outputs**, the
    slave's push loop cycles all eight, ports 16–19 normalise to indexes 4–7 on both sides,
    and the master's read copies status, type, mode **and** the data payload. Locally a
    slave answers an output query with `OutputInstance.pMotor[…].TachoSensor`, the real
    counter.

    Hypothesis for why the counter alone is dead, unconfirmed and not resolvable from
    source: a slave runs no program — the hardware kit says the slaves "will not be
    executing any individual program but instead be executing individual designated
    commands" — so its output module may never refresh `pMotor`, leaving whatever value it
    powered up with. Type and mode are static properties and survive; the counter is not.
    Consistent with that, the frozen figure is not a fixed constant: it changed from 111616
    to 43192 when the motors were rewired and the chain resynchronised, then froze again.

  - [x] 3.1.4i **Writing to a remote motor works; only reading is broken.** Driving layer 1's
    ports A and B with `opOUTPUT_TIME_SPEED` turned both motors — confirmed by eye, eight
    alternating bursts, starting and stopping together. The counter still reported the same
    frozen number throughout.

    So the daisy chain is **asymmetric**: commands go down and are executed, sensor readings
    come back up, and motor state does not. For the cockpit that means a chained brick's
    motors can be controlled but never observed — a UI must not offer a position readout for
    them, and any close-the-loop operation (move to an angle, wait until stopped) is
    impossible on a remote layer with this firmware.

    The port argument of the output ops is a **bitfield** (0x01=A … 0x08=D), unlike the
    single-port index that `opOUTPUT_GET_COUNT` takes. Verified before trusting the remote
    result by driving the master's own port C with 0x04 and watching its live counter move
    231 → 527 while port D stayed put — without that control, a motionless remote motor
    would not have distinguished a broken chain from a malformed command.

    **Firmware mismatch is ruled out.** Layer 1 runs V1.10E, the same build as the master,
    and behaves exactly like the V1.09H brick on layer 2: `opOUTPUT_READ` returns zeros for
    all four ports on both. Moving a motor between bricks changed nothing either — and the
    two remote layers then reported **byte-identical** motor data (both a `medium-motor` on
    port B with the same 111616), which two different bricks cannot legitimately produce.
    Whatever the master answers for a remote layer's outputs, it is not a reading of that
    brick.

  - [ ] 3.1.4g **Daisy chain changes what discovery sees, and `brickKey` cannot express it.**
    With three bricks chained, USB discovery reports **one** — only the master keeps its
    client port free. The other two are reachable only as layers 1 and 2 of that connection.
    Today `brickKey` is `transport:id` and every command hardcodes layer 0, so the cockpit
    can neither list nor address a chained brick. Needs a design decision: does a layer
    become part of the key, a property of the session, or a separate concept?

  - [ ] 3.1.4h **A 32-bit global must start on a 4-byte boundary.** It *is* documented, in
    the Communication Developer Kit's opening section on direct commands — "Offset in the
    response buffer (global variables) must be aligned (float/32bits first and 8 bits last)"
    — which was found only after three probes had been debugged the hard way. The opcode
    table and the Firmware Kit were read; the Communication Kit's prose was not. A command whose `PAR32` output lands on an
    unaligned offset is not executed at all — and the brick answers with the **previous
    command's global buffer**, which reads as plausible data rather than as an error. The
    shipped commands happen to comply (SI floats at 16/20/24/28, tachos at 32/36/40/44), so
    nothing was broken; anything new that allocates globals must keep to it.

  - [ ] 3.1.4j **A Bluetooth brick-to-brick link is not a daisy chain, and carries no ports
    at all.** With the master on USB and a second brick joined over Bluetooth, layers 1–3
    read empty — no sensors, no motors, nothing — while the same bricks over a USB chain had
    filled layer 1 and 2. That is by design rather than a fault: the Hardware Kit scopes
    daisy chaining to USB, `c_daisy.c` is written directly against libusb, and the
    brick-to-brick Bluetooth facility is `opMailbox_Write`, which addresses **a brick by
    name** and carries application messages between running programs. Ports are not part of
    it. A Bluetooth-linked brick is therefore invisible to the host through the master and
    must be connected to directly.

  - [ ] 3.1.4k **The brick keeps its own pairing list, and forgetting on Windows does not
    touch it.** After every trace of the bricks was removed from Windows — PnP nodes, the
    `BTHPORT` pairing keys, the COM reservations — the master still listed the PC in its own
    paired devices. Whatever 6.6.x implements as "forget" has to clear **both sides**, or a
    brick keeps offering a stale peer that the host no longer knows.

    `opCOM_GET` answers this directly and is worth wiring for the `system` telemetry
    category (3.1.3), which already lists BT visibility: `GET_ON_OFF` (1), `GET_VISIBLE` (2),
    `CONNEC_ITEMS` (17), `FAVOUR_ITEMS` (10) and `FAVOUR_ITEM` (11), with HARDWARE = 2 for
    Bluetooth. `FAVOUR_ITEM` returns a name plus paired/connected/type bytes and reads
    cleanly. `CONNEC_ITEM` (18) returned filler on the first attempt, so its parameter shape
    differs from `FAVOUR_ITEM`'s and is still unknown — the connected count from
    `CONNEC_ITEMS` was correct, and the per-item detail is available from the paired list's
    `connected` flag anyway.

  - [ ] 3.1.4l **A one-sided pairing record blocks re-pairing, and renaming a brick strands
    it.** A brick that could not join the others turned out to hold a pairing entry for the
    intended master under the master's **previous** name, while the master held no record of
    it at all. Every transaction between the two then failed: the remote name request came
    back as the firmware's `"????"` marker (`c_bt.c` writes that literal when the request
    returns a non-zero status, so it means *lookup failed*, not *unnamed*), `SET_CONNECTION`
    did nothing, and pairing from the brick's own UI left its checkbox unticked. Ruled out:
    the master being busy — dropping its existing link changed nothing.

    Two lessons for 6.6.x, both about "forget". A pairing has to be cleared on **both**
    sides or the stale half poisons the next attempt, and a **rename leaves peers holding
    the old name** — which matters because `SET_CONNECTION` addresses a peer by name, so a
    renamed brick becomes unreachable to a peer that still remembers the old one.

    Clearing the stale record fixed the name lookup: the same device that had read `"????"`
    from that brick resolved to its real name on the next search. So the poisoned pairing
    was blocking discovery itself, not only the connection.

    Two claims made along the way turned out to be wrong, both from probes rather than from
    the bricks. "A brick that already holds a link cannot be discovered" was never actually
    tested — the search that produced the negative result was the broken one below. And
    "`SET_SEARCH` from a direct command does not populate the list" was a **too-short wait**:
    the list was read after 15 s and found empty, and the entries appeared later. Bluetooth
    inquiry plus name resolution wants tens of seconds, so any host-driven search in the
    cockpit needs a patient timeout rather than a single poll.

    `SEARCH_ITEM` takes **five** output parameters — name, paired, connected, type and
    visible — where `FAVOUR_ITEM` takes four. Passing the four-output form to both returns
    plausible-looking rubbish (a truncated name and wrong flags) rather than an error.

  - [ ] 3.1.4b **A UART sensor cannot be read in two modes in one command.** Asking for a
    mode other than the current one returns `DATAF_NAN` and the sensor stays NaN while it
    settles — including in the mode that worked a moment earlier. Mode switching therefore
    needs a settling policy, and 3.1.5's batching cannot span modes of one device
  - [ ] 3.1.4 `PeripheralType` enum in `src/contracts/` — the EV3 device-type codes the brick actually reports, plus explicit `none` and `unknown`. `PortState.peripheralType` is a bare `string` today while every other domain concept is an enum, and Phase 4 exports it to third parties as a de-facto contract. Measured scope of the divergence: **motors already agree** (both sides say `large-motor`, confirmed on hardware), it is the **sensors** that differ — the protocol maps device codes to `touch`/`color`/`ultrasonic` while the mock config uses `touch-sensor`/`color-sensor`/`ultrasonic-sensor`
  - [ ] 3.1.5 Batch the foreground frame into one multi-opcode command. All three transports are now measured (USB 9 ms, TCP 58 ms, BT 121 ms worst case), which retires the original premise that the *transport* makes the frame rate unusable — but promotes this task rather than closing it. The binding constraint is the brick's own sustained rate, measured in §9.2: 176 commands/second on USB, 62 on TCP, **10.7 on Bluetooth**. At four commands per frame Bluetooth gives under 3 Hz with nothing left for the heartbeat, and batching is what buys that back. The earlier version of this task cited a `MAX_COMMANDS_PER_SEC = 10` guard in §4.1 as the binding constraint; §4.1 now specifies a ≤200/s backstop that is deliberately not a meter on normal traffic, and §9.2 retracted the 10 as a figure that came from nowhere and is 17x low on USB. The open question that followed from that guard — whether its budget counted the heartbeat — is moot under a backstop and is withdrawn.
  - [ ] 3.1.2 `filesystem` category — filesystem state relevant to API consumers
  - [ ] 3.1.3 `system` category — firmware version, battery, available transports, BT visibility
- [ ] **3.2 Telemetry data models**
  - [ ] 3.2.1 `TelemetrySnapshot` — **rewrite against rows before implementing** (3.1.14 (3)):
    a set of row values, each carrying its own `sampledAt`, because rows in one snapshot come
    from different ticks. Typed row values, not a `data: unknown` payload
  - [ ] 3.2.2 `TelemetryEvent` — **rewrite against rows before implementing** (3.1.14 (3)):
    the rows that changed. Add `TelemetryRow` (id, value type, unit, raw type code) and
    `TelemetrySubscription` (handle plus the interval each row was granted)
  - [ ] 3.2.3 Per-port value model (peripheral type, value, unit, timestamp). Port identity must
    carry the **daisy-chain layer** (0–3), not just the port number: 3.1.4j–3.1.4l measured that
    sensor types and values relay across a chain while motor tacho does not, so a port is only
    identified by layer *and* number. Keep the raw type code alongside the resolved name — a
    closed vocabulary throws away the one thing a consumer could use to recognise a device we
    have never heard of
  - [ ] 3.2.4 Extend `BrickCommand`/`ev3Commands`/`ev3Responses` with a brick-name **write** command. The union is read-only for device state today, yet 5.7.2 and DESIGN §12.3 make renaming mandatory. The opcode is known: `opCOM_SET` (0xD4) with `SET_BRICKNAME` (0x08), both already declared in `ev3Packet.ts`; the read side (1.7.10) confirms the matching getter works
  - [ ] 3.2.5 Define one canonical peripheral-type vocabulary. The protocol layer emits `touch`/`color`/`ultrasonic`, the mock emits `touch-sensor`/`color-sensor`/`ultrasonic-sensor`; Phase 3 detection and Phase 5 visual styles would inherit both
- [ ] **3.3 Telemetry scheduler**
  - [ ] 3.3.1 Foreground loop — fastest frequency, full `ports` + `system` data
  - [ ] 3.3.2 Subscribed loop — per-category, reduced frequency
  - [ ] 3.3.3 Minimal loop — heartbeat only, no extended telemetry
  - [ ] 3.3.4 Mode switching on foreground/background transitions
  - [ ] 3.3.5 Subscription registry — **rewrite against rows before implementing**
    (3.1.14 (3)): track claims on *rows* per brick, each keyed by an opaque subscriber handle,
    so releasing one claim recomputes the effective interval from those that remain. A registry
    keyed on categories cannot honour 3.1.10
- [ ] **3.4 Adaptive Throttling** — **gated**: before building this, record in DESIGN §4.5 the concrete degradation this prevents (brick count, subscription mix, observable symptom) and reproduce it. Both inputs the design names have near-zero dynamic range against the serial per-brick queue — latency sits at the transport's constant RTT and depth stays at 0 or 1 unless the scheduler out-runs the brick — so the throttler would mostly measure its own arrival rate. If it cannot be reproduced, that is a finding to take back to REQUIREMENTS §8 ("telemetry frequency must adapt to actual transport latency and queue depth") as a proposed change — not a licence to drop adaptivity unilaterally, since the phase gate and the requirement both still demand it
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
- [ ] **3.8 Per-mode timing constants** — base interval for `foreground`/`subscribed`/`minimal`, min/max clamp, a **per-transport foreground target and floor** (DESIGN §9.2), latency and queue-depth thresholds, placed alongside the empirical values in
  `transportConstants.ts`. Derive them from the **measured sustained rates** in DESIGN §9.2 — USB 176 cmd/s, TCP 62 cmd/s, BT 10.7 cmd/s — with the worst-case round trips (USB 9 ms, TCP 58 ms, BT 121 ms) as the lower-bound check. Bluetooth is the case that constrains the design: a floor must leave headroom for the heartbeat and for user commands, so the foreground target there cannot approach 10 Hz. Do **not** seed these from `MAX_COMMANDS_PER_SEC` or `COMMAND_RTT_MS`: the first was retracted in §9.2, and the second was pessimistic by ~50x on USB and is being replaced by the measurements, not read.

### Definition of Done

- foreground brick has the fastest telemetry,
- subscribed brick receives telemetry only while a subscription is active,
- minimal brick maintains only heartbeat and reconnect,
- the telemetry scheduler sustains concurrent per-brick subscriptions in the multi-brick
  test (3.7.6) without starving the foreground loop,
- adaptive throttling demonstrably scales frequency based on load,
- **antipattern cleanup**: scan the code this phase touched for code smells and anti-patterns (DRY violations, hardcoded config, silent catches, magic numbers, dead code, YAGNI, etc.); every detected issue is recorded as either fixed or explicitly accepted with a stated reason.

## 8. Phase 4 — Public API and Filesystem Services

### Goal

Export a stable API for other extensions without giving them direct access to the physical lifecycle.

### Tasks

- [x] **4.1 API surface type definitions** — all six already exist in `src/contracts/api.ts`
  - [x] 4.1.1 `ConnectedBrickSnapshot` — public representation of a connected brick
  - [x] 4.1.2 `BrickStateChangeEvent` — state transition event for consumers
  - [x] 4.1.3 `ActiveBrickSnapshot` — currently active brick or null
  - [x] 4.1.4 `TelemetrySnapshot` (API version) — category-specific data snapshot
  - [x] 4.1.5 `TelemetryEvent` (API version) — incremental telemetry update
  - [x] 4.1.6 `FilesystemEvent` — filesystem operation result
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
- [ ] **4.6 Filesystem services** — scope and behaviour are settled in
  `docs/plans/2026-08-20-1740-feat-filesystem-layer-plan.md`; the protocol survey behind it is
  `docs/ideation/2026-08-20-filesystem-protocol-survey.md`. That contract replaces the five
  operations this section used to list, which came from what seemed obvious rather than from
  what the protocol offers
  - [ ] 4.6.1 `FileTransferService` above the command layer — chunked upload and download via
    `CONTINUE_DOWNLOAD` / `CONTINUE_UPLOAD`, which are declared but never sent today, so
    `fs:write` drops content and `fs:read` truncates while both report success (R1)
  - [ ] 4.6.2 Progress reporting and cancellation, no size ceiling — Bluetooth is bandwidth-bound
    at ~11 KB/s, and whether a slow transfer is worth waiting for is the consumer's call (R2, R3)
  - [ ] 4.6.3 Stall detection per transport — replaces the total-time deadline this plan called
    1.8.5b: with progress visible, “no progress for N seconds” is the signal that matters (R3)
  - [ ] 4.6.4 Per-transport chunk size — USB takes the report payload; TCP and BT take the largest
    the firmware accepts, which is unmeasured (R4)
  - [x] 4.6.5 `list` with `CONTINUE_LIST_FILES` paging, typed entries carrying the byte
    size and checksum the brick already includes per file (R5)
  - [x] 4.6.6 `read` for a file of any size (R6)
  - [x] 4.6.7 `exists` from `opFILENAME/EXIST` instead of listing the parent and searching (R7)
  - [x] 4.6.8 `size` from `opFILENAME/TOTALSIZE`, which reports **kilobytes** rounded up
    and a zero file count for a plain file; storage from `opMEMORY_USAGE`, since
    `opFILE/GET_POOL` allocates an image pool and reports nothing about storage (R8, R9)
  - [x] 4.6.9 `move` — `opFILE/MOVE` turned out to be `cp -r`, so this is copy-then-delete
    and cannot be atomic; the failure path says both copies exist. Blocked over USB: the
    command carries two paths and a HID write delivers 64 bytes (R10)
  - [x] 4.6.10 `makeDirectory`, `remove` and `removeTree` — a populated directory is refused
    with an error naming the reason, because the firmware reports ENOTEMPTY as
    NO_PERMISSION; recursive removal is `opFILE/REMOVE` and never the default (R11, R12)
  - [x] 4.6.11 Path length guard — the firmware truncates a path silently at 60 bytes, so an
    over-length path must be rejected before a packet is sent or the brick acts on a different
    path than the caller named (R13)
  - [x] 4.6.14 Wired into `extension.ts` via `createBrickFilesystem`, which binds both
    services to one brick over the session manager's queued send and derives the
    per-transport packet cap from the brick key. Two palette commands (DESIGN §14:
    diagnostics, not primary UX) give the layer a caller before the API and panel
    exist, and a host test asserts they are both declared and registered
  - [x] 4.6.15 libusb backend for USB — was **a correctness requirement, not only a
    throughput one**: a HID write delivers 64 bytes, which caps any single command, so
    `copy` and `move` (two paths, and a stock project path is 25 characters) could not be
    sent over USB at all. `UsbLibusbAdapter` goes straight at the interrupt endpoints and
    reaches the firmware's full 1024-byte frame. Verified against hardware through the
    shipped stack — provider, session manager, `createBrickFilesystem` — rather than
    through a probe: `copy` and `move` both execute byte-identical, a 600-byte file goes in
    one packet, and 64 KB moves at **201 KB/s written and 325 KB/s read**, against 6.8 KB/s
    over HID. Four findings worth keeping:
    - The 64-byte ceiling is a **defect in the brick's HID report descriptor**, which
      declares `Report Count 0` for both reports while its endpoints advertise 1024. It was
      never a `node-hid` limitation and nothing above HID could have lifted it
    - A libusb interrupt transfer must be **exactly** `wMaxPacketSize`; a 16-byte write
      fails with `LIBUSB_ERROR_IO` and the same packet padded to 1024 succeeds. Reads come
      back full-length too, so a reply is found by its length prefix
    - `maxPacketBytes` had to become a property of the **live link**, travelling adapter →
      provider → session → filesystem. Reaching a full frame alone would have fixed
      `copy`/`move` while leaving every transfer chunked to 64 bytes, silently
    - USB is now the **fastest** transport for bulk work by a factor of five, inverting the
      ranking a second time and in the opposite direction (DESIGN §4.1)
  - [ ] 4.6.16 Unverified on the libusb path: the Linux backend (padding should be
    harmless, but has not been run) and recovery from unplugging mid-transfer
  - [x] 4.6.12 Mock parity — also corrected a divergence nothing had noticed: the mock
    listed full paths, a shape no brick produces. It now returns bare names with kinds
    and sizes, tracks directories explicitly so an empty one is representable, and
    refuses to delete a populated directory. — partial-transfer failure, cancellation, populated-directory refusal,
    and over-length path rejection all reproducible against the mock (R15)
  - [ ] 4.6.13 Declare the remaining system commands and `opFILE` / `opFILENAME` subcodes the
    survey found, including `BEGIN_GETFILE` / `CONTINUE_GETFILE`. Log tailing itself is deferred
    until a consumer wants it, but the opcodes are recorded so the capability is not lost again
- [ ] **4.9 Consumer requirements from the sibling projects** — `ev3-native` and
  `ev3-explorer` both consume this API, and neither can work with what §10.2 listed. The
  `ev3://` scheme is deliberately **not** here: it is a VS Code UI-integration surface and
  `ev3-explorer` registers it over this API (DESIGN §4.6a)
  - [ ] 4.9.1 Expose program control on the API surface, over the service built in 4.7a
  - [ ] 4.9.2 Expose the safe/full mode policy, so a consumer can honour `ev3-explorer`'s
    “no side channel around the guardrails” rule instead of reimplementing the policy.
    Required because the enforcement point (`ev3://`) ships in a consumer
  - [ ] 4.9.3 Decide the brick-identity shape in the API. `ev3-native`'s design assumes an
    `'active'` sentinel (`api.uploadFile('active', …)`) alongside explicit ids; the cockpit
    models the active brick as state, so a sentinel and a key are not interchangeable
  - [ ] 4.9.4 Reconcile `ev3-native/design.md` §3 against this cockpit. It describes
    capabilities that do not exist — “Registruje 45+ VS Code příkazů”, program start/stop —
    and an internal contradiction of its own: §3.2 channel 3 calls `api.uploadFile()` while
    the §3.3 workflow diagram routes upload through `ev3://`
- [ ] **4.7a Program control service** — a peer of the filesystem and telemetry services on
  the service tier (DESIGN §4.3b), not part of the API. It earns a service because running a
  program is not one command: the image is loaded first and its address flows into the start
  call, and run state has to be polled because the brick does not push it
  - [ ] 4.7a.1 `runProgram` — `opFILE/LOAD_IMAGE` (subcode 8) for the slot and image
    address, then `opPROGRAM_START(slot, imageAddress, imageSize, debugFlag)`. Verify the
    argument order against `bytecodes.c`: `PAR16,PAR32,PAR32,PAR8`
  - [ ] 4.7a.2 `stopProgram` — `opPROGRAM_STOP(slot)`
  - [ ] 4.7a.3 `isProgramRunning` — `opPROGRAM_INFO` with `GET_STATUS` (subcode 22) per slot
  - [ ] 4.7a.4 Run-state change events — needs polling, so decide the interval against the
    same per-transport command budget telemetry uses, and whether polling stops when nobody
    subscribes
  - [ ] 4.7a.5 `emergencyStop` — decide whether it is `opPROGRAM_STOP` on every slot or the
    firmware has a dedicated path. Unverified; do not assume
  - [ ] 4.7a.6 Slot model — the brick has several program slots and every call above takes
    one. Nothing in the cockpit models slots yet, and `ev3-native`'s API sketch does not
    mention them
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
- all API methods are covered by integration tests,
- **antipattern cleanup**: scan the code this phase touched for code smells and anti-patterns (DRY violations, hardcoded config, silent catches, magic numbers, dead code, YAGNI, etc.); every detected issue is recorded as either fixed or explicitly accepted with a stated reason.

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
  - [ ] 5.4.8 Degraded-telemetry indicator — the status bar shows a degraded state when the achieved foreground refresh rate falls below the per-transport floor (DESIGN §9.2)
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
  - [ ] 5.7.2 Editable brick name with auto-save (depends on 3.2.4 — the protocol has no name-write command)
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
- all smoke tests pass,
- **antipattern cleanup**: scan the code this phase touched for code smells and anti-patterns (DRY violations, hardcoded config, silent catches, magic numbers, dead code, YAGNI, etc.); every detected issue is recorded as either fixed or explicitly accepted with a stated reason.

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
  - [ ] 6.4.0 Retain `removed` entries for the session. DESIGN §6.1 requires it so that rediscovery stays distinguishable from first discovery, but `discoveryScheduler.incrementMiss` and `presenceAggregator.handlePresenceChange` both delete the entry — 6.4.1 and 6.4.3 are indistinguishable until this lands
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
  - [ ] 6.6.4 BT provider (Windows): delete the `BTHPORT\Parameters\Devices\{mac}` registry entry alongside unpairing — its `Name` value goes stale and survives a rename (DESIGN §7.3). The USB path is unaffected: libusb string descriptors return the current name. Consider whether 6.6.6 absorbs this entirely rather than leaving two units on the same registry key
  - [ ] 6.6.5 Provider capability check before offering forget action (`capabilities.supportsForget`)
  - [ ] 6.6.6 BT `forget()` must unpair at the OS level. It currently disconnects and drops the preferred-backend cache entry, leaving the pairing intact, which is why `supportsForget` is declared `false` for BT
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
- all persistence operations are covered by unit tests,
- **antipattern cleanup**: scan the code this phase touched for code smells and anti-patterns (DRY violations, hardcoded config, silent catches, magic numbers, dead code, YAGNI, etc.); every detected issue is recorded as either fixed or explicitly accepted with a stated reason.

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
- release checklist is documented and followed,
- **antipattern cleanup**: scan the code this phase touched for code smells and anti-patterns (DRY violations, hardcoded config, silent catches, magic numbers, dead code, YAGNI, etc.); every detected issue is recorded as either fixed or explicitly accepted with a stated reason.

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
