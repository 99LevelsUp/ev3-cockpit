# EVƎ Cockpit - Requirements

> Version: 2026-04-02
> Status: current product specification

## 1. Product Purpose

EVƎ Cockpit is a Visual Studio Code extension that:

- discovers EV3 bricks available via `mock` (deferred, §13), `usb`, `tcp`, and `bt`,
- connects one or more bricks into the Cockpit runtime,
- displays the state of the active brick in the Cockpit panel,
- runs as one per-user daemon that VS Code, the `ev3` command, an MCP server and add-ons share through one public contract.

Cockpit is not intended for programming the brick.
Cockpit is not intended for browsing the brick's filesystem in the user-facing GUI.

## 2. Target Users

Primary users are VS Code end users, approximately from age 10 to adult.

Usability requirements:

- the basic mode must be simple and clear,
- the advanced mode must expose all available information,
- the architecture must not be constrained to a simplified GUI,
- increased detail is handled through settings and configuration, not by a separate architecture.

## 3. Scope of This Version

In scope for this version:

- brick discovery and continuous tracking,
- connect and disconnect exclusively through Cockpit,
- multiple simultaneously connected bricks,
- one active brick in the Cockpit foreground,
- foreground monitoring of the active brick,
- background heartbeat and reconnect for connected bricks,
- subscription-based telemetry for other extensions,
- a public contract and client library for other programs,
- filesystem operations for other programs,
- transport support: `mock` (deferred, §13), `usb`, `tcp`, `bt`,
- mock runtime (deferred, §13),
- persistence of favorites and remembered metadata.

## 4. Deferred to a Later Version

In scope eventually, but not part of this version:

- panel-based list of `.rbf` / `.rpf` programs and launching them from the GUI,
- run/stop workflow for programs from the panel,
- advanced full-folder deployment workflow.

The design must not block these areas.

## 5. Main Workflow

Primary user workflow:

1. opens Cockpit and views the brick list,
2. selects a brick and connects to it,
3. monitors port state, sensors, motors, and system data,
4. switches between multiple connected bricks as needed,
5. simultaneously uses other programs (add-ons, the `ev3` command, an AI agent) through the cockpit daemon,
6. temporarily loses and rediscovers a brick during work,
7. finally disconnects the brick or powers it off.

The system must work for a single brick as well as for scenarios with dozens of simultaneously visible devices.

## 6. UX Requirements

### 6.1 Placement

The main UX runs as a webview in the right secondary panel of VS Code.

### 6.2 Panel Tabs

The panel contains:

- one discovery tab with the brick list,
- one tab for each connected brick.

When the discovery tab is in the foreground, no brick is active.

### 6.3 Discovery Tab

The discovery tab displays a single unified list of:

- available bricks,
- connected bricks,
- remembered bricks that are currently out of reach but known to the system.

Each item contains:

- a transport icon,
- a color-coded status indicator,
- the brick name,
- supplementary icons on the right.

The right-side icons may include, depending on state:

- signal strength indicator where applicable,
- a star for `favorite`,
- a trash icon to forget a remembered brick from the system.

Ordering must be stable. Renaming a brick must not change its position in the list.

### 6.4 Brick Tab

The brick tab displays:

- an image of the brick,
- motor and sensor ports,
- connected and disconnected peripherals,
- live measured values,
- a status bar,
- a button to switch to configuration mode,
- a favorite star in the status bar — clickable, toggles `favorite` on/off.

Measured values can be displayed in two visual styles:

- **Numeric**: the exact text value as returned by the sensor.
- **Visual**: each peripheral type has its own graphical element (color target, slider, arc, etc.).

The preferred style is configurable per brick and stored alongside other metadata.

The default status bar must show:

- battery state,
- available transports for the brick,
- for Bluetooth, also the visibility status if available.

The brick name and active transport are primarily shown in the tab header.

### 6.5 Configuration Mode

The active brick has a gear icon to switch to configuration mode.

Configuration mode must allow:

- changing the brick name,
- viewing technical and system information,
- configuring which data is shown in the status bar,
- toggling the visual style of measured values.

Changes are written to the brick continuously — after each edit action a short timer starts for that specific field, and the value is saved on focus loss or after 1 second from the last change, whichever comes first.

### 6.6 Brick Buttons

The buttons on the brick image must be interactive.

Required behavior:

- display physical button presses,
- relay button presses from the UI to the brick if the protocol allows,
- if software button presses are not reliably available, show buttons as disabled.

### 6.7 Command Palette

The Command Palette is not the primary mode of interaction.

It serves only as:

- a fallback when the panel is unavailable,
- diagnostics and emergency panel recovery.

The primary UX is always the Cockpit panel.

## 7. State Model

### 7.1 Discovery State

From the perspective of discovery, a brick can be:

- `remembered`,
- `available`,
- `unavailable`,
- `removed`.

`remembered` means the system knows about the brick (from OS evidence or Cockpit persistence) but the brick is not currently visible.

`unavailable` means the brick was visible but has temporarily disappeared; the system waits for it to return before transitioning to `removed`.

### 7.2 Session State

A connected brick goes through:

- `connecting`,
- `connected`,
- `reconnecting`,
- `disconnected`.

### 7.3 Activity in Cockpit

Cockpit always has at most one active brick:

- `active` is the brick whose tab is in the foreground,
- all other connected bricks are in background mode,
- when the discovery tab is shown, no brick is active.

### 7.4 Brick Identification and Favorites

- A brick is one brick however many channels reach it (owner's decision D2, 29.10.2026). Its
  identity is the twelve hex digits that are its USB serial, its Bluetooth address and the
  serial in its TCP beacon.
- `brickKey` identifies one channel to a brick:
    - **USB**: Serial number (or VID:PID:Serial).
    - **BT**: MAC address.
    - **TCP**: Serial number reported by the brick, falling back to the IP address when the
      brick reports no serial; a brick known only by IP is its own brick.
- `favorite` status and `auto-connect` are bound to the brick, not to one channel of it.

## 8. Telemetry

Cockpit monitors the state of connected bricks and delivers telemetry data to the panel and to other extensions.

Telemetry is divided into categories:

- `ports` — sensors, motors, port mapping, and measured values,
- `filesystem` — filesystem state and events relevant to API consumers,
- `system` — system information: firmware, battery, available transports.

Each connected brick operates in one of three telemetry modes:

- `foreground` — fastest scan, full data for the active brick in the panel,
- `subscribed` — reduced frequency, only for categories requested by API consumers,
- `minimal` — heartbeat and reconnect only, no extended telemetry.

Requirements:

- the foreground brick must have the fastest telemetry,
- subscription telemetry must not degrade the foreground experience,
- the system must remain responsive even with concurrent subscriptions on multiple bricks,
- telemetry frequency must adapt to each brick's measured response latency — its tail, not its
  average; queue depth was measured and has no range with one frame in flight (DESIGN §4.5,
  changed 11.11.2026).

Bricks chained over USB (up to four, owner decision 16.11.2026, built 17.11.2026): the cockpit
reads the chain below the brick it reads, through that brick. Each brick below it is a member
of the chain, with its sensor ports (type, mode, value) and its motor ports (type only: a
member's motor position does not cross the chain) named by layer and port, and with what it can
do. A brick with no chain pays one extra reading every fifth tick and nothing more. After the
chain is rewired the master must be restarted: the firmware can freeze a chain's last state,
and nothing the host can read tells a frozen chain from a still one.

## 9. The Daemon and Its Contract

Other programs communicate with bricks exclusively through the cockpit daemon — they never connect
to bricks directly. One daemon runs per user; the VS Code extension, the `ev3` command, the MCP
server and add-ons are its clients (4.10.2, `docs/protocol.md`). The daemon runs on its own: a
native program that needs neither VS Code nor a Node runtime, on a channel only the user's account
can use (IMPLEMENTATION_PLAN 4.10.4, `docs/channel.md`).

The contract exposes:

- the brick list with each brick's channels and holders, and its changes,
- connecting and disconnecting a brick for the calling client (the brick layer's own sign-in, with
  pairing on the way; a brick stays connected while any client holds it),
- files, programs (deploy and run, stop, emergency stop, state), and the shell in full mode,
- telemetry subscriptions and the daisy chain,
- the settings, the access mode included,
- questions for a person, answered by the client that started the operation.

The session lifecycle stays under the daemon's control: no client opens a brick itself.

### Add-ons extend `ev3` and `ev3 mcp`

An add-on (EVƎ C is the first) registers its commands and tools with the cockpit instead of
shipping an entry point of its own. `ev3 <name>` runs the add-on `ev3-<name>` found on PATH; in
the same way the one MCP server, `ev3 mcp`, offers the tools of every installed add-on beside its
own, so a user adds one MCP server to an agent for the cockpit and all its add-ons (owner,
23.11.2026). Tool names stay unique, a missing or broken add-on costs only its own tools, and the
agent's roots and the confinement rules reach an add-on's tools as they reach the cockpit's.
Tracked in issue #2.

## 10. Filesystem

The filesystem is designed as a service for API consumers, not as a GUI feature.

The first version must provide:

- `uploadFile`,
- `downloadFile`,
- `executeRbf`,
- basic read and list operations over explicit `folder` and `file` paths.

More extensive deployment workflows (e.g., full-folder sync) are deferred to a later version.

## 11. Communication and Recovery

The runtime communicates with the panel and external extensions through a combined push/pull model:

- **Push**: the runtime emits an event on every state or telemetry change,
- **Pull**: the panel and dependent extensions can explicitly request a current snapshot at any time.

The panel must be able to recover its full state after a reload or restart by requesting a fresh snapshot from the runtime.

## 12. Transports

Supported transports:

- `mock` (deferred, §13),
- `usb`,
- `tcp`,
- `bt`.

Requirements:

- `usb`, `tcp`, and `bt` are equally important,
- Windows and Linux are required platforms,
- the solution must be stable and sufficiently fast.

The choice of specific technology for a given transport may rely on external experiments outside this repository.

### 12.1 Connecting and Pairing

- Connecting a brick connects every channel that can reach it. A Bluetooth channel nobody has paired is paired on the way, after the other channels are connected, and joins once the pairing succeeds.
- Connecting a brick that is already connected retries every channel that is not connected, a paired Bluetooth channel the presence checks did not hear too.
- A connected brick joins a channel that appears later without asking, and pairs a new Bluetooth sighting by itself.
- The brick's pairing dialog is the only consent. The cockpit never connects to a Bluetooth channel nobody has paired, and while it pairs it tells the user to confirm on the brick.
- A cancelled or failed pairing, clearing the brick's Bluetooth list and forgetting the brick stop automatic pairing of that brick until the user connects it again; channels already connected stay connected.
- With USB or TCP connected, a pairing broken on one side is repaired: the half that is left is removed, the brick is paired again, and the user is told what was found and done.
- When a Bluetooth connect to a paired brick fails and nothing else reaches it, the message says the brick may be out of reach and that connecting USB or TCP and connecting again repairs a one-sided pairing; it never states that the pairing is broken.
- The brick's list of paired computers is read when a channel connects, after a pairing, a forget or a clear, and on request; it is kept per brick for the panel and never polled.
- Pairing phases and changes between a Bluetooth channel being heard and not heard are logged.

## 13. Mock

> **Deferred 20.11.2026** (owner, native daemon plan `docs/plans/2026-11-20-1845-refactor-native-daemon-plan.md`):
> the native daemon has no simulated bricks yet, and the `ev3-cockpit.mockBricks` setting went with
> the TypeScript core. Recorded brick sessions replayed by a test daemon guard regressions instead.
> The requirements below stand for when mock comes back.

Mock is a full transport channel within the same architecture as physical transports.

Mock must provide:

- discovery,
- connect,
- reconnect,
- loss and recovery,
- error states,
- a surface of the contract comparable to a physical brick.

Mock brick definitions are configured via a JSON file in the workspace. No GUI editor is required in this version.

Mock bricks are a development aid. Whether they appear is the `ev3-cockpit.mockBricks` setting; when nobody has set it, they appear only while the extension runs from source, never in an installed build.

## 14. Persistence and Remembered Data

Cockpit requires internal persistence for brick metadata.

At minimum, the following must be stored:

- `favorite`,
- user preferences related to the panel,
- remembered metadata needed for unified display.

Favorite brick:

- has a star in the list,
- can be toggled in the active tab of a connected brick,
- is automatically connected when transitioning `removed -> available`.

Automatic connection must not re-trigger on each rediscovery within an already running session after the user has explicitly disconnected.

Remembered bricks:

- may originate from OS evidence such as BT pairing,
- are displayed even when not currently available,
- can be forgotten using the trash action.

## 15. Quality and Workflow

After every change, at minimum the following must pass:

- `compile`,
- `lint`,
- `test-smoke`.

Only after these pass is a commit and push acceptable.

Regularly:

- after several smaller changes or approximately once a day, run full tests,
- after larger functional blocks, perform analysis, refactoring, optimization, and increased test coverage.

## 16. Maybe Someday

No concrete plan or timeline. Must not be architecturally blocked.

- **Mock settings editor** — GUI editor in the main editor area for creating and configuring mock brick definitions without editing JSON manually.
- **Firmware update** — ability to flash EV3 firmware from within Cockpit.
- **Mailbox** — sending and receiving mailbox messages between the host and a brick.
- **Display mirror** — live view of the EV3 screen inside the Cockpit panel.
- **macOS support** — running Cockpit on macOS with at least USB and TCP transports working.
