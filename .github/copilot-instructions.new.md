# Copilot Instructions for EV3 Cockpit

## Build, Test, and Lint Commands

- **Build:**
  - `npm run compile` — Compile TypeScript sources
  - `npm run package` — Build production bundle (via esbuild)
  - `npm run package:vsix` — Create VS Code extension package (.vsix)
- **Lint:**
  - `npm run lint` — Run ESLint on TypeScript sources
- **Test:**
  - `npm run test:unit` — Run unit tests
  - `npm run test:host` — Run host integration tests
  - `npm run test:hw` — Run hardware smoke tests (requires EV3 hardware)
  - `npm run test:hw:matrix` — Run hardware matrix tests
  - `npm run test:ci` — Compile, lint, unit, and host tests
  - `npm run test:ci:release` — Full CI release gates (compile, lint, tests, bundle, vsix, smoke)
  - **Single test:** Run `node scripts/run-unit-tests.cjs --grep <pattern>` for unit tests

## High-Level Architecture

- **VS Code Extension:**
  - Provides EV3-specific commands, remote file system, and brick control via custom Explorer and webview panels
  - Connects to EV3 Bricks via USB, Wi-Fi (TCP), or Bluetooth; supports mock mode for development
  - Core runtime: command scheduler, transport abstraction, capability probe, error handling
  - Remote file system: `ev3://active/...` and `ev3://<brickId>/...` for per-brick operations
  - Brick view: status, sensors, motors, controls, and batch actions
  - Test infrastructure: unit, host, hardware, and matrix tests

## Key Conventions

- **Atomic Step Execution:**
  - All autonomous work is tracked in `.work/` (gitignored): plans, state, logs, blockers, backlog
  - Only one atomic step is executed at a time, with mandatory gates (compile, lint, test)
  - Commit and push after every atomic step; checkpoint files updated after each step
- **Config Files:**
  - Primary sources: `.work/IMPLEMENTATION.md`, `.work/EXECUTION_PLAN.md`, `.work/EXECUTION_PLAN_ATOMIC.md`, `.work/architecture.md`
  - If missing, create a blocker in `.work/BLOCKERS.md`
- **File System Safety:**
  - Default mode is `safe` (restricted roots); `full` mode requires explicit confirmation
- **Mock Mode:**
  - Enable via `ev3-cockpit.transport.mode` = `mock` in VS Code settings
  - Provides virtual sensors, motors, brick, and in-memory filesystem

---

If you want to configure MCP servers (e.g., Playwright for web testing), let me know and I can help set them up.

This file summarizes build/test/lint commands, architecture, and key conventions for Copilot and other AI agents. Would you like to adjust anything or add coverage for areas I may have missed?
