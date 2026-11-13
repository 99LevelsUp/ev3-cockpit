---
title: Step 7 — the Linux Bluetooth backend (IMPLEMENTATION_PLAN 1.11.11), then TCP on Linux
date: 2026-11-13
status: draft — owner decisions D1–D4 open
origin: owner via the Windows session, 13.11.2026 — build the Linux Bluetooth backend on HOSTC; one branch `linux-backend` for USB (done), Bluetooth and TCP (last)
---

# Step 7: the Linux Bluetooth backend - Plan

## Goal Capsule

- **Objective:** on Linux the cockpit finds the paired bricks by name, pairs a new one (the brick's dialog, then PIN `1234`), connects over RFCOMM channel 1, knows whether a paired brick is switched on, hears unpaired bricks nearby, forgets a brick (unpair plus a list of what BlueZ keeps), and reads this computer's Bluetooth name for the brick-side forget — with Windows unchanged to the comma.
- **Means:** a BlueZ backend behind the seams the Windows backend already uses (`BtTransportProvider` backends and `discoverDevices`/`unpairDevice`, `BtClassicDiscovery`'s injectable functions, `BtPresenceMonitor`'s `check`/`inquire`), a libc RFCOMM socket through `koffi`, and a way to BlueZ (D1).
- **Authority:** owner decisions D1–D4 > `DESIGN.md` §4.1.1 and IMPLEMENTATION_PLAN §2 "What Linux needs" > this plan's KTDs > existing code.
- **Not in this step:** the panel; Windows changes of any kind; the wiring in `createRuntime.ts` (the Windows session's; this step hands it one factory and a wiring note, KTD8); `src/telemetry/`, `src/api/`.
- **Finishes and ships:** HOSTC implements unit by unit, test first and mutation-checked, commits and pushes to `linux-backend`; each unit goes to the Windows session for review; the owner runs the hardware steps.

## What is measured already (HOSTC, 11.11.2026, three bricks, both firmware versions)

From `docs/plans/linux-session-results/2026-11-11-hostc.md`; raw material in `hostc-raw/`, originals in `.review-out/hostc-raw/` on HOSTC.

| Fact | Value |
|---|---|
| The brick's services | Serial Port `00001101-…` only; RFCOMM channel 1 |
| Pairing | brick shows a connection request, then a PIN keyboard; BlueZ asks the agent "Enter PIN code" 2.7–5.0 s after `Pair`; bonded 3.4–5.4 s after `Pair`; `LegacyPairing: no`, `Trusted: no` |
| Unanswered pairing dialog | `org.bluez.Error.AuthenticationRejected` after 60 s, no agent prompt before it; the dialog stays on the brick |
| Discovery | a mixed LE + BR/EDR scan missed a visible brick for 40 s; BR/EDR only found all three in about 7 s; BlueZ drops a scanned device about 30 s after the scan stops |
| RFCOMM | connect 0.5–2.7 s; `info` reply 42–107 ms; `close()` returns at once |
| Reconnect after close | 0 s → `EBUSY` (16) at once; 0.2–2 s → `ECONNREFUSED` (111) after ~140 ms; ≥ 2.5 s connects. The provider's existing per-brick gap is 5 s (`BT.RECONNECT_GAP_AFTER_CLOSE_MS`), which covers it |
| koffi on arm64 | `koffi.load('libc.so.6')`, `socket(31, 1, 3)` returns a descriptor |
| D-Bus policy (Debian 13 / RPi OS) | `bluetooth.conf` lets the default context send to `org.bluez`: a desktop user pairs and connects with no group and no `sudo` |
| `/var/lib/bluetooth` | `root:root 0700`: the user cannot list it, so residue can only be reported, never inspected or removed by the cockpit |
| This computer's name | `org.bluez.Adapter1.Alias`, which defaults to the host name; the brick listed HOSTC under it |

## Where the code is (13.11.2026, checked against the repo)

- `BtTransportProvider` takes `backends: Map<BtBackend, factory>`, `discoverDevices`, `unpairDevice` (synchronous), `presence`, `connectionQueue`. `BtBackend = 'winsock' | 'spp'`. Forget returns `windowsResidue(mac)`, hard-coded.
- `BtClassicDiscovery` takes `listDevices` (synchronous, Windows `BluetoothDeviceInfo`), `portScan`, `pairDevice(mac, onEvent, signal)`, `unpairDevice` (synchronous), `radioName` (synchronous), `connectionQueue`; it filters bricks with `isLikelyEv3` (Class of Device toy + LEGO OUI).
- `BtPresenceMonitor` takes `check(mac) → Promise<boolean>` and `inquire() → Promise<ScannedBrick[]>`; on Windows both run the helper (`--sdp`, the inquiry).
- All Bluetooth wiring is in `createRuntime.ts` (`registerRealProviders`), and presence starts only on `win32`.
- `BtWinsockAdapter` is the pattern for an FFI socket adapter: a non-blocking connect polled with `select` on the main thread (DESIGN §4.1.1: a blocking connect on a koffi worker could not be aborted and ended Bluetooth until the process exited), idle and active receive polling, error codes mapped to `BrickUnreachableError` / `TransportError`.

## Decisions for the owner

- **D1. How the extension talks to BlueZ.** Pairing needs an agent object exported on the system bus (BlueZ calls `RequestPinCode` on it); discovery and presence need properties and signals. Options, each against the packaging the Windows session is building (platform VSIX per target, arm64 and x64, native modules shipped per target; a pure-JS dependency is bundled by esbuild and ships everywhere):
  - **(a) A D-Bus library, pure JS** — `@homebridge/dbus-native` (0.7.9, maintained, Oct 2026; MIT) or `dbus-next` (0.10.2, last release 2022, optional native `usocket`). Little code of ours; adds a runtime dependency and its transitive ones (`xml2js`, `event-stream`, `long`, `hexy`, `minimist`, `safe-buffer`) to a public extension; `event-stream` carries the 2018 supply-chain incident in its history (the versions here are after it). Bundled by esbuild: no per-target build.
  - **(b) `koffi` on `libdbus-1.so.3`** — no new dependency (koffi is already shipped); but marshalling `a{oa{sa{sv}}}` through hand-written FFI, a dispatch loop polled from the main thread, and C callbacks for the agent. Most code, most crash surface (FFI), inherits koffi's per-target packaging.
  - **(c) Our own minimal D-Bus client in TypeScript** over the system bus socket (`/run/dbus/system_bus_socket`, `EXTERNAL` auth): marshalling for the types BlueZ uses, method calls, signals, `AddMatch`, and incoming method calls for the agent. About 600–900 lines plus tests; no dependency, no FFI, bundled by esbuild; the wire format is a public, stable spec, and byte fixtures make it testable without a bus. Risk: alignment and marshalling bugs of our own, mitigated by fixtures and a round-trip against the real bus on HOSTC.
  - **(d) Run `bluetoothctl`** (and `busctl --json` for reads). No dependency; but parsing a human interface whose output changes between BlueZ versions (5.82 adds escape codes and prompts), an agent driven over a pseudo-terminal, and `bluetoothctl` is a separate package on some distributions (`bluez-utils` on Arch). `busctl` exists only with systemd.
  - *Recommendation:* **(c)**, with (a) `@homebridge/dbus-native` as the fallback if the owner prefers not to own a protocol implementation. (c) adds nothing to the supply chain of a public extension, ships unchanged on arm64 and x64, and keeps the agent in-process; the repo already writes its own bindings (Winsock through koffi) rather than wrap them. (b) and (d) are the most fragile.
- **D2. How "is a paired brick switched on" is answered.** Windows asks an SDP query (the helper's `--sdp`), which proves the brick is on without connecting and never raises a pairing dialog. Options: (a) an L2CAP connect to PSM 1 (SDP) through koffi and close at once — the same question at the same layer; (b) an RFCOMM connect — heavier, takes the brick's only channel and its 2.5 s cooldown; (c) only what BlueZ's cache says (`Connected`, `RSSI` during a discovery) — a paired brick that is not discoverable never shows. *Recommendation:* (a), confirmed by measurement in U0 before it is built (a page to a non-discoverable paired brick, time to answer, no dialog on the brick, user permissions).
- **D3. Mark a paired brick `Trusted`?** BlueZ needs `Trusted` only for incoming connections and for auto-authorising services; the cockpit only connects out. Windows sets nothing like it. *Recommendation:* no.
- **D4. A distribution whose D-Bus policy restricts BlueZ** (some limit it to a `bluetooth` group): the cockpit reports Bluetooth unavailable with the reason ("BlueZ refused: … — on this distribution the user may need to be in the `bluetooth` group") and changes nothing itself. *Recommendation:* that; plus a line in the user documentation (0.2.5).

## Key Technical Decisions

- **KTD1. Same seams, Linux implementations behind them.** `BtClassicDiscovery`, `BtPresenceMonitor`, `BtConnectionQueue` and `BtTransportProvider` stay; Linux supplies `listDevices`, `pairDevice`, `unpairDevice`, `radioName`, `check`, `inquire` and an adapter factory. No Windows file changes except the two type widenings in KTD6 and the residue seam in KTD7, both defaulting to today's behaviour.
- **KTD2. RFCOMM through libc via koffi** (`linuxBluetoothSocket.ts`): `socket(AF_BLUETOOTH, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, BTPROTO_RFCOMM)`, `connect` with `struct sockaddr_rc` (family, the address byte-reversed, channel 1) answering `EINPROGRESS`, polled with `poll(POLLOUT)` at 50 ms on the main thread, result from `getsockopt(SO_ERROR)`; `send`/`recv` non-blocking; `koffi.errno()`. Injectable as an interface like `Winsock2Api`, so every path is tested without a radio.
- **KTD3. `BtBluezAdapter`** implements `TransportAdapter` on that socket, mirroring `BtWinsockAdapter` (connect deadline `BT.CONNECT_TIMEOUT_MS`, idle 250 ms / active 5 ms receive polls, length-prefixed framing via `extractLengthPrefixedPacket`, message counter matching). Errors: `EHOSTDOWN`, `EHOSTUNREACH`, `ETIMEDOUT`, `ECONNREFUSED` → `BrickUnreachableError`; `EBUSY` → `BrickUnreachableError` with "closed less than a moment ago"; a socket the OS will not create (`EAFNOSUPPORT`, no koffi) → `BackendUnavailableError`. `BtBackend` gains `'bluez'`. Pacing stays in the provider (5 s per brick, the queue) — the adapter paces nothing, as on Windows.
- **KTD4. One BlueZ object cache** (`bluezObjects.ts`): `GetManagedObjects` at start, then `InterfacesAdded` / `InterfacesRemoved` / `PropertiesChanged`. It answers synchronously what the synchronous seams ask: the paired bricks (`Device1` with `Paired`, LEGO OUI or Class 0x000804 → `BluetoothDeviceInfo`, with the name BlueZ knows — better than Windows, which forgets names of unconnected devices) and the adapter's `Alias`. The first adapter (`hci0`) unless D-Bus says otherwise.
- **KTD5. Pairing through an agent we own.** `RegisterAgent(<our path>, 'KeyboardDisplay')` without `RequestDefaultAgent`: BlueZ asks the agent of the connection that called `Pair`, so a desktop's own agent stays default and is not displaced. A brick not in BlueZ's list is found first by a BR/EDR discovery (filter `Transport: bredr`), as the Windows helper searches first. `RequestPinCode` → `1234` (`EV3_PAIRING_PIN`); `RequestConfirmation`, `AuthorizeService` → accept for that brick only, refuse anything else; `Cancel` and `Release` handled. Events map onto `BtPairingEvent` (`searching`, `found`, `pairingRequested`, `result`) so the log and the picker read the same on both platforms. Abort → `Device1.CancelPairing`. `AuthenticationRejected` after 60 s reads "the brick's dialog was not confirmed in time; it may still be showing on the brick".
- **KTD6. Two type widenings, Windows unchanged.** `unpairDevice` in `BtTransportProvider` and `BtClassicDiscovery` becomes `(mac) => PairingResult | Promise<PairingResult>`; `forget()` is already async and awaits it. `RemoveDevice` is a D-Bus call and cannot answer synchronously. Windows' synchronous function returns the same values.
- **KTD7. Residue per platform.** `BtTransportProviderOptions.forgetResidue?: (mac) => ForgetResidue[]`, default `windowsResidue`. Linux reports what BlueZ keeps after `RemoveDevice`, as measured in U0 (expected: `/var/lib/bluetooth/<adapter>/cache/<mac>`, the name cache; the device directory with the link key is expected to go). Reported, never removed: root-owned (as on Windows, step-3 KD3).
- **KTD8. One factory, wired by the Windows session.** `createBluezBluetooth({ log, queue })` returns `{ backends, discoverDevices, unpairDevice, forgetResidue, pairDevice, radioName, presenceCheck, inquire, dispose }`. A wiring note in the plan says exactly what `createRuntime.ts` does on `linux` (and that `win32` is untouched). No file in `src/runtime/` is edited from HOSTC.
- **KTD9. Presence and inquiry.** `check(mac)`: D2. `inquire()`: `SetDiscoveryFilter({ Transport: 'bredr' })`, `StartDiscovery` for `BT.PRESENCE_INQUIRY_SECONDS`, collect `Device1` objects seen with an `RSSI` and the LEGO OUI, `StopDiscovery`; unpaired ones become `ScannedBrick`s. The monitor's existing intervals and miss counts are kept.
- **KTD10. Tests without a radio, then on HOSTC.** Unit tests use fakes: a fake libc (`linuxBluetoothSocket`), byte fixtures and a fake bus (D-Bus client), a fake object cache (discovery, pairing, presence). Each unit's hardware check runs on HOSTC with the owner (pairing needs him at the brick); `scripts/hardware-matrix.js` gains the BlueZ backend on Linux. Every test run is under a time limit (`timeout`), and the unit runner already has `--test-timeout=30000`.

## Implementation Units

### U0. Measurements before code (HOSTC, owner at the bricks)

No product code. (1) D2: an L2CAP connect to PSM 1 through koffi to a paired, non-discoverable brick, switched on and off: answer, time, any dialog on the brick, permissions. (2) What stays in `/var/lib/bluetooth` after `RemoveDevice` — needs the owner to run `sudo ls -R /var/lib/bluetooth/<adapter>` before and after in a desktop terminal (the MAC is replaced before anything is written down). (3) Pairing through `Device1.Pair` with an agent registered by the calling connection only, while the desktop's agent is default: which agent BlueZ asks. (4) The names BlueZ keeps for paired bricks across a restart of `bluetoothd`. Results into this plan.

### U1. libc RFCOMM bindings — `src/transports/linuxBluetoothSocket.ts`

`loadLinuxSocketApi()` (koffi, `libc.so.6`), `sockaddr_rc` building, `macToBdaddr`, the errno constants. Tests: address byte order, struct layout, the loader refusing on a non-Linux platform with `BackendUnavailableError`.

### U2. `BtBluezAdapter` — `src/transports/btBluezAdapter.ts`

KTD3. Tests with the fake libc: connect in progress then done, a deadline that closes the socket, `EBUSY` / `ECONNREFUSED` / `EHOSTDOWN` mapping, a partial `send`, a peer closing mid-exchange, stale replies stepped over, close during a connect. Hardware: `hardware-matrix.js` BT section with the BlueZ backend on all three bricks (connect, `info`, filesystem, telemetry, the contract checks).

### U3. D-Bus client — `src/transports/dbus/` (if D1 = c; with D1 = a, a thin wrapper and its tests)

Marshalling and unmarshalling (alignment, `a{sv}`, variants, object paths, signatures), `EXTERNAL` auth, `Hello`, method calls with replies and errors, signals and `AddMatch`, exported objects answering incoming calls. Tests: byte fixtures for every type BlueZ sends us, a fake bus over a socket pair. Hardware: `GetManagedObjects` against HOSTC's `org.bluez` returns the three paired bricks.

### U4. BlueZ object cache, discovery and the radio name — `src/transports/bluezObjects.ts`, `bluezDiscovery.ts`

KTD4. `listDevices` and `radioName` for `BtClassicDiscovery`. Tests: devices appearing, changing, removed; non-bricks dropped; the adapter's `Alias`; a bus that refuses (D4) reported once.

### U5. Pairing — `src/transports/bluezPairing.ts`

KTD5. Tests: PIN answered, confirmation accepted only for the brick being paired, a brick not yet known searched for first, abort → `CancelPairing`, 60 s `AuthenticationRejected` wording, events in order. Hardware (owner at the brick): pair AAA, BBB, CCC from the cockpit; an unconfirmed dialog; an abort.

### U6. Presence and inquiry — `src/transports/bluezPresence.ts`

KTD9, D2. Tests: a brick heard / not heard, misses counted by the existing monitor, inquiry filtered to bricks and to unpaired ones, discovery stopped even when it fails. Hardware: switch a brick off and on, watch "heard again" / "not heard".

### U7. Forget and residue

KTD6, KTD7. `RemoveDevice` through the cache; the provider seam with Windows' default; residue as measured in U0. Tests: Windows default unchanged (the existing forget tests stay green untouched), Linux residue listed, a refusal reported. Hardware: forget a brick from the cockpit, then pair it again.

### U8. The factory and the wiring note — `src/transports/bluezBluetooth.ts`

KTD8. Tests: what the factory returns on `linux`; nothing loaded on `win32`. The note for the Windows session: the `createRuntime.ts` branch, the log lines on Linux ("BT transport registered (BlueZ RFCOMM; BlueZ discovery)", presence started on Linux too).

### U9. Hardware session (owner at HOSTC)

Dev host on HOSTC with the wiring from the Windows session: pick, pair, connect, list projects, presence, forget, re-pair, on all three bricks; then the BlueZ backend in `hardware-matrix.js`; then USB and Bluetooth to the same brick at once.

### U10. Documents

DESIGN §4.1.1 (the Linux backend, D1, the agent, presence), IMPLEMENTATION_PLAN 1.11.11 and §2 "What Linux needs" (Bluetooth items closed or carried), REQUIREMENTS §12 if anything changes, the user notes for 0.2.5 (D4).

### U11. TCP on Linux (last)

The owner puts AAA (the brick with the Wi-Fi dongle) and HOSTC on one network. `hardware-matrix.js` TCP section; the dev host connects over TCP and lists files; USB, Bluetooth and TCP to AAA at once. Results into `docs/plans/linux-session-results/`.

## Risks

- **A desktop agent answering instead of ours** (blueman, GNOME): KTD5 relies on BlueZ asking the caller's agent; U0 (3) measures it before U5 is built.
- **D-Bus policy differs by distribution** (D4): only Debian 13 / RPi OS is measured.
- **The L2CAP presence page might raise a dialog or need root** on some setups: U0 (1) decides D2 before U6.
- **koffi per-target packaging** is the Windows session's 0.2.5; until it lands an installed VSIX has no Bluetooth on Linux either (as on Windows today).
- **One adapter assumed** (`hci0`); a second radio is out of scope and reported.
