# Summary: Pending-Update Deduplication, Cancel Update, Worker Reliability & Single-Scope Guards

**Date:** 2026-11-27

## Implemented & Changed Behavior

1. **Pending-Update Read & Write Deduplication (`server/lib/store.mjs`, `server/lib/service.mjs`)**
   - Updated `getPendingUpdates()` to deduplicate any pre-existing duplicate entries on read by `(id.toLowerCase(), scope)`, `(slug, scope)`, or `finalDir` (last wins).
   - Updated `upsertPendingUpdate()` and `removePendingUpdate()` to match/deduplicate by `(id.toLowerCase(), scope)` in addition to `finalDir` and `(slug, scope)`, cleaning up superseded `stageDir` directories automatically.

2. **Swap Worker Reliability (`server/lib/pending-updates.mjs`, `server/lib/pending-worker.mjs`, `sidecars/marketplace/server.mjs`)**
   - Updated `spawnShutdownSwapWorker()` to pass `ELECTRON_RUN_AS_NODE: "1"` in the spawned child environment so `Antigravity.exe` always executes `pending-worker.mjs` in Node mode.
   - Updated `runPendingWorker()` to probe `applyPendingUpdates()` periodically (~450ms) while `watchPid` is alive, so plugin MCP-host restarts or window reloads apply unlocked updates immediately without waiting exclusively for the sidecar host PID to exit.
   - Updated `sidecars/marketplace/server.mjs` `start()` to spawn the swap worker when startup `applyPendingUpdates()` leaves `stillLocked` entries.

3. **Replace `Retry Now` with `Cancel Update` & Lock Out Duplicate Clicks (`server/lib/service-config.mjs`, `server/lib/service.mjs`, `server/tools-mutating.mjs`, `ui/src/render.js`, `ui/src/main.js`, `ui/src/helpers.js`, `ui/src/actions.js`, `ui/src/drawer-sections.js`, `ui/src/drawer.js`)**
   - Added `mp_cancel_pending_updates` and replaced the misleading `Retry Now` button on the pending-restart alert with `Cancel Update`.
   - Disabled card and drawer update buttons (`Pending Restart` / `Pending Restart (<scope>)`) whenever a pending update is already staged for that plugin and scope.

4. **Single-Scope Install Guards & Consistent Labels (`ui/src/render.js`, `ui/src/main.js`, `ui/src/actions.js`, `ui/src/drawer-sections.js`, `ui/src/drawer.js`)**
   - Standardized labels to `Install (global)` and `Install (project)`, hid `Install (project)` whenever globally installed, added `buildProjectInstalledWarning()`, and disabled `Install (global)` (with `Uninstall (Project)` beside it and an `executeInstall` guard) when already installed in project scope.

5. **Plugin Manifest Logo & Display Name (`plugin.json`)**
   - Replaced `"icon": "icon.svg"` with `"logo": "icon.svg"` and added `"displayName": "Community Plugins"` so Antigravity's Plugins screen displays the icon and title instead of the raw slug monogram.

6. **Live Plugin Sync & Cleanup**
   - Ran `node server/index.mjs install --global` to sync all built updates to `C:\Users\domus\.gemini\config\plugins\agy-community-marketplace`.
   - Stopped the stale stuck worker (`pending-worker.lock`) and removed the duplicate `domush--antigravity-plugin-context-mode` entry and its stage folder, leaving 1 clean `domush--context-mode` pending entry.

## Files Created or Modified

- `.artifacts/2026-11-27_pending-dedup-worker-and-scope-guards.md` (created)
- `.artifacts/2026-11-27_pending-dedup-worker-and-scope-guards-summary.md` (created/updated)
- `server/lib/store.mjs` (modified)
- `server/lib/service.mjs` (modified)
- `server/lib/service-config.mjs` (modified)
- `server/tools-mutating.mjs` (modified)
- `server/lib/pending-updates.mjs` (modified)
- `server/lib/pending-worker.mjs` (modified)
- `sidecars/marketplace/server.mjs` (modified)
- `ui/src/helpers.js` (modified)
- `ui/src/actions.js` (modified)
- `ui/src/render.js` (modified)
- `ui/src/main.js` (modified)
- `ui/src/drawer.js` (modified)
- `ui/src/drawer-sections.js` (modified)
- `ui/dist/marketplace.html` (rebuilt)
- `tests/staged-locked-updates.test.mjs` (modified)
- `tests/ui-card-actions.test.mjs` (modified)
- `tests/ui-version-direction.test.mjs` (modified)
- `CHANGELOG.md` (modified)
- `Logs/test-results.log` (updated)

## Verification

- `npm run build:ui`: Passed (`dist/marketplace.html`, 361.18 kB).
- `node --test ./tests/*.test.mjs`: Passed 100/100 tests across 27 suites (0 failures, 0 skipped), logged to `Logs/test-results.log`.
- `node server/index.mjs install --global`: Installed cleanly into `C:\Users\domus\.gemini\config\plugins\agy-community-marketplace`.
