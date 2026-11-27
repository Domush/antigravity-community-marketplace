# Review: Antigravity Aux Pane Sidecar & Dual-Mode UI (v1.0.2)

**Date:** 2026-11-27  
**Repository:** `C:\GitHub\antigravity-community-marketplace`  
**Audit & QA Results:** Pass 1 (`VERDICT: REJECT`, 6 findings) -> Remediation -> Pass 2 (`VERDICT: PASS`, 2 non-blocking P1 notes) -> Final QA (`VERDICT: PASS`)

## Pass 1 Findings Resolved (`DEF-01`..`DEF-06`)
1. **[DEF-01] [P0] Wildcard CORS on Unauthenticated Loopback API (`sidecars/marketplace/server.mjs:218-225`):**
   Removed `Access-Control-Allow-Origin: *`, wildcard `Access-Control-Allow-*` headers, and `OPTIONS` preflight allowance from `createStandaloneServer`. Added `validateStandaloneToolRequest` in `sidecars/marketplace/http-helpers.mjs` to reject `Sec-Fetch-Site: cross-site` or non-matching/invalid `Origin` headers with HTTP `403`, and non-`application/json` `Content-Type` headers with HTTP `415`.
2. **[DEF-02] [P0] Asymmetrical Teardown in Sidecar App Test (`tests/sidecar-server.test.mjs:344-390`):**
   Moved `sidecarApp?.stop()` and `standaloneApp?.stop()` into the `finally` block prior to temporary directory removal so server handles close deterministically on assertion failures.
3. **[DEF-03] [P1] Silent Fallback When `sidecar_sdk` Is Unavailable in Sidecar Env (`sidecars/marketplace/server.mjs:339-344,389-428`):**
   Separated `hasSidecarEnv` detection from `SidecarApp` availability and enforced fail-fast error throw when all three `ANTIGRAVITY_*` sidecar environment variables are set without a loadable `sidecar_sdk`.
4. **[DEF-04] [P1] Unsettled Promise on Premature Request Close (`sidecars/marketplace/server.mjs:136-185`):**
   Refactored `readJsonObjectBody` into `sidecars/marketplace/http-helpers.mjs` with unified listener cleanup and a `close` handler that rejects deterministically when `!settled && !req.complete`.
5. **[DEF-05] [P1] Overlapping `loadBootstrap` Races & `window.prompt` (`ui/src/main.js:43-78,262-269`):**
   Added a monotonic `bootstrapSeq` request sequence guard in `loadBootstrap` to discard stale responses, and replaced `window.prompt` with an inline `#custom-project-editor` control in `ui/marketplace.html` and `ui/src/sidebar.css`.
6. **[DEF-06] [P1] Missing URL Scheme Validation in `openExternal` (`ui/src/bridge.js:136-139`):**
   Added `isSafeHttpUrl` validation via `new URL(...)` so both Sidecar and MCP `openExternal` handlers only open `https:` or `http:` URLs.

## Pass 2 Audit & QA Verification Evidence
- **Adversarial Audit (`@team-auditor` Pass 2):** `VERDICT: PASS` (0 blocking defects; 2 non-blocking P1 advisory notes recorded).
- **Static Audit Gate (`audit-gate.js`):** `GATE VERDICT: PASS` (0 violations across all 18 audited source/config/test files, all `<= 469` lines).
- **UI Single-File Build (`npm run build:ui`):** Built `ui/dist/marketplace.html` (`321.47 kB` / `77.94 kB` gzip, 0 warnings, exit code `0`).
- **Automated Tests (`@team-qa`, `Logs/test-results-v1.0.2.log`):** `VERDICT: PASS` — `46/46` tests passed across `15` suites (`0` failed, `0` skipped, exit code `0`).
- **Package Dry-Run (`npm pack --dry-run`):** Verified `19` packaged files including `sidecars/marketplace/sidecar.json`, `sidecars/marketplace/server.mjs`, `sidecars/marketplace/http-helpers.mjs`, `server/lib/service.mjs`, and `ui/dist/marketplace.html`.

## Recommended Next Steps
1. Reinstall locally (`npx --yes . install`) and verify the **Community Plugins** tab inside Google Antigravity's Aux Pane and global sidebar.
2. Publish `v1.0.2` via the release workflow once verified in the desktop host.
