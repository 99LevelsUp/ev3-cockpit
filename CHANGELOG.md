# Changelog

All notable changes to EVƎ Cockpit are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

Versioning: patch bumps automatically on every commit via the pre-commit hook.
Minor and major versions are bumped manually for significant milestones.

---

## [Unreleased]

## [0.0.1] — 2026-04-04

### Added
- Extension skeleton: `package.json`, `src/extension.ts`, TypeScript compilation, ESLint, watch mode
- Build scripts: `compile`, `lint`, `package` (esbuild bundle), `test:unit`, `test:host`, `test:ci`
- Requirements, Design, and Implementation Plan documentation
- Pre-commit hook: automatic patch version bump on every commit (`scripts/bump-version.cjs`)
