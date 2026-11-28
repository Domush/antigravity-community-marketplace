# Review: Staged Locked Plugin Updates & In-Place Sync Fallback

**Date:** 2026-11-27  
**Topic:** `staged-locked-plugin-updates`

## Root Causes Diagnosed & Resolved After Live Restart Test

1. **Dot-prefixed staging directory inside `plugins/` was loaded by Antigravity on restart:**
   - Leaving `.domush--...tmp` inside `C:\Users\domus\.gemini\config\plugins\` caused Antigravity to load the staged folder as a second active plugin on startup, locking both `legacyDir` and `stageDir`.
   - **Fix:** `installPlugin` now accepts `pendingStageRoot` (passed by `service.mjs` as `<dataDir>/pending-stages`) and relocates staged directories out of `plugins/` immediately when `pending_restart` occurs.
2. **Shutdown-only worker spawning missed Windows `TerminateProcess` exits & Sidecar runs:**
   - Waiting until `stdin` `end` or `SIGTERM` to spawn `pending-worker.mjs` failed when Antigravity terminated the MCP server/sidecar via `TerminateProcess` on Windows.
   - **Fix:** `service.mjs` now spawns `pending-worker.mjs --data-dir <dataDir> --watch-pid <process.pid>` immediately when a pending update is staged, so the detached worker survives `TerminateProcess`/`SIGKILL`, detects the parent PID exit, and waits up to 20s for active plugin locks to clear.
3. **Missing parent directory during deferred swap:**
   - `moveDirAtomic` now ensures `path.dirname(destDir)` exists before renaming `srcDir` -> `destDir`.
4. **User Recovery Control:**
   - Added `mp_apply_pending_updates` and a **Retry Now** button on the UI warning banner.

## Verification & Line Ceiling Status

- All modified/new source files are under 500 lines (`ui/src/main.js`: 494, `ui/src/render.js`: 471, `sidecars/marketplace/server.mjs`: 412, `server/lib/service.mjs`: 403, `server/lib/installer.mjs`: 352, `server/lib/pending-updates.mjs`: 270, `server/lib/pending-worker.mjs`: 185).
- `npm run build:ui` and `npm test` passed (`93/93` tests across `26` suites), including a cross-process `SIGKILL` survival test for `--watch-pid`.

## Recommended Next Steps

1. Update your local `agy-community-marketplace` plugin installation from this workspace (`node server/index.mjs install` or `npm run build:ui && node server/index.mjs install`) so the live marketplace MCP/sidecar process uses the fixed code.
2. Clean up the previously staged `.domush--antigravity-plugin-context-mode.install.9d40bda0eea6.tmp` and update `Domush/antigravity-plugin-context-mode` again (after closing Antigravity or clicking **Retry Now** once unlocked).
