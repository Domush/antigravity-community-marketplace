# Plan: Short `owner--pluginName` Slugs, Always-Isolated Staging, Top-Left Back & Amber Staged Notice

**Date:** 2026-11-27

## Goal

1. Use `owner--shortName` (`domush--context-mode`) instead of `owner--repo` (`domush--antigravity-plugin-context-mode`) when `pluginName` is known, keeping folder names short while preserving cross-author collision safety.
2. Always stage downloads/extractions inside `pendingStageRoot` (never creating `.install.*.tmp` folders inside `~/.gemini/config/plugins/` or `.agents/plugins/`), preventing failed attempts from leaving duplicate plugin copies in the live plugins directory.
3. Replace the top-right `Close` button in the detail drawer with a top-left `← Back` button.
4. Render the pending-restart notice in prominent amber (`--mp-elevated-bg` / `--mp-elevated-fg`) at the top of the drawer body across both tabs with clear copy (`pending and will update on restart`).

## Implementation Steps
- **`server/lib/installer.mjs`:** Update `pluginSlug(id, pluginName)` and `installPlugin` to compute `owner--shortName` and always stage inside `pendingStageRoot` (falling back to `os.tmpdir()` when `pendingStageRoot` is omitted).
- **`ui/src/helpers.js` & `ui/src/drawer-sections.js`:** Add `getPluginSlug(plugin)` matching `pluginSlug`, use it for `canonicalSlug`, and move staged-update rendering to the drawer shell so it appears on every tab.
- **`ui/src/drawer.js` & `ui/src/drawer.css`:** Move the dismiss button to top-left `← Back`, add `.mp-panel-warning` amber styling, and render the friendly pending-restart panel at the top of `.mp-drawer-body`.
- **Tests, UI build & Changelog:** Update `tests/staged-locked-updates.test.mjs`, `tests/ui-version-direction.test.mjs`, `CHANGELOG.md`, rebuild `ui/dist/marketplace.html`, and run `npm test`.
