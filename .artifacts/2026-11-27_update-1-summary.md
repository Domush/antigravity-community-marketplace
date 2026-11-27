# Summary: Community Marketplace Update 1 (v1.0.3)

**Date:** 2026-11-27  
**Repository:** `C:\GitHub\antigravity-community-marketplace`

## Created & Modified Files
- **Server & CLI:**
  - Created: `server/lib/cli-sync.mjs` (220 lines), `server/lib/semver.mjs` (73 lines)
  - Modified: `server/index.mjs`, `server/lib/cli.mjs` (438 lines), `server/lib/scanner-local.mjs`, `server/lib/service.mjs`
- **Sidecar:**
  - Modified: `sidecars/marketplace/server.mjs` (client version `1.0.3`)
- **UI & Markdown Renderer:**
  - Created: `ui/src/markdown.js` (267 lines), `ui/src/security-meta.js` (126 lines)
  - Modified: `ui/marketplace.html`, `ui/src/bridge.js`, `ui/src/drawer.css`, `ui/src/drawer.js`, `ui/src/helpers.js`, `ui/src/main.js`, `ui/src/render.js`, `ui/src/sidebar.css`, `ui/src/styles.css`, and rebuilt `ui/dist/marketplace.html` (`343.97 kB` / `84.85 kB` gzip)
- **Packaging & Documentation:**
  - Modified: `package.json`, `package-lock.json`, `plugin.json`, `README.md`, `CHANGELOG.md`
- **Tests:**
  - Created: `tests/cli-sync.test.mjs` (310 lines), `tests/markdown.test.mjs`, `tests/ui-version-direction.test.mjs`
  - Modified: `tests/client-installer.test.mjs`

## Implemented Behavior (v1.0.3)
1. **Semantic Version Direction & Downgrade Protection (`server/lib/semver.mjs`, `server/lib/service.mjs`, `ui/src/helpers.js`, `ui/src/render.js`, `ui/src/drawer.js`):**
   - Compares full `major.minor.patch` and prerelease tags via `parseSemver` / `compareSemver` on both server (`summarizeStatus`) and UI (`evaluateInstallVersionState`, `getInstallActionMeta`).
   - Prevents locally ahead installs from inflating update counts or showing misleading update badges, and adds explicit version comparison + downgrade confirmation in the Security Audit Drawer when adopting an older catalog release.
2. **Sidebar UX, Collapsible Filters, Icons & Security Context (`ui/marketplace.html`, `ui/src/main.js`, `ui/src/render.js`, `ui/src/drawer.js`, `ui/src/security-meta.js`, `ui/` CSS):**
   - Moves category, surface, risk, credential, and sort controls into a collapsible filter drawer (`#filter-drawer`) with active filter badge and reset control so plugin cards stay visible above the fold.
   - Displays validated plugin and author icons with two-letter monogram fallbacks, dedicated Details and Audit card buttons, expandable descriptions, and hover tooltips.
   - Enriches security capability badges and scan findings via `ui/src/security-meta.js` (including plain-language metadata for `accesses_gemini_dir`).
   - Updates `server/index.mjs` MCP App CSP `resourceDomains` to permit `https://raw.githubusercontent.com` alongside `https://avatars.githubusercontent.com`.
3. **XSS-Safe Markdown Renderer (`ui/src/markdown.js`):**
   - Renders plugin README and documentation previews safely by escaping HTML, stripping null bytes, blocking unsafe URL schemes, pinning relative repository links to commit SHAs, degrading images/badges to host-safe links without `<img>` tags, and supporting `button` and `anchor` link modes.
4. **Focused Live Collision Detection (`server/lib/scanner-local.mjs`, `README.md`):**
   - Removes noisy shared lifecycle `hookEvents` collision warnings while keeping `/slash` command, MCP server, and custom agent conflict detection.
5. **Resilient Live Reinstall Directory Sync (`server/lib/cli-sync.mjs`, `server/lib/cli.mjs`):**
   - Adds `syncPluginDirectory(srcDir, destDir)` for `REQUIRED_DIRS`, falling back from clean replacement to symlink-safe recursive in-place overwrite and stale-entry pruning when Windows holds an active `EPERM`/`EBUSY` directory handle/CWD lock (such as a running sidecar under `sidecars/marketplace/`).
   - Unlinks pre-existing symlinks/junctions or mismatched entries before copying `REQUIRED_FILES` and `ui/dist/marketplace.html`.
6. **Release & Verification (`1.0.3`):**
   - Bumped version metadata to `1.0.3` in `package.json`, `package-lock.json`, `plugin.json`, `sidecars/marketplace/server.mjs`, `ui/src/bridge.js`, and `CHANGELOG.md`.
   - Verified with `npm run build:ui` (`343.97 kB`), `node --test ./tests/*.test.mjs --bail` (`72/72` passed across `21` suites in `Logs/test-results-v1.0.3-final.log`), `npm pack --dry-run` (`21` files in `Logs/pack-dry-run-v1.0.3-final.log`), and `audit-gate.js` (`26/26` PASS in `Logs/audit-gate-v1.0.3-final.log`).
