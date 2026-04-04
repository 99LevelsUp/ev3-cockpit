# AGENTS.md

## Purpose

Single source of truth for agent instructions in this repository.

The primary project documents are:

- `REQUIREMENTS.md` — product requirements
- `DESIGN.md` — architecture decisions
- `IMPLEMENTATION_PLAN.md` — implementation order

Agents must treat these as authoritative and keep them up to date with every change.

## Language

**Everything in this project must be in English — without exception.**

This includes: source code, comments, strings, identifiers, documentation files, commit messages, PR descriptions, issue titles, and any other text that ends up in the repository.

The only exception is conversation with the user, which is conducted in the user's preferred language.

## Document Rules

- When the product intent changes, update `REQUIREMENTS.md`.
- When an architecture decision changes, update `DESIGN.md`.
- When the step order or scope changes, update `IMPLEMENTATION_PLAN.md`.

## Workflow

- Prefer small, incremental changes.
- Keep scope aligned with `IMPLEMENTATION_PLAN.md`.
- Do not introduce new top-level files unless the plan explicitly requires them.
- The repository was intentionally cleaned; do not restore old code or tests unless the user explicitly requests it.

## Project Structure

Source code under `src/`, entry point `src/extension.ts`. Modules are split by responsibility:

- `src/contracts/` — shared types and contracts
- `src/runtime/` — session manager, presence aggregator
- `src/transports/` — USB, BT, TCP, Mock providers
- `src/api/` — public API for dependent extensions
- `src/ui/` — webview panel
- `src/mock/` — mock runtime and settings editor
- `src/persistence/` — globalState adapter
- `src/test/` — test utilities

Unit tests: `src/__tests__/*.test.ts`, compiled to `out/__tests__`.  
Playwright tests: `tests/*.spec.ts`.  
Scripts and outputs: `scripts/`, `out/`, `artifacts/`.

## Build and Test Commands

- `npm install` — install dependencies (Node 20+)
- `npm run compile` — TypeScript compilation to `out/`
- `npm run watch` — incremental watch mode
- `npm run lint` — ESLint on `src/**/*.ts`
- `npm run test:unit` — unit tests (Node built-in runner)
- `npm run test:host` — VS Code extension host tests
- `npm run test:pw:smoke` — Playwright smoke tests
- `npm run test:ci` — compile + lint + unit + host
- `npm run test:ci:release` — full release gate (bundle + VSIX + smoke)
- `npm run package` — production bundle via esbuild
- `npm run package:vsix` — installable VSIX into `artifacts/vsix/`

### Cheat Sheet

| Need | Command |
|---|---|
| Quick validation | `npm run test:ci` |
| Unit tests only | `npm run test:unit` |
| Host tests only | `npm run test:host` |
| UI smoke | `npm run test:pw:smoke` |
| Before commit | `npm run test:ci:release` |

## Coding Conventions

TypeScript, `strict` mode, ES2022, CommonJS. Indent with tabs, use semicolons, single-quote imports.

Naming:

- `PascalCase` — classes, interfaces, types
- `camelCase` — functions, methods, variables
- `SCREAMING_SNAKE_CASE` — environment variables (`EV3_COCKPIT_*`)
- Files: `camelCase.ts` (example: `presenceAggregator.ts`)

## Testing Rules

Unit tests: Node built-in runner, `assert/strict`. Files in `src/__tests__/`, named `*.test.ts`.  
Playwright tests: `tests/*.spec.ts`.

## Commit Rules

- Short, imperative commit subject.
- One commit = one logical change.
- PRs must include: motivation, commands run, screenshots for UI changes.

## Security

Do not commit machine-specific hardware values, private endpoints, or local artifact logs. Use environment variables for overrides (`EV3_COCKPIT_*`).

## Agent Workflow

After every code or configuration change:

1. `npm run compile`
2. `npm run lint`
3. `npm run test:unit` + `npm run test:host`

If the change touches UI/webview, also run: `npm run test:pw:smoke`.

Before committing: `npm run test:ci:release`.
