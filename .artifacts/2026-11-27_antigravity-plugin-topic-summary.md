# Implementation Summary: Add `antigravity-plugin` Discovery Topic & Release v1.0.5 / v1.0.1

**Date:** 2026-11-27  
**Scope:** Added `antigravity-plugin` alongside `agy-plugin` as a supported GitHub repository discovery topic across the registry crawler, parser, Issue-Ops submission workflow, web portal copy, tests, and READMEs (preserving `resolveTargetRelease` release-vs-HEAD behavior unchanged), hardened `.gitignore` in both repositories, and bumped versions (`1.0.5` for `antigravity-community-marketplace`, `1.0.1` for `agy-plugin-registry`) with updated changelogs.

## Created / Modified Files

### `c:\GitHub\antigravity-plugin-registry` (`v1.0.1`)
- `scripts/lib/github-client.mjs` (modified): Exported `DEFAULT_DISCOVERY_TOPICS = ["agy-plugin", "antigravity-plugin"]`, replaced single-`topic` config with validated `topics` array, updated `discoverRepositories` and `searchRange` to query each configured topic and deduplicate matching repositories by `full_name`, and left `resolveTargetRelease` untouched.
- `scripts/crawl.mjs` (modified): Updated `CONFIG.topics` to `["agy-plugin", "antigravity-plugin"]`, bumped `crawlerVersion` and `userAgent` to `1.0.1`, and passed `topics: CONFIG.topics` to `createGitHubClient` and `validateAndParsePlugin`.
- `scripts/lib/plugin-parser.mjs` (modified): Updated `validateAndParsePlugin` to accept `topics` (default `["agy-plugin", "antigravity-plugin"]`) and exclude all configured discovery topics case-insensitively (plus `agy-cat-*`) from `tags`.
- `.github/workflows/issue-ops-submit.yml` (modified): Accepted either `agy-plugin` or `antigravity-plugin` (case-insensitive) during Issue-Ops repository validation.
- `.github/ISSUE_TEMPLATE/submit-plugin.yml` (modified): Updated submission instructions and checklist wording to reference `agy-plugin` or `antigravity-plugin`.
- `site/index.html` (modified): Updated hero description to list both `agy-plugin` and `antigravity-plugin`.
- `README.md` (modified): Documented `agy-plugin` or `antigravity-plugin` as discovery topics.
- `CHANGELOG.md` (created): Documented `1.0.1` and `1.0.0` releases.
- `package.json`, `package-lock.json` (modified): Bumped version to `1.0.1`.
- `.gitignore` (modified): Hardened ignores for `Logs/`, `registry-data/`, `pages-dist/`, `.env*` (preserving `!.env.example`), `*.pem`/`*.key`, `.codegraph/`, `.vite/`, editor files, and OS artifacts.
- `tests/github-client.test.mjs` (created): Added unit tests verifying multi-topic discovery & deduplication, fail-fast topic validation, and preserved release-first resolution with default-branch fallback.
- `tests/registry-fixtures.test.mjs` (modified): Updated fixture test to verify both `agy-plugin` and `antigravity-plugin` are excluded from `parsed.tags`.
- `.artifacts/2026-11-27_antigravity-plugin-topic.md`, `.artifacts/2026-11-27_antigravity-plugin-topic-summary.md` (created): Plan and summary artifacts.

### `c:\GitHub\antigravity-community-marketplace` (`v1.0.5`)
- `README.md` (modified): Updated plugin submission instruction to mention `agy-plugin` or `antigravity-plugin`.
- `CHANGELOG.md` (modified): Added `[1.0.5]` release notes.
- `package.json`, `package-lock.json`, `plugin.json`, `sidecars/marketplace/server.mjs`, `ui/src/bridge.js`, `ui/src/helpers.js` (modified): Bumped version to `1.0.5`.
- `ui/dist/marketplace.html` (rebuilt): Rebuilt single-file UI bundle with `v1.0.5`.
- `.gitignore` (modified): Hardened ignores for `Logs/`, `.env*` (preserving `!.env.example`), `*.pem`/`*.key`, `.codegraph/`, `.vite/`, editor files, and OS artifacts while keeping `!ui/dist/marketplace.html` tracked.
- `.artifacts/2026-11-27_antigravity-plugin-topic.md`, `.artifacts/2026-11-27_antigravity-plugin-topic-summary.md` (created): Plan and summary artifacts.

## Verification
- `antigravity-community-marketplace`: `npm run build:ui` succeeded (`dist/marketplace.html` 345.98 kB); `npm test` passed (`76/76` tests, `0` failed, `0` skipped), logged to `Logs/test-results-v1.0.5.log`; `audit-gate.js` passed (`GATE VERDICT: PASS`).
- `antigravity-plugin-registry`: `npm test` passed (`73/73` tests, `0` failed, `0` skipped), logged to `Logs/test-results-v1.0.1.log`; `audit-gate.js` passed (`GATE VERDICT: PASS`).
