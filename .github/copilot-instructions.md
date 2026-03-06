# Copilot Instructions for EV3 Cockpit

VS Code extension for controlling LEGO Mindstorms EV3 bricks over USB HID, TCP (Wi-Fi), Bluetooth serial, or mock transport.

## Build, Test, and Lint Commands

```bash
npm run compile          # TypeScript compilation (tsc) to out/
npm run lint             # ESLint on src/**/*.ts
npm run test:unit        # Compile + run unit tests (node --test)
npm run test:host        # Compile + run host integration tests
npm run test:ci          # Full CI: compile + lint + unit + host
npm run package          # Production esbuild bundle (out/extension.js)
npm run package:vsix     # Create .vsix into artifacts/vsix/
npm run test:ci:release  # Release gates: CI + bundle-size + vsix smoke
```

**Single test file:**
```bash
npm run compile && node --test out/__tests__/<testName>.test.js
```

**Hardware tests** (require physical EV3 brick):
```bash
npm run test:hw          # Hardware smoke tests
npm run test:hw:matrix   # Hardware matrix tests
```

**Mandatory gates before committing:** `npm run compile && npm run lint && npm run test:unit && npm run test:host`. If changes touch transport/protocol/scheduler, also run hardware tests when available.

## Architecture

### Core Data Flow

```
Transport (USB/TCP/BT/Mock)
  -> CommandScheduler (queue, retry, timeout, orphan recovery)
    -> Ev3CommandClient (EV3 bytecode protocol encoding)
      -> BrickSessionManager (per-brick session lifecycle)
        -> BrickRegistry (central brick state: READY/CONNECTING/UNAVAILABLE/ERROR)
          -> UI (TreeView + WebView panel)
```

### Key Abstractions

- **TransportAdapter** (`src/transport/transportAdapter.ts`): Minimal async interface -- `open()`, `close()`, `send(packet, options) -> response`. Implementations for USB HID, TCP, Bluetooth SPP, and mock.
- **TransportMode**: `USB | TCP | BT | MOCK` (in `src/types/enums.ts`). Brick IDs are prefixed by transport: `usb-`, `tcp-`, `bt-`, `mock-`. The virtual ID `active` aliases the currently selected brick.
- **CommandScheduler** (`src/scheduler/`): Serializes commands per brick with configurable timeout, retry policy, and orphan recovery. Each brick session gets its own scheduler instance.
- **Ev3CommandClient** (`src/protocol/ev3CommandClient.ts`): Typed EV3 filesystem/system operations built on scheduler + transport, using `ev3Bytecode.ts` for packet encoding.
- **BrickRegistry** (`src/device/brickRegistry.ts`): Central state store for all known bricks. Event-driven with `onStatusChange`. Provides `resolveFsService()` and `resolveControlService()` per brick.
- **BrickSessionManager** (`src/device/brickSessionManager.ts`): Creates/destroys per-brick runtime sessions (scheduler + command client pairs). Tracks program execution state.
- **Remote Filesystem**: `ev3://` URI scheme via `Ev3FileSystemProvider`. Authority is brick ID or `active`. Operations delegated to `RemoteFsService` per brick.

### Extension Activation

Single `activate()` in `src/extension.ts` wires everything -- no DI container. Services created in order, cross-referenced via closures. Commands registered in dedicated `registerXxxCommands()` functions in `src/commands/`.

### Error Hierarchy

`ExtensionError` base class with typed subclasses: `TransportError`, `ProtocolError`, `SchedulerError`, `FilesystemError`, `Ev3Error`. Each has typed error codes (string union), structured metadata, recovery action recommendations, and error message maps. Type guards provided (`isTransportError()`, etc.). User-facing messages extracted via `getUserFacingMessage()`.

### Config Pattern

Config readers in `src/config/` each export a `read*Config()` function returning a typed snapshot. `ConfigService.readExtensionConfig()` consolidates them. Shared sanitizers in `src/config/sanitizers.ts`. All settings under `ev3-cockpit.*` namespace.

### Mock System

`src/mock/` provides virtual bricks for development without hardware. Includes simulated sensors, motors, filesystem, and fault injection. Enable via `ev3-cockpit.transport.mode` = `"mock"`.

## Conventions

- **TypeScript**: strict mode, ES2022, CommonJS output. Tabs for indentation, semicolons, single-quote imports.
- **Naming**: `PascalCase` classes/interfaces/types, `camelCase` functions/variables/filenames, `SCREAMING_SNAKE_CASE` environment variables (`EV3_COCKPIT_*`).
- **Testing**: Node.js built-in `node:test` runner with `node:assert/strict` -- no external test frameworks. Tests in `src/__tests__/*.test.ts`, shared helpers in `testHelpers.ts`. VS Code API mocked via lightweight fakes (FakeMemento, FakeEventEmitter, etc.).
- **Native dependencies**: `node-hid`, `serialport`, `ffi-napi`, `regkey` are optional -- loaded via `require()` with try/catch fallback. Marked as externals in esbuild.
- **Bundling**: esbuild bundles everything into single `out/extension.js`; native deps excluded. Bundle-size budget enforced by `npm run check:bundle-size` (default 256 KiB, override with `EV3_COCKPIT_MAX_BUNDLE_BYTES`).
- **ESLint**: unused vars error with `_` prefix exception; `no-explicit-any` is off.
- **Brick names**: max 12 characters (EV3 hardware limit).

## Workflow (.work/ directory)

The project uses a structured `.work/` directory for tracking implementation progress:
- `.work/STATE.md` -- current state of implementation
- `.work/NEXT.md` -- the single next atomic step to implement
- `.work/LOG.md` -- execution log of completed steps
- `.work/BACKLOG.md` -- discovered work items
- Check these files at session start to understand current context.