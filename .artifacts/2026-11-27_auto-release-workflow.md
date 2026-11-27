# Plan: Add Auto-Release Workflow and Bump to v1.0.7

**Date:** 2026-11-27  
**Repository:** `c:\GitHub\antigravity-community-marketplace`

## Goal
Port the npm publish + automated GitHub Release workflow pattern from `../antigravity-plugin-context-mode/.github/workflows/publish.yml` into `.github/workflows/publish.yml`, bump the package version to `1.0.7`, update `CHANGELOG.md`, verify build/tests/audit-gate, and commit, tag `v1.0.7`, and push.

## Implementation Steps
1. **Update `.github/workflows/publish.yml`**
   - Set `permissions: contents: write` and `id-token: write`.
   - Configure `actions/setup-node@v4` with `registry-url: 'https://registry.npmjs.org'`.
   - Upgrade `npm@latest`, run `npm ci`, `npm run build:ui`, `npm test`, `npm --version`, and `npm publish --access public --provenance --ignore-scripts`.
   - On tag pushes (`startsWith(github.ref, 'refs/tags/')`), extract the matching `## [<version>]` section from `CHANGELOG.md` into `release_notes.md` and create the GitHub Release via `softprops/action-gh-release@v2`.
2. **Bump Version (`1.0.6` → `1.0.7`) & Update `CHANGELOG.md`**
   - Update `package.json`, `package-lock.json`, `plugin.json`, `sidecars/marketplace/server.mjs`, `ui/src/bridge.js`, and `ui/src/helpers.js`.
   - Add `## [1.0.7] - 2026-11-27` entry to `CHANGELOG.md` (matching the tag so `Extract Release Notes from CHANGELOG.md` succeeds).
3. **Verify & Release**
   - Run `npm run build:ui`, `npm test`, and `audit-gate.js`.
   - Commit, tag `v1.0.7`, push `main` and `v1.0.7` to `origin`, and monitor the triggered `Publish to npm and create GitHub release` workflow run.
