# Repository Guidelines

## Project Structure & Module Organization
Core source is under `src/`, with `src/extension.ts` as the VS Code extension entry point. Main modules are split by responsibility: `src/commands`, `src/device`, `src/transport`, `src/fs`, `src/ui`, `src/protocol`, `src/config`, and `src/scheduler`. Diagnostics and mocks live in `src/diagnostics` and `src/mock`.  
Unit tests are colocated in `src/__tests__` (`*.test.ts`) and compile to `out/__tests__`. Playwright specs are in `tests/` (`*.spec.ts`). Build and release scripts are in `scripts/`; packaged outputs go to `out/` and `artifacts/`.

## Build, Test, and Development Commands
- `npm install`: install dependencies (Node 20+).
- `npm run compile`: TypeScript compile to `out/`.
- `npm run watch`: incremental TypeScript watch mode.
- `npm run lint`: run ESLint on `src/**/*.ts`.
- `npm run test:unit`: compile, then run Node unit tests.
- `npm run test:host`: run VS Code extension host tests.
- `npm run test:pw`: run Playwright specs in `tests/` (requires Playwright browsers).
- `npm run test:pw:smoke`: run Playwright smoke subset (`@smoke` tests).
- `npm run test:ci`: compile + lint + unit + host + Playwright smoke.
- `npm run package`: production bundle via `esbuild`.
- `npm run package:vsix`: build installable VSIX into `artifacts/vsix/`.
- `npm run test:ci:release`: full release gate (includes bundle-size + VSIX smoke).

## Coding Style & Naming Conventions
Use TypeScript (`strict` mode, ES2022, CommonJS). Follow existing style: tabs for indentation, semicolons, and single-quote imports.  
Naming conventions:
- `PascalCase` for classes, interfaces, and types.
- `camelCase` for functions, methods, and variables.
- `SCREAMING_SNAKE_CASE` for environment variables (`EV3_COCKPIT_*`).
- File names use descriptive `camelCase.ts` (for example, `brickDiscoveryService.ts`).

## Testing Guidelines
Unit tests use Node’s built-in test runner (`node --test`) with `assert/strict`. Add tests in `src/__tests__/` and name them `*.test.ts`.  
Keep Playwright tests in `tests/*.spec.ts`.  
When changing transport/hardware behavior, also run `npm run test:hw` and optionally `npm run test:hw:matrix` with relevant `EV3_COCKPIT_HW_*` environment variables.

## Commit & Pull Request Guidelines
Recent commits use short, imperative subjects, sometimes with prefixes (for example, `A: ...`, `Review: ...`, `Refine ...`). Keep commits focused and scoped to one change set.  
For PRs, include:
- clear summary and motivation,
- linked issue (if applicable),
- test evidence (commands run),
- screenshots/GIFs for UI changes (`src/ui`, webview/panel updates).  
Before requesting review, ensure `npm run test:ci` passes; for release-impacting changes, run `npm run test:ci:release`.

## Security & Configuration Tips
Do not commit machine-specific hardware values, private endpoints, or local artifact logs. Prefer environment variables for overrides (`EV3_COCKPIT_MAX_BUNDLE_BYTES`, `EV3_COCKPIT_HW_*`) and keep defaults safe.
