# Plan: Antigravity Community Marketplace Client Extraction & Implementation

**Date:** 2026-11-27  
**Repository:** `C:\GitHub\antigravity-community-marketplace`  
**Pipeline Scope:** Code + Adversarial Audit (`@team-coder` -> `@team-auditor`)

## Goal
Extract and implement the complete `agy-community-marketplace` Antigravity App plugin (manifest, MCP config, local stdio MCP server, Ed25519 catalog verifier, verified tarball installer with Enable/Disable & legacy migration, OS pre-flight checker, 3-tier local plugin scanner, single-file Vite sidebar UI, README, and offline fixture test suites) specified in `community marketplace v1.pdf` (with all incremental updates applied).

## Implementation Phases

### Phase 1: Plugin Manifests, Package & Documentation
- `plugin.json`: Strict Antigravity v1 plugin manifest.
- `mcp_config.json`: Local stdio MCP server config using `${PLUGIN_ROOT}` and `${PLUGIN_DATA}`.
- `package.json`: Dependencies (`@modelcontextprotocol/ext-apps`, `@modelcontextprotocol/sdk`, `tar-stream`, `zod`) and devDependencies (`vite`, `vite-plugin-singlefile`), scripts (`build:ui`, `test`).
- `README.md`: End-user installation, security guarantees, permission diffs, and troubleshooting guide.

### Phase 2: Local Stdio MCP Server & Security Libraries
- `server/lib/store.mjs`: Atomic `${PLUGIN_DATA}` storage (`prefs.json`, `lockfile.json`, `cache/`) with per-file write queues and `updateInstallEnabled()`.
- `server/lib/catalog.mjs`: ETag-cached `RegistryCatalog` with fail-closed Ed25519 signature verification, anti-rollback watermarks, CDN desync retry, and transitive `detailSha256` verification.
- `server/lib/installer.mjs`: Zip-slip & bomb-hardened tarball extraction, deterministic `contentTreeSha256` (with `excludeDotGit`), denylist blocking, `moveDirAtomic` (with EXDEV fallback), non-destructive `setPluginEnabled` (`plugins-disabled/`), and atomic `replaceSlug` legacy folder migration with rollback.
- `server/lib/preflight.mjs`: Zero-subprocess `findBinaryOnPath` (POSIX + Windows `PATHEXT`) and `runPreflightChecks` for missing runtimes and cross-OS hook mismatches.
- `server/lib/scanner-local.mjs`: `parseGitHubRepoId`, `parseFrontmatter`, runtime-namespaced MCP keys (`<pluginName>_<serverKey>`), nested `hooks.json` group parsing, `SKILL.md` & `agents/*.md` parsing, 3-tier manual plugin reconciliation (`exact_hash`, `repo_origin`, `name_suggestion`), and `detectLiveCollisions` (excluding self and disabled plugins).
- `server/index.mjs`: Stdio MCP server exposing `ui://marketplace/app.html`, `open_marketplace`, and all app-only (`visibility: ["app"]`) tools (`mp_get_bootstrap`, `mp_check_updates`, `mp_get_plugin_detail`, `mp_install_plugin`, `mp_toggle_plugin`, `mp_uninstall_plugin`, `mp_update_prefs`).

### Phase 3: Single-File Sidebar UI
- `ui/vite.config.js` and `ui/marketplace.html`.
- `ui/src/styles.css`: MCP Apps host CSS variables with `light-dark()` fallbacks and alert/disabled styles.
- `ui/src/main.js` (modularized under `ui/src/` e.g. `helpers.js`, `render.js`, `drawer.js` to stay strictly <= 500 lines per file): Host theme/font integration, search/filter/sort/tabs, self-update banner, Enable/Disable toggle, 3-tier adoption/migration UI, OS pre-flight warnings, permission escalation diffs, and HTML escaping via `esc()`.

### Phase 4: Offline Fixture Tests (Extracted from PDF)
- `tests/client-installer.test.mjs` (updated with namespaced MCP keys, named `hooks.json` groups, `agents/*.md`, and frontmatter skill names).
- `tests/preflight-and-toggle.test.mjs` (updated with namespaced `unity-helper_unity-mcp`).
- `tests/signing-and-catalog.test.mjs` (resolving `sign-registry.mjs` cleanly across the sibling `antigravity-plugin-registry` repo).
- `tests/adoption-and-migration.test.mjs`.

## Edge Cases & Guardrails
- Enforce <= 500-line ceiling on every source and test file (`audit-gate.js`).
- Zero stubs, zero `TODO`/`FIXME` markers, zero `.skip`/`.only` in tests.
- All diagnostic logs in `server/` must write to `stderr` (`console.error`), keeping `stdout` strictly for JSON-RPC.

## Verification Strategy
- Run `node "C:\Users\domus\.gemini\config\plugins\agent-team\scripts\audit-gate.js"` on all created files.
- Perform full line-1-to-EOF adversarial audit via `@team-auditor`.
