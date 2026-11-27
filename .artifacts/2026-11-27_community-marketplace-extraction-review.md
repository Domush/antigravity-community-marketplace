# Review: Antigravity Community Marketplace Extraction, Configuration, CLI & QA

**Date:** 2026-11-27  
**Repository:** `C:\GitHub\antigravity-community-marketplace`  
**Audit & QA Results:** Code + Audit (`VERDICT: PASS`) -> Config (`Domush` + Ed25519 `39619f51b6d74dfa`) + Audit (`VERDICT: PASS`) -> Stream Fix + Audit (`VERDICT: PASS`) -> npm Publish Setup + Audit (`VERDICT: PASS`) -> `npx` CLI + Audit (`VERDICT: PASS`) -> Final QA (`VERDICT: PASS`)

## Key Findings Resolved
1. **Self-Contained Client & Key Configuration:** Added `--public-key-file` and `--insecure-skip-verify` CLI flags in `server/index.mjs`, wired `Domush` registry/repo URLs and Ed25519 key `39619f51b6d74dfa`, and isolated all signing/catalog tests.
2. **Runtime & Installer Hardening:** Wrapped `open_marketplace` in `try/catch`; deduplicated `lockfile.json` by `(slug, scope)` in `server/lib/store.mjs`; aligned `.antigravity-plugin/plugin.json` precedence in `server/lib/scanner-local.mjs`; added 60s `AbortController` fetch timeout and `stream.destroy(err)` error propagation in `server/lib/installer.mjs`.
3. **UI Drawer Safety:** Disabled drawer opening on `isManualOnly` cards in `ui/src/render.js` and added close-button header to the `!summary` drawer fallback in `ui/src/drawer.js`.
4. **npm Publishing & `npx` Installer CLI (`antigravity-community-marketplace`):** Configured `package.json`, `package-lock.json`, `.npmignore`, `LICENSE`, `CHANGELOG.md`, `.github/workflows/publish.yml` (OIDC Trusted Publishing), `server/lib/cli.mjs` (`install`, `uninstall`, `--global`, `--workspace`, MCP passthrough), updated `README.md`, and added `tests/cli-installer.test.mjs`.

## Verification Evidence
- **Static Audit Gate (`audit-gate.js`):** `PASS` across all files (0 violations, all `<= 500` lines).
- **UI Single-File Build (`npm run build:ui` -> `Logs/build-ui.log`):** Built `ui/dist/marketplace.html` (`316.45 kB`, 0 warnings, exit code `0`).
- **Automated Tests (`npm test` -> `Logs/test-results.log`):** `39/39` passed across `15` suites (`0` failed, `0` skipped, `0` warnings, exit code `0`).
- **Package Dry-Run (`npm pack --dry-run --ignore-scripts` -> `Logs/pack-dry-run.log`):** Verified `15` packaged files (`104.6 kB` packed / `418.4 kB` unpacked), including `ui/dist/marketplace.html` and `server/lib/cli.mjs`.
- **Local `npx` Install (`npx --yes . install`):** Installed to `C:\Users\domus\.gemini\config\plugins\agy-community-marketplace`.
