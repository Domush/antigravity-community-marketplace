# Summary: Staged Update Worker Reliability Fix, Version 1.0.8 Release & Local Sync

**Date:** 2026-11-28  
**Topic:** `pending-worker-windows-fix-and-release`

## Implemented & Changed Behavior

1. **Windows Process-Tree Escape & Multi-PID Watching (`server/lib/windows-process.mjs`, `server/lib/pending-updates.mjs`, `server/lib/pending-worker.mjs`, `server/index.mjs`, `sidecars/marketplace/server.mjs`):**
   - Added `resolveWindowsNodeExecutable()`, `discoverWindowsLockHolderPids()`, and `launchWindowsDetachedWmi()` to launch the detached swap worker as an independent `node.exe` process via WMI (`Win32_Process.Create`) on Windows (with detached `spawn` fallback), preventing Antigravity shutdown from killing the worker before locks clear.
   - Updated `pending-worker.mjs` (`parseWorkerArgs`, `runPendingWorker`) to support repeatable and comma-separated `--watch-pid` arguments and wait until all watched PIDs (sidecar/server + ancestor `Antigravity`/`language_server` lock holders) exit before starting `maxWaitMs`.
   - Updated `server/index.mjs` startup and `sidecars/marketplace/server.mjs` startup/shutdown to pass `watchPid: process.pid` and normalized `store.dataDir`.
2. **Live-PID Lock Protection (`server/lib/pending-worker.mjs`):**
   - Updated `acquireWorkerLock()` so locks owned by a living PID (`isAliveFn(pid) === true`) are never stolen regardless of file `mtimeMs`, added heartbeat mtime touches while polling, and ensured `releaseWorkerLockIfOwned()` only unlinks locks owned by `process.pid`.
3. **Unified `--data-dir` Resolution (`mcp_config.json`, `server/lib/service-config.mjs`, `server/lib/service.mjs`, `sidecars/marketplace/server.mjs`):**
   - Removed `--data-dir ${PLUGIN_DATA}` from `mcp_config.json` and added `resolveDataDir()` so both the MCP server and the marketplace sidecar resolve the same canonical `DEFAULT_DATA_DIR`.
4. **Persistent Worker Diagnostics & Orphan Cleanup (`server/lib/pending-diagnostics.mjs`, `server/lib/pending-updates.mjs`, `server/lib/pending-worker.mjs`):**
   - Replaced silent `logger: null` / `stdio: "ignore"` with bounded/rotated `pending-worker.log` logging (`openRotatedWorkerLogFd`, `createWorkerLogger`), detailed `pending-worker-status.json` outcome reporting, and `cleanupOrphanedArtifacts()` for stale temp files/dead locks.
5. **Version Bump (`1.0.8`) & Changelog (`package.json`, `package-lock.json`, `plugin.json`, `sidecars/marketplace/server.mjs`, `ui/src/bridge.js`, `ui/src/helpers.js`, `ui/dist/marketplace.html`, `CHANGELOG.md`):**
   - Bumped version from `1.0.7` to `1.0.8` across manifests, sidecar/UI sources, and rebuilt bundle.
   - Rolled `[Unreleased]` and all uncommitted git changes plus this release's improvements into `## [1.0.8] - 2026-11-28` in `CHANGELOG.md`.

## Files Created or Modified
- **Created:**
  - `.artifacts/2026-11-28_pending-worker-windows-fix-and-release.md`
  - `.artifacts/2026-11-28_pending-worker-windows-fix-and-release-review.md`
  - `.artifacts/2026-11-28_pending-worker-windows-fix-and-release-summary.md`
  - `server/lib/windows-process.mjs`
  - `server/lib/pending-diagnostics.mjs`
  - `tests/shutdown-swap-hook.test.mjs`
  - `tests/pending-worker-reliability.test.mjs`
  - `tests/windows-process-and-diagnostics.test.mjs`
  - `tests/config-normalization-and-version.test.mjs`
- **Modified:**
  - `server/lib/pending-updates.mjs`
  - `server/lib/pending-worker.mjs`
  - `server/lib/service-config.mjs`
  - `server/lib/service.mjs`
  - `server/index.mjs`
  - `sidecars/marketplace/server.mjs`
  - `mcp_config.json`
  - `package.json`
  - `package-lock.json`
  - `plugin.json`
  - `ui/src/bridge.js`
  - `ui/src/helpers.js`
  - `ui/dist/marketplace.html`
  - `CHANGELOG.md`
  - `tests/staged-locked-updates.test.mjs`

## Verification & Local Sync
- `npm run build:ui`: Passed (`dist/marketplace.html 420.19 kB`, `Logs/ui-build.log`).
- `npm test` (`node --test ./tests/*.test.mjs`): Passed `123/123` tests across `34` suites (`0` failed, `0` skipped, `Logs/test-results.log`).
- `audit-gate.js`: Passed on all 30 created/modified files (`0` violations, `Logs/audit-gate.log`).
- `node server/index.mjs install --global`: Installed `v1.0.8` to `C:\Users\domus\.gemini\config\plugins\agy-community-marketplace` (`Logs/local-install.log`) and automatically spawned the live WMI swap worker (`PID 23672`, `node.exe`) watching Antigravity + `language_server.exe` (`watchPids=18724,23128,24760`), preserving all 3 staged updates for the user's restart test.
