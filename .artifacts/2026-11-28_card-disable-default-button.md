# Plan: Default Disable Split Button & Release v1.0.8

**Date:** 2026-11-28  
**Topic:** `card-disable-default-button`

## Goal
Update the installed plugin card split-action button so `Disable` (styled with a transparent dark orange/red background) is the default primary action when enabled, `Enable` is primary when disabled, `Update` remains primary when an update is available, and `Uninstall` moves into the split dropdown across all installed states—then rebuild UI, update tests/changelog, sync the local global install, commit, tag `v1.0.8`, and push.

## Implementation Steps
1. **Card Split-Action Model & Styling (`@team-coder`):**
   - Update `buildCardActionModel()` and `renderSplitActionButton()` in `ui/src/render.js` (and `ui/src/main.js` / `ui/src/actions.js` if action dispatch needs adjustment) so:
     - When an update is available (`hasUpdate` and not `pendingRestart`), `Update` remains the primary split button.
     - When `pendingRestart` is active, `Pending Restart` remains disabled primary as before.
     - When installed and up-to-date (enabled): primary action is `Disable` (for the active installed scope—global or project), styled with a transparent dark orange/red modifier class across the split button (`.mp-split-btn` / `.mp-split-main` / `.mp-split-toggle`), and `Uninstall` (global and/or project) is placed in the dropdown menu.
     - When installed and already disabled (`enabled === false`): primary action is `Enable`, and `Uninstall` remains in the dropdown menu.
   - Add the transparent dark orange/red split-button styling in `ui/src/sidebar.css` with accessible hover/focus/disabled states matching the existing dark theme tokens.
2. **Tests, UI Build & Changelog (`@team-coder`):**
   - Update `tests/ui-card-actions.test.mjs` (and any other affected UI tests) to assert the new default `Disable` / `Enable` / `Update` primary button behavior, dropdown `Uninstall` placement, and transparent dark orange/red CSS class.
   - Update `CHANGELOG.md` under `## [1.0.8] - 2026-11-28` to reflect the updated card action behavior in end-user-friendly wording.
   - Rebuild `ui/dist/marketplace.html` via `npm run build:ui`.
3. **Quick Verification & Local Install (`@team-qa` -> `@team-coder`):**
   - Run `npm run build:ui`, `npm test`, and `audit-gate.js` on touched files (logged to `Logs/`).
   - Sync the local global install via `node server/index.mjs install --global`.
4. **Git Commit, Tag & Push:**
   - Stage changes cleanly (respecting `.gitignore`), commit, create annotated/lightweight tag `v1.0.8`, and push branch + tag to `origin`.
