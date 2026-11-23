# EVƎ Cockpit - Design

> Version: 2026-04-02, updated 2026-11-23
> Status: target design for new implementation
> Input: `REQUIREMENTS.md`
>
> Since 23.11.2026 the design is implemented by the native daemon `ev3-cockpitd`, a Rust workspace
> in `daemon/` (plan `docs/plans/2026-11-20-1845-refactor-native-daemon-plan.md`), which ported the
> TypeScript core rule by rule (its KTD11). Where a section below names a TypeScript class or file
> that no longer exists, it records how the rule was found; the Rust module named beside it, or in
> `docs/ARCHITECTURE.md`, holds it now.

## 1. Design Goal

This document describes the target architecture of EVƎ Cockpit so that it:

- meets the current requirements,
- can be re-implemented from a clean foundation,
- remains extensible for future versions.

## 2. Product Model

EVƎ Cockpit has two primary roles:

- a panel UI for brick discovery, connection, and monitoring,
- a daemon that holds the bricks, with a contract for other programs: the `ev3` command, an MCP
  server and add-ons.

The cockpit is the sole authority for physical `connect` and `disconnect`.
Other programs do not communicate with bricks directly — they go through the cockpit daemon.

### 2.1 Integration of Add-ons

Add-ons (EVƎ C and others) are separate clients of the daemon, not VS Code extensions that import
the cockpit's exports:

- An add-on uses `@ev3-cockpit/client` and connects with kind `addon`.
- When no daemon runs, it starts the one the installed cockpit recorded, or tells the user to
  install the cockpit.
- It compares only the contract version; it never replaces the daemon.
- An add-on's own command line is `ev3 <name>`: the `ev3` command runs `ev3-<name>` from the PATH.

## 3. Core Principles

### 3.1 Runtime Is the Source of Truth

The webview is not the source of truth about brick state.

The source of truth is the runtime layer, which manages:

- discovery,
- remembered bricks,
- connected sessions,
- the active brick,
- telemetry,
- the daemon and its contract,
- metadata persistence.

### 3.2 One Foreground Brick

Cockpit can have at most one foreground brick at any time.

The foreground brick:

- is in the panel foreground,
- receives the fastest scan,
- provides the full read model for the Cockpit UI.

If the discovery tab is in the foreground or the panel is not visible, no brick is foreground.

### 3.3 Multiple Connected Sessions

Multiple bricks can be connected simultaneously, subject to a per-transport session ceiling.
USB, TCP and mock are unbounded. Windows RFCOMM permits one active BT connection, so BT has a
ceiling of one; a connect request beyond a transport's ceiling must fail with a stated reason
rather than queue indefinitely.

Inactive connected bricks:

- stay connected,
- maintain heartbeat and reconnect,
- do not receive a foreground scan,
- may have subscription telemetry for other extensions.

### 3.4 Separation of Cockpit UX and API Telemetry

A clear distinction must be made between:

- Cockpit foreground telemetry for the active tab,
- subscription telemetry for other extensions,
- minimal telemetry for connected bricks without subscriptions.

This is a fundamental architectural rule. The active tab in the panel and API subscriptions are two separate things.

## 4. Architecture Layers

```mermaid
graph TD
    subgraph Providers["Transport Providers"]
        PU[USB]
        PT[TCP]
        PB[BT]
    end

    PERS[Persistence / globalState]

    PA[Presence Aggregator]
    SM[Session Manager]
    CMD[Command Layer]
    subgraph Services["Service Tier"]
        TM[Telemetry]
        FS[Filesystem]
        PC[Program Control]
    end
    API[Daemon + Contract]
    UI[Cockpit UI Layer]

    Providers --> PA
    PERS --> PA
    PERS --> SM
    PA --> SM
    SM --> CMD
    CMD --> Services
    SM --> API
    Services --> API
    SM --> UI
    Services --> UI
    API -->|JSON-RPC: requests, events, snapshots| EXT[VS Code, ev3, MCP, add-ons]
    UI -->|read model| PANEL[Webview Panel]
    PANEL -->|actions| UI
```

### 4.1 Transport Providers

Each transport implements a shared contract (`TransportProvider`,
`daemon/crates/transports/src/provider.rs`):

- `discover`,
- `connect`,
- `disconnect`,
- `send_packet`,
- `recover`,
- `forget`, `pair` and `check_presence` where applicable.

Supported providers:

- `usb`,
- `tcp`,
- `bt`.

Simulated bricks (`mock`) are deferred (native daemon plan, Key Decisions); recorded brick
sessions replayed at the provider trait stand in for hardware in tests (§13).

#### 4.1.1 Internal Structure

The providers carry bytes; the command layer above them owns the codec (§4.3a).

```mermaid
graph LR
    CMD[BrickCommand] --> ENC[commands: build_command]
    ENC --> PKT[packet: encode]
    PKT --> LINK[provider link]
    LINK -->|raw bytes| BRICK[EV3 Brick]
    BRICK -->|raw bytes| LINK
    LINK --> DPKT[packet: decode]
    DPKT --> RESP[responses: parse_response]
    RESP --> RES[BrickResponse]
```

**Protocol layer** (`daemon/crates/protocol`): Pure functions with no I/O.

- `bytecode` — encoding primitives (local constants, global variables, integer encoding).
- `packet` — packet framing: `[length:2LE][counter:2LE][type:1B][payload]`. Encode and decode.
- `commands` — maps `BrickCommand` to EV3 direct/system command bytecode.
- `responses` — parses raw EV3 reply bytes into typed `BrickResponse`.

**Links** (`daemon/crates/transports`): raw I/O only. A link opens and closes the physical
connection and exchanges one framed packet for its reply, with a deadline, cancellation and the
expected message counter (`pending.rs`, shared by every byte link).

- USB (`usb/`): libusb through `rusb` with a vendored libusb — the brick's interrupt endpoints at
  the firmware's full 1024-byte frame, the preferred link; HID through `hidapi` as the fallback
  when libusb cannot claim the interface, 64 bytes per packet.
- TCP (`tcp/`): the UDP beacon for discovery and a TCP socket, length-prefixed, after the unlock
  handshake.
- Bluetooth on Windows (`bt_windows/`): RFCOMM over Winsock `AF_BTH`, connected non-blocking and
  driven by tokio; presence over uncached SDP; pairing through WinRT; forget through `bthprops`.
- Bluetooth on Linux (`bt_linux/`): an `AF_BLUETOOTH` RFCOMM socket to channel 1 through libc
  ("Bluetooth on Linux" below).

The serial-port (SPP) Bluetooth fallback of the TypeScript implementation was not ported: the
communication lab found Winsock working on both adapters measured and SPP transferring nothing on
one.

#### USB has two backends, and they are not equivalent

**The 64-byte HID ceiling is a defect in the brick's own descriptor.** Its HID report
descriptor declares `Report Count 0` for both the input and the output report, so Windows
derives no usable report length and a write delivers 64 bytes however large a report it is
handed — while the interrupt endpoints underneath advertise `wMaxPacketSize` **1024**.
Nothing above HID can lift that: the ceiling is the descriptor, not the HID library.

Going straight at the endpoints through libusb reaches the firmware's real frame. Two
measured quirks shape that path, both invisible in review and fatal in practice:

- **A transfer must be exactly `wMaxPacketSize`.** A 16-byte interrupt write fails with
  `LIBUSB_ERROR_IO`; the same packet padded to 1024 succeeds. Sends are padded.
- **Reads come back full-length too**, so a reply is located by its own length prefix
  rather than by the size of the transfer that carried it.

**Verified throughput, every byte compared:**

| Transport | Write | Read |
|---|---|---|
| USB (libusb) | 200–278 KB/s | 325–330 KB/s |
| TCP | 57.3 KB/s | — |
| Bluetooth | 20.3 KB/s | — |
| USB (HID fallback) | 6.8 KB/s | — |

**This ranking has now inverted twice, in opposite directions.** The plan first assumed USB
was fastest for bulk work; measurement over HID made it the slowest by an order of
magnitude, and that finding is recorded above; measurement over libusb makes it the fastest
by a factor of five. What survives is not a ranking but a method: the number came from the
wire each time, and the two revisions differed only in which wire was being used.

So `maxPacketBytes` is a property of the **live link**, not of the transport — it is read
from the endpoint descriptor at open and travels adapter → provider → session →
`createBrickFilesystem`. Both halves matter: reaching a full frame is what lets `copy` and
`move` be expressed at all, and the figure arriving at `FileTransferService` is what stops
every transfer from chunking to 64 bytes with nothing visibly wrong.

`UsbTransportProvider` prefers libusb and falls back to HID **loudly**, naming the refusal
and what the fallback costs. A silent fallback would look like a working connection and
behave like a broken one: on HID, `copy` and `move` carry two paths and do not fit a packet
at all.

Discovery stays on HID enumeration, which needs no handle. libusb name probing skips a
device whose interface a session holds claimed — identified by bus address, since reading a
serial would mean opening the device discovery is trying to avoid touching.

**On Linux the kernel's `usbhid` holds the brick's interface**, so a plain claim fails with
`LIBUSB_ERROR_BUSY` and every connect would land on HID. Measured on HOSTC (13.11.2026,
`docs/plans/linux-session-results/2026-11-13-hostc-usb.md`): the cockpit detaches `usbhid` as the
normal user (libusb's auto-detach, or a detach and reattach by hand), then clears the halt on both
endpoints — without it the first exchange after every detach timed out. The read needs no slack
byte there (`READ_OVERRUN_SLACK` is Windows-only). A brick that a crashed extension host left
without a driver is still found, through libusb's own enumeration. A user may open the brick only
with the udev rule the extension ships (`native/linux/70-lego-ev3.rules`); without it the connect
says so. Recovery from a cable pulled mid-transfer holds on both platforms: the loss is a
`TransportError` at once, the next command fails in milliseconds, nothing hangs.

The HID ceiling also cost a real defect. The USB adapter discarded what `write()` returned,
and the brick advances its file pointer by the length the host *declares* rather than by
what arrived, so a truncated upload reported success and landed zero padding. Nothing
detected it because every command sent before the filesystem work fit inside 64 bytes.

#### Bluetooth has one runtime backend, and WinRT is not it

> **Superseded 23.11.2026** by the native daemon plan
> (`docs/plans/2026-11-20-1845-refactor-native-daemon-plan.md`, KTD5): the daemon is a native
> process, so WinRT is reachable in-process. Pairing runs through WinRT
> `DeviceInformationCustomPairing` inside the daemon, on its own thread; the data channel stays on
> Winsock `AF_BTH`, and SPP was not ported. The two paragraphs below record the rule of the
> TypeScript implementation.

The design used to name three backends in a fallback chain: WinRT `StreamSocket`, then
WinSock2 through an FFI, then SPP over a serial port. Only the last was ever built, and
building the first was never the right plan.

**WinRT is excluded deliberately.** LEGO's own desktop products do use it — EV3 Classroom
opens `RfcommDeviceService` and a `StreamSocket` — but they are .NET applications and we
are a VS Code extension. Reaching WinRT from Node means a .NET helper process, and the
testlab ruled that class of solution out at the start: native Windows API through an
FFI, never a `child_process` shelling out to .NET, PowerShell or Python. A backend that
cannot be built within the extension's own process is not a backend, it is a dependency on
a runtime the user may not have. The chain is now **WinSock2 → SPP**, and nothing above
the provider knows the difference.

**WinSock2 is the testlab's answer, not a guess.** The lab compared the candidates against
live bricks and selected `AF_BTH`/`BTHPROTO_RFCOMM` sockets as the BT runtime; the serial
port was its *discovery* mechanism, promoted to a transport here by an oversight rather
than by a measurement. Porting the lab's choice is what this section records.

**Opening is serialised; holding is not.** This section used to say Windows carries one
RFCOMM connection at a time whichever API opens it. Measured 29.10.2026, the host held two
sessions to two bricks at once (§4.1.1). What does need serialising is the *opening* of
connections, pairing and the background presence jobs, which all page the one radio:
`BtConnectionQueue` paces those, on both backends.

**Transport guard**: A backstop against a pathological caller (≤ 1000 commands/second per
brick, counted across all of its channels; a full window waits, it does not refuse) and
degradation tracking per channel, so a pulled
cable degrades its USB channel and not the Bluetooth link standing by. The former "one active
transport at a time" and its 2-second switch cooldown are gone: two links open to one brick
with commands in flight on both froze nothing on three bricks (§4.1.1). It is deliberately
**not** a meter on normal traffic:
commands are strictly serial, so each transport is already self-limiting at its own round
trip — measured at 176, 62 and 11 commands per second for USB, TCP and BT, with no error
and no latency drift at any of them. The guard exists for a retry storm or a runaway
loop, not for the rates a working caller can reach. It was 200 until file chunks through
libusb on Windows ran at about 380 per second and the guard refused a 100 000-byte write
halfway (step-5 plan, U9); a refused chunk leaves a half-written file, so a full window
now delays the next command instead.

**BT connection queue**: serialises the opening of Bluetooth connections, pairing attempts and
the presence jobs — a 15-second gap after a connect is released cleanly, 30 seconds after one
that failed, and exponential backoff on repeated errors (kept for the release, step-1 plan D3).
The presence jobs hold it for mutual exclusion only and start none of those gaps. Each brick
also gets 5 seconds after its own connection closes before it is connected again.

#### What the communication lab confirmed, and what is still assumed (29.10.2026)

`ev3-lab-communication` rebuilt every candidate technology independently and measured it on
two Windows hosts, a Raspberry Pi 5 and Linux. Its report calls every channel undecided, but
only because it counts scenarios it has not written yet (file operations beyond the basic
ones, throughput, recovery, several bricks at once). On the data it has, it confirms each
choice above for Windows: libusb ahead of HID (1024-byte frames, the brick's real name),
Winsock RFCOMM ahead of SPP (works on both adapters measured; SPP transfers nothing on one),
the WinRT helper for pairing (the data channel stays on Winsock; WinRT reaches the extension
only through that helper process, the exclusion above stands for the runtime), and the plain
TCP socket.

Three things in this section were **assumptions, not measurements**. Measured on hosta on
29.10.2026 (step-1 plan, U3/U4), with what changed:

- **"One RFCOMM connection at a time" — does not hold.** Two sessions to two bricks answered
  115/115 each, held at once, and a live inquiry beside them cost nothing. The queue now
  serialises *opening* only; a session no longer holds its slot, so several bricks can be on
  Bluetooth together.
- **The queue's cooldowns — decided (D3).** What the bricks need is a gap after *their own*
  close: a reconnect 0 s after a clean close gave WSA 10064 on all three bricks and locked the
  brick out for minutes; 5 s did not. The provider waits `RECONNECT_GAP_AFTER_CLOSE_MS` (5 s)
  per brick. The queue's 15 s between bricks and 30 s after a failure stay for the release,
  as slow and safe; tuning them is post-release work. The ~50 % connect failures belong to
  one host's Realtek adapter; the same stack on an Intel adapter opened 96 %.
- **The connect itself** ran blocking on an FFI worker thread and was "aborted" by closing the
  socket, which did not end it: four deadlines in one process ended Bluetooth until the
  process exited. It is now non-blocking, its completion reported by tokio's reactor
  (`bt_windows/winsock.rs`).
- **"One active transport per brick"** in the transport guard. Measured 29.10.2026 on all
  three bricks and both firmware versions: USB and Bluetooth open to the same brick at once,
  even with commands in flight on both, answered every request with no freeze; a USB cable
  pulled with Bluetooth standing by lost nothing on Bluetooth, and the next USB call failed at
  once with `LIBUSB_ERROR_IO`. The rule is removed. Built in step 2: several links open, traffic
  over one (§4.3, "Brick layer"); 30.10.2026 a 64 KB transfer with the telemetry loop running
  and both links up froze nothing either (step-2 plan, U10).

#### Bluetooth on Linux: BlueZ, through our own D-Bus client

Linux has the same seams as Windows and different things behind them (step-7 plan, KTD1):
the connection queue and the presence monitor are shared (`daemon/crates/transports/src/bt/`), and
the Linux provider (`bt_linux/provider.rs`) fills every seam the Windows one fills — the RFCOMM
link, the paired-device list, this computer's radio name, pairing, forget and its residue, the
presence check and the inquiry. It is compiled on Linux only. What was measured first is in
`docs/plans/linux-session-results/2026-11-11-hostc.md` and in the step-7 plan's U0 and U6.

**Data: a libc RFCOMM socket, no helper process.** The link (`bt_linux/rfcomm.rs`) opens
`AF_BLUETOOTH` / `BTPROTO_RFCOMM` to channel 1, the brick's only service, through libc.
As on Windows the connect is non-blocking (`SO_ERROR` read once the socket is writable),
so a deadline really ends it. `EHOSTDOWN`, `EHOSTUNREACH`, `ETIMEDOUT` and `ECONNREFUSED` are an
unreachable brick; `EBUSY` is one closed a moment ago — a reconnect needs about 2.5 s on Linux,
which the provider's 5 s per-brick gap already covers. A kernel without Bluetooth sockets makes
the backend unavailable, not the brick unreachable.

**BlueZ is reached through `zbus`** (native daemon plan, KTD6), a pure-Rust D-Bus library, behind
one trait so the logic above runs against a fake BlueZ in tests (`bt_linux/bluez.rs`,
`system_bus.rs`). The TypeScript implementation had a D-Bus client of its own (owner decision D1),
since a library would have added runtime dependencies to a public extension; in a Rust binary a
crate is compiled in and pinned. `bluer` was rejected: it links `libdbus`. `bluetoothctl` stays out,
a human interface that changes between versions. On Debian 13 / Raspberry Pi OS the bus policy lets
a desktop user talk to BlueZ with no group and no `sudo`.

**One object cache answers the synchronous seams** (`bt_linux/bluez.rs`): `GetManagedObjects` once,
then `InterfacesAdded`, `InterfacesRemoved` and `PropertiesChanged`. Paired bricks keep the name
BlueZ learned, even while the brick is off — better than Windows, which forgets it. **Who speaks
for BlueZ is checked.** The bus session (`bt_linux/session.rs`) tracks `org.bluez`'s unique name with `GetNameOwner` and
`NameOwnerChanged` (from the bus daemon only); the cache and the pairing agent take signals and
calls from that name only, and from nobody while it is unknown. When BlueZ restarts, the cache is
dropped, its listeners told, and a fresh snapshot read once BlueZ is back.

**Pairing goes through an agent we own** (`bt_linux/agent.rs`). `RegisterAgent` as
`KeyboardDisplay`, never `RequestDefaultAgent`: BlueZ asks the agent of the connection that called
`Pair`, so a desktop's own agent stays the default (measured with the Raspberry Pi OS panel
running: BlueZ asked ours). The agent answers PIN `1234` and confirms for the brick being
paired only, and only to BlueZ. A brick BlueZ does not know yet is found first by a BR/EDR
discovery — a mixed LE and BR/EDR scan missed a visible brick for 40 s. Pairings run one at a
time. A dialog left unconfirmed on the brick ends after BlueZ's 60 s as `AuthenticationRejected`,
reported as such; the dialog stays on the brick. `Trusted` is not set (D3): the cockpit only
connects out.

**Presence is a short L2CAP connect to PSM 1, SDP, closed at once** (D2, `bt_linux/presence.rs`).
Every Classic device listens there, and the connect asks the brick nothing: no dialog on any brick,
no root, no D-Bus. A brick that is on answered in 2.9–4.4 s; one that is off failed with
`EHOSTDOWN` after 5.1 s. Only what the brick did counts: a page that went unanswered (`EHOSTDOWN`,
`EHOSTUNREACH`, `ETIMEDOUT`) is a miss, a refusal (`ECONNREFUSED`, `ECONNRESET`) is the brick
answering, and anything else — the adapter down included — fails the round without counting
against the brick.

**The inquiry hears a brick on evidence, not on a remembered value.** It runs a BR/EDR discovery
for a 15 s window and counts a brick heard only if BlueZ reported its RSSI *during* the window.
Under a filtered discovery, as ours is, BlueZ 5.82 reports every result, a repeated value too
(`adapter.c`; the 8 dBm threshold is for unfiltered ones); a brick reported every 8–14 s. An RSSI
BlueZ still holds is not evidence: under another client's discovery it outlived a brick switched
off. The inquiry and a pairing's search share the radio's discovery, so both go through
`BtConnectionQueue` (pairing enqueued, presence holding it) and never overlap.

**Forget is `Adapter1.RemoveDevice` through the adapter that holds the brick** (`bt_linux/provider.rs`).
It drops the link key; BlueZ keeps the brick's name cache under
`/var/lib/bluetooth/<adapter>/cache/<brick>`, root-owned, which is reported as the residue and not
touched, as on Windows. A brick BlueZ does not hold counts as forgotten.

**Where a distribution limits BlueZ to the `bluetooth` group, the cockpit offers the fix** (D4,
`bt_linux/access.rs`). An `AccessDenied` from the bus is told apart from every other failure; with the
user's confirmation the cockpit runs `pkexec usermod -aG bluetooth <user>` — a fixed argv, no
shell, the user from the OS, the password asked by polkit and never seen by the cockpit. Without
`pkexec` it shows the command to copy. The group applies to a new login; "check again" opens a new
bus connection.

Measured through the TypeScript implementation on HOSTC (step-7 plan, U9; the native daemon's
Linux round is U16): the hardware matrix on all three bricks, a BlueZ restart, a brick switched off and on, forget and re-pair. With HOSTC's own Wi-Fi up, one matrix run in two had page timeouts (`EHOSTDOWN`) on two bricks; the Pi 5's Wi-Fi and Bluetooth share one chip. Unverified: the cockpit's wiring end to end in VS Code; other distributions' bus
policy; desktop agents other than Raspberry Pi OS's (blueman, GNOME); other adapters' behaviour
on the L2CAP page; a second adapter (out of scope: the first one is used and forget refuses a
brick held by another).

### 4.2 Presence Aggregator

The Presence Aggregator unifies discovery output from all providers into a single discovery
model: **one entry per brick**, whichever channels reach it. Providers report channels
(`usb:001653F00C0C`, `bt:00:16:53:F0:0C:0C`); the aggregator groups them by the brick's
identity (§5.1) and keeps each channel's state in a state machine (§6.1a).

Responsibilities:

- data normalization,
- `available / lost / removed` transitions,
- tracking of remembered devices,
- merging runtime information with persisted metadata.

It does **not** order the list. Which brick belongs at the top is a question about the person
reading the screen, not about discovery: a panel may want the brick someone is carrying
towards the computer to climb the list as its signal rises, and no ordering chosen down here
could serve that. The aggregator records what exists and what is true about it; every view
sorts it for itself.

### 4.3 Session Manager

The Session Manager manages physically connected channels — one session per channel to a
brick. It is the exclusive owner of the connection state.

**Brick layer** (`daemon/crates/runtime/src/bricks.rs`, above it). Signs a brick in over every channel it is available
on, and over every channel that appears while it stays signed in; sends each command over the
connected channel with the highest priority its provider declares (USB, then Bluetooth, then
TCP). A link fault on that channel takes it out of routing at once, so the next command goes
over the next channel, and probes it: back in routing if it answers, reconnecting if not. A
file transfer keeps the channel it started on and fails only if that channel is lost. Sign-out
is per brick and closes every channel. A failed join is retried on a backoff, except where the
provider opts out (`rejoinOnEvidenceOnly`, Bluetooth): there only when the brick is seen again
or answers a presence check. The daemon builds this whole runtime once, at its start.

Responsibilities:

- establishing sessions (via an internal API for the Cockpit UI),
- reconnect,
- heartbeat,
- explicit disconnect (via an internal API for the Cockpit UI),
- switching between `foreground / subscribed / minimal`.

Clients never open a brick themselves: `bricks/connect` and `bricks/disconnect` go through the brick layer's own sign-in and sign-out, so the session lifecycle keeps one owner (§10.4).

### 4.3a Command Layer

Owns the typed command vocabulary and everything needed to execute one command against
one connected brick: the EV3 codec (`daemon/crates/protocol`), message counters, reply matching,
and command-to-response typing (`daemon/crates/runtime/src/session.rs`).

It sits above the session manager, which owns connections, and below telemetry and the
filesystem, which both orchestrate commands rather than issue them one at a time.

**The transports beneath it carry bytes.** `TransportProvider::send_packet` takes a packet
and returns a packet; it does not know what a command means. Until this was separated, a
provider accepted a typed `BrickCommand`, which inverted the dependency — the lowest
layer owned the vocabulary every layer above it was defined in terms of, and the codec
lived inside the transports.

A channel is **session-scoped**, because the message counter is. Two channels over one
connection would hand out colliding counters and match each other's replies. The session
manager builds one per session.

The TypeScript mock was the single provider that stayed at the command level. Simulated bricks
are deferred in the native daemon (§13); a replayed recording sits at the provider trait and
carries bytes like any link.

### 4.3b Service Tier

Between the command layer and the daemon's contract sits one tier of peer services: **telemetry**,
**filesystem**, and **program control**. They are siblings, not a chain.

**What earns a service.** Not a command group — a group is not a reason for a layer.
A service exists where a capability needs more than one command, or holds state the
command layer does not:

| Capability | Commands | Why it is or is not a service |
|---|---|---|
| `battery`, `ports`, `buttons` | one each | periodic scheduling, throttling, subscriptions — **telemetry** |
| `info`, brick rename | one each | nothing to orchestrate — straight through, no service |
| filesystem | many, plus a brick handle | chunking, progress, cancellation, handle cleanup — **filesystem** |
| program control | `opFILE/LOAD_IMAGE` then `opPROGRAM_START`; `opPROGRAM_INFO/GET_STATUS` polled | the loaded image's address flows between commands, and run state has no push — **program control** |

So most command groups get no service. A service over `battery` would be a pass-through
with nothing in it; the command layer already delivers that capability whole.

**Why the tier is not folded into the API.** A service must be usable without being a
registered consumer. Tests, the mock, and hardware probes are its first callers and its
most useful ones: the chunked-transfer work was driven straight against
`FileTransferService`, with no API and no consumer registration. Move the orchestration up
into the API and none of that is reachable without the whole entry ceremony, and the API
becomes the only place complex behaviour can live.

**What the API owns instead** (§10): the consumer contract — registration and lifecycle,
the snapshot-and-event model, the active brick, and the safe/full mode policy. It composes
the services rather than containing them.

### 4.4 Telemetry Runtime

The Telemetry Runtime runs over a connected session and drives **one base tick per brick**,
composing one command per tick from the rows whose divider comes up. Not one loop per mode —
§9.1b explains why, and an earlier version of this section described three loops with three
frequencies, which contradicted it.

Modes are **interval presets applied to rows**, not separate schedulers:

| Mode | What it means |
|---|---|
| `foreground` | the fastest tick the transport allows; sampled rows on divider 1 |
| `subscribed` | a slower tick; only rows some consumer has claimed come up at all |
| `minimal` | no telemetry rows — heartbeat and reconnect only |

Priority belongs to truncation order within a tick (§9.1b), not to modes. A mode selects how
often the tick fires and which rows are eligible; it never competes with another mode for the
brick, because a brick has exactly one tick.

**A frame goes out through the session's own command queue**, as the `telemetry:frame`
command, not straight at the transport. That is what makes telemetry take turns with the
heartbeat rather than run beside it — two writers on one serial link, each blind to the
other's outstanding command, is the arrangement this replaced.

Two consequences worth stating, because both were found by building it:

- **The tick period comes from the transport, and the figures are measured** (§9.2, and
  `daemon/crates/runtime/src/telemetry/cadence.rs` for the derivation): USB 100 ms, TCP 200 ms, BT 500 ms.
  Bluetooth sets the shape — at 10.7 commands a second, a uniform 10 Hz target would consume
  the whole link and leave nothing for the heartbeat.
- **The packet budget is a property of the live link, not of the session**, so the scheduler
  re-reads it every tick rather than being handed it once. A session outlives its link:
  reconnect reuses the same session resources and only rewires the executor, so a USB brick
  that returns on the 64-byte HID fallback would otherwise keep composing frames sized for
  libusb's 1024. The firmware answers a truncated request rather than complaining, so the
  failure would be silent.

A transport that cannot execute a composed frame says so through `TransportCapabilities`, and a
brick on it runs in `minimal` regardless of whether it is the active one. The TypeScript mock was
not such a transport: it decoded the opcodes the assembler emits and answered from its own ports
(owner, 11.11.2026, step-6 plan D4); simulated bricks wait in the native daemon (§13).

### 4.5 Adaptive Throttling

The speed of telemetry is governed by an **Adaptive Throttling** mechanism.

Goal:

- Cockpit foreground must remain responsive,
- the VS Code editor must not be blocked,
- subscription telemetry should be as fast as possible within the remaining capacity.

The mechanism scales **the base tick period** (§9.5) — the single knob — based on:

- **Response latency**, as a distribution rather than an average. The measurements in the
  subsection below are why: a brick with an active Wi-Fi stack is 4x slower across the board,
  and one showing Port View stalls the channel periodically, which moves the tail while
  leaving the median alone.
- ~~**Queue depth**~~: retired as an input. With one telemetry frame in flight per brick
  (§9.1b) depth is 0 or 1 by construction, so it measures the invariant, not the brick.
  **Now measured rather than argued**: driven at a 5 ms tick over libusb — a period the link
  cannot serve — the queue never held more than one waiting entry across 1286 ticks, while the
  scheduler declined 162 of them and the heartbeat never missed. Depth stayed pinned to the
  invariant exactly as predicted, which is the strongest case for not reading it.

The throttling applies to telemetry delivery scheduling only — it has no effect on user-facing UI logic or explicit commands.

The current telemetry speed is visible in the Cockpit panel (diagnostic display).

#### What the measurements say about those two inputs

The phase gate on this section asked for the concrete degradation throttling prevents,
reproduced rather than assumed. It reproduces — but **not through either input named
above**, and that is the finding.

A full `ports` frame costs 6.0 ms against an idle brick over USB, the same as a
three-operation `battery` read: the cost is the round trip, not the work in it. Two things
change that, and both are properties of the brick rather than of the channel or the queue:

| Cause | Effect | Shape |
|---|---|---|
| Wi-Fi stack running | median 6.0 → 26 ms | steady, ~4× |
| Port View open on the brick's screen | ~34 ms stall, ~7×/s | periodic, median unchanged |

Both were isolated by experiment. Switching Wi-Fi off in software with the adapter still
fitted restored the full rate, so the tax is the running radio stack rather than the
hardware. Moving the on-screen port monitor between bricks moved the stalls with it — a
crossover, which also rules out firmware version.

Three consequences for the design:

- **Latency must be measured as a distribution, not an average.** A brick drawing its own
  port screen keeps a 6.0 ms median and a 37 ms p95. A throttler watching mean latency sees
  a healthy brick; only p95 or a stall count separates it from one.
- **Queue depth has no dynamic range here.** Commands are strictly serial per brick, so
  depth is 0 or 1 unless the scheduler out-runs the brick. Neither cause above moves it.
- **The signal is the brick's own workload**, which the host cannot query and cannot
  control. It is observable only through the host's own latency tail — an argument for
  keeping that tail as the input, not for dropping adaptivity.

Throttling must also be **per brick**: in a three-brick session, one brick with its port
screen open must not slow telemetry for the other two.

### 4.6 Daemon and Contract

The daemon (`daemon/crates/daemon`, the binary `ev3-cockpitd`) serves the runtime to its clients
over the contract (`contract/`, §10): brick list and holders, write leases, files, programs,
telemetry subscriptions, the daisy chain, settings, and questions for a person. TypeScript clients
use the client library (`src/client/`); the native `ev3` command speaks the same contract
(`daemon/crates/cli`).

### 4.6a The `ev3://` Scheme Is Not Cockpit's

The cockpit does **not** register a `vscode.FileSystemProvider` for `ev3://`. Consumers
reach the filesystem through the daemon's contract (§10).

A `FileSystemProvider` exists to make a remote filesystem appear inside VS Code — in
editors, `vscode.workspace.fs`, drag and drop. That is a UI-integration concern, and the
consumer that wants it is `ev3-explorer`, whose own design calls itself *"čistě UX
vrstva pro filesystém"*. It registers the scheme over this API.

`ev3-native` does not need it either, which is the case worth recording because it looks
like it might. It compiles a binary and needs it on the brick, but its design asks for a
programmatic API for exactly that (`uploadFile`, `runProgram`) and its usage example calls
that API directly. Its own recommended channel is VS Code commands, not `ev3://`.

**One obligation follows from putting the scheme in a consumer.** `ev3-explorer`'s design
states that safe and full mode are properties of the cockpit and that no consumer may
build a side channel around the guardrails. A consumer can only honour that if the policy
is reachable from the API, so §10 must export it rather than leaving each consumer to
reimplement it.

### 4.7 Cockpit UI Layer

The Cockpit UI layer is a webview panel over runtime read models.

The UI:

- does not create its own brick state,
- only displays the read model and dispatches actions,
- must not contain domain logic for reconnects and lifecycle.

### 4.8 Communication Model

The runtime communicates with the webview and external extensions through a combined model:

```mermaid
graph LR
    RT[Runtime] -->|push: events| WV[Webview]
    WV -->|pull: snapshot| RT
    RT -->|push: events| EXT[External Extension]
    EXT -->|pull: snapshot| RT
```

Rules:

- **Push**: The runtime emits an event on every state or telemetry change. The webview and dependent extensions subscribe at initialization.
- **Pull**: The webview and dependent extensions can explicitly request a current snapshot at any time — for example after a webview restart or at first initialization.
- Within the runtime, layers communicate via direct calls or shared observable streams.
- Across a process boundary (to the webview or a dependent extension), communication is exclusively through events and snapshots.

## 5. Data Models

### 5.1 Discovery Item

One row in the discovery list represents one **brick** (`BrickEntry`), however many channels
reach it; each channel (`DiscoveryItem` from its provider) keeps its own `brickKey`.

Minimum fields:

- `brickKey`,
- `displayName`,
- `transport`,
- `presenceState`,
- `remembered`,
- `connected`,
- `favorite`,
- `signalInfo?`,
- `availableTransports`,
- `btVisible?`,
- `lastSeenAt`.

`brickKey` identifies one channel to a brick. `BrickId` identifies the brick: the twelve hex
digits that are its USB serial, its Bluetooth address and the serial in its TCP beacon alike
(`brickIdOf`). A key with no hardware identity (a mock brick, a TCP brick known only by its IP)
is its own brick with one channel. Neither depends on `displayName`, which is user-editable.

A brick entry carries its name with where it came from and whether the brick itself confirmed
it (its `info` reply or its TCP beacon); a USB descriptor or a Windows Bluetooth record is shown
as unconfirmed, because both go stale after a rename.

Transport-specific `brickKey` definitions:

- **USB**: Serial number (or VID:PID:Serial).
- **BT**: MAC address.
- **TCP**: Serial number reported by the brick, falling back to the IP address when the
  brick reports no serial. Keying on IP alone would break every TCP favorite on a DHCP
  lease change.
- **Mock** (deferred, §13): Synthetic identifier from the JSON configuration (e.g., `mock:<id>` where `id` is defined in the config file).

### 5.2 Connected Session

Model of a connected session:

- `brickKey`,
- `displayName`,
- `transport`,
- `connectionState`,
- `lastError?`,
- `heartbeatState`.

What telemetry a brick runs (foreground, subscribed, minimal) is not part of the session: the
telemetry service is its one source (`daemon/crates/runtime/src/telemetry/service.rs`), and claims are on rows, not
categories (§9.3). The session once carried both and the two disagreed (step-6 plan, drift 3).

### 5.3 Active Brick View Model

Model for the foreground panel:

- brick identity,
- battery state,
- available transports,
- BT visibility if known,
- ports A–D and 1–4,
- peripheral types,
- current values,
- button state,
- system information for config mode,
- favorite state,
- preferred value display style,
- status bar configuration.

### 5.4 Contract Models

The contract does not use UI models or the runtime's internal ones. Its own models are JSON Schema
in `contract/schema/`, generated into Rust and TypeScript: `ContractBrick` (a brick with its channels, holders, and whether it is
reconnecting or blocked), `DaemonStatus`, `ProgramState` (with `runSeq` and `stoppedBy`),
`DeployResult`, `TelemetryRowInfo`, `TelemetryValue` (one row's value with its own `sampledAt`,
`effectiveIntervalMs` and `stale`), `TelemetryUpdate` (a `snapshot` first, then each `change`, and
`ended` when the brick goes), `ContractChain`, `SettingValue` and `Question`.

A `TelemetryUpdate` carries typed `TelemetryValue`s, not a `data: unknown` payload. A typed
surface that gives up its type at the one point a client reads it is not a typed surface.

## 6. State Model

### 6.1 Presence

Presence states:

- `remembered` — the system knows about the brick from OS evidence or Cockpit persistence, but the brick is not currently visible. It exists in the list as an offline entry.
- `available` — the brick is currently visible in discovery.
- `unavailable` — the brick was visible but has temporarily disappeared; the system waits for it to return.
- `removed` — the brick has disappeared definitively (timeout of `unavailable`). The entry is
  retained for the rest of the session so that rediscovery stays distinguishable from a first
  discovery — the two drive different auto-connect triggers. **Not yet implemented**: both
  `discoveryScheduler` and `presenceAggregator` currently delete the entry (plan task 6.4.0).

`remembered` and `removed` are equivalent from the user's perspective: the brick "does not exist". The difference is technical — `remembered` originates from evidence, `removed` from a timeout.

Rules:

- `available -> unavailable` after discovery timeout,
- `unavailable -> available` on rediscovery,
- `unavailable -> removed` after the removal timeout elapses,
- a `remembered` entry may exist without a prior `available` in the current session.

**Auto-connect:**

A brick marked as `favorite` is automatically connected on transition from "non-existent" to `available`. This includes:

- first discovery in a new session (`remembered -> available` or `[*] -> available`),
- rediscovery within a session (`removed -> available`).

After an explicit disconnect, auto-connect for that brick is suppressed for the rest of the current session — it will not re-trigger even if the brick disappears and reappears.

### 6.1a Channel

Each channel of a brick has its own state, kept by a state machine with a fixed transition
table (`ChannelStateMachine`; every current transport uses `BaseChannelStateMachine`, and a
transport that ever needs other states can bring its own behind the same interface):

- `absent` — never seen this session,
- `available` — seen and not connected,
- `connected` — a live session over it,
- `lost` — seen or connected this session and not now: a pulled cable, a brick out of range, a
  paired Bluetooth brick whose presence check went unanswered three times in a row ("not heard").

Discovery (`seen`, `gone`), the channel's session (`linkUp`, `linkDown`, `closed`) and presence
answers drive it. A connected channel stays connected while a scan misses it — the session is
the stronger evidence. A channel discovery has given up on stays `lost`, so a brick that was
connected keeps a grey icon for it; a stranger's brick whose every channel has expired is
dropped from the list.

Bluetooth presence (`BtPresenceMonitor`) runs in the background: an inquiry about once a
minute adds bricks nobody has paired yet, and an uncached service query about once a minute
checks each paired brick without a session. An answer proves the brick is on; silence may be
the adapter missing it (measured 30.10.2026), so one answer makes it heard and three misses in
a row make it not heard (owner's decision, step-2 plan KD10). Both hold the Bluetooth queue
only for mutual exclusion and start none of its cooldowns.

### 6.2 Connection

**Two independent states, and confusing them is what made recovery unpredictable.**

- **Signed in** is the user's intent. Only the user changes it, by signing a brick in or out
  in the cockpit.
- **Available** is the world's doing. Only discovery changes it, by seeing the brick or not.

Everything else follows from the pair:

```
telemetry runs  ⟺  signed in  ∧  available
```

The vocabulary matters because the old one collapsed both into "disconnect", which meant a
pulled cable and a user's decision at once. **Losing the link** is something that happens to
the cockpit; **signing out** is something the user does.

The pair is **the same on every transport**, and the only thing that differs is what losing
the link looks like: a cable pulled or a brick powered off on USB, a brick carried out of
range or its radio switched off on Bluetooth, Wi-Fi turned off on the brick for TCP. All of
them are the world's doing, none of them is a decision, and none of them signs anything out.

Connected session states, which describe the link and not the intent:

- `connecting`,
- `connected`,
- `reconnecting`,
- `disconnected`.

Rules:

- only Cockpit creates sessions via `connect`,
- a transport failure leads to `reconnecting`,
- **a signed-in session keeps trying for as long as the sign-in stands.** There is no attempt
  ceiling, because a ceiling counted in attempts is a time limit nobody chose: ten attempts
  spanned about three minutes, and a brick unplugged for longer was never picked up again —
  measured on a brick, it came back 35 seconds after the session had given up, while discovery
  had been seeing it the whole time. The backoff caps at `RECONNECT_MAX_MS` and repeats; the
  sighting itself makes the next attempt immediate (§4.3),
- signing out terminates the session regardless of active subscriptions,
- on sign-out, subscription registries for that brick are cleared.

The cockpit never signs a brick in by itself. At startup every brick is *available* and none
is signed in, so a brick in range that the user has not asked for is never connected to — and
a brick the user signed out of stays signed out when its cable goes back in.

Sign-in is **per brick**: signing a brick in joins every channel it is available on, and a
channel that appears later joins by itself; signing it out closes every channel.

Sign-in has **no persistence**: it lives in the extension host's memory and nowhere else.
Closing the cockpit signs every brick out, which is what makes the startup rule above true
rather than merely usual.

Pairing is part of connecting (step 4, `docs/plans/2026-11-02-0113-step4-pairing-on-connect.md`):

- a connection goes only to a paired brick; an unpaired Bluetooth sighting never joins as it is,
- "Connect a Brick" connects every channel that can work and pairs an unpaired Bluetooth
  sighting on the way, after USB or TCP are connected, and a signed-in brick pairs a new
  sighting by itself. The brick's pairing dialog is the consent; the cockpit shows a
  notification telling the user to confirm on the brick,
- the brick layer owns pairing, one run per brick, so one brick never shows two dialogs,
- a cancelled or failed pairing, "Clear a Brick's Bluetooth List" and "Forget a Brick" suspend
  automatic pairing of that brick until the user runs "Connect a Brick" on it again; Windows'
  cache relists a brick unpaired for minutes after a forget, and without this the dialog would
  come back again and again,
- when USB or TCP connects, the brick's list of paired computers is read and compared, by this
  computer's exact Bluetooth name, with Windows' pairing as discovery lists it. A pairing left on
  one side only is repaired before any new pairing: the half that is left goes and the brick is
  paired again. A suspended brick is not repaired until "Connect a Brick", and a brick is
  repaired once until the next "Connect a Brick", so a name that does not match exactly cannot
  loop. Over Bluetooth alone nothing is checked; a failed connect says that USB or TCP repairs a
  one-sided pairing, without claiming that the pairing is broken,
- when USB or TCP is there, the brick's Bluetooth channel joins only after that check: USB and
  TCP join first, Bluetooth once the list has been read and compared. A connect over a pairing
  broken on the brick's side only fails, after holding the radio for 15 s and arming the queue's
  recovery pause, which starved the repair's own pairing on hardware (step-4 U10). When every
  USB and TCP join fails, Bluetooth is tried at once: there is nothing left to check over. A
  brick that still looks one-sided after its one repair is reported on every USB or TCP join,
  on purpose: it is a fault, and a reminder each time gets it fixed sooner.

After sign-out:

- if the brick is still visible in discovery → it transitions to `available`,
- if not visible → it transitions to `removed`.

### 6.3 Activity

Session activity is a separate dimension:

- `foreground`,
- `subscribed`,
- `minimal`,
- `none`.

Transitions:

- at most one session can be `foreground`,
- multiple sessions can be `subscribed`,
- `minimal` means heartbeat without extended telemetry,
- `none` occurs after disconnect.

### 6.4 State Diagram

```mermaid
stateDiagram-v2
    classDef gray fill:#9e9e9e,color:#fff,stroke:#757575
    classDef blue fill:#1976d2,color:#fff,stroke:#1565c0
    classDef yellow fill:#f9a825,color:#333,stroke:#f57f17
    classDef green fill:#388e3c,color:#fff,stroke:#2e7d32

    [*] --> Remembered : known from OS / persistence
    [*] --> Available : first discovery
    Remembered --> Available : discovered
    Available --> Unavailable : timeout
    Unavailable --> Available : rediscovered
    Unavailable --> Removed : removal timeout
    Removed --> Available : rediscovered

    Available --> Connecting : connect (manual or auto-connect favorite)
    Connecting --> BrickView : success
    Connecting --> Unavailable : connect failed

    state "Brick View" as BrickView {
        [*] --> Connected
        Connected --> Reconnecting : transport lost
        Reconnecting --> Connected : reconnect success
    }

    BrickView --> Available : explicit disconnect (still visible)
    BrickView --> [*] : explicit disconnect (not visible)

    class Remembered gray
    class Available blue
    class Unavailable gray
    class Connecting yellow
    class Connected green
    class Reconnecting yellow
```

## 7. Discovery and Remembered Bricks

### 7.1 Discovery List

The discovery tab displays a single unified list of:

- available bricks,
- connected bricks,
- remembered bricks that are out of reach.

Each item stays in the list according to its current state. The UI works with a single read model, not several separate lists.

### 7.2 Ordering

The owner's order (step-1 plan, D5), in `ui/brickOrder`:

1. bricks on USB, whatever else reaches them — a cable means the brick is on this desk;
2. bricks without USB that are paired with this computer;
3. everything else — at a competition, the bricks that belong to other people.

Within a group by name, ignoring case, with the brick id breaking ties so two bricks with the
same name never swap. Ordering group 3 by smoothed signal strength waits for its measurement
(step-1 plan, §8).

### 7.3 Forget Action

A remembered brick may have a trash action.

Implementation model:

- an OS-specific adapter performs the unpairing or removal from local evidence,
- Cockpit simultaneously removes local persisted metadata (including `favorite`),
- forgetting is only permitted where the provider can safely perform it.

"OS-level evidence" on Windows includes the BT registry entry at
`HKLM\SYSTEM\CurrentControlSet\Services\BTHPORT\Parameters\Devices\{mac}`. Its `Name` value
goes stale and survives a rename — measured on two paired bricks whose real names were AAA
and BBB while the registry still held `"EV3"` and `"B"` — and the key survives
`BluetoothRemoveDevice` and Settings' own Remove (1.11.14).

**Forget does not delete it (step 3, KD3, 31.10.2026).** The key is owned by SYSTEM. The
cockpit never takes ownership of it, changes its permissions or deletes it, never elevates
and never restarts `bthserv`. Forget unpairs through the supported API, and its result names
the key with the brick's address and Windows' in-memory device record (which lasts until
Windows restarts) as records left behind, so the user can remove them. The subkeys on this
host are twelve lower-case hex digits; the forget report spells the key that way, and the
step-3 hardware session confirms it against a forgotten brick.

Forget also clears the brick's side: the brick keeps its own list of paired devices and a
one-sided record blocks the next pairing (IMPLEMENTATION_PLAN 3.1.4k, 3.1.4l). When the brick
is reachable, forget removes this computer's entry with `opCOM_REMOVE`, matched exactly on
this computer's Bluetooth radio name, and confirms it by reading the list back over a channel
the removal does not cut. The brick saves its list only on an orderly shutdown, so the
report tells the user to switch it off from its menu. "Clear a Brick's Bluetooth List"
removes every entry, whatever its name.

That entry is **not** the source of a USB brick's display name, despite an earlier note here
saying so. USB name resolution reads libusb string descriptors straight off the device and
gets the current name; it is the HID enumeration's cached `product` string that goes stale, reporting
the generic `"Xfer data to and from EV3 brick"` for two of three bricks where libusb
returned AAA, BBB and CCC correctly. So the stale-name problem is real, and it belongs to
the Bluetooth path once BT discovery is wired (1.11.7a).

A related measurement worth recording: an EV3's USB serial number **is** its Bluetooth MAC
with the separators removed — the BTHPORT subkey names matched the USB serials, compared
without regard to case (the subkeys are lower case, the serials upper case). Any
future cross-transport identity work can relate `usb:001653AABBCC` to `bt:00:16:53:AA:BB:CC`
by normalising the string, with no on-brick probe involved. (Identifiers here are
placeholders on the real LEGO OUI; actual device serials stay out of the repository.)

## 8. Favorites and Persistence

### 8.1 Persistence Location

Cockpit metadata is stored in the standard per-user VS Code extension storage (`ExtensionContext.globalState`).

Reasons:

- it is the natural cross-platform storage,
- it requires no direct work with the registry or a custom per-user database,
- it binds naturally to the extension lifecycle.

OS-specific evidence such as BT pairing remains outside this storage and is read through the provider.

### 8.2 Favorite Rules

Persisted per-brick metadata includes at minimum:

- `favorite`,
- preferred visual style for measured values (`numeric` / `visual`),
- status bar configuration,
- remembered UI metadata.

Rules:

- `star toggle` is available only in the status bar of the connected brick tab — clicking the star toggles `favorite`,
- in the discovery list, the star only indicates state and is not clickable,
- in config mode, the star is not available,
- the trash icon in the discovery list deletes all stored metadata for the brick including `favorite` — this is a deletion, not a toggle.

## 9. Telemetry Design

### 9.1 What telemetry is, and what it costs

A direct command is not a query — it is a short bytecode program the brick runs, where each
instruction names the offset in a reply buffer to write its result to. The brick executes it
top to bottom and returns that buffer. **One round trip carries many values.**

Measured against a brick, one row up to the full catalogue of twenty-six, all in one run so
the brick's own state cannot drift between the readings:

| Rows | Request | Reply | Median round trip |
|---|---|---|---|
| 1 | 10 B | 6 B | 10.1 ms |
| 3 | 25 B | 17 B | 10.9 ms |
| 14 (the sampled tier) | 77 B | 43 B | 10.9 ms |
| 26 (everything) | 159 B | 96 B | 11.9 ms |

**Twenty-six times the values for eighteen percent more time.** The control row is what makes
that readable: the same brick measured 6.0 ms on a different day (§4.5), so without a
one-row baseline in the same run the full frame would have looked twice as expensive as a
narrow command rather than marginally so.

The scarce resource is therefore **round trips, not bytes** — with one exception that is not
about width at all. A row addressing a device that is still settling makes the firmware
re-execute the instruction for up to 1.2 s (§9.1c), which is why the value rows are gated on
port state rather than composed freely.

The buffers are large enough that this rarely binds:

| | Limit | Source |
|---|---|---|
| Reply buffer (= global variables) | 1021 B | `MAX_COMMAND_GLOBALS` |
| — of which usable by the assembler | **1019 B** | the reply is globals + 5 B, unchecked |
| Whole message, either direction | 1024 B | `MAX_MSG_SIZE` |
| Locals | 64 B | `MAX_COMMAND_LOCALS` |

The reply is always *declared* globals + 5 bytes on the wire, whatever the program wrote, and
the firmware validates globals on the way in but never re-checks the reply against
`MAX_MSG_SIZE`. So 1019 is the assembler's hard cap, not 1021.

Today's `ports` command uses 99 bytes of request and 48 of reply. A frame carrying *every* row
measures **159 and 96** — an earlier revision projected 250 and 120, which was high by more
than half on the request. Either way it is a tenth of the budget, so on a link that carries
1024 bytes there is nothing to leave out.

**The exception is the HID fallback at 64 bytes per packet.** Measured with the same
catalogue: **eleven rows of twenty-six fit**, at 62 bytes of request and 40 of reply. That is
where leaving something out becomes a real question, and why truncation has to rotate (§9.1b)
rather than pick the same winners every tick.

Whether a reply longer than 64 bytes fragments across HID reports or is truncated is still
unmeasured — nothing we send has crossed it, and the assembler refuses to declare more than
the link can carry rather than find out by accident (plan 3.1.13).

### 9.1a Categories and cadence

Telemetry values differ by **how they change**, and that decides how they are read:

| Tier | Rows | Read |
|---|---|---|
| **Sampled** | sensor values · motor tacho · buttons | at a rate |
| **Event-ish** | port occupancy · brick name + battery · connectivity (BT, Wi-Fi) · filesystem usage | at a slower rate |
| **Static** | firmware and Linux version · serial number | once, at connect |

Each row carries its own interval and its own switch. **Interval 0 means never read** — no
special case in the scheduler, the row simply never falls due. Battery sits in the event
tier deliberately: it is dynamic, but nothing needs its instantaneous value.

The tiers cut *across* commands as well as categories, which is why cadence cannot be a
per-category or per-command property. `info` alone returns a firmware version (static) and a
brick name (mutable, since renaming is a feature).

Rows are the **subscription surface** — the one third parties build against, which §9.3 and
§10.2 spell out. The panel's switches are the cockpit's own subscription, and a dependent
extension has its own. The effective interval for a row is the **fastest any subscriber asks
for**, so turning a row off in the panel means "I do not want it", never "nobody gets it".

**Port occupancy is a row like any other**, with its own interval — it is not a mandatory
header on every frame. An earlier version of §9.1c required reading every port's type in
every frame; that contradicted this table, and on the 64-byte HID path it cost ~48 of the 57
available bytes, leaving room for a single value and starving every other row permanently.

The consequence to accept deliberately: a hot-plug is noticed when the occupancy row next
falls due, not instantly. At a sub-second occupancy interval that is invisible next to the
1–2 seconds the device itself spends reporting `TYPE_UNKNOWN` while it identifies.

A row whose value depends on a port being occupied is **registered against that port** and
only falls due while the port is in the *known* state (§9.1c). Occupancy is therefore what
gates the value rows, at its own cadence, rather than being re-read for their benefit.

### 9.1b Composing a frame

The scheduler is a **base tick with integer dividers**. Each row's interval is expressed as a
whole number of ticks; a row with divider *n* is included every *n*-th tick, and **divider 0
means never**.

A row's divider does not have to be the whole story. The static tier needs *once*, which
divider 0 cannot express, so a row carries one of three lifetimes: **off** (divider 0),
**repeating** (divider *n*), or **one-shot** — included on the first tick after connect and
then retired. One-shot is a state, not an interval, which is why it needs saying: the earlier
version of this section had only intervals and would have either skipped the firmware version
or polled it forever. Worth noting the references chose differently and read even nominally
static values repeatedly — Device Manager re-reads the firmware version every fifth tick, on a
product that can flash firmware in-session. If in-session flashing ever becomes ours to
support, the affected rows move from one-shot to repeating; the mechanism already allows it.

On each tick the scheduler composes **one command** from the rows that come up,
and hands it to the per-brick `commandQueue` so telemetry interleaves with the heartbeat and
with explicit commands rather than racing them.

This is what both mature implementations do, and an earlier version of this section did not.
LEGO's own Device Manager runs a 200 ms tick with `_checkDeviceInfoCounter = 5` for its slow
tier; LEGOev3 awaits each reply *before* its 100 ms delay, so its "100 ms" is a gap rather
than a period. The version this replaces held per-row next-due times and fired on wall-clock,
which bought nothing and gave up three things:

- **At most one telemetry frame is in flight per brick.** A tick that arrives while the
  previous frame is outstanding is **skipped**, not queued — Device Manager guards exactly
  this with an `Interlocked` counter. Without it a stalled brick lets frames pile up behind a
  serial queue until the heartbeat misses its window and trips reconnect on a healthy brick.
  Since a single unsettled device can hold a frame for 1.2 s (§9.1c) while Bluetooth sustains
  only 10.7 commands/second, this is a routine case, not a corner one.
- **The tick is the only clock.** Phase comes from the tick, so no row drifts and none can be
  pulled forward. "Nearly due" needed a bound nobody could state; a divider needs none.
- **A skipped tick costs latency, and for a slow row it can cost a sample.** A divider-1 row
  simply comes up again on the next tick. A divider-5 row whose turn fell on a skipped tick
  waits for the next multiple of five, because phase is anchored to the tick counter and the
  counter keeps running while the scheduler stands down — so that row's series has a gap.

  That is the price of a clock nothing can drift against, and it is a divergence from LEGO's
  Device Manager, which decrements its slow-tier counter only inside a tick that actually ran:
  its slow tier is delayed by a stall but never skips. Ours is the right trade while stalls
  are rare and the slow tier is battery and occupancy; it would be the wrong one if a slow row
  ever carried something whose every sample matters.

One rule genuinely follows from round trips being scarce, and it survives:

- **Compose widely within a tick.** Every row coming up on this tick rides in one command.
  What does *not* follow is pulling rows forward from future ticks: neither reference does it,
  and it is what made the HID budget unmanageable while letting intervals ratchet shorter.
  ~~The slow tier keeps its own command on its own ticks rather than being merged into the fast
  one, as Device Manager does.~~ **Superseded by owner decision D8 (11.11.2026):** one command a
  tick, the event and static rows riding with the sampled ones on their ticks. Measured on three
  bricks, every telemetry command costs a running user program about 2 ms of the VM, nearly
  whatever it carries (step-6 plan, "does telemetry slow a running program?"); a second
  command on every slow tick bought nothing that justified that.
- **Priority is a truncation rule, not the scheduling principle.** It decides what survives
  when a tick's rows genuinely cannot fit one command — in practice the HID fallback.
  Truncation must be **rotating, not static**: a row that loses this tick is carried to the
  front of the next one. Static priority on a tight budget starves the losers for good, which
  is how the first version of this design produced a panel that could show ports appearing and
  disappearing but never a single sensor value.
  With occupancy now a row rather than a mandatory header, and the slow tier in its own
  command, the HID budget is no longer routinely exhausted — but the rule has to hold anyway,
  because a user with eight populated ports on HID can still overrun a tick.
- **The assembler owns the offsets.** A row declares how many bytes its result needs; it does
  not pick where. It lays 32-bit results out 4-byte aligned — the Communication Developer Kit
  states it as "float/32bits first and 8 bits last".

  **How strictly the brick enforces that depends on the opcode**, which took two measurements
  to establish and one wrong conclusion in between:

  | Instruction | 32-bit result at offset 2 | Reply |
  |---|---|---|
  | `opINPUT_READSI` (0x9d) | **rejected** | `DIRECT_REPLY_ERROR` (0x04) |
  | `opINPUT_DEVICE` / `READY_SI` (0x99, sub 29) | **accepted**, correct value | `DIRECT_REPLY` (0x02) |

  Both measured 3 of 3 on a brick with a gyro on port 2. The second row is LEGOev3's shipped
  layout — type at 0, mode at 1, SI float at 2, RAW int32 at 6, PCT at 10 — which is
  unaligned in six of its eight ports and works. So alignment is not a property of the
  global buffer; it is a property of the instruction writing into it.

  We use `opINPUT_READSI`, so the rule binds on us and the assembler must keep it. But state
  it as what it is: a constraint of the opcodes we chose, not a law of the firmware. Switching
  a row to the `READY_*` subcodes would lift the padding at the cost of one byte per
  instruction — worth weighing when the HID budget is tight, not before.

  When it does bind, the rejection is not silent. The brick answers `DIRECT_REPLY_ERROR`, and
  `c_com.c` copies the full declared global buffer into that error reply exactly as into a
  successful one — so the payload is whatever the *previous* command left there. It reads as
  data only to a parser that ignores the reply-type byte. Ours checks it (`validate_reply` in
  `daemon/crates/protocol/src/responses.rs`), which is why shipped code was never exposed; the earlier claim that the
  brick "skips the command silently" came from a probe of mine that did not check it.

- **The assembler must bound the reply, not just the request.** The reply on the wire is
  always *declared globals + 5 bytes*, however few bytes the program actually wrote, and the
  firmware never checks it against `MAX_MSG_SIZE`. So the usable ceiling is 1019 B, not the
  1021 B of `MAX_COMMAND_GLOBALS` — and on the 64-byte HID fallback the declaration must stay
  under 59 B, which alignment padding can breach before the instruction count does.

The assembler also has to **refuse conflicts rather than merge them**: two *modes* of the same
UART sensor cannot share a command. Asking for both returns `DATAF_NAN` and leaves the sensor
unsettled, including in the mode that worked a moment earlier.

Two reads of the same mode are not a conflict — LEGOev3 takes SI, RAW and PCT off one port in
one frame. The constraint is the mode switch, not the number of reads.

### 9.1c Port state is five-valued

Port type is read by the **occupancy row**, on that row's own divider (§9.1a) — not in every
frame. It is what gates the value rows: a value is read only when the port's last known state
was *known*, so the state is one tick stale by construction and that is a property to state,
not a defect to hide.

| State | Code | Value | What the panel shows |
|---|---|---|---|
| empty | 126 | — | nothing attached |
| identifying | **125** | — | attached, being identified |
| known | a device type | read | the device and its reading |
| error | 127 | — | attached, faulty |
| terminal | 124 | — | a console, not a peripheral |

Anything else at or above 124 that is not a recognised device code is displayed as
not-readable rather than guessed at.

`TYPE_UNKNOWN` is information, not noise: every device plugged in while running reports it
for a second or two, and showing it is how the panel says "working on it" instead of showing
a blank.

The reason not to read its value is **not** stale data. `c_input.c` pops the remaining
parameters and writes the type-appropriate NAN into each — `DATA8_NAN`, `DATA32_NAN` or
`DATAF_NAN` — so an absent or faulty port reports its own absence, and that NAN is the
authoritative answer rather than something to be second-guessed host-side.

> **Correction (11.11.2026, from `c_input.c` of firmware 1.09d; U10 measures it on a brick).**
> The stall described in the next paragraph does not apply to the instruction the value rows
> use. `opINPUT_READSI` (`cInputReadSi`) sets the type and mode and returns
> `cInputReadDeviceSi`; it never changes the dispatch status, so a busy or identifying device
> answers NaN at once. The `SetObjectIp(TmpIp - 1); SetDispatchStatus(BUSYBREAK)` re-execution
> is in `opINPUT_DEVICE`'s `READY_SI`/`READY_IIC` cases and in `opINPUT_READY`. The gate stays,
> for a smaller reason: a read of a port that is not known has nothing to learn and costs scarce
> bytes. A mode switch likewise makes the next reads NaN rather than holding the frame.

The real reason is that an *identifying* port is not absent. Its connection is a live value,
so the read takes the device-present path, and if the device is still settling the firmware
does `SetObjectIp(TmpIp - 1); SetDispatchStatus(BUSYBREAK)` — it re-executes the instruction,
blocking the VM thread for up to `MAX_DEVICE_BUSY_TIME`, **1200 ms**. Since everything rides
in one command, one unsettled port holds up every other value in the frame, the heartbeat,
and every explicit command queued behind it.

`GET_TYPEMODE` never blocks; it reads `DeviceType` and `DeviceMode` straight out of memory.
So the occupancy row is safe at any divider. It is only the value read that can stall — which
is the second reason the two are separate rows rather than one mandatory sweep plus optional
values.

Two consequences of gating on the previous tick's state, both worth stating rather than
discovering later: a freshly known port shows no value for one extra tick, and a port that has
just gone empty had a slot allocated for it in the frame already in flight. Neither is a
defect; the panel shows *identifying* in the first case and a NAN it can recognise in the
second.

**One stall window stays open, deliberately.** A port nothing has reported on yet is treated
as readable, so a device plugged in seconds before connect — still reporting 125 — has its
value read on the very first frame of the session and can hold it for 1.2 s. Closing the
window means gating on unknown as well, which costs every port one tick of silence at every
connect. Since the occupancy rows come up on tick 0 anyway, the window is one frame wide and
only opens on a connect that races a hot-plug, while the silence would be paid every time.
Worth revisiting if the first frame after connect ever matters more than that.

**Mode ownership spans ticks.** At most one active mode row per port at any time. Two rows
asking for two modes of one UART sensor cannot be fixed by putting them in different frames:
each frame would force a mode change, and `cInputSetDeviceType` sets Busy with a timeout of
`MAX_DEVICE_BUSY_TIME`, so both rows would read NAN indefinitely — worse than the in-frame
conflict the rule was written to prevent. Changing a row's mode is therefore an explicit
switch-and-settle: change it, then discard readings until one comes back non-NAN.

Two reads of the *same* mode are not a conflict. LEGOev3 takes SI, RAW and PCT off one port in
one frame, and our own measurement reproduced it.

### 9.2 Foreground Telemetry

**Refresh budget.** The foreground rate is bounded from below by the transport, not only from
above by throttling: the per-brick queue is strictly serial, so the frame rate is the round
trip time times the number of commands per frame.

The per-command figures below are measured. The **frame** figures are arithmetic on top of
them, against a frame of four commands (`ports`, `battery`, `buttons`, `info`) — what the
cockpit happened to send at the time, not a considered baseline. Both reference
implementations already compose one command, so four was never the state of the art; it was
our own starting point.

§9.1b replaces it with a single composed command. That does **not** license dividing every
figure by four: the composed frame has not been measured, and it is wider than any of the four
it replaces. What the division gives is an upper bound on the improvement, not a prediction.

Both an average and a worst case are given below, because mixing them was how this section
previously reported a Bluetooth frame at 240 ms while quoting a 121 ms worst-case command.

Measured on USB, firmware V1.10E: **9 ms** worst case over 40 exchanges, including the
`ports` command's 16 sub-operations. Four such commands is about 40 ms — roughly 25 Hz, far
above anything the panel needs. An earlier version of this section put USB at 0.5 Hz; that
came from `USB.COMMAND_RTT_MS: 500`, a constant no code ever read and which was about 50x
pessimistic. Sustained rate: **176 commands/second**.

Bluetooth SPP measures at **121 ms** worst case over 30 exchanges, averaging 55-70 ms. Four
commands is therefore ~240 ms (≈4 Hz) on average and ~484 ms (≈2 Hz) worst case. Slower than
USB by an order of magnitude, and still usable for the panel. The RFCOMM connect itself took
4851 ms, which is the cost worth designing around on that transport — not the per-command
latency. Sustained rate: **10.7 commands/second**, which is worth stating plainly: a target of
"10 Hz on Bluetooth" would consume the brick's entire measured capacity, leaving nothing for
the heartbeat or for anything the user does.

TCP measures at **58 ms** worst case over 40 exchanges against a brick on Wi-Fi, averaging
33 ms, so four commands is about 130 ms (≈7 Hz) on average and ~232 ms (≈4 Hz) worst case.
Connect plus the VMTP unlock handshake takes 273 ms. Sustained rate: **62 commands/second**.

All three transports are now measured, and in every case the constant that had been sitting
in `transportConstants.ts` was pessimistic by more than an order of magnitude: USB by ~50x,
TCP by ~17x, BT by ~16x. None of them was read by any code, which is why nobody noticed.

**Beacon discovery needs an outbound datagram first.** The brick broadcasts its announcement
to the subnet broadcast address every 5 seconds whenever Wi-Fi is up — the firmware enables
this on AP association and only stops it on shutdown or an AP search, never because a client
is connected. A host firewall that filters unsolicited inbound UDP therefore drops it, and
Windows does exactly that by default: measured here, the brick announced for half an hour
while discovery saw nothing, and an exclusive bind proved no other process held the port.
The provider now sends a one-byte datagram to each interface's broadcast address every few
seconds, which puts its socket in the firewall's stateful table and lets the announcements
through. This changes no firewall configuration; it is the ordinary
outbound-before-inbound pattern, and without it TCP discovery cannot work on a stock
Windows install.

**The transport is the binding constraint, not a guard.** Sustained command rates were
measured per transport over 600 back-to-back commands: **USB 176/s** (6 ms median),
**TCP 62/s** (16 ms), **BT 10.7/s** (102 ms). No transport produced a single error or any
latency drift at its own rate, and all three recovered clean. At four commands per
telemetry frame that is **~44 Hz on USB, ~15 Hz on TCP, ~2.7 Hz on BT**.

This section has now been wrong twice about the same thing, in opposite directions, and the
second time is more instructive than the first.

The first revision measured USB round trips, read 9 ms as "far above anything the panel
needs", and declared the refresh problem solved. Two independent reviewers then caught a
real inconsistency — §4.1 capped a brick at 10 commands per second, which would have made
the reachable frame rate 2.5 Hz everywhere and the transport ceilings irrelevant — and this
section was rewritten to say the guard binds first.

That resolution was wrong, because the 10 came from nowhere. It appeared in
`FIRMWARE_SAFETY` with no recorded basis, was read by a guard that was never wired, and
measurement puts it 17x low on USB and 6x low on TCP. It matches BT only by coincidence:
SPP's round trip happens to land at about ten exchanges a second. **A consistency argument
cannot tell you which of two inconsistent numbers is the wrong one** — the reviewers were
right that the documents contradicted each other, and resolving it toward the unmeasured
side was the error.

Two consequences follow. Phase 3's per-transport target and floor (3.8) derive from the
**measured per-transport rate**, not from one global budget; USB and TCP have ample room and
BT does not. And batching the frame into one multi-opcode command (3.1.5) stays worth doing,
but for a narrower reason than the previous revision claimed: it is what makes **BT**
usable, taking it from ~2.7 Hz to ~10 Hz. On USB and TCP it is an optimisation, not a
prerequisite.

Phase 3 still owes that target and floor, and the panel still owes a degraded-telemetry
indicator below the floor.

Foreground telemetry is for the active brick in the panel only.

Contains:

- port mapping,
- peripheral detection,
- live values,
- button state,
- battery,
- system data needed for the status bar and config mode.

### 9.3 Subscribed Telemetry

Subscribed telemetry runs over an inactive connected brick only when an active API subscription exists.

Rules:

- **subscriptions are per row.** A category is a convenience bundle that expands to a set of
  rows at subscribe time and is never a unit of cadence — §9.1a explains why cadence cannot be
  a per-category property, and an earlier version of this section contradicted it,
- a snapshot is always delivered before events,
- after a subscription ends, the runtime may hold the last snapshot briefly as `stale`,
- a claim is clamped to the transport's floor like any other (3.1.10), so a subscribed brick
  can run faster than the foreground cadence; every telemetry command costs a running program
  about 2 ms of the VM (step-6 plan, measurement), which is what the floor and the program-running
  preset are for.

**What a row must carry to be a contract.** Rows are the surface third parties build on, so
each needs more than a value:

| | Why a consumer needs it |
|---|---|
| stable **row id** in a namespace | to name a row across versions; `ports.sensor.1.value`, not an index into an array (format: owner, 11.11.2026) |
| the **contract version** in the handshake | to detect that the row vocabulary changed |
| **`sampledAt`** per row value | rows in one snapshot come from different ticks; without this a consumer cannot tell fresh from carried-over |
| the **granted interval** | what the consumer asked for is a request, not a guarantee — see below |
| raw type code beside the resolved name | a closed vocabulary cannot name a device we have not heard of; the code lets a consumer recognise one anyway |

**Subscribing is a negotiation, not an assignment.** "Fastest subscriber wins" is the
reconciliation rule, but not without limits: a request faster than the transport's floor
(§9.2) is **clamped**, not honoured, and the subscribe call returns the interval each row was
granted: the request clamped to the floor, a promise of at least that often, fixed when the
claim is made. Without that, one extension asking for 10 Hz on Bluetooth would consume the
brick's entire measured capacity of 10.7 commands/second and every other consumer — and the
heartbeat — would pay for it silently.

The grant stays what was negotiated. When throttling moves the tick (§4.5), the snapshot and
every event carry `effectiveIntervalMs`, the interval the rows really run at; nothing is
re-negotiated (owner, 11.11.2026). Every port carries `layer`: 0 for the brick's own ports,
1–3 for the bricks below it in a USB daisy chain (owner, 11.11.2026; built 17.11.2026).

**The daisy chain** (step-8 plan, `docs/plans/2026-11-17-step8-daisy-chain.md`). A brick below
another is reached only through it, by the `LAYER` argument of an ordinary direct command; it
has no `BrickKey`, session or queue of its own. One event-tier row, `chain.depth`, copies the
master's device list (`opINPUT_DEVICE_LIST`, all 32 port types of the chain in one instruction)
and reports the deepest layer with a device; an empty last member reads exactly like no brick
and is not counted. A member's ports are rows of their own under `chain.<layer>`, with port
names `'<layer>:<port>'` so the occupancy gate and the mode claims work per port; there is no
tacho row for a member, because the position does not cross the chain. The scheduler reads a
member's rows only within the reported depth, a member's value only after its occupancy says a
device is there, and nothing of the chain on the HID fallback, where the 33-byte list would take
the brick's own readings' frames. The chain itself is derived from the depth row, never stored,
and each member carries what it can do from one module (`daemon/crates/runtime/src/chain.rs`): today
sensors, motor types on the layers measured, and nothing a host cannot address to a layer
(name, files, programs). The contract offers it as `chain/get` and `chain/follow`.

Subscribers are identified by an opaque handle returned from subscribe, so unsubscribing
releases exactly one claim on a row and the effective interval is recomputed from those that
remain. This is what makes §9.1a's promise real: switching a row off in the panel drops the
cockpit's claim, never anyone else's.

**Registering a row rejects, rather than documents, what will not fit.** A third party adding
a row does not need to know about 4-byte alignment for `opINPUT_READSI`, the 1019-byte reply
ceiling, or 59 bytes of declared globals on HID (64 less the 5-byte reply header; the request's bytecode gets 57) (§9.1b). Registration validates against them
and fails there — the alternative is a constraint published as API and breached at runtime as
a corrupt frame.

### 9.4 Minimal Telemetry

Minimal telemetry is the base mode of a connected brick without foreground and without subscriptions.

Contains only:

- heartbeat,
- reconnect state,
- session availability.

### 9.5 Adaptive Throttling

Throttling adjusts **one knob: the base tick period** (§9.1b). Row dividers stay fixed, so
every row slows in proportion and their phase relationships are preserved — which is the
practical reason to throttle the tick rather than the intervals. There is no other quantity to
scale: under §9.1a telemetry has no single speed, and the earlier wording here pointed at §4.5
as though it did.

The tick period is floored per transport (§9.2) and clamped so it can never grow past the
heartbeat's window.

Of §4.5's two named inputs, only one survives its own measurements: **latency**, and as a
distribution rather than an average. Queue depth has no dynamic range here — with one frame in
flight per brick (§9.1b) it is 0 or 1 by construction, so it reports the invariant holding
rather than the brick struggling.

The throttling applies to telemetry delivery scheduling only — it has no effect on user-facing UI logic or explicit commands.

The current telemetry speed is visible in the Cockpit panel (diagnostic display).

### 9.6 Telemetry Subscription Flow

```mermaid
sequenceDiagram
    participant Ext as Client
    participant API as Daemon
    participant TM as Telemetry Runtime
    participant SM as Session Manager

    Ext->>API: hello (key proof, contract version)
    API-->>Ext: accepted; bricks/list

    Ext->>API: telemetry/subscribe(brick, rows, intervalMs)
    API->>TM: claimRows(brickKey, rows, intervalMs)
    TM-->>Ext: Subscription { id, grantedIntervalMs per row }
    TM-->>Ext: TelemetrySnapshot (initial, each row with sampledAt)

    loop Every tick a claimed row comes up
        SM->>TM: reply parsed
        TM-->>Ext: TelemetryEvent (changed rows only)
    end

    Ext->>API: subscriptions/cancel(subscriptionId)
    API->>TM: releaseRows(subscriptionId)
    note over TM: effective interval recomputed<br/>from the claims that remain

    note over SM,TM: On disconnect
    SM->>API: brick disconnected
    API-->>Ext: bricks/changed; telemetry/update(ended)
    TM->>TM: cancel all subscriptions for brick
```

## 10. Daemon and Clients

Built in 4.10.2 (`docs/plans/2026-11-19-0937-feat-cockpit-daemon-and-clients-plan.md`) as a Node
daemon, rewritten as the native daemon `ev3-cockpitd`
(`docs/plans/2026-11-20-1845-refactor-native-daemon-plan.md`), which replaced it on 23.11.2026. The
wire protocol is described in `docs/protocol.md`, the channel in `docs/channel.md`; add-on authors
start with `docs/api-for-consumers.md`.

### 10.1 One Daemon, Many Clients

One daemon per user holds the bricks: their connections, presence, telemetry, programs, files,
the transfer ledger and the settings. It is a native binary for Windows x64, Linux x64 and Linux
arm64 that needs no Node runtime, shipped in the VSIX and npm packages. Every client goes through
it:

- the VS Code extension, one client per window;
- the `ev3` command, for a shell, scripts and agents;
- the MCP server, `ev3 mcp`, a subcommand of the native `ev3`;
- add-ons such as EVƎ C, through the client library `@ev3-cockpit/client`.

The first client starts a verified copy of the daemon binary; it ends 10 s after its last client
has gone and no brick is held through `ev3 connect`. Only the daemon opens a brick, so two programs
never pull at one. The extension exports no API (KTD18).

### 10.2 The Contract

One contract for every client: JSON Schema in `contract/` holds the method names, parameters,
results, notifications, error codes and the contract version, generated into Rust and into
`src/contract/generated/`; `src/client/` is the library that finds or starts the daemon, proves
the user's key, keeps the brick list and settings current, and renews subscriptions after the
daemon is replaced. Everything that crosses it is plain JSON; every error carries a stable code.
A brick is named by id or name; a write takes the brick's lease for one request, and a second
writer gets `brick_busy` naming the holder; stop and emergency stop never wait. Questions for a
person go only to a VS Code window or a terminal: the requesting client when it is one, else the
one that connected last; an add-on or an MCP server is never asked, and the question names who
requested. An unanswered question changes nothing.

The daemon runs one program service per brick for everyone, so every stop reaches it, and
delivers every client's telemetry from one queue in one order.

### 10.3 Access Mode

The daemon's setting `accessMode` (owner, 11.11.2026; moved to the daemon in 4.10.2). **safe**, the
default: a client writes, deletes and runs only under `/home/root/lms2012/prjs` and `/media/card`,
and reads everywhere; paths are resolved as the brick resolves them, so `..` cannot climb out, and
a user area itself cannot be removed. **full**: the whole brick, shell included. Switching to full
needs a person's confirmation from VS Code (`EVƎ: Settings`) or the `ev3` command; an MCP server or
an add-on cannot switch it. Full lasts until the daemon ends; it is never stored. The daemon
enforces it for every client. **It is a guardrail against mistakes, not a sandbox:** a program run
in safe mode can do anything on the brick (`opSYSTEM` is open to every `.rbf`), and the check
reads paths as written, so a symbolic link inside a user area that points outside it is not caught.

### 10.4 Connecting

A client connects a brick with `bricks/connect`, which runs the brick layer's sign-in exactly as
"Connect a Brick" does — pairing first a brick only an inquiry has heard, the brick's dialog as
consent — and makes the client one of the brick's holders. A brick stays connected while it has a
holder; a disconnect drops only the caller's own hold (R36).

### 10.5 Replacement and Development

A newer release client, or a development client meeting a release daemon, asks the daemon to end
(`daemon/exit`) once no write is in progress and starts its own; any other exit request is a
restart that needs a person's yes (`ev3 daemon restart`, "Restart the Cockpit Daemon"). Nothing is
handed over: the new daemon connects again the bricks held with `ev3 connect` (`held.json`), and
each client reconnects its own bricks. Development and release builds share the user's channel; the
separate development daemon with brick loans and the handover of 4.10.2 were dropped in the native
rewrite (`docs/channel.md`, "The daemon's life").

## 11. Filesystem Design

The Cockpit UI will not contain a file explorer or browse workflow.

The filesystem is designed as a service for API consumers.

The layer covers **every operation the protocol offers**, not a chosen subset. The full
contract — requirements, flows, and the operations deliberately excluded — is
`docs/plans/2026-08-20-1740-feat-filesystem-layer-plan.md`, built on the firmware-verified
survey in `docs/ideation/2026-08-20-filesystem-protocol-survey.md`.

In outline: chunked upload and download with progress and cancellation and no size ceiling;
list, read, exists, size, and free space; make and remove directories; move, which is the
protocol's only rename primitive and has no system command at all.

An earlier revision of this section listed `uploadFile`, `downloadFile`, `executeRbf` and
“basic read/list”. That list came from what seemed obvious rather than from the protocol:
the firmware exposes seventeen system commands and thirty-two `opFILE` subcodes, and rename,
free space, and a real existence check were missing because nobody had looked.

Three operations in range are deliberately excluded because they are not filesystem work:
`ENTERFWUPDATE` (a bricking hazard), `BLUETOOTHPIN` (a pairing credential), and
`WRITEMAILBOX` (VM messaging). Full-folder sync and log tailing are deferred, the latter
with its opcodes declared so the capability is not lost again.

## 12. Cockpit UI Design

The primary users include children from approximately age 10 (see `REQUIREMENTS.md §2`). The UX must be clear and self-explanatory in its basic mode. Advanced features are exposed through settings and configuration mode, not through a separate interface.

### 12.1 Discovery Tab

The discovery tab is the main entry point into Cockpit.

Each row is one brick and contains:

- one icon per channel (`[U][B][T]`): hidden when the channel is absent, blue when available,
  green when connected, grey when lost — for a paired Bluetooth brick that stopped answering
  its presence checks, "not heard",
- a name, marked when the brick has not confirmed it,
- supplementary icons on the right according to state.

Connecting a brick opens every available channel (step-2 plan, KD1); there is no per-channel
connect.

Quick actions:

- connect for an available brick,
- focus/open for a connected brick,
- trash for a remembered offline brick (removes all metadata including `favorite`),
- signal indication where available,
- star for a brick with `favorite: true` (indication, not a toggle).

### 12.2 Brick Tab

Each connected brick has its own tab.

**Tab header:**

- transport icon with status color,
- brick name,
- gear icon for config mode,
- X icon for explicit disconnect.

**Status bar** (top row inside the tab):

- left: icons of available transports for the brick (not necessarily the one it is connected through),
- center: battery state,
- right: star — **clickable**, toggles `favorite` on/off; always shown, filled when
  `favorite: true` and outlined otherwise.

**Tab content — normal mode:**

- brick image with interactive buttons,
- above the brick: 4 motor ports (A, B, C, D),
- below the brick: 4 sensor ports (1, 2, 3, 4),
- each port shows a peripheral icon and a measured value.

**Measured value visual style** (configurable per brick, stored with `favorite`):

- **Numeric style**: the exact text value as returned by the sensor.
- **Visual style**: each peripheral type has its own graphical element — a color sensor shows a color target, a touch sensor shows press state, a gyro shows an arc with an indicator, an ultrasonic sensor shows a distance bar, a motor shows schematic rotation, etc. Visual inspiration: makecode.mindstorms.com.

Switching the style is done in config mode and the preference is persisted.

### 12.3 Config Mode

Config mode is part of the same tab — it replaces the normal mode content.

Displays:

- editable brick name,
- system and technical information,
- toggle for the measured value visual style (`numeric` / `visual`),
- status bar configuration.

**Auto-save and Optimistic Updates**: After each edit action (keystroke, checkbox toggle, etc.), a timer starts for that specific field. The change is written to the brick on focus loss or after 1 second from the last action.
- **Optimistic Update**: The Session Manager immediately emits a local event with the new value so the UI and the daemon's clients see the change at once.
- **Telemetry Confirmation**: The final source of truth remains the physical brick. Telemetry eventually confirms whether the change was successful or if the value has changed externally (e.g., physically on the brick).

**The star toggle is not available in config mode.**

**Sensor and motor port state is not displayed in config mode.** The brick image with ports is replaced by the configuration form. System information fields (such as brick name) remain live — if a value changes externally, it updates in the form.

## 13. Mock Design

> **Deferred 20.11.2026** (native daemon plan, Key Decisions): the native daemon has no simulated
> bricks yet. Recorded brick sessions guard regressions instead: a recording made on hardware
> (`daemon/fixtures/`) is replayed at the provider trait, strictly for the Rust failure-path tests
> and matched for the client tests on a test channel (`docs/channel.md`, `--replay`). The design
> below is what a mock provider will implement when it comes back.

Mock is an equal transport provider.

### 13.1 Mock Runtime

The mock runtime must implement the same contract as physical transports:

- discovery,
- connect,
- reconnect,
- telemetry,
- filesystem API,
- error states.

### 13.2 Mock Configuration

Mock brick definitions are loaded from a JSON configuration file in the workspace.

The format must support:

- brick identity and system parameters,
- connected sensors and motors,
- value dynamics (static values or oscillators).

A GUI editor for this configuration is deferred — see `REQUIREMENTS.md §16`.

In the TypeScript implementation the mock provider was registered only in development or when the
user asked for it; without it there were no mock bricks in discovery and no mock lines in the log.

## 14. Commands and VS Code Integration

The primary UX is in the panel.

The Command Palette serves only as:

- a fallback,
- diagnostics,
- emergency panel recovery.

Commands can be added or removed in future versions. The design must not rely on them as the primary mode of interaction.

## 15. Non-Functional Requirements

### 15.1 Performance

Cockpit must not significantly degrade the VS Code experience.

Requirements:

- tab switching must remain smooth,
- the text editor must not be blocked,
- webview refresh must be limited,
- separate frequencies for `foreground / subscribed / minimal`.

The system must handle dozens of simultaneously visible devices (as required by `REQUIREMENTS.md §5`). This implies:

- the Presence Aggregator must handle frequent discovery updates without blocking,
- the discovery list UI must render efficiently (consider virtual scrolling for large lists),
- telemetry scheduling must scale with the number of connected bricks without degrading the foreground experience.

### 15.2 Stability

A connected session is more valuable than a transient discovery record.

This means:

- reconnect is preferred over losing a session,
- explicit disconnect takes precedence,
- a failure of one brick must not destabilize other sessions.

**Command queue:**

- each connected brick has its own communication queue,
- the queue is shared across all transport providers for that brick — if a brick is connected via both USB and BT simultaneously, they share one queue,
- this architecture prevents conflicts between transport layers over the same brick.

## 16. Deferred and Maybe Someday

See `REQUIREMENTS.md §4` (deferred to a later version) and `REQUIREMENTS.md §16` (maybe someday). The architecture must not block any of those areas.
