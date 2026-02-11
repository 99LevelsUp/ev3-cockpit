# Copilot Instructions — EV3 Cockpit (PowerShell 7, autonomous execution)

## Environment
- Shell: **PowerShell 7 (pwsh)**. Use PowerShell syntax for all commands.
- Repo contains an untracked working folder **`.work/`** (gitignored). All working docs, checkpoints, logs, and generated architecture files MUST be stored there.

## Primary sources of truth (MUST READ)
Before doing any work, read these files (create `.work/` if missing):
- `.work/IMPLEMENTATION.md`
- `.work/EXECUTION_PLAN.md`
- `.work/EXECUTION_PLAN_ATOMIC.md`
- `.work/architecture 00 - Úvod.md`

If any of these files are missing, stop and create a **BLOCKER** in `.work/BLOCKERS.md` describing what is missing and how to obtain it.

## Autonomy checkpoint files (MUST MAINTAIN)
These files are the “state machine” that makes long autonomous work stable and resumable:
- `.work/STATE.md`     — current status, completed steps, remaining work, risks
- `.work/NEXT.md`      — EXACTLY ONE next atomic step to execute (with Step ID)
- `.work/LOG.md`       — command outputs + short summaries (compile/lint/tests + paths to reports)
- `.work/BACKLOG.md`   — parking lot for new tasks (DO NOT implement immediately)
- `.work/BLOCKERS.md`  — anything that prevents forward progress
- `.work/EV3IO_OCCURRENCES.md` — any leftover mentions of “ev3io” with path + line numbers

### Startup / Resume protocol (for power outage)
On every new session (or after failure):
1) Ensure `.work/` exists.
2) Read `.work/STATE.md`, `.work/NEXT.md`, `.work/LOG.md`.
3) Reconstruct context ONLY from `.work/*` and the plan files (ignore prior chat history if conflicting).
4) Continue with the step in `.work/NEXT.md`.
5) If `.work/NEXT.md` is missing or unclear, pick the **first not-yet-DONE** step from `.work/EXECUTION_PLAN_ATOMIC.md`, then write it into `.work/NEXT.md`.

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
1) Follow `.work/architecture 00 - Úvod.md` exactly:
   - Generate/update `.work/architecture 01..30*.md` (overwrite from scratch).
   - Do NOT delete `architecture 00`; only update its “Obsah” section.
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
