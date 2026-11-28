# Plan: Fix Pending-Update Staging EPERM & Streamline Marketplace Update/Drawer UX

**Date:** 2026-11-27

## Goal

Resolve the Windows `EPERM` failure when staging locked plugin updates for restart, and align the Marketplace drawer and update UX with user expectations:
1. Relocate locked plugin stage directories into `pending-stages` cleanly on Windows (`EPERM`/`EBUSY`) so the restart prompt triggers instead of failing.
2. Treat matched manual (`repo_origin`) installs identically to managed installs—no `"Adopt & Verify"` wording or special `"Adopt"` flow, just standard `Update` buttons and labels.
3. Show **Release Notes** and a **Permission Diff** whenever reviewing an update (including matched manual installs), and render install/update errors inside the drawer so failures are immediately visible.
4. Place the **`README & Notes`** tab to the left of **`Security Audit`** (and default `Details` to `README & Notes`), and make the `Details` footer install-aware so it surfaces update actions for installed scopes instead of hardcoded `Install Global` / `Install Project` buttons.

## Implementation Steps

### Phase 1 — Backend Pending-Stage Fallback (`server/lib/installer.mjs`)
- Update `relocateStageDir(stageDir, pendingStageRoot, fsOps)` so that in addition to `EXDEV`, any `isBusyLockError(err)` (`EPERM`, `EBUSY`, `ENOTEMPTY`) falls back to recursive copy (`fsOps.cp(stageDir, targetStage, { recursive: true, force: true })`) followed by best-effort cleanup (`fsOps.rm(stageDir, { recursive: true, force: true }).catch(() => {})`).
- Keep `applyPendingUpdates` tree-hash verification intact so copied stage directories remain cryptographically verified before swap.

### Phase 2 — Unified Update Metadata (`ui/src/helpers.js`)
- In `getInstallActionMeta(install, plugin)`:
  - Use `"review-update"` for matched `repo_origin` installs as well as managed installs.
  - Replace `"Adopt & Verify (v...)"` and `"Adopt Registry v... (Downgrade)"` with standard update/re-sync/downgrade labels (`Update ... → ...`, `Re-sync Verified (v...)`, `Downgrade to v...`).
- Update `getActionTooltip(meta, scope)` to describe reviewing release notes and permission diffs for updates/downgrades uniformly.
- Change `state.drawer.subTab` default to `"overview"` and add `actionError: null` to `state.drawer`.

### Phase 3 — Drawer UI, Release Notes, Permission Diff & Error Visibility (`ui/src/drawer.js`, `ui/src/main.js`)
- **`ui/src/main.js`**:
  - Handle `"review-update"` (and `"review-adopt"` if triggered from an unmatched Tier 3 suggestion) cleanly, setting `pendingAction.type = "update"` for matched installs.
  - In `executeInstall`, capture errors into `state.drawer.actionError` when the drawer is open for that plugin, and clear `state.drawer.actionError` on new actions / drawer opens.
- **`ui/src/drawer.js`**:
  - Reorder drawer tabs so `README & Notes` is on the left of `Security Audit (${findings.length})`.
  - Compute `isUpdate = Boolean(targetInstall && (isAhead || targetInstall.matchTier === "repo_origin" || (!targetInstall.manual && targetInstall.sha !== summary.release?.sha)))` so matched manual installs show the Permission Diff block (noting when baseline capabilities were not previously tracked in the lockfile).
  - Include the `Release Notes` panel in the update review body (`buildAuditBlocks`) whenever `isUpdate` or `pending?.type === "update"`.
  - Render `state.drawer.actionError` as a danger alert inside the drawer body.
  - Replace `"Confirm Adopt & Verify"` with `"Confirm Update (${scope})"` (or `"Confirm Downgrade..."` when local is ahead).
  - Replace the hardcoded `Install Global` / `Install Project` footer when `pending` is null with install-aware actions: show update action buttons matching the card's `Update` button for any installed scope with an update/action, and only show `Install Global` / `Install Project` for scopes where the plugin is not already installed.

### Phase 4 — Tests, Build & Verification
- Add a regression test in `tests/staged-locked-updates.test.mjs` verifying `relocateStageDir` falls back to `cp` + `rm` when `fsOps.rename` throws `EPERM` on relocation into `pending-stages`, returning `pending_restart`.
- Update `tests/ui-version-direction.test.mjs` to match the unified `review-update` / non-`Adopt & Verify` labels and verify `buildDrawerFooter` / `getInstallActionMeta` behavior.
- Rebuild the bundled UI (`npm run build:ui`) and run the full test suite (`npm test`), saving test logs under `Logs/`.
- Update `CHANGELOG.md` under `[Unreleased]` for end-user visibility, and save the final summary artifact in `.artifacts/`.

## Edge Cases
- **Locked `.tmp` directory during `rm` after `cp` fallback:** `rm(stageDir)` is best-effort (`.catch(() => {})`) so an active file-watcher lock in `plugins/` does not abort `pending_restart`. Dot-prefixed directories are already skipped by `scanner-local.mjs`.
- **Unmatched Tier 3 `name_suggestion` plugins:** Keep `Review & Adopt` functional on `isManualOnly` cards since those are not yet matched via `repo_origin`.
- **Missing release notes on a release:** Show a clean muted fallback (`No release notes available for this release.`) inside the Release Notes panel during update review.
- **Installed in one scope, not the other:** In `Details`, show the update button (or up-to-date state) for the installed scope and `Install <Scope>` only for the uninstalled scope.

## Verification Strategy
1. `npm run build:ui` succeeds cleanly.
2. `npm test` passes all test files with zero failures or skipped assertions, logged to `Logs/test-results.log`.
3. `git status` and `git diff` confirm no unintended edits and all touched files comply with repository guidelines.
