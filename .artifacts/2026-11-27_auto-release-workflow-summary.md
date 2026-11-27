# Implementation Summary: Auto-Release Workflow & v1.0.7

**Date:** 2026-11-27  
**Repository:** `c:\GitHub\antigravity-community-marketplace`

## Created / Modified Files
- `.github/workflows/publish.yml` (modified): Added `contents: write` permission, `registry-url: 'https://registry.npmjs.org'`, `npm --version` check, `CHANGELOG.md` release-notes extraction, and `softprops/action-gh-release@v2` GitHub Release creation on `v*` tag pushes.
- `package.json`, `package-lock.json`, `plugin.json`, `sidecars/marketplace/server.mjs`, `ui/src/bridge.js`, `ui/src/helpers.js` (modified): Bumped version from `1.0.6` to `1.0.7`.
- `ui/dist/marketplace.html` (rebuilt): Single-file UI bundle updated for `v1.0.7`.
- `CHANGELOG.md` (modified): Added `[1.0.7]` release notes.
- `.artifacts/2026-11-27_auto-release-workflow.md`, `.artifacts/2026-11-27_auto-release-workflow-summary.md` (created): Plan and summary artifacts.
