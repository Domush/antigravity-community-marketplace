# Plan: Auto-Close Drawer on Confirm Update & Multi-Version Release Notes

**Date:** 2026-11-27

## Goal
1. Automatically close the slide-over detail drawer when `Confirm Update` (or any install/update in `executeInstall`) succeeds, returning the user directly to the plugin grid.
2. When an installed plugin is behind by multiple versions, show **all** release notes newer than the installed version (`> installedVersion` and `<= targetVersion`) instead of only the single latest release note.

## Implementation Steps
1. **`server/lib/release-notes.mjs` (new module):**
   - Implement `parseChangelogSections(markdown)` and `parseGitHubReleaseNotes(releases)` using `parseSemver` / `compareSemver`.
   - Implement `filterReleaseNotesSince({ sections, installedVersion, targetVersion })` to return all versions strictly greater than `installedVersion` and at most `targetVersion`, ordered newest-first.
   - Implement `fetchReleaseNotesSince({ pluginEntry, detail, installedVersion, store, fetchFn })` with immutable `(id, sha)` caching in `store.detailsCacheDir`, fetching `raw.githubusercontent.com/<id>/<sha>/CHANGELOG.md` and falling back to GitHub Releases API or `detail.latestReleaseNotes` on missing changelog / offline errors.
2. **`server/lib/service.mjs`:**
   - In `getPluginDetail`, determine the oldest outdated `installedVersion` among matching installs for `pluginEntry.id`, call `fetchReleaseNotesSince`, and return `{ ...detail, releaseNotesSinceInstalled, releaseNotesVersions }` without mutating cached objects.
3. **`ui/src/drawer-sections.js`:**
   - Render `detail?.releaseNotesSinceInstalled || detail?.latestReleaseNotes` in both the update review panel and `README & Notes`, updating the heading when multiple versions are included.
4. **`ui/src/actions.js`:**
   - In `executeInstall`, call `closeDrawer()` when the install/update succeeds (including `pendingRestart: true`), keeping the drawer open only on error.
5. **Tests, Build & Live Sync:**
   - Add unit tests for multi-version changelog parsing, GitHub Releases fallback, semver range filtering, and UI rendering (`tests/release-notes.test.mjs` and `tests/ui-version-direction.test.mjs`).
   - Run `npm run build:ui`, `npm test`, and `node server/index.mjs install --global`.
