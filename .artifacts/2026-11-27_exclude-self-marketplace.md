# Plan: Exclude Self Marketplace Entry from Catalog and Installed Listings

**Date:** 2026-11-27  
**Repository:** `c:\GitHub\antigravity-community-marketplace`

## Goal
Prevent the Community Plugin Marketplace from listing itself (`Domush/antigravity-community-marketplace` / `agy-community-marketplace`) in the browsable catalog, category dropdown, installed plugin counts, or installed plugin cards (since the marketplace manages self-updates via its dedicated top-level update banner and CLI).

## Implementation Steps
1. **Define a shared pure self-marketplace matcher** in `server/lib/self-filter.mjs` (browser- and Node-safe, zero Node built-ins so both `server/` and Vite-bundled `ui/` can import it directly without duplicating logic):
   - Hardcode `SELF_MARKETPLACE_REPO_ID = "domush/antigravity-community-marketplace"` and `SELF_MARKETPLACE_PLUGIN_NAME = "agy-community-marketplace"` (plus legacy slug `"antigravity-community-marketplace"`).
   - Export `isSelfMarketplacePlugin(entry)` checking `id`, `pluginName`, `name`, `slug`, and `repoUrl` case-insensitively.
   - Export `filterSelfFromCatalogIndex(index)` returning a shallow copy of `index` with `plugins` filtered by `!isSelfMarketplacePlugin(p)`.
2. **Apply in `server/lib/service.mjs`**:
   - Filter the registry `index` via `filterSelfFromCatalogIndex(index)` in `getSummary()`, `getBootstrap()`, and `checkUpdates()` so `total`, `Loaded N plugins.`, and the catalog delivered to the UI never include the marketplace itself.
   - Reject `getPluginDetail` / `installPlugin` attempts targeting the self-marketplace ID cleanly (`Plugin not found in registry index` or explicit error) — filtering `index` before lookup handles this uniformly.
3. **Apply in `server/lib/scanner-local.mjs`**:
   - Exclude the marketplace's own local installation directory (`isSelfMarketplacePlugin(record)` / manifest name `agy-community-marketplace` or `antigravity-community-marketplace`) from `scanInstalledPlugins()` results so it is not counted in `installed` or shown as an unmanaged manual plugin in the `Installed` tab.
4. **Apply in `ui/src/helpers.js`**:
   - Filter out `isSelfMarketplacePlugin(p)` in `getFilteredPlugins()` (covers both `state.catalog.plugins` and `state.installed` even if cached or injected directly in UI state/tests).
5. **Tests**:
   - Add unit tests in `tests/self-filter.test.mjs` covering `isSelfMarketplacePlugin`, `filterSelfFromCatalogIndex`, `createMarketplaceService` (`getBootstrap`, `getSummary`, `checkUpdates`), `scanInstalledPlugins`, and `getFilteredPlugins`.

## Edge Cases
- Case-insensitive matching on `Domush/antigravity-community-marketplace`, `agy-community-marketplace`, and `antigravity-community-marketplace`.
- Do NOT filter unrelated plugins whose names merely contain `"marketplace"`.
- Ensure `getSelfUpdateInfo()` (which reads `index.marketplaceClient`, not `index.plugins`) continues to work unaffected.

## Verification Strategy
- Run `npm run build:ui`, `npm test`, and `audit-gate.js` on all modified/created files, saving logs to `Logs/`.
