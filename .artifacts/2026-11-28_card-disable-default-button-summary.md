# Summary: Default Disable Split Button, Prominent Web Link & Release v1.0.8

**Date:** 2026-11-28  
**Topic:** `card-disable-default-button`

## Implemented & Changed Behavior

1. **Default `Disable` Split Button for Installed Plugins (`ui/src/card-actions.js`, `ui/src/render.js`, `ui/src/sidebar.css`):**
   - Extracted `buildCardActionModel()` and `renderSplitActionButton()` into `ui/src/card-actions.js` (252 lines).
   - Updated installed-plugin primary action precedence:
     - `Pending Restart` (disabled primary with active dropdown toggle) when a staged update is pending.
     - `Update ...` (`mp-btn-primary`) when an update is available.
     - `Disable` (`data-action="toggle"`, `data-enabled="true"`, `mp-split-btn-disable` + `mp-btn-disable`) when installed and enabled.
     - `Enable` (`data-action="toggle"`, `data-enabled="false"`) when installed and disabled.
   - Moved `Uninstall (Global)` / `Uninstall (Project)` into the split dropdown menu across all installed states.
   - Styled `.mp-split-btn-disable .mp-btn-disable` in `ui/src/sidebar.css` with a transparent dark orange/red background (`rgba(180, 62, 24, 0.24)`), warm border (`rgba(224, 96, 48, 0.48)`), readable theme-adaptive text, and hover state (`rgba(196, 70, 28, 0.36)`).
2. **Prominent Web Marketplace Preview Link (`README.md`):**
   - Added a first-class **Preview on the Web** callout near the top of `README.md` inviting visitors to browse the online catalog before installing the plugin.
3. **Tests, Changelog, UI Bundle & Local Sync (`tests/ui-card-actions.test.mjs`, `CHANGELOG.md`, `ui/dist/marketplace.html`):**
   - Updated `tests/ui-card-actions.test.mjs` for `Disable`/`Enable`/`Update`/`Pending Restart` split-button precedence, dropdown `Uninstall` placement, and dark orange/red modifier classes.
   - Updated `CHANGELOG.md` under `## [1.0.8] - 2026-11-28`.
   - Rebuilt `ui/dist/marketplace.html` (`421.60 kB`) and synced to `C:\Users\domus\.gemini\config\plugins\agy-community-marketplace`.

## Verification
- `npm run build:ui`: Passed (`dist/marketplace.html 421.60 kB`, `Logs/ui-build.log`).
- `npm test`: Passed `124/124` tests across `34` suites (`0` failed, `0` skipped, `Logs/test-results.log`).
- `audit-gate.js`: Passed on `ui/src/card-actions.js`, `ui/src/render.js`, `tests/ui-card-actions.test.mjs` (`0` violations, `Logs/audit-gate-ui.log`).
- `node server/index.mjs install --global`: Installed `v1.0.8` cleanly (`Logs/local-install.log`).
