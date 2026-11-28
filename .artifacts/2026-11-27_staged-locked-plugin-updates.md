# Plan: Staged Locked Plugin Updates & In-Place Sync Fallback

**Date:** 2026-11-27  
**Topic:** `staged-locked-plugin-updates`

## Goal

Eliminate `EBUSY` / `EPERM` update and legacy-migration failures on Windows (and any OS with active file/directory locks) when updating or migrating an actively running Antigravity plugin (such as `context-mode`).

Combine two complementary mechanisms:
1. **In-Place File Sync Fallback (`moveDirAtomic`):** Reuse `syncPluginDirectory` from `server/lib/cli-sync.mjs` when an existing plugin directory cannot be renamed due to a directory-handle lock (`EBUSY` / `EPERM`), completing the update immediately when all individual files are writable.
2. **Staged "Restart to Finish Update" Flow (`pending-updates` + Shutdown Swapper):** When a legacy folder rename or an individual file inside the active plugin directory remains locked (`EBUSY` / `EPERM` / `ENOTEMPTY`), preserve the verified `stageDir`, persist a pending update record in `PluginStore`, surface a clear "Restart Antigravity to finish update" state in the UI, spawn a detached swap worker on MCP server / sidecar shutdown (after Antigravity terminates running plugin MCP servers), and reconcile any leftover pending updates on startup.

## Detailed Implementation Phases

### Phase 1: Store & Installer Lock Handling
1. **`server/lib/store.mjs`**
   - Add `pendingUpdatesPath` (`<dataDir>/pending-updates.json`) and serialized methods:
     - `getPendingUpdates()`
     - `upsertPendingUpdate(entry)` (deduplicates by `finalDir` or `(slug, scope)` and removes any superseded `stageDir`)
     - `removePendingUpdate({ finalDir, slug, scope })`
   - Export `hasPendingUpdatesSync(dataDir)` for fast shutdown-hook checks without async I/O overhead.
2. **`server/lib/installer.mjs`**
   - Export `isBusyLockError(err)` (`EPERM`, `EBUSY`, `ENOTEMPTY`) and `PluginBusyLockError`.
   - Update `moveDirAtomic(srcDir, destDir)` so that when `hadExisting` is true and `fs.rename(destDir, backupDir)` throws `EBUSY`/`EPERM`, it attempts `syncPluginDirectory(srcDir, destDir)` from `cli-sync.mjs`, removing `srcDir` if sync succeeds, or leaving `srcDir` intact and throwing `PluginBusyLockError` if files inside `destDir` are still locked.
   - If `fs.rename(srcDir, destDir)` throws `EBUSY`/`EPERM` (e.g., `setPluginEnabled`), throw `PluginBusyLockError` after restoring any backup.
   - Update `installPlugin(...)` so that when `legacyDir` rename or `moveDirAtomic` fails with `PluginBusyLockError` / `isBusyLockError(err)`, it restores any moved `legacyBackupDir`, keeps the verified `stageDir` intact, and returns `{ status: "pending_restart", pendingUpdate }` instead of failing and deleting `stageDir`.
   - Keep all existing fields on immediate success alongside `status: "installed"`.

### Phase 2: Pending Update Reconciliation & Shutdown Swapper
3. **`server/lib/pending-updates.mjs`**
   - Implement `applyPendingUpdates({ store, denylist, logger })`:
     - Reads pending entries from `store`.
     - Verifies `stageDir` exists and passes `computeContentTreeSha256(stageDir) === entry.contentTreeSha256` (fail-closed on tamper/corruption).
     - Checks optional `denylist` before applying.
     - Attempts legacy folder rename/backup (if `legacyDir` exists) and `moveDirAtomic(stageDir, finalDir)`.
     - On `EBUSY`/`EPERM`/`ENOTEMPTY`, restores any moved legacy folder and preserves the pending entry as `stillLocked`.
     - On success, removes `plugins-disabled/<slug>`, removes `legacyBackupDir`, updates `store` lockfile (`removeInstallRecord` for legacy slug + `upsertInstallRecord` for canonical install), and removes the pending record.
   - Implement `spawnShutdownSwapWorker({ dataDir, workerScriptPath, execPath, logger })` and `registerShutdownSwapHook({ dataDir, ... })` listening once on `stdin` `end`/`close` and `SIGINT`/`SIGTERM`/`SIGHUP`.
4. **`server/lib/pending-worker.mjs`**
   - Detached worker script (`--data-dir <dir> [--max-wait-ms <ms>] [--poll-ms <ms>]`).
   - Acquires `${dataDir}/pending-worker.lock` exclusively (with stale-PID cleanup) so concurrent shutdown hooks from MCP server and sidecar do not race.
   - Retries `applyPendingUpdates({ store })` with short stepped backoff until all locks clear (up to `maxWaitMs`, default 15s), then exits cleanly.

### Phase 3: Service, Bootstraps, and UI Integration
5. **`server/lib/service.mjs`, `server/index.mjs`, `sidecars/marketplace/server.mjs`**
   - `service.mjs`: Handle `status === "pending_restart"` in `installPlugin`, return `pendingRestart: true` and `pendingUpdate` in `structuredContent`; include `pendingUpdates` in `getBootstrap`; clean up matching pending updates on normal install or uninstall.
   - `server/index.mjs` and `sidecars/marketplace/server.mjs`: Reconcile `applyPendingUpdates({ store })` on boot after `store.init()`, and register `registerShutdownSwapHook({ dataDir })`.
6. **`ui/src/helpers.js`, `ui/src/main.js`, `ui/src/render.js`, `ui/src/drawer.js`**
   - Track `state.pendingUpdates` from `mp_get_bootstrap` and `mp_install_plugin`.
   - Render a clear warning alert banner listing plugins staged for restart ("Restart Antigravity App to finish applying staged updates automatically").
   - Render a `Pending Restart` badge on affected cards and in the drawer.
   - Rebuild single-file UI bundle via `npm run build:ui`.

### Phase 4: Verification & Documentation
7. **Tests (`tests/staged-locked-updates.test.mjs`)**
   - Test in-place fallback when target directory handle is locked (`EBUSY`/`EPERM`) and files are writable.
   - Test legacy migration returning `pending_restart` when `legacyDir` is locked, preserving verified `stageDir` and original `legacyDir`.
   - Test `applyPendingUpdates` succeeding once lock clears, fail-closed hash check on tampered `stageDir`, and `pending-worker.mjs` end-to-end execution + lockfile cleanup.
   - Test `service.installPlugin` + `service.getBootstrap` pending-update lifecycle.
8. **Docs (`README.md`, `CHANGELOG.md`) & Artifacts**
   - Update user-facing documentation and changelog.
   - Create review (`-review.md`) and summary (`-summary.md`) artifacts.

## Edge Cases
- **Tampered or deleted `stageDir` before restart:** Re-verified via `contentTreeSha256` before swap; missing or mismatched stages are discarded safely without touching the active plugin.
- **Duplicate installs/updates for same plugin while pending:** `upsertPendingUpdate` replaces the older pending entry and deletes the superseded `stageDir`.
- **Uninstall before restart:** `uninstallPlugin` removes the pending record and deletes its `stageDir`.
- **Concurrent MCP + Sidecar shutdown:** Exclusive `pending-worker.lock` prevents two detached workers from racing on `lockfile.json` or folder renames.
- **Plugin still locked past worker timeout:** Pending entry remains intact in `pending-updates.json` for startup reconciliation or next shutdown.

## Verification Strategy
- `npm run build:ui`
- `npm test` (all existing + new tests, logged to `Logs/`)
- Verify all modified/new source files remain under 500 lines and have zero syntax/lint errors.
