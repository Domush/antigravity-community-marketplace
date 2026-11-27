# Summary: Antigravity Aux Pane Sidecar & Dual-Mode UI (v1.0.2)

**Date:** 2026-11-27  
**Repository:** `C:\GitHub\antigravity-community-marketplace`

## Created & Modified Files
- **Sidecar Manifest & Server:** `sidecars/marketplace/sidecar.json`, `sidecars/marketplace/server.mjs`, `sidecars/marketplace/http-helpers.mjs`
- **Shared Service & MCP Server:** `server/lib/service.mjs`, `server/index.mjs`, `server/tools-mutating.mjs`, `server/lib/cli.mjs`
- **Dual-Mode UI & Styling:** `ui/marketplace.html`, `ui/src/bridge.js`, `ui/src/main.js`, `ui/src/helpers.js`, `ui/src/styles.css`, `ui/src/sidebar.css`, and rebuilt `ui/dist/marketplace.html` (`321.47 kB`)
- **Packaging & Metadata:** `package.json`, `plugin.json`, `package-lock.json`, `CHANGELOG.md`
- **Tests:** `tests/sidecar-server.test.mjs`, `tests/cli-installer.test.mjs`

## Implemented Behavior (v1.0.2)
1. **Native Antigravity Aux Pane Sidecar (`sidecars/marketplace/`):**
   - Registers `"Community Plugins"` via `SIDECAR_UI_ENTRYPOINT_AUX_PANE` in `sidecar.json`.
   - Resolves `sidecar_sdk/index.mjs` from `~/.gemini/config/node_modules/sidecar_sdk/index.mjs` (failing fast if `ANTIGRAVITY_*` sidecar env vars are set without `sidecar_sdk`), serves `ui/dist/marketplace.html` with `<script src="/preload.js"></script>` injected before `</head>`, and exposes `GET /api/health` and `POST /api/tool` with `file://` `workspaceUris` resolution.
   - Standalone loopback HTTP fallback serves `/preload.js` as harmless JS and enforces same-origin `Origin` (`403`), `application/json` `Content-Type` (`415`), bounded JSON body parsing (`400`/`413`), and deterministic stream close settlement.
2. **Shared Marketplace Service (`server/lib/service.mjs`):**
   - Consolidates `TOOL_SCHEMAS`, `createMarketplaceService`, `createCatalogAndStore`, `loadClientVersion`, `parseServerArgs`, `loadTrustedPublicKeys`, and `summarizeStatus` as the single source of truth shared by `server/index.mjs`, `server/tools-mutating.mjs`, and `sidecars/marketplace/server.mjs`.
3. **Dual-Mode UI Bridge & Sidebar Responsive Polish (`ui/`):**
   - Auto-detects Sidecar/HTTP mode vs MCP App mode in `ui/src/bridge.js`, skipping `app.connect()` in Sidecar/HTTP mode, calling `POST /api/tool` via `window.sidecar.fetch` (or `fetch`), subscribing to `window.sidecar?.getWorkspaceUris?.()` / `onWorkspaceChange`, and validating `http:`/`https:` URLs in `openExternal`.
   - Added monotonic bootstrap sequence guarding and an inline project path editor in `ui/src/main.js` and `ui/marketplace.html`.
   - Cascaded Antigravity sidecar CSS theme variables in `ui/src/styles.css` and added compact `340px–520px` Aux Pane wrapping rules in `ui/src/sidebar.css`.
4. **CLI Installer & Release Packaging (`1.0.2`):**
   - Added `"sidecars"` and required sidecar file checks to `server/lib/cli.mjs` and `"sidecars/"` to `package.json`, bumped `package.json`, `plugin.json`, `package-lock.json`, and `ui/src/` to `1.0.2`, and updated `CHANGELOG.md`.
   - Verified with `npm run build:ui`, `node --test ./tests/*.test.mjs` (`46/46` passed, `Logs/test-results-v1.0.2.log`), `npm pack --dry-run` (`19` files), and `audit-gate.js` (`GATE VERDICT: PASS`).
