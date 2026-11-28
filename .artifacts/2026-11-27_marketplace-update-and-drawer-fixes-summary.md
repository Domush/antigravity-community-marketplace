# Summary: Pending-Update Staging Fix & Streamlined Marketplace Update/Drawer UX

**Date:** 2026-11-27

## Implemented & Changed Behavior

1. **Global & Next-Steps Rule Updates**
   - Updated `C:\Users\domus\.gemini\GEMINI.md` (Rules 2 & 3) and `C:\Users\domus\.gemini\config\plugins\suggest-next-steps\rules\AGENTS.md` to override the `ask_question` plain-text caveat, forbid ending turns with prose questions/option menus, and require emitting `ask_question` in the same turn when asking how to proceed or suggesting next steps.

2. **Windows `EPERM` Pending-Restart Staging Fallback (`server/lib/installer.mjs`)**
   - Updated `relocateStageDir()` so `isBusyLockError(err)` (`EPERM`, `EBUSY`, `ENOTEMPTY`) falls back to recursive copy (`fsOps.cp`) + best-effort cleanup (`fsOps.rm(...).catch(() => {})`) just like `EXDEV`.
   - Prevents Windows file-watcher/antivirus locks on `~/.gemini/config/plugins/` from aborting `stagePendingUpdate`, allowing `mp_install_plugin` to return `pendingRestart: true` cleanly.

3. **Unified Update Flow for Matched Local Plugins (`ui/src/helpers.js`, `ui/src/drawer-sections.js`, `ui/src/main.js`)**
   - Removed `"Adopt & Verify"` and `"review-adopt"` from `getInstallActionMeta()` and `getActionTooltip()` so matched `repo_origin` installs use standard `"review-update"` actions and `"Update ..."` / `"Re-sync Verified"` / `"Downgrade to v..."` labels.
   - Updated `renderDrawer()` so `isUpdate` treats `repo_origin` installs identically to managed installs and removed the `"Adopt Manual Plugin"` banner for matched updates.

4. **Release Notes, Permission Diff, Drawer Errors, Tab Order & `Details` Footer (`ui/src/drawer.js`, `ui/src/drawer-sections.js`, `ui/src/main.js`)**
   - Extracted `buildAuditBlocks`, `buildOverviewHtml`, and `buildDrawerFooterHtml` into `ui/src/drawer-sections.js` to keep all source files under the 500-line ceiling.
   - Added the **Release Notes** panel directly into `buildAuditBlocks` whenever reviewing an update (`isUpdate || pending?.type === "update"`), alongside the **Permission Diff** panel (with a baseline note when a manual install had no previously recorded lock capabilities).
   - Placed **`README & Notes`** to the left of **`Security Audit`** and made `"overview"` the default tab when opening `Details` or clicking a plugin title.
   - Updated `buildDrawerFooterHtml` so opening `Details` (`pending === null`) on an installed plugin with an available update displays `Confirm Update (<scope>)` (or `Confirm Downgrade ...`) instead of `Install Global` / `Install Project`, shows `Uninstall (<Scope>)` for up-to-date installed scopes, and only offers `Install Global` / `Install Project` for scopes where the plugin is not installed.
   - Added `state.drawer.actionError` in `executeInstall` and `executeUninstall` and rendered it inside `.mp-drawer-body` so failures are immediately visible without closing the drawer.

5. **Tests, UI Bundle & Changelog**
   - Added an `EPERM` relocation regression test in `tests/staged-locked-updates.test.mjs`.
   - Updated version-direction assertions and added drawer update-review, footer, and tab-order tests in `tests/ui-version-direction.test.mjs`.
   - Rebuilt `ui/dist/marketplace.html` via `npm run build:ui`.
   - Updated `CHANGELOG.md` under `[Unreleased]`.

## Files Created or Modified

- `C:\Users\domus\.gemini\GEMINI.md` (modified)
- `C:\Users\domus\.gemini\config\plugins\suggest-next-steps\rules\AGENTS.md` (modified)
- `.artifacts/2026-11-27_marketplace-update-and-drawer-fixes.md` (created)
- `.artifacts/2026-11-27_marketplace-update-and-drawer-fixes-summary.md` (created)
- `server/lib/installer.mjs` (modified)
- `ui/src/helpers.js` (modified)
- `ui/src/main.js` (modified)
- `ui/src/actions.js` (created)
- `ui/src/drawer.js` (modified)
- `ui/src/drawer-sections.js` (created)
- `ui/dist/marketplace.html` (rebuilt)
- `tests/staged-locked-updates.test.mjs` (modified)
- `tests/ui-version-direction.test.mjs` (modified)
- `CHANGELOG.md` (modified)
- `Logs/test-results.log` (test run log)

## Verification

- `npm run build:ui`: Passed (built `ui/dist/marketplace.html`, 357.94 kB).
- `node --test ./tests/*.test.mjs`: Passed 97/97 tests across 27 suites (0 failures, 0 skipped), output logged to `Logs/test-results.log`.
