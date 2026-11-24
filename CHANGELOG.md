# Changelog

All notable changes to EVƎ Cockpit are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

Versioning: patch bumps automatically on every commit via the pre-commit hook.
Minor and major versions are bumped manually for significant milestones.

---

## [Unreleased]

### Added
- `files/follow` follows a file on a brick as it grows, such as a program's output while it runs
  (#7): `files/appended` carries every growth in order, `files/followEnded` says why it ended. Each
  round asks the file's size first, which costs the brick nothing; a grown file is read from the
  offset with one direct command, or whole when that costs less (a big backlog, or a long file
  over USB), so nothing stays open on the brick between rounds. At most two follows per brick,
  and a follow takes at most about half of the brick's or the link's time.
- `ev3 follow <remote> [offset]` prints a file on the brick as it grows.
- `ev3-client`: `Client::follow_file` and `Cockpit::follow_file`, which follows again from the
  offset reached after a reconnect.

### Fixed
- A command no longer waits for Bluetooth to give up on a brick that is on USB (#11): a connect
  that came while the brick's last holder let it go waits for the sign-out and signs it in afresh,
  and `reuse` waits only for a brick's first channel. `ev3`, `ev3 mcp` and the clients' rejoin after
  a daemon replacement connect with `reuse`.
- A brick a client uses is no longer signed out under it when its last holder leaves (#9):
  `ev3` holds a connected brick it uses (`bricks/connect` with `reuse`, which joins nothing),
  and a brick a request is working on is signed out only when that request ends.
- A file read and a folder listing on one brick at the same time no longer break each other
  (#8): the firmware keeps one read cursor per channel, so the daemon now lets one read or
  listing at a time hold it.

## [0.3.0-preview.1] — 2026-11-23

A preview for early testers of the backend (the daemon, `ev3` and `ev3 mcp`): install the npm
packages attached to the GitHub pre-release. The VS Code extension is not part of it; its four
VSIX packages, attached at first by mistake, were removed (23.11.2026) and wait for issue #5.

### Added
- One native daemon per user, `ev3-cockpitd` (Rust), holds the bricks for every client: their
  connections over USB, Bluetooth and TCP, presence, telemetry, programs, files and settings.
  It needs no Node runtime.
- `ev3`, a native command for a shell, scripts and agents (`ev3 help`), and `ev3 mcp`, which
  serves the cockpit's tools to an agent over MCP. The npm package `ev3-cockpit` installs it
  through a launcher and the platform package `@ev3-cockpit/<platform>`.
- `@ev3-cockpit/client`, the client library add-ons such as EVƎ C use; the contract is generated
  from the JSON Schema in `contract/`.
- `daemon/status` names the brick each client shows; `daemon/showsChanged` tells every client.
- Platforms: Windows and Linux on x64 and arm64 (VSIX and npm), and 32-bit x86 (npm only; VS Code
  has no 32-bit build).

### Changed
- The VS Code extension is a client of the daemon; two windows share one brick.
- A program run's `runSeq` survives a daemon replacement.

### Removed
- The Node daemon, the TypeScript core, the C# Bluetooth pairing helper and macOS support (to come
  back on the Rust daemon).

## [0.0.1] — 2026-04-04

### Added
- Extension skeleton: `package.json`, `src/extension.ts`, TypeScript compilation, ESLint, watch mode
- Build scripts: `compile`, `lint`, `package` (esbuild bundle), `test:unit`, `test:host`, `test:ci`
- Requirements, Design, and Implementation Plan documentation
- Pre-commit hook: automatic patch version bump on every commit (`scripts/bump-version.cjs`)
