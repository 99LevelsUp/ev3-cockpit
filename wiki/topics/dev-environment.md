---
topic: Development Environment
last_compiled: 2026-11-23
status: active
---

# Development Environment

## Purpose

How to run the extension and the daemon from source, and the workspace fixes that were needed more than once. Read it before chasing mysterious start-up failures.

## What you need

- Node 20+ and `npm install` for the TypeScript side.
- A Rust toolchain for `daemon/` (edition 2024). `npm run daemon:build` builds `ev3-cockpitd` and `ev3` in debug and writes the manifest beside them in `daemon/target/debug/`; `npm run daemon:build:release` does the same in `daemon/target/release/`.
- On Linux, the udev rule `native/linux/70-lego-ev3.rules` for USB (copy it to `/etc/udev/rules.d/`, reload, re-plug).

## Running the extension (F5)

1. Run `npm run daemon:build` once, and again after every change under `daemon/`. A client built from the repository starts the newest development build it finds in `daemon/target/<profile>/`, by its manifest; without one it fails with `missing_binary` and says to run `npm run daemon:build`.
2. Press **F5** (Run → Start Debugging → "Run Extension"). The `build:dev` task bundles `src/vscode/extension.ts` into `out/extension.js` with source maps and opens an **Extension Development Host** window.
3. The output channel "EVƎ Cockpit" in that window shows the extension's log; the daemon logs to `daemon.log` in its state root (`docs/channel.md`).

The Extension Host log in the original window (`Ctrl+Shift+U` → "Extension Host") belongs to the outer VS Code, not to the development host.

Development and release builds share the user's channel: a development client replaces a release daemon it meets, so a development build and an installed cockpit do not run side by side.

## `.vscode/` configuration

- **`launch.json`** — `preLaunchTask` is the explicit `"build:dev"`; VS Code does not reliably resolve `"${defaultBuildTask}"` there ("Could not find the task"). The development host is started with `--disable-extension` for GitHub Copilot Chat, Copilot and GitLens (see below).
- **`tasks.json`** — `build:dev` is a `shell` task running `npm run build:dev`. An `npm`-type task can fail to resolve on Windows when the npm task provider breaks (as under the Copilot Chat file-descriptor leak).
- **`settings.json`** — `files.watcherExclude` for `node_modules`, `out` and `.git`; `json.schemaDownload.enable: false`, without which the JSON language server can download VS Code's huge extension-manifest schema and crash with "Pending response rejected since connection got disposed".

## Known third-party problems

**Copilot Chat 0.42.x and 0.43.x leak file descriptors (`EMFILE: too many open files`).** They patch `require()` and leak a descriptor per call. Two effects:

- inside the development host, the extension fails to activate after about 20 s ("Activating extension '99LevelsUp.ev3-cockpit' failed: EMFILE"); `--disable-extension` in `launch.json` fixes this;
- in the outer VS Code, the leak is inherited on Windows by the development host as a child process, which then crashes at once. `--disable-extension` does not help; upgrade Copilot Chat to 0.44.0 or later, or disable it in the outer window and reload.

0.42.x also fails its own start with `TypeError: e is not iterable`; cosmetic, same bug.

## Gotchas

- The development host does not pick up changes by itself: restart it (`Ctrl+Shift+F5`) after a TypeScript change, and rebuild the daemon after a Rust change. A daemon that still runs keeps serving its old build until it is replaced or idles out (10 s after its last client).
- `out/extension.js` is the esbuild bundle; `tsc` writes `out/**/*.js` for type checking and tests, but the extension host loads the bundle.
- `Couldn't find a debug adapter descriptor for debug type 'extensionHost'` means VS Code's built-in debugger extension failed, usually from the EMFILE leak: reload the window and update Copilot Chat.
- The bundles keep the old Node native module names external on purpose, so an import of one that crept back fails the packaging check instead of being inlined.

## Sources

- [.vscode/launch.json](../../.vscode/launch.json)
- [.vscode/tasks.json](../../.vscode/tasks.json)
- [.vscode/settings.json](../../.vscode/settings.json)
- [package.json](../../package.json)
- [src/client/nativeLaunch.ts](../../src/client/nativeLaunch.ts)
