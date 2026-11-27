# Plan: Card Action Split Button, Prominent Details, and Header Icons

**Date:** 2026-11-27  
**Repository:** `c:\GitHub\antigravity-community-marketplace`

## Goal
Streamline plugin card controls by combining install/disable/uninstall actions into a single contextual split button with a dropdown, making the `Details` button more prominent while removing the separate `Audit ->` button, replacing `Hide` with an eye icon, and enlarging the favorite star positioned to the right of the eye icon.

## Implementation Steps
1. **State & Testable Card Action Helper (`ui/src/helpers.js` / `ui/src/render.js`)**
   - Add `openActionMenuId: null` to `state` in `ui/src/helpers.js`.
   - Build a clean pure helper `buildCardActionModel(plugin, installs, isBusy)` (exported for unit testing) that computes:
     - Optional `primaryAction` (`Adopt & Update` / `Update` / `Downgrade` CTA when applicable).
     - `splitMain`: contextual primary action (`Install` globally when not installed; `Uninstall` targeting global or project install when installed).
     - `dropdownItems`: always includes `Install in Project` (for registry plugins), plus `Install (Global)` when only project-installed, `Disable/Enable (Global)` / `Disable/Enable (Project)` when installed in those scopes, and `Uninstall from Project` when installed in project scope.
2. **Card Header & Footer Markup (`ui/src/render.js`)**
   - In `.mp-card-quick`: render the eye/eye-off SVG button (`Hide`/`Unhide`) on the left, and the larger favorite star button (`&#9733;` / `&#9734;`) to the right of the eye icon.
   - In `.mp-card-footer`: render the split button + dropdown menu, keep any `primaryAction` update/adopt CTA, remove the `Audit ->` button, and upgrade `Details` to a prominent bordered `.mp-btn.mp-btn-details` button.
3. **Dropdown Interaction & Styling (`ui/src/main.js`, `ui/src/sidebar.css`)**
   - Wire `[data-toggle-menu]` click, outside click dismissal, and `Escape` dismissal for the split-button dropdown.
   - Style `.mp-split-btn`, `.mp-split-main`, `.mp-split-toggle`, `.mp-split-menu`, `.mp-split-item`, `.mp-btn-details`, `.mp-eye-btn`, and `.mp-fav-btn` (enlarged star) in `ui/src/sidebar.css`.
4. **Documentation & Tests**
   - Update `CHANGELOG.md` under `[Unreleased]`.
   - Add unit tests in `tests/ui-card-actions.test.mjs` verifying contextual main button labels, dropdown contents across install states, header icon order, prominent `Details` button, and removal of `Audit ->`.

## Verification Strategy
- Run `npm run build:ui`, `npm test`, and `audit-gate.js`, saving logs to `Logs/`.
