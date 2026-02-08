# EV3 Cockpit

EV3 Cockpit is a Visual Studio Code extension for working with LEGO Mindstorms EV3 bricks.

It is designed for users who want one place to connect to an EV3, manage files on the brick, deploy projects, and run programs.

## Goals

- Make EV3 connection and project deployment simple from inside VS Code.
- Support the most common EV3 connection methods (USB, Wi-Fi, Bluetooth).
- Provide safe defaults for remote file operations.
- Offer reliable run control, including emergency stop.

## What You Can Do With EV3 Cockpit

- Connect to an EV3 brick.
- Probe connection and firmware capabilities.
- Browse remote files and folders on the brick.
- Upload, download, create folders, and delete files.
- Deploy project/workspace files to EV3.
- Preview deploy changes before applying them.
- Run, stop, and restart `.rbf` programs.
- Use Emergency Stop when needed.

## Implementation Status

### Implemented

- [x] USB connection workflow
- [x] Wi-Fi (TCP) connection workflow
- [x] Bluetooth connection workflow (basic support)
- [x] Remote file browser (`ev3://active/...`)
- [x] Deploy + preview + sync workflows
- [x] Run / Stop / Restart for `.rbf` programs
- [x] Emergency Stop command
- [x] Deploy profiles (`Safe Sync`, `Atomic Sync`, `Full Sync`)
- [x] Test suites (unit, host, hardware smoke)

### In Progress

- [ ] Bluetooth runtime stability across different Windows driver/COM setups
- [ ] Hard Bluetooth hardware verification without fallback `SKIP` in unstable host environments

### Planned

- [ ] Prebuilt downloadable release artifacts for non-developer users (ready-to-install package)
- [ ] Expanded end-user documentation and troubleshooting guides

## Download and Build

### Option A: Download a Prebuilt Release

If a GitHub Release is available, you can download the extension package (`.vsix`) and install it in VS Code.

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
```

Run in VS Code (development mode):

- Open the project in VS Code.
- Press `F5` to launch the Extension Development Host.

Create an installable VS Code package (`.vsix`):

```bash
npm install -g @vscode/vsce
vsce package
```

Then install the generated `.vsix` in VS Code via:

- `Extensions` -> `...` -> `Install from VSIX...`

## Connection Support (Current)

- USB: stable
- Wi-Fi (TCP): stable
- Bluetooth: functional, but may be unstable on some host driver stacks

## License

License information is currently not finalized for this repository.
