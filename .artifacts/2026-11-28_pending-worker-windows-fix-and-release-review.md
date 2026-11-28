# Review: Staged Update Worker Reliability Fix & 1.0.8 Release

**Date:** 2026-11-28  
**Topic:** `pending-worker-windows-fix-and-release`

## Adversarial Code Audit Passes (`@team-auditor`)

### Pass 1 (`a5057862-dab6-4c17-a1ce-0d5f6618f48b`) — `VERDICT: REJECT`
- **DEF-01 [P0]** `server/lib/pending-diagnostics.mjs:64-70` & `server/lib/pending-updates.mjs:313-324`: `openRotatedWorkerLogFd` performed unguarded `mkdirSync`/`openSync` calls that could throw on permission/FS errors during `installPlugin`/`start`/`stop`.
- **DEF-02 [P1]** `sidecars/marketplace/server.mjs:324,326,397`: `createSidecarApp` passed raw `dataDir` instead of normalized `store.dataDir` to `spawnShutdownSwapWorker` and `registerShutdownSwapHook`.
- **DEF-03 [P1]** `server/lib/windows-process.mjs:289-291`: Loose `Number(parsed?.ReturnValue)` coercion in `launchWindowsDetachedWmi` could treat `null`/`""`/`false` as `0`.

### Pass 2 (`0a8e71a9-ee5f-44ad-922c-2b69ff78ba6a`) — `VERDICT: PASS`
- Verified `DEF-01`, `DEF-02`, and `DEF-03` completely resolved across `server/lib/pending-diagnostics.mjs` (146 lines), `server/lib/pending-updates.mjs` (381 lines), `sidecars/marketplace/server.mjs` (418 lines), and `server/lib/windows-process.mjs` (303 lines).
- `audit-gate.js` passed all 4 files (`0` violations) and `node --check` exited `0`.

## Adversarial Test Suite Audit Passes (`@team-auditor`)

### Pass 1 (`e39946d7-64d7-47da-b79f-6aec10e9dc2e`) — `VERDICT: REJECT`
- **DEF-01 [P0]** `tests/staged-locked-updates.test.mjs:723`: Exceeded 500-line ceiling (`724 > 500`).
- **DEF-02 [P0]** `tests/staged-locked-updates.test.mjs:488-508`: Assertions inside `spawnFn` callback could be silently swallowed by `registerShutdownSwapHook`'s `try...catch`.
- **DEF-03 [P0]** `tests/staged-locked-updates.test.mjs:594-624,423-439`: Child process/worker cleanup race with `withTempDir` on Windows.
- **DEF-04 [P1]** `tests/staged-locked-updates.test.mjs`: Untyped `assert.rejects(() => fs.access(...))` without `{ code: "ENOENT" }`.
- **DEF-05 [P1]** `tests/pending-worker-reliability.test.mjs`: Potential child leak on `spawnHoldProcess` timeout and pre-`try` setup.
- **DEF-06 [P1]** `tests/windows-process-and-diagnostics.test.mjs:254-256`: Unprotected FD cleanup in `openRotatedWorkerLogFd` test and missing malformed JSON case.

### Pass 2 (`f2329f61-748f-416b-9d07-f073a30cc21c`) — `VERDICT: PASS`
- Verified all 6 defects resolved: `tests/staged-locked-updates.test.mjs` decomposed cleanly into `staged-locked-updates.test.mjs` (439 lines) and `tests/shutdown-swap-hook.test.mjs` (350 lines); all 5 suites under 500 lines (`439`, `350`, `399`, `338`, `120`) and passing `audit-gate.js` (`0` violations) and `node --check`.

## QA Execution (`@team-qa`, `bf197fbd-416d-44b8-b79f-8aa9b2a19645`) — `VERDICT: PASS`
- `npm run build:ui`: Exit `0` (`dist/marketplace.html` `420.19 kB`, logged to `Logs/ui-build.log`).
- `npm test` (`node --test ./tests/*.test.mjs`): Exit `0`, `123/123` tests passed across `34` suites (`0` failed, `0` skipped, `0` warnings, logged to `Logs/test-results.log`).
- `audit-gate.js` across all 30 created/modified files: `GATE VERDICT: PASS (0 violations detected)` (logged to `Logs/audit-gate.log`).
