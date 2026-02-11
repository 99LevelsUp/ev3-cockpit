# EV3 Cockpit

EV3 Cockpit is a Visual Studio Code extension for LEGO Mindstorms EV3.

Its purpose is to let you connect to EV3 bricks, manage files on the brick, deploy projects, and control program execution directly from VS Code.

## Goals

- Make EV3 development practical inside VS Code.
- Focus first on stock LEGO EV3 firmware compatibility.
- Keep file operations safe by default.
- Provide reliable run control with emergency-first behavior.
- Evolve toward multi-brick workflows over time.

## What This Software Is

EV3 Cockpit is not a standalone desktop app.  
It is an extension that runs inside Visual Studio Code and adds EV3-specific commands and workflows.

## Main Features

- Connect to EV3 over USB, Wi-Fi (TCP), or Bluetooth.
- Detect EV3 capabilities after connection.
- Browse and manage remote files via `ev3://active/...` and `ev3://<brickId>/...`.
- Browse and manage files from the **EV3 Cockpit Bricks** tree in the Explorer sidebar.
- Upload, download, create folders, delete entries.
- Deploy project/workspace files to EV3.
- Preview deploy changes before applying them.
- Run, stop, restart remote executables (currently `.rbf`).
- Trigger Emergency Stop.
- Store per-brick connection profiles for targeted reconnect.
- Run batch actions for ready bricks (batch reconnect, batch workspace preview/deploy/deploy+run).

## Explorer Tree Workflow (User UI)

The extension adds **EV3 Cockpit Bricks** to the left Explorer panel in VS Code.

- Each connected brick is shown as its own collapsible root.
- Expanding a brick shows its remote folders and files.
- Clicking a file opens it in the editor.
- Executable files are shown with a run-oriented icon and have a direct **Run** action.
- You can drag-and-drop remote files/folders in the tree to move them within the same brick.
- You can drag local files/folders from your OS/Explorer into a remote EV3 folder to upload.
- Active-brick root context now includes quick actions like reconnect/disconnect/emergency stop and deploy variants.
- Brick roots show runtime busy counters and keep per-brick last-operation metadata in tooltips.
- Executable launch is type-based under the hood, so more executable file types can be added without changing the UI workflow.

## Brick Panel (Active Brick)

The **EV3 Brick Panel** webview appears in the Explorer sidebar alongside the Bricks tree.

- Shows a tab per connected brick with a colored status dot (green = READY, yellow = CONNECTING, grey = UNAVAILABLE, red = ERROR).
- Clicking a tab switches the **active brick** — the target for `ev3://active/...` filesystem operations and deploy commands.
- The active brick's status tile shows transport type, role, last operation, and any error.
- The panel polls for updates automatically: 500 ms when bricks are connected, 3 s when idle.
- Switching the active brick also refreshes the Explorer tree so the new active brick sorts to the top.

## Implementation Status

### Implemented

- [x] Core command scheduler runtime
- [x] USB connection workflow
- [x] Wi-Fi (TCP) connection workflow
- [x] Bluetooth connection workflow (runtime support)
- [x] Capability probe and profile selection
- [x] Remote filesystem provider (`ev3://active/...` + `ev3://<brickId>/...`)
- [x] Deploy workflows (preview/sync/deploy+run)
- [x] Run/Stop/Restart `.rbf`
- [x] Emergency Stop
- [x] Multi-brick tree runtime sessions + per-brick reconnect profiles
- [x] Batch multi-brick commands (reconnect/deploy workspace)
- [x] Test infrastructure (unit, host, hardware smoke/matrix)
- [x] Brick Panel webview with active brick switching and polling

### In Progress

- [ ] Bluetooth stability across different Windows COM/driver setups
- [ ] Hard Bluetooth hardware verification without `SKIP` fallback

### Planned

- [ ] Real-time sensor/motor monitoring UI
- [ ] Advanced topology workflows (master/slave, daisy-chain optimizations)
- [ ] Prebuilt installable release artifacts (`.vsix`)
- [ ] Expanded troubleshooting and user docs

## Download and Build

### Option A: Download a Prebuilt Release

If GitHub Releases are published, download the `.vsix` package from the Releases page and install it in VS Code.

If no release is published yet, use Option B.

### Option B: Build From Source

Prerequisites:

- Node.js 20+
- Visual Studio Code

Steps:

```bash
git clone https://github.com/99LevelsUp/ev3-cockpit.git
cd ev3-cockpit
npm install
npm run compile
npm run package
```

Run in VS Code (development mode):

- Open the project in VS Code.
- Press `F5` to launch the Extension Development Host.

Create an installable VS Code package (`.vsix`):

```bash
npm run package:vsix
```

Then install the generated `.vsix` in VS Code via:

- `Extensions` -> `...` -> `Install from VSIX...`

## Developer Build and Release Gates

- `npm run package` builds bundled production output (`out/extension.js`) via `esbuild`.
- `npm run check:bundle-size` enforces bundle-size budget (default `256 KiB`, override with `EV3_COCKPIT_MAX_BUNDLE_BYTES`).
- `npm run package:vsix` builds `artifacts/vsix/ev3-cockpit.vsix`.
- `npm run test:vsix-smoke` installs the built VSIX into a temporary VS Code profile and verifies extension registration.
- `npm run test:ci:release` runs compile/lint/unit/host tests plus bundle-size and VSIX smoke gates.

## Internal Module Notes

- Shared config sanitizers are centralized in `src/config/sanitizers.ts` and reused by deploy/feature/scheduler config readers.
- Tree runtime helpers were extracted from activation bootstrap:
  - `src/ui/busyIndicator.ts` for per-brick busy polling updates,
  - `src/ui/treeStatePersistence.ts` for expanded/selection persistence restore.
- Deploy command type contracts are centralized in `src/commands/deployTypes.ts`.

## Quick Start

1. Open the Command Palette in VS Code.
2. Run `EV3 Cockpit: Connect to EV3 Brick`.
3. Run `EV3 Cockpit: Browse Remote FS (active)` to verify remote access.
4. Use deploy commands to upload and run your `.rbf`.

## Connection Support (Current)

- USB: stable
- Wi-Fi (TCP): stable
- Bluetooth: functional, but currently less stable on some host driver stacks

## Notes for Users

- Default filesystem mode is safe (`safe`) and intentionally restricted to common project roots.
- Emergency actions are prioritized by design.
- The project targets stock EV3 firmware first.

## Releases

Prebuilt releases are planned, but not yet regularly published.

When release publishing is enabled, this README should link directly to the latest `.vsix` download.

## License

MIT. See `LICENSE`.
