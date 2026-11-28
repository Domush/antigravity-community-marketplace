# Summary: Staged Locked Plugin Updates & In-Place Sync Fallback

**Date:** 2026-11-27  
**Topic:** `staged-locked-plugin-updates`

## Created & Modified Files

- **Created:**
  - `server/lib/tarball.mjs` — Extracted tarball verification and `computeContentTreeSha256` / `resolveInside` helpers from `installer.mjs`.
  - `server/lib/pending-updates.mjs` — `applyPendingUpdates`, `spawnShutdownSwapWorker` (with `--watch-pid` support), and `registerShutdownSwapHook`.
  - `server/lib/pending-worker.mjs` — Detached worker (`runPendingWorker`) with exclusive lockfile coordination, parent-PID watch mode, stepped retry backoff, and `pending-worker-status.json` diagnostics.
  - `server/lib/service-config.mjs` — Extracted tool schemas, CLI arg parsing, and catalog/store factory helpers from `service.mjs`.
  - `tests/staged-locked-updates.test.mjs` — Tests for `EBUSY` in-place sync fallback, `pendingStageRoot` relocation, tampered-stage rejection, shutdown hook, cross-process `SIGKILL` worker survival, and `mp_apply_pending_updates`.
- **Modified:**
  - `server/lib/store.mjs` — Added `pending-updates.json` persistence and `hasPendingUpdatesSync`.
  - `server/lib/installer.mjs` — Added `isBusyLockError`, `PluginBusyLockError`, `moveDirAtomic` in-place `syncPluginDirectory` fallback, and `pendingStageRoot` relocation outside `plugins/` on `pending_restart`.
  - `server/lib/service.mjs` & `server/tools-mutating.mjs` — Wired `pendingStageRoot`, immediate `--watch-pid` worker spawning on `pending_restart`, `getBootstrap` pending list, `uninstallPlugin` cleanup, and `mp_apply_pending_updates`.
  - `server/index.mjs` & `sidecars/marketplace/server.mjs` — Added startup `applyPendingUpdates` reconciliation and shutdown hook registration.
  - `ui/src/helpers.js`, `ui/src/main.js`, `ui/src/render.js`, `ui/src/drawer.js`, `ui/dist/marketplace.html` — Added `pendingUpdates` state, restart-required banner with **Retry Now** button, `Pending Restart` card badges, drawer notice, and rebuilt bundle.
  - `README.md` & `CHANGELOG.md` — Documented automatic in-place updates and staged restart completion.

## Verification

- `npm run build:ui` succeeded (`dist/marketplace.html` `355.00 kB`, logged to `Logs/staged-locked-updates-build.log`).
- `npm test` passed **`93/93` tests across `26` suites** (`0` failed, `0` skipped, logged to `Logs/staged-locked-updates-test.log`).
