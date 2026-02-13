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

## Atomic execution loop (STRICT)
You MUST work in **ultra-atomic** steps only:
- Implement ONLY the step currently listed in `.work/NEXT.md`.
- Do not start any other step.
- If you discover additional work, write it to `.work/BACKLOG.md` (with reason + suggested priority), but do not implement it unless it becomes the “NEXT” step.

### Mandatory gates after EVERY atomic step (in this order)
After implementing the step, run:

1) `npm run compile`
2) `npm run lint`
3) `npm run test:unit`
4) `npm run test:host`

If the step touches communication/transport/protocol/scheduler/reconnect/framing:
- Additionally run (if HW available):
  - `npm run test:hw`
  - `npm run test:hw:matrix`
- If HW is required but not available, mark the step as **BLOCKED** in `.work/BLOCKERS.md` unless the change is fully verifiable via unit/host tests and clearly marked as such in `.work/STATE.md`.

### Commit & push after EVERY atomic step
If gates pass:
- `git status` (must show only intended changes)
- `git add -A`
- `git commit -m "<STEP_ID>: <short description>"`
- `git push`

Rules:
- Never use `--force` push.
- Keep commits small and focused.
- Never commit secrets. Do not log secrets. Redact sensitive values in logs.

### Update checkpoint files after EVERY atomic step
After push:
- Append to `.work/LOG.md`:
  - the commands run
  - whether they passed
  - brief summary
  - references to generated artifacts/reports (paths)
- Update `.work/STATE.md`:
  - mark the step DONE
  - add evidence (files changed, tests run)
  - note any new risks
- Update `.work/NEXT.md`:
  - set the next atomic step (ONE step only)

## Architecture review cycle (after each package/bundle)
A “package” is a larger chapter in the plan (e.g., BALÍČEK A, B, C…).
After completing a package:
1) Follow `.work/architecture.md` exactly:
   - Generate/update `.work/architecture_files/NN.md` (overwrite from scratch).
   - Do NOT delete `architecture.md`; only update its “Obsah” section.
2) Write `.work/ARCH_FINDINGS.md`:
   - concrete refactors/bugfixes/test coverage gaps
   - for each: P0/P1/P2, estimated scope, affected files, recommended tests
3) Implement findings as a new mini-package “<PACKAGE>-ARCH-FIX”:
   - break it into 10–30 atomic steps
   - each step uses the same gates + commit + push loop
4) Only then proceed to the next functionality package.

## Context hygiene / compaction
The canonical memory is `.work/*`. Prefer file-based state over conversation memory.
If the session becomes too long:
- Use internal compaction if supported by the tool.
- If compaction is not available, create `.work/COMPACT.md` (max 1–2 pages) summarizing:
  - what’s done
  - what’s next
  - current blockers/risks
  - how to proceed
Then continue strictly from COMPACT + STATE + NEXT + EXECUTION_PLAN_ATOMIC.

## README and user-visible changes
For user-visible or functional changes, update `README.md` accordingly in the same atomic step (or an immediately following atomic step).

## “ev3io” rename cleanup
If you find any mention of “ev3io” anywhere in the repo:
- Record exact `path:line` + surrounding context into `.work/EV3IO_OCCURRENCES.md`.
- Fix each occurrence as its own atomic step (gates + commit + push).

## Safety and scope control
- Do not change `.gitignore` to include `.work/`.
- Do not delete `.work/` contents.
- Avoid large refactors unless they are explicitly required by the current atomic step or ARCH_FINDINGS.
- When uncertain: create a BLOCKER entry rather than guessing.

## First action each session (summary)
1) Read `.work/STATE.md` + `.work/NEXT.md` + `.work/LOG.md`.
2) Execute ONE atomic step.
3) Run gates.
4) Commit + push.
5) Update `.work/STATE.md`, `.work/NEXT.md`, `.work/LOG.md`.
