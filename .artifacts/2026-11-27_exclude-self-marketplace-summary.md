# Implementation Summary: Exclude Self Marketplace Entry

**Date:** 2026-11-27  
**Repository:** `c:\GitHub\antigravity-community-marketplace`

## Created / Modified Files
- `server/lib/self-filter.mjs` (created): Added shared hardcoded self-marketplace predicate `isSelfMarketplacePlugin()` and `filterSelfFromCatalogIndex()` matching `domush/antigravity-community-marketplace`, `agy-community-marketplace`, and `antigravity-community-marketplace` across `id`, `slug`, `pluginName`, `name`, and `repoUrl`.
- `server/lib/service.mjs` (modified): Filtered catalog indexes in `getSummary()`, `getBootstrap()`, `checkUpdates()`, `getPluginDetail()`, `installPlugin()`, and `summarizeStatus()`, and excluded self from installed counts.
- `server/lib/scanner-local.mjs` (modified): Skipped the marketplace's own installation directory during `scanScopeDirectory()`.
- `ui/src/helpers.js` (modified): Filtered self out of `getFilteredPlugins()` across both catalog and local installed entries.
- `ui/dist/marketplace.html` (rebuilt): Rebuilt single-file UI bundle with updated filtering.
- `tests/self-filter.test.mjs` (created): Added unit tests covering `isSelfMarketplacePlugin`, `filterSelfFromCatalogIndex`, `createMarketplaceService`, `scanInstalledPlugins`, `summarizeStatus`, and `getFilteredPlugins`.
- `CHANGELOG.md` (modified): Documented the improvement under `[Unreleased]`.
- `.artifacts/2026-11-27_exclude-self-marketplace.md`, `.artifacts/2026-11-27_exclude-self-marketplace-summary.md` (created): Plan and summary artifacts.
