# EV3 Cockpit

VS Code extension for connecting and controlling LEGO Mindstorms EV3 via ev3dev.

## Architecture (Quick View)

Detailed UML diagrams are available in `architecture.md`.

### High-level Components

```mermaid
flowchart LR
  UI[VS Code UI]
  CM[Connection Manager]
  BC[Brick Connection]
  CS[Command Scheduler]
  DEV[Device Provider]
  FS[Remote FS Provider]
  TA[Transport Adapter]
  EV3[EV3 Brick]

  UI --> CM --> BC
  BC --> CS
  BC --> DEV
  BC --> FS
  CS --> TA --> EV3
```

### Connect Flow (TCP/BT/USB)

```mermaid
sequenceDiagram
  autonumber
  participant User
  participant Extension
  participant Connection
  participant Transport
  participant EV3

  User->>Extension: Connect
  Extension->>Connection: create/open
  Connection->>Transport: handshake/init
  Transport->>EV3: connect + probe
  EV3-->>Transport: replies
  Transport-->>Connection: ready
  Connection-->>Extension: READY
```

## Development

```bash
npm install
npm run clean
npm run compile
```

Press **F5** in VS Code to launch the Extension Development Host.

Workspace default transport for development is set to USB in `.vscode/settings.json`:

```json
{
  "ev3-cockpit.transport.mode": "usb"
}
```

Override it in workspace/user settings when you need `bluetooth` or `tcp` test runs.

## Test Categories

- `npm test` or `npm run test:unit` - compile + unit/integration tests without physical EV3 hardware.
- `npm run test:host` - extension-host category (`[HOST]`) in real VS Code process:
  - extension activation + command registration,
  - non-interactive command execution without hardware (`inspectTransports`, `browseRemoteFs`),
  - `ev3://` provider offline behavior,
  - mock connect flow wiring (`ev3-cockpit.transport.mode=mock`) for active provider path,
  - fake TCP EV3 end-to-end provider flow (`ev3://active/...` read/write/copy/rename/delete) without physical hardware.
- `npm run test:hw` - hardware smoke category (`[HW]`) in fixed order: USB -> TCP (WiFi) -> Bluetooth.
- `npm run test:all` - unit + extension-host + hardware categories.

Hardware smoke returns explicit status per transport:
- `PASS` transport tested successfully.
- `SKIP` transport not available in current environment (for example no USB EV3 detected).
- `FAIL` transport was available but probe/capability check failed.

Optional hardware env vars:
- `EV3_COCKPIT_HW_TIMEOUT_MS`, `EV3_COCKPIT_HW_USB_PATH`
- `EV3_COCKPIT_HW_TRANSPORTS` (optional): comma-separated transport subset for hardware smoke, for example `usb,tcp` to skip Bluetooth.
- `EV3_COCKPIT_HW_EMERGENCY_STOP_CHECK` (optional, default `true`): include emergency-stop validation (`PROGRAM_STOP` + `OUTPUT_STOP`) in hardware smoke.
- `EV3_COCKPIT_HW_RECONNECT_CHECK` (optional, default `false`): include disconnect/reconnect recovery scenario (open -> probe -> close -> reopen -> probe) for selected transports (`usb|tcp|bluetooth`).
- `EV3_COCKPIT_HW_TCP_HOST`, `EV3_COCKPIT_HW_TCP_USE_DISCOVERY`, `EV3_COCKPIT_HW_TCP_DISCOVERY_TIMEOUT_MS`, `EV3_COCKPIT_HW_TCP_ATTEMPTS`, `EV3_COCKPIT_HW_TCP_RETRY_DELAY_MS`
- `EV3_COCKPIT_HW_BT_PORT`, `EV3_COCKPIT_HW_BT_PROBE_TIMEOUT_MS`, `EV3_COCKPIT_HW_BT_PORT_ATTEMPTS`, `EV3_COCKPIT_HW_BT_RETRY_DELAY_MS`, `EV3_COCKPIT_HW_BT_DTR`
- `EV3_COCKPIT_HW_RUN_RBF_PATH` (optional): run an already existing remote `.rbf` path (supports `ev3://active/...` too).
- `EV3_COCKPIT_HW_RUN_RBF_FIXTURE` (optional): local `.rbf` fixture path. Use `auto` to use embedded `Empty.rbf` bytes from source (`src/hw/fixtures/emptyProgram.ts`).
- `EV3_COCKPIT_HW_RUN_RBF_REMOTE_PATH` (optional): remote upload destination for fixture mode (default `/home/root/lms2012/prjs/ev3-cockpit-hw-run-fixture.rbf`).

When `EV3_COCKPIT_HW_RUN_RBF_FIXTURE` is set, hardware smoke performs a real lifecycle test:
`upload fixture -> run program -> delete uploaded file`.

## Commands

- `EV3 Cockpit: Connect to EV3 Brick` — connect to EV3 brick
- `EV3 Cockpit: Deploy and Run .rbf (active)` — pick a local `.rbf`, upload to active EV3 default root and start it
- `EV3 Cockpit: Preview Deploy Changes (active)` — pick a local folder and preview upload/skip/cleanup result without modifying EV3
- `EV3 Cockpit: Sync Project to EV3 (active)` — pick a local folder and upload/sync project tree to active EV3 (without starting program)
- `EV3 Cockpit: Deploy Project and Run .rbf (active)` — pick a local folder, upload project tree to EV3 and run selected `.rbf`
- `EV3 Cockpit: Run Remote Program (.rbf)` — run a chosen remote `.rbf` path (`/path/file.rbf` or `ev3://active/...`)
- `EV3 Cockpit: Stop Program (active)` — send `PROGRAM_STOP` for active VM slot
- `EV3 Cockpit: Restart Program (active)` — stop current program and run last/selected `.rbf` again
- `EV3 Cockpit: Reconnect EV3 (active settings)` — re-run full connect probe/capability flow using current transport settings
- `EV3 Cockpit: Disconnect EV3 (active)` — close active session and clear in-memory EV3 services
- `EV3 Cockpit: Emergency Stop (active)` — sends emergency lane stop command (`PROGRAM_STOP` + `OUTPUT_STOP`) to active connection
- `EV3 Cockpit: Inspect Transport Candidates` — show USB/serial discovery snapshot
- `EV3 Cockpit: Transport Health Report` — run probe+capability checks over USB/TCP/Bluetooth and print PASS/SKIP/FAIL summary
- `EV3 Cockpit: Browse Remote FS (active)` — interactive browser for `ev3://active/...` with actions:
  - upload file(s) to current folder,
  - create folder,
  - delete file/folder,
  - open/download binary files (`Open Preview` / `Download to Local...`),
  - run `.rbf` program directly on EV3 (`Run on EV3`).

## Config Notes

- `ev3-cockpit.compat.profile`: `auto` or `stock-strict`
- `ev3-cockpit.fs.mode`: `safe` (default) or `full`
- `ev3-cockpit.fs.defaultRoots`: safe mode allowed roots (default `/home/root/lms2012/prjs/`, `/media/card/`)
- `ev3-cockpit.fs.fullMode.confirmationRequired`: UX guard for risky full FS access
- `ev3-cockpit.deploy.excludeDirectories`: directories skipped by project deploy recursion (default `.git`, `node_modules`, `.vscode-test`, `out`)
- `ev3-cockpit.deploy.excludeExtensions`: file extensions skipped by project deploy (default `.map`)
- `ev3-cockpit.deploy.maxFileBytes`: max allowed file size per uploaded file in project deploy (default `5242880`)
- `ev3-cockpit.deploy.incremental.enabled`: upload only changed project files by remote md5/size comparison (default `false`)
- `ev3-cockpit.deploy.cleanup.enabled`: delete stale remote files/directories missing from local project after deploy (default `false`)
- `ev3-cockpit.deploy.cleanup.confirmBeforeDelete`: require modal confirmation before cleanup deletes stale remote entries (default `true`)
- `ev3-cockpit.deploy.cleanup.dryRun`: preview stale remote files/directories without deleting them (default `false`)
- `ev3-cockpit.deploy.atomic.enabled`: stage project to temporary remote root and swap with rollback semantics (default `false`)

Remote filesystem URI scheme is `ev3://<brickId>/<abs_path>`. Current MVP uses `ev3://active/...` for the active connection.
After connecting, you can open files via Quick Open with paths like `ev3://active/home/root/lms2012/prjs/your-file.txt`.
For directory navigation use command `EV3 Cockpit: Browse Remote FS (active)`.
When switching `ev3-cockpit.fs.mode` to `full` and confirmation is enabled, extension asks for explicit confirmation and reverts to `safe` if declined.
