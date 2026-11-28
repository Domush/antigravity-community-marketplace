# Plan: Pending-Update Deduplication, Worker Retry During Restart, Click Lockout & Single-Scope Guards

**Date:** 2026-11-27

## Root Cause Diagnosis
1. **Why restart left updates pending:** The Antigravity sidecar host (`sidecars/marketplace/server.mjs`) stayed alive across the server/window restart, keeping `pending-worker.mjs` blocked in `while (isProcessAlive(watchPid))` without attempting `applyPendingUpdates`, while `pending-worker.lock` prevented newer workers from starting. Additionally, `spawnShutdownSwapWorker` should explicitly set `ELECTRON_RUN_AS_NODE: "1"` when spawning via `Antigravity.exe`.
2. **Duplicate pending entries & repeatable Update clicks:** `store.upsertPendingUpdate` only deduplicated by `finalDir` / `(slug, scope)`, leaving duplicate entries when `slug` changed (`domush--antigravity-plugin-context-mode` vs `domush--context-mode`). On the UI, neither the card `Update` button nor the drawer `Confirm Update` button checked `state.pendingUpdates`, allowing repeated clicks.
3. **Single-scope install clarity:** `Install (project)` appeared even when globally installed, and `Install (global)` lacked a warning to uninstall an existing project-level install first.

## Implementation Steps
1. **`server/lib/store.mjs` & `server/lib/service.mjs`:** Deduplicate `upsertPendingUpdate` and match `removePendingUpdate` by `(id.toLowerCase(), scope)` as well as `finalDir` and `(slug, scope)`.
2. **`server/lib/pending-updates.mjs` & `server/lib/pending-worker.mjs`:** Set `ELECTRON_RUN_AS_NODE: "1"` in `spawnShutdownSwapWorker`, and have `runPendingWorker` periodically attempt `applyPendingUpdates` while `watchPid` is alive so MCP-host restarts also apply unlocked updates immediately.
3. **`ui/src/helpers.js`, `ui/src/actions.js`, `ui/src/render.js`, `ui/src/main.js`, `ui/src/drawer.js`, `ui/src/drawer-sections.js`:**
   - Disable card and drawer update buttons (`Pending Restart` / `Pending Restart (<scope>)`) when a pending update is already staged for that plugin & scope.
   - Use `Install (global)` and `Install (project)` labels consistently; omit `Install (project)` when `globalInst` exists; show a prominent warning (and disable `Install (global)` until project install is uninstalled) when `projectInst` exists.
4. **Tests & Verification:** Update `tests/staged-locked-updates.test.mjs`, `tests/ui-card-actions.test.mjs`, `tests/ui-version-direction.test.mjs`, `CHANGELOG.md`, rebuild `ui/dist/marketplace.html`, and run `npm test`.
