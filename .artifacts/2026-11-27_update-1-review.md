# Review: Community Marketplace Update 1 (v1.0.3)

**Date:** 2026-11-27  
**Repository:** `C:\GitHub\antigravity-community-marketplace`  
**Scope:** Version direction parity, sidebar UX & filter compaction, plugin/author icons & monogram fallbacks, tooltips & capability explanations (`accesses_gemini_dir`), collision false-positive removal, XSS-safe Markdown renderer, CSP `raw.githubusercontent.com` allowance, and resilient CLI locked-directory synchronization (`syncPluginDirectory`).

## Audit & QA Verdicts

### 1. Feature & UI/Server Audits (`v1.0.3`)
- **Version Direction & Downgrade Protection (`@team-auditor` / `@team-qa`):** `VERDICT: PASS`
  - Verified full semantic version comparison (`server/lib/semver.mjs`, `ui/src/helpers.js`) across `summarizeStatus` in `server/lib/service.mjs` and UI card/drawer helpers (`evaluateInstallVersionState`, `getInstallActionMeta`).
  - Locally ahead installs (`installedVersion > registryVersion`) no longer trigger false update badges/counts and instead surface a local-ahead status badge with explicit downgrade confirmation inside the Security Audit Drawer.
- **UX, Collapsible Filters, Icons, Tooltips & Collision Fix (`@team-auditor` / `@team-qa`):** `VERDICT: PASS`
  - Collapsible filter drawer (`#filter-drawer`) with active filter badge and reset keeps plugin cards immediately visible at the top of the sidebar.
  - Plugin/author icons render with `isSafeHttpUrl` validation and two-letter monogram fallbacks; `server/index.mjs` CSP `resourceDomains` includes `https://avatars.githubusercontent.com` and `https://raw.githubusercontent.com`.
  - Tooltips, `RISK_DESCRIPTIONS`, `CAPABILITY_DESCRIPTIONS` (including `accesses_gemini_dir`), and `severityDescription` provide plain-language security context (`ui/src/security-meta.js`).
  - `detectLiveCollisions` in `server/lib/scanner-local.mjs` removes noisy shared `hookEvents` warnings while preserving slash command, MCP server, and custom agent collision detection (`README.md` updated to match).
- **XSS-Safe Markdown Renderer (`@team-auditor` / `@team-qa`):** `VERDICT: PASS`
  - Verified `ui/src/markdown.js` (`sanitizeMarkdownUrl`, `renderMarkdown`) escapes raw HTML, strips null bytes, blocks unsafe URL schemes (`javascript:`, `data:`, `vbscript:`, protocol-relative `//`), resolves relative links only against pinned GitHub commit SHAs, degrades images/badges to host-safe links without `<img>` tags, and supports both `button` (`data-open-url`) and `anchor` link modes.

### 2. CLI Locked-Directory Sync Audit (`server/lib/cli-sync.mjs`, `server/lib/cli.mjs`, `tests/cli-sync.test.mjs`)
- **Pass 1 (`@team-auditor`):** `VERDICT: REJECT` (6 findings: `DEF-01`..`DEF-06`)
  - **[DEF-01] [P0]** Added fail-fast `TypeError` boundary guards in `stripTrailingSeparators`, `removePluginEntry`, and `syncPluginDirectory` (including rejecting array `fsOps` and explicit `null` option overrides).
  - **[DEF-02] [P0]** Expanded `tests/cli-sync.test.mjs` with negative-path `TypeError` guards, missing/non-directory `srcDir`, filesystem root refusals, locked symlink/file `destDir` refusals, `EBUSY`/`EPERM`/`ENOTEMPTY` coverage, unexpected error propagation on `removeEntryFn`/`rmdirSync`/`copyFileSync`, file-symlink unlink-before-copy ordering, and `runCli` symlink/junction tests.
  - **[DEF-03] [P1]** Guarded the live child-process readiness promise against premature `exit` and timeout, and guarded `finally` cleanup with `child.exitCode === null && child.signalCode === null`.
  - **[DEF-04] [P1]** Preserved original `unlinkErr` in `removePluginEntry` when `rmdirSync` fallback fails with `ENOTDIR` or `EINVAL`.
  - **[DEF-05] [P1]** Added `removeIfSymlinkOrMismatched`, `copyFileSafely`, and `ensureRealDirectoryPath` in `server/lib/cli.mjs` so pre-existing symlinks/junctions or mismatched entries at `REQUIRED_FILES`, `ui/`, `ui/dist/`, or `ui/dist/marketplace.html` are unlinked before copying.
  - **[DEF-06] [P1]** Passed `{ recursive: true, dereference: false }` explicitly on top-level `fsOps.cpSync` in `syncPluginDirectory`.
- **Pass 2 (`@team-auditor`):** `VERDICT: PASS` (0 defects remaining).

## Final QA & Packaging Verification Evidence
- **Automated Test Suite (`Logs/test-results-v1.0.3-final.log`):** `VERDICT: PASS` — `72/72` tests passed across `21` suites (`0` failed, `0` cancelled, `0` skipped, exit code `0`, `4558.77ms`).
- **Static Audit Gate (`Logs/audit-gate-v1.0.3-final.log`):** `GATE VERDICT: PASS` — `26/26` audited files passed with `0` violations detected (all source/test files `<= 500` lines).
- **UI Single-File Build (`Logs/build-ui-v1.0.3-final.log`):** `npm run build:ui` built `ui/dist/marketplace.html` (`343.97 kB` / `84.85 kB` gzip, `140` modules transformed, `0` warnings, exit code `0`).
- **Package Dry-Run (`Logs/pack-dry-run-v1.0.3-final.log`):** `npm pack --dry-run` verified `21` packaged files (`122.1 kB` tarball / `480.4 kB` unpacked), including `server/lib/cli-sync.mjs`, `server/lib/semver.mjs`, `sidecars/marketplace/*`, and `ui/dist/marketplace.html`.

## Recommended Next Steps
1. Reinstall locally (`npx --yes . install`) while Antigravity is running to confirm live in-place sidecar sync in the target desktop environment.
2. Commit and tag `v1.0.3` once final repository inspection is complete.
