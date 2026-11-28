# Plan: Staged Update Worker Reliability Fix, Version Bump, Changelog & Local Sync

**Date:** 2026-11-28  
**Topic:** `pending-worker-windows-fix-and-release`

## Goal

Fix the staged plugin update swap pipeline so updates staged due to Windows file/directory locks (`EPERM`/`EBUSY`) reliably complete when Antigravity exits/restarts, unify `--data-dir` configuration, add persistent worker diagnostics, bump the plugin version, update `CHANGELOG.md` for all uncommitted changes, and update the local global install for testing.

## Implementation Phases

### Phase 1: Staged Update Worker & Data-Dir Fixes (`@team-coder`)
1. **Windows Process-Tree Escape & `language_server.exe` Exit Watching (`server/lib/pending-updates.mjs`, `server/lib/pending-worker.mjs`):**
   - Avoid spawning the detached swap worker as an `Antigravity.exe` child inside the sidecar process tree that gets terminated during Antigravity shutdown. Resolve an independent Node executable on Windows and launch it in a way that escapes parent-tree termination on shutdown.
   - Ensure the worker monitors not only the immediate sidecar PID (`watchPid`) but also any parent `language_server.exe` / Antigravity lock-holder PIDs (discovered via process ancestry or passed via CLI flags) so the post-exit swap window does not start or expire while `language_server.exe` still holds `ReadDirectoryChangesW` handles on plugin directories.
   - Preserve cross-platform behavior (POSIX `detached: true` + `SIGTERM`/`SIGHUP` resilience) and keep all files under the 500-line ceiling and free of machine-specific paths (package isolation).
2. **Prevent Live-PID Lock Stealing (`server/lib/pending-worker.mjs`):**
   - Update `acquireWorkerLock()` so a lock held by an active, living worker (`isProcessAlive(pid) === true`) is never stolen purely due to `mtimeMs` age. Only reclaim locks when the PID is dead or unreadable/corrupt (and/or refresh heartbeat mtime on active loops).
3. **Unify `--data-dir` Configuration (`mcp_config.json`, `sidecars/marketplace/sidecar.json`, `server/lib/service-config.mjs`):**
   - Ensure the MCP server and the marketplace sidecar resolve the exact same default/configured `dataDir` (compatible with existing `pending-updates.json` data) so startup reconciliation checks the actual pending updates directory.
4. **Persistent Worker Diagnostics (`server/lib/pending-worker.mjs`, `server/lib/pending-updates.mjs`):**
   - Replace silent `logger: null` / `stdio: "ignore"` with structured file logging (`pending-worker.log` inside `dataDir`, bounded/rotated cleanly) and detailed error/attempt state in `pending-worker-status.json`.
   - Clean up any orphaned `.install.*.tmp` or stale lock state cleanly if encountered during startup/reconciliation.

### Phase 2: Version Bump, Changelog & Documentation (`@team-coder`)
1. Inspect `git diff` / uncommitted changes across the repository, `package.json`, `package-lock.json`, `plugin.json`, `CHANGELOG.md`, and `README.md`.
2. Bump the version consistently across `package.json`, `package-lock.json`, and `plugin.json`.
3. Update `CHANGELOG.md` under the new version header with all uncommitted git changes and this release's fixes, strictly adhering to `AGENTS.md` documentation rules (end-user friendly, sales appropriate, no method/variable names, no historical references to removed features). Update `README.md` only if directly needed for new/changed user-facing behavior.

### Phase 3: Adversarial Audit (`@team-auditor`)
- Fresh `@team-auditor` instance reviews all modified/created production files from line 1 to EOF against `audit-standards.md`, `coding-standards.md`, and `AGENTS.md` (package isolation, zero stubs, fail-fast error handling, 500-line ceiling, changelog/doc compliance).

### Phase 4: Adversarial Test Authoring & Test Audit (`@team-test` -> `@team-auditor`)
- `@team-test` authors regression tests in `tests/staged-locked-updates.test.mjs` (or a focused test file) covering:
  - Live-PID lock non-stealing even when lockfile mtime is old.
  - Multi-PID / `language_server`-style lock-holder waiting before post-exit swap timeout begins.
  - Windows process-escape spawn command/options verification and worker log/status output.
  - Unified `dataDir` resolution between MCP config and sidecar config.
- Fresh `@team-auditor` verifies test suite compliance against `testing-standards.md`.

### Phase 5: Build, QA Execution, Local Install Sync & Final Summary (`@team-qa` -> `@team-planner`)
- `@team-qa` runs `npm run build:ui` (if UI changed), `node scripts/audit-gate.js` (if present), and the full test suite (`node --test ./tests/*.test.mjs` / `npm test`) logging outputs to `Logs/`.
- Sync the updated plugin to the local global install (`node server/index.mjs install --global`) and report exact status (including whether `agy-community-marketplace` itself updated live or staged for restart).
- Save `.artifacts/2026-11-28_pending-worker-windows-fix-and-release-summary.md` and `.artifacts/2026-11-28_pending-worker-windows-fix-and-release-review.md`.

## Edge Cases
- Antigravity shutdown kills `cmd.exe` / sidecar process trees on Windows (`taskkill /T` or Job/console close): worker must not share `ParentProcessId` under the sidecar tree or use `Antigravity.exe` if that causes termination.
- Multiple updates staged >60s apart must not cause competing workers to steal `pending-worker.lock` from a live worker.
- `language_server.exe` takes longer to exit than the sidecar: worker must wait for the ancestor lock-holder PID(s) to exit before starting its post-exit swap timeout.
- No hardcoded machine-specific user paths (`C:\Users\domus\...`) anywhere in repository source or tests.

## Verification Strategy
- Independent adversarial code audit (`@team-auditor`) -> `VERDICT: PASS`.
- Independent adversarial test suite + test audit (`@team-test` + `@team-auditor`) -> `VERDICT: PASS`.
- Full automated test execution (`@team-qa`) with zero failures and zero skipped tests, logs captured in `Logs/`.
- Local global install updated and verified ready for user restart testing.
