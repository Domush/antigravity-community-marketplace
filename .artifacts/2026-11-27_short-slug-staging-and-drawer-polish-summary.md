# Summary: Short `owner--pluginName` Slugs, Always-Isolated Staging, Top-Left Back & Amber Staged Notice

**Date:** 2026-11-27

## Implemented & Changed Behavior

1. **Author + Short Plugin Name Slug (`server/lib/installer.mjs`, `ui/src/helpers.js`, `ui/src/drawer-sections.js`)**
   - Updated `pluginSlug(id, pluginName)` and added `getPluginSlug(plugin)` so installs with a `pluginName` use `<owner>--<shortName>` (e.g., `domush--context-mode` instead of `domush--antigravity-plugin-context-mode`), keeping folder names short while avoiding cross-author collisions.
   - Updated `drawer-sections.js` to use `getPluginSlug(summary)` when checking for legacy folder migrations.

2. **Always Stage Outside the Live `plugins/` Directory (`server/lib/installer.mjs`)**
   - Updated `installPlugin` so extractions always stage inside `pendingStageRoot` (or `os.tmpdir()/agy-marketplace-stage` when `pendingStageRoot` is omitted) instead of creating `.install.*.tmp` folders inside `~/.gemini/config/plugins/` or `.agents/plugins/`.
   - Prevents failed or interrupted updates from leaving extra plugin directories inside the live `plugins/` folder.

3. **Top-Left `← Back` Button & Amber Pending-Restart Notice (`ui/src/drawer.js`, `ui/src/drawer-sections.js`, `ui/src/drawer.css`)**
   - Replaced the top-right `Close` button in `.mp-drawer-head` with a top-left `← Back` button (`mp-drawer-back`).
   - Moved the pending-restart notice into `buildStagedUpdateNotice` rendered at the top of `.mp-drawer-body` across both `README & Notes` and `Security Audit` tabs.
   - Styled the notice with `.mp-panel-warning` (matching the amber `--mp-elevated-bg` / `--mp-elevated-fg` alert palette) and simplified the message to: `Update to v<version> (<scope>) is pending and will update on restart.`

4. **Tests, UI Bundle & Changelog**
   - Updated `tests/staged-locked-updates.test.mjs` and `tests/ui-version-direction.test.mjs`.
   - Updated `CHANGELOG.md` under `[Unreleased]`.
   - Rebuilt `ui/dist/marketplace.html` via `npm run build:ui`.

## Files Created or Modified

- `.artifacts/2026-11-27_short-slug-staging-and-drawer-polish.md` (created)
- `.artifacts/2026-11-27_short-slug-staging-and-drawer-polish-summary.md` (created)
- `server/lib/installer.mjs` (modified)
- `ui/src/helpers.js` (modified)
- `ui/src/drawer.js` (modified)
- `ui/src/drawer-sections.js` (modified)
- `ui/src/drawer.css` (modified)
- `ui/dist/marketplace.html` (rebuilt)
- `tests/staged-locked-updates.test.mjs` (modified)
- `tests/ui-version-direction.test.mjs` (modified)
- `CHANGELOG.md` (modified)
- `Logs/test-results.log` (updated)

## Verification

- `npm run build:ui`: Passed (`dist/marketplace.html`, 358.76 kB).
- `node --test ./tests/*.test.mjs`: Passed 97/97 tests across 27 suites (0 failures, 0 skipped), output logged to `Logs/test-results.log`.
