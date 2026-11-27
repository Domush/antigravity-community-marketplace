# Plan: UI Polish, Marketplace Icon, and Label Updates

**Date:** 2026-11-27  
**Repository:** `c:\GitHub\antigravity-community-marketplace`

## Goal
Refine the sidebar and card UI by simplifying `Adopt & Update` to `Update`, giving `Install` and `Details` 90%-opaque brighter button backgrounds, vertically aligning the enlarged favorite star SVG with the eye icon, hiding the `Project` selector pill for now, enlarging card plugin titles, adding `icon.svg` and displaying it in the upper-left header, and enhancing the `Community Plugins` sidebar title.

## Implementation Steps
1. **Marketplace Icon (`icon.svg`, `package.json`, `plugin.json`)**
   - Create root `icon.svg` (32×32 vector icon for Antigravity Community Marketplace).
   - Reference `"icon": "icon.svg"` in `plugin.json` and include `"icon.svg"` in `package.json` `"files"`.
2. **Header Branding & Hidden Project Pill (`ui/marketplace.html`, `ui/src/styles.css`)**
   - Add `<img class="mp-brand-icon" src="../icon.svg" ...>` in the upper left of `.mp-title-group` and style `.mp-brand-title` (`Community Plugins`) with refined typography and gradient accent.
   - Add `hidden` attribute to `#project-pill` so it stays cleanly hidden without removing project-root logic.
3. **Update Label, Button Colors, Card Title, and Star Alignment (`ui/src/helpers.js`, `ui/src/render.js`, `ui/src/styles.css`, `ui/src/sidebar.css`)**
   - Change `getInstallActionMeta` upgrade prefix from `"Adopt & Update"` to `"Update"`.
   - Give `.mp-btn-install` and `.mp-btn-details` bright 90%-background styles (`.mp-btn-install` using 90% `--mp-accent`, `.mp-btn-details` using 90% bright indigo `#6366f1`).
   - Replace the Unicode star in `.mp-fav-btn` with a crisp `20×20` inline SVG star aligned slightly higher with the eye icon.
   - Increase `.mp-card-name` font size to `15.5px`.
4. **Tests, Documentation & Preview Install**
   - Update `tests/ui-version-direction.test.mjs` and `tests/ui-card-actions.test.mjs` for `"Update ..."` and SVG star/install styling assertions.
   - Update `CHANGELOG.md` under `[Unreleased]`.
   - Rebuild UI (`npm run build:ui`), run `npm test` and `audit-gate.js`, and install locally via `node server/index.mjs install`.
