# Summary: Auto-Close Drawer on Confirm Update & Multi-Version Release Notes

**Date:** 2026-11-27

## Implemented & Changed Behavior

1. **Auto-Close Detail Drawer After Confirming Update/Install (`ui/src/actions.js`)**
   - Updated `executeInstall()` to call `closeDrawer()` when `mp_install_plugin` succeeds (returning immediately to the plugin list, while keeping the drawer open on error to display `state.drawer.actionError`).

2. **All Release Notes Since Installed Version (`server/lib/release-notes.mjs`, `server/lib/service.mjs`, `ui/src/drawer-sections.js`, `ui/src/drawer.js`)**
   - Added `server/lib/release-notes.mjs` (`parseChangelogSections`, `parseGitHubReleaseNotes`, `filterReleaseNotesSince`, `fetchReleaseNotesSince`) to fetch and SHA-cache `CHANGELOG.md` from `raw.githubusercontent.com/<id>/<sha>/CHANGELOG.md` (with GitHub Releases API and `detail.latestReleaseNotes` fallbacks) and return all release sections `> installedVersion` and `<= targetVersion` in descending semver order.
   - Wired `fetchReleaseNotesSince` into `getPluginDetail()` in `server/lib/service.mjs` using the oldest matching local install version, returning `releaseNotesSinceInstalled` and `releaseNotesVersions` on a shallow copy of `detail`.
   - Extracted `buildReleaseNotesPanel()` in `ui/src/drawer-sections.js` to render `detail.releaseNotesSinceInstalled || detail.latestReleaseNotes` with a multi-version heading when multiple updates are spanned.

3. **Tests, UI Bundle, Changelog & Live Sync**
   - Added unit tests in `tests/release-notes.test.mjs` and `tests/ui-version-direction.test.mjs`.
   - Updated `CHANGELOG.md` under `[Unreleased]`.
   - Rebuilt `ui/dist/marketplace.html` via `npm run build:ui` and synced to `C:\Users\domus\.gemini\config\plugins\agy-community-marketplace` via `node server/index.mjs install --global`.

## Files Created or Modified

- `.artifacts/2026-11-27_auto-close-and-multi-version-release-notes.md` (created)
- `.artifacts/2026-11-27_auto-close-and-multi-version-release-notes-summary.md` (created)
- `server/lib/release-notes.mjs` (created)
- `server/lib/service.mjs` (modified)
- `ui/src/actions.js` (modified)
- `ui/src/drawer.js` (modified)
- `ui/src/drawer-sections.js` (modified)
- `ui/dist/marketplace.html` (rebuilt)
- `tests/release-notes.test.mjs` (created)
- `tests/ui-version-direction.test.mjs` (modified)
- `CHANGELOG.md` (modified)
- `Logs/test-results.log` (updated)

## Verification

- `npm run build:ui`: Passed (`dist/marketplace.html`, 361.40 kB).
- `node --test ./tests/*.test.mjs`: Passed 103/103 tests across 28 suites (0 failures, 0 skipped), logged to `Logs/test-results.log`.
- `node server/index.mjs install --global`: Installed cleanly into `C:\Users\domus\.gemini\config\plugins\agy-community-marketplace`.
