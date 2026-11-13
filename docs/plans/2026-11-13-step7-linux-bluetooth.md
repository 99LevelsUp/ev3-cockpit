---
title: Step 7 — the Linux Bluetooth backend (IMPLEMENTATION_PLAN 1.11.11), then TCP on Linux
date: 2026-11-13
status: active — owner decisions D1–D4 taken 13.11.2026; U0 measured
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

## Decisions (owner, 13.11.2026)

- **D1. Our own minimal D-Bus client in TypeScript** over the system bus socket, `EXTERNAL` auth, no new dependency (option (c) of the draft). Small and ours: only what BlueZ needs. Byte fixtures for the marshalling: `a{sv}`, `a{oa{sa{sv}}}` from `GetManagedObjects`, the signals `InterfacesAdded` and `PropertiesChanged`, exporting the agent object and answering `RequestPinCode` / `RequestConfirmation`.
  *Considered:* (a) a pure-JS library (`@homebridge/dbus-native`, `dbus-next`) — adds a runtime dependency and its transitive ones to a public extension; (b) `koffi` on `libdbus` — most FFI code and crash surface, the agent through C callbacks; (d) running `bluetoothctl` / `busctl` — a human interface that changes between BlueZ versions, an agent over a pseudo-terminal, a separate package on some distributions.
- **D2. Presence: a short L2CAP connect to PSM 1 (SDP), closed at once** — measured in U0 below before it is built.
- **D3. `Trusted` is not set.** The cockpit only connects out; Windows sets nothing like it.
- **D4. A distribution whose D-Bus policy limits BlueZ to the `bluetooth` group: the cockpit offers the fix and runs it when the user confirms.**
  - Run through `pkexec` (polkit shows its own system dialog for the password; no password ever passes through the cockpit): `pkexec usermod -aG bluetooth <user>`.
  - The user comes from `os.userInfo().username`, never from input.
  - A fixed argv, no shell.
  - Without `pkexec`: show the command to copy.
  - After success: say the change applies after logging out and in (or `newgrp`), and offer to check again.
  - Nothing else runs without confirmation.
  - Test: the argv is exactly this, and nothing runs without confirmation.
  - Built in U4, where the permissions are found out.

## Key Technical Decisions

- **KTD1. Same seams, Linux implementations behind them.** `BtClassicDiscovery`, `BtPresenceMonitor`, `BtConnectionQueue` and `BtTransportProvider` stay; Linux supplies `listDevices`, `pairDevice`, `unpairDevice`, `radioName`, `check`, `inquire` and an adapter factory. No Windows file changes except the two type widenings in KTD6 and the residue seam in KTD7, both defaulting to today's behaviour.
- **KTD2. RFCOMM through libc via koffi** (`linuxBluetoothSocket.ts`): `socket(AF_BLUETOOTH, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, BTPROTO_RFCOMM)`, `connect` with `struct sockaddr_rc` (family, the address byte-reversed, channel 1) answering `EINPROGRESS`, polled with `poll(POLLOUT)` at 50 ms on the main thread, result from `getsockopt(SO_ERROR)`; `send`/`recv` non-blocking; `koffi.errno()`. Injectable as an interface like `Winsock2Api`, so every path is tested without a radio.
- **KTD3. `BtBluezAdapter`** implements `TransportAdapter` on that socket, mirroring `BtWinsockAdapter` (connect deadline `BT.CONNECT_TIMEOUT_MS`, idle 250 ms / active 5 ms receive polls, length-prefixed framing via `extractLengthPrefixedPacket`, message counter matching). Errors: `EHOSTDOWN`, `EHOSTUNREACH`, `ETIMEDOUT`, `ECONNREFUSED` → `BrickUnreachableError`; `EBUSY` → `BrickUnreachableError` with "closed less than a moment ago"; a socket the OS will not create (`EAFNOSUPPORT`, no koffi) → `BackendUnavailableError`. `BtBackend` gains `'bluez'`. Pacing stays in the provider (5 s per brick, the queue) — the adapter paces nothing, as on Windows.
- **KTD4. One BlueZ object cache** (`bluezObjects.ts`): `GetManagedObjects` at start, then `InterfacesAdded` / `InterfacesRemoved` / `PropertiesChanged`. It answers synchronously what the synchronous seams ask: the paired bricks (`Device1` with `Paired`, LEGO OUI or Class 0x000804 → `BluetoothDeviceInfo`, with the name BlueZ knows — better than Windows, which forgets names of unconnected devices) and the adapter's `Alias`. The first adapter (`hci0`) unless D-Bus says otherwise.
- **KTD5. Pairing through an agent we own.** `RegisterAgent(<our path>, 'KeyboardDisplay')` without `RequestDefaultAgent`: BlueZ asks the agent of the connection that called `Pair`, so a desktop's own agent stays default and is not displaced. A brick not in BlueZ's list is found first by a BR/EDR discovery (filter `Transport: bredr`), as the Windows helper searches first. `RequestPinCode` → `1234` (`EV3_PAIRING_PIN`); `RequestConfirmation`, `AuthorizeService` → accept for that brick only, refuse anything else; `Cancel` and `Release` handled. Events map onto `BtPairingEvent` (`searching`, `found`, `pairingRequested`, `result`) so the log and the picker read the same on both platforms. Abort → `Device1.CancelPairing`. `AuthenticationRejected` after 60 s reads "the brick's dialog was not confirmed in time; it may still be showing on the brick".
- **KTD6. Two type widenings, Windows unchanged.** `unpairDevice` in `BtTransportProvider` and `BtClassicDiscovery` becomes `(mac) => PairingResult | Promise<PairingResult>`; `forget()` is already async and awaits it. `RemoveDevice` is a D-Bus call and cannot answer synchronously. Windows' synchronous function returns the same values.
- **KTD7. Residue per platform.** `BtTransportProviderOptions.forgetResidue?: (mac) => ForgetResidue[]`, default `windowsResidue`. Linux reports what BlueZ keeps after `RemoveDevice`, as measured in U0: `/var/lib/bluetooth/<adapter>/cache/<mac>`, the name cache; the device directory with the link key goes. Reported, never removed: root-owned (as on Windows, step-3 KD3).
- **KTD8. One factory, wired by the Windows session.** `createBluezBluetooth({ log, queue })` returns `{ backends, discoverDevices, unpairDevice, forgetResidue, pairDevice, radioName, presenceCheck, inquire, dispose }`. A wiring note in the plan says exactly what `createRuntime.ts` does on `linux` (and that `win32` is untouched). No file in `src/runtime/` is edited from HOSTC.
- **KTD9. Presence and inquiry.** `check(mac)`: D2. `inquire()`: `SetDiscoveryFilter({ Transport: 'bredr' })`, `StartDiscovery` for `BT.PRESENCE_INQUIRY_SECONDS`, collect `Device1` objects seen with an `RSSI` and the LEGO OUI, `StopDiscovery`; unpaired ones become `ScannedBrick`s. The monitor's existing intervals and miss counts are kept.
- **KTD10. Tests without a radio, then on HOSTC.** Unit tests use fakes: a fake libc (`linuxBluetoothSocket`), byte fixtures and a fake bus (D-Bus client), a fake object cache (discovery, pairing, presence). Each unit's hardware check runs on HOSTC with the owner (pairing needs him at the brick); `scripts/hardware-matrix.js` gains the BlueZ backend on Linux. Every test run is under a time limit (`timeout`), and the unit runner already has `--test-timeout=30000`.

## Implementation Units

### U0. Measurements before code (HOSTC, owner at the bricks) — done 13.11.2026

No product code. Probes in Python's standard `socket` and `python3-dbus` (on HOSTC already); originals in `.review-out/hostc-bt-u0/`.

1. **Presence by L2CAP to PSM 1 (D2) — holds.** All three bricks paired, Bluetooth on, **visibility off**: three rounds each, every connect succeeded in **2.9–4.1 s** (AAA 3.0–4.1, BBB 2.9–3.3, CCC 3.9–4.1). **No dialog on any brick** (owner). CCC switched off: `EHOSTDOWN` (112) after **5.12 s**, three rounds of three, with AAA answering in between. As a normal user, no group. `koffi` opens the socket from Node (`socket(31, SOCK_SEQPACKET, BTPROTO_L2CAP)` → a descriptor), and the non-blocking RFCOMM socket too (`SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC`).
2. **What `RemoveDevice` leaves in `/var/lib/bluetooth` — measured on CCC.** The owner listed the tree with `sudo ls -laR` before and after. `RemoveDevice` deletes the whole device directory `<adapter>/<mac>/` (its `info`, which holds the link key, and `attributes`). **It keeps `<adapter>/cache/<mac>`**, rewritten from 477 to 20 bytes (by its size, the name alone). So the Linux residue is that one file: reported, root-owned, never touched.
3. **Which agent BlueZ asks — ours.** An agent registered by the pairing connection with `RegisterAgent(path, 'KeyboardDisplay')` and **no** `RequestDefaultAgent`, while the desktop panel (`wf-panel-pi`) runs: CCC (visibility on) found by a BR/EDR discovery in 1.9 s; `Pair` → our agent's `RequestPinCode` 6.4 s later → `1234` → `Pair` ok at 6.7 s; `Paired`, `Bonded`, `Connected` true, `Trusted` false. The brick showed its usual connection request, then the PIN keyboard.
4. **Names.** BlueZ holds `Name` for every paired brick (`AAA`, `BBB`, `CCC`, class 2052) while none is connected — unlike Windows. Not measured across a `bluetoothd` restart; `info` (gone after a forget) and `cache/<mac>` (kept) are where BlueZ stores it.

### U1. libc RFCOMM bindings — `src/transports/linuxBluetoothSocket.ts`

`loadLinuxSocketApi()` (koffi, `libc.so.6`), `sockaddr_rc` building, `macToBdaddr`, the errno constants. Tests: address byte order, struct layout, the loader refusing on a non-Linux platform with `BackendUnavailableError`.

### U2. `BtBluezAdapter` — `src/transports/btBluezAdapter.ts`

KTD3. Tests with the fake libc: connect in progress then done, a deadline that closes the socket, `EBUSY` / `ECONNREFUSED` / `EHOSTDOWN` mapping, a partial `send`, a peer closing mid-exchange, stale replies stepped over, close during a connect. Hardware: `hardware-matrix.js` BT section with the BlueZ backend on all three bricks (connect, `info`, filesystem, telemetry, the contract checks).

### U3. D-Bus client — `src/transports/dbus/` (if D1 = c; with D1 = a, a thin wrapper and its tests)

Marshalling and unmarshalling (alignment, `a{sv}`, variants, object paths, signatures), `EXTERNAL` auth, `Hello`, method calls with replies and errors, signals and `AddMatch`, exported objects answering incoming calls. Tests: byte fixtures for every type BlueZ sends us, a fake bus over a socket pair. Hardware: `GetManagedObjects` against HOSTC's `org.bluez` returns the three paired bricks.

### U4. BlueZ object cache, discovery, the radio name and the `bluetooth` group — `src/transports/bluezObjects.ts`, `bluezDiscovery.ts`, `bluezAccess.ts`

KTD4. `listDevices` and `radioName` for `BtClassicDiscovery`. Tests: devices appearing, changing, removed; non-bricks dropped; the adapter's `Alias`; a bus that refuses reported once. D4: an `AccessDenied` from BlueZ is told apart, and the cockpit offers `pkexec usermod -aG bluetooth <user>` (argv fixed, user from `os.userInfo()`, run only on confirmation; without `pkexec` the command to copy; after success "log out and in, or `newgrp`", and a check again). Tests pin the argv, no shell, and that nothing runs unconfirmed.

### U5. Pairing — `src/transports/bluezPairing.ts`

KTD5. Tests: PIN answered, confirmation accepted only for the brick being paired, a brick not yet known searched for first, abort → `CancelPairing`, 60 s `AuthenticationRejected` wording, events in order. Hardware (owner at the brick): pair AAA, BBB, CCC from the cockpit; an unconfirmed dialog; an abort.

### U6. Presence and inquiry — `src/transports/bluezPresence.ts`

KTD9, D2. Tests: a brick heard / not heard, misses counted by the existing monitor, inquiry filtered to bricks and to unpaired ones, discovery stopped even when it fails. Hardware: switch a brick off and on, watch "heard again" / "not heard".

**U6 results (HOSTC, 13.11.2026, BlueZ 5.82-1.1+rpt2).**

1. *The presence check on the bricks:* AAA, BBB and CCC on, visibility off on AAA and BBB: answered in 4.40, 3.01 and 3.52 s. No dialog on any brick through all the checks and the inquiries (owner). CCC switched off: the L2CAP connect fails with `SO_ERROR` 112 (EHOSTDOWN) after 5.13 s, twice; the check answers not heard after 5.14 s; `BtBluezAdapter.open()` throws `BrickUnreachableError` (errno 112) after 5.15 s. AAA answered as the control. U5 re-pair with the reviewed code: found after 2.3 s, PIN asked at 10.6 s, Paired and Bonded at 10.9 s, Trusted false; a dialog confirmed after BlueZ's 60 s ended `AuthenticationRejected` at 65.3 s with the reworded reason.
2. *When BlueZ reports an RSSI (source, BlueZ 5.82):* `adapter.c` 7375-7378 sets a found device's RSSI with delta 0 under a filtered discovery and with `RSSI_THRESHOLD` (8 dBm, `device.c` 78) otherwise; with delta 0 a same value is still emitted (`device.c` 6538). A client's filter counts as filtered unless it is empty and its transport equals the adapter's scan type (`adapter.c` 2209-2219); ours, `Transport=bredr` on a dual-mode adapter, is filtered. Every RSSI is cleared when the last discovery stops (`adapter.c` 1692-1696).
3. *RSSI reports counted per window (CCC visible; AAA and BBB not):*

| Other client | Window | Reports for CCC |
|---|---|---|
| none | 10 s | 1 (-52) |
| `bluetoothctl scan bredr` (filtered) | 10 s | 1 (-52; the same value as the last one) |
| none | 30 s | 3 (-60, -52, -52) |
| `bluetoothctl scan bredr` (filtered) | 30 s | 3 (-51, -51, -51) |
| `bluetoothctl scan on` (unfiltered), 3 runs | 30 s | 0; 3 (-51, -51, -57); 3 (-52, -51, -51) |

Same values are reported beside a filtered or an unfiltered client: the delta stays 0. One run in three beside an unfiltered client had no report at all for 30 s, changed values included, so not the threshold; the inquiry then answers "not heard", and the monitor drops an unpaired sighting only after two windows without it. So the inquiry hears a brick on evidence, a report during its window (`BluezObjectCache.rssiReports`), not on a cached RSSI, which outlives a brick switched off under another client's discovery.

### U7. Forget and residue

KTD6, KTD7. `RemoveDevice` through the cache; the provider seam with Windows' default; residue as measured in U0. Tests: Windows default unchanged (the existing forget tests stay green untouched), Linux residue listed, a refusal reported. Hardware: forget a brick from the cockpit, then pair it again.

### U8. The factory and the wiring note — `src/transports/bluezBluetooth.ts`

KTD8. Tests: what the factory returns on `linux`; nothing loaded on `win32`. The factory also wires BlueZ's unique bus name: `GetNameOwner(org.bluez)` at start and `NameOwnerChanged` after, passed as `bluezOwner` both to `BluezObjectCache` and to `createBluezPairing` (the agent then answers no caller but BlueZ; U5 review, 2ac9948, finding 8). Until then the system bus policy is the only guard, and the PIN is the public 1234. From the U4 review (8e000ed): when BlueZ's owner goes (a daemon restart), the cache clears, turns not ready and tells its listeners; when a new owner comes, it takes a fresh snapshot (finding 9). Once the owner is wired, an unknown owner rejects signals instead of passing them (finding 10). The caller of `offerBluetoothGroup` offers to check again after "added" (D4); `GroupFixResult` has no retry of its own (finding 11). From the U6 review (d17c5b1): the inquiry and the pairing search share the connection's discovery, and an inquiry whose StartDiscovery fails would stop a pairing's discovery in its `finally`; both must go through `BtConnectionQueue` (presence `holdOnly`, pairing through `enqueue`), with an end-to-end test that an inquiry and a pairing search never overlap (finding 8). The inquiry's `log` goes to the output channel. The note for the Windows session: the `createRuntime.ts` branch, the log lines on Linux ("BT transport registered (BlueZ RFCOMM; BlueZ discovery)", presence started on Linux too).

**U8 wiring note for the Windows session (`src/runtime/createRuntime.ts`, not edited from HOSTC).** `createBluezBluetooth` (`src/transports/bluezBluetooth.ts`) is built: one system-bus connection, BlueZ's owner tracked (`GetNameOwner` + `NameOwnerChanged`, from the bus daemon only), the object cache and the pairing agent fail closed while the owner is unknown, a fresh snapshot when BlueZ comes back, `retry()` for D4's "check again". In `registerRealProviders`, on `process.platform === 'linux'` only (Windows untouched):

```ts
const bluez = createBluezBluetooth({
	log,
	// D4: offer the fix; on "added", offer "Check again", which calls bluez.retry().
	onAccessDenied: () => { void offerBluetoothGroup({ confirm: /* modal showing prompt.command */ }).then(/* added → retry offer; manual → show command */); },
});
services.add({ dispose: () => bluez.dispose() });
void bluez.start(); // never rejects; logs why when not ready
const btDiscovery = new BtClassicDiscovery({
	listDevices: bluez.listDevices, radioName: bluez.radioName,
	pairDevice: bluez.pairDevice, unpairDevice: bluez.unpairDevice,
	onCacheUnavailable: /* as on Windows, logOnChange */, connectionQueue: btQueue, onPairingEvent: /* as on Windows */,
	// no portScan: the SPP backend is Windows-only
});
const btPresence = new BtPresenceMonitor({
	queue: btQueue, check: bluez.presenceCheck, inquire: bluez.inquire,
	pairedWithoutSession: () => btProvider.pairedWithoutSession(),
	onUnavailable: (reason) => log.warn(`Bluetooth presence unavailable: ${reason}`), onChange: refreshDiscovery,
});
bluez.onChange(refreshDiscovery); // BlueZ's devices changed, or BlueZ went or came back
const btProvider = new BtTransportProvider({
	presence: btPresence, discoverDevices: btDiscovery.discover, unpairDevice: btDiscovery.unpair,
	forgetResidue: bluez.forgetResidue, backends: bluez.backends, connectionQueue: btQueue,
});
log.info('BT transport registered (BlueZ RFCOMM; BlueZ discovery)');
```

Presence: `btPresence.start()` on `linux` too (today only `win32`). Pairing and the inquiry both go through `btQueue` (pairing via `BtClassicDiscovery`'s `enqueue`, presence `holdOnly`), so their discoveries never overlap (tested end to end in `bluezBluetooth.test.ts`). The inquiry's `log` warnings and the factory's go to the output channel.

### U9. Hardware session (owner at HOSTC)

Dev host on HOSTC with the wiring from the Windows session: pick, pair, connect, list projects, presence, forget, re-pair, on all three bricks; then the BlueZ backend in `hardware-matrix.js`; then USB and Bluetooth to the same brick at once.

### U10. Documents — done 13.11.2026, before U9

DESIGN §4.1.1 (the Linux backend, D1, the agent, presence), IMPLEMENTATION_PLAN 1.11.11 and §2 "What Linux needs" (Bluetooth items closed or carried), REQUIREMENTS §12 if anything changes, the user notes for 0.2.5 (D4).

Written: DESIGN §4.1.1 "Bluetooth on Linux" (and the Linux USB paragraph, which 4.6.16 left unverified), IMPLEMENTATION_PLAN 1.11.11, 4.6.16 and §2 "What Linux needs" with "What a user on Linux does" for the 0.2.5 install notes, `docs/ARCHITECTURE.md`. REQUIREMENTS §12 unchanged: nothing in it was Windows-only. U9's results go into the plan and DESIGN's "Unverified" line when it runs.

### U11. TCP on Linux (last)

The owner puts AAA (the brick with the Wi-Fi dongle) and HOSTC on one network. `hardware-matrix.js` TCP section; the dev host connects over TCP and lists files; USB, Bluetooth and TCP to AAA at once. Results into `docs/plans/linux-session-results/`.

## Risks

- **A desktop agent answering instead of ours:** U0 (3) showed BlueZ asks the caller's agent with the RPi OS panel running; blueman and GNOME are not measured.
- **D-Bus policy differs by distribution** (D4): only Debian 13 / RPi OS is measured.
- **The L2CAP presence page:** no dialog and no root on HOSTC (U0 (1)); other adapters not measured.
- **koffi per-target packaging** is the Windows session's 0.2.5; until it lands an installed VSIX has no Bluetooth on Linux either (as on Windows today).
- **One adapter assumed** (`hci0`); a second radio is out of scope and reported.
