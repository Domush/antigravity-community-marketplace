# Plan: Safe `<img>` Tag & Markdown Table Support in README Renderer

**Date:** 2026-11-27

## Goal
Support safe HTML `<img>` tags, Markdown image rendering, and GFM pipe tables in `ui/src/markdown.js` so plugin READMEs (like Context Mode's screenshots, badges, and feature matrices) render accurately and safely inside the detail drawer.

## Implementation Steps
1. **`ui/src/markdown.js`:**
   - Add `sanitizeMarkdownImageUrl(rawUrl, opts)` allowing `https://` / `http://` URLs and resolving relative repo paths to `raw.githubusercontent.com/<owner>/<repo>/<sha>/<path>` (rejecting `javascript:`, `data:`, `vbscript:`, protocol-relative `//`, and unsafe characters).
   - Parse HTML `<img ...>` tags in `formatInline()` before HTML escaping using a strict attribute allowlist (`src`, `alt`, `title`, `width`, `height`), rejecting unsafe URLs and stripping all event handlers or arbitrary attributes.
   - Render Markdown `![alt](src)` and linked badges `[![alt](imgSrc)](href)` using `<img class="md-img" ...>` / `<img class="md-badge-img" ...>` when `src` passes `sanitizeMarkdownImageUrl`, falling back cleanly to text links if invalid.
   - Add GFM pipe table parsing in `renderMarkdown()` (header row + alignment delimiter row + body rows, handling escaped `\|` and backtick code spans containing `|`), emitting `<div class="md-table-wrap"><table class="md-table">...</table></div>`.
2. **`ui/src/drawer.css`:**
   - Style `.md-img`, `.md-badge-img`, `.md-table-wrap`, and `.md-table` cleanly for dark/light themes and narrow drawer widths.
3. **`server/index.mjs`:**
   - Add common GitHub README image origins (`https://github.com`, `https://user-images.githubusercontent.com`, `https://camo.githubusercontent.com`, `https://img.shields.io`) to the MCP App UI CSP `resourceDomains`.
4. **Tests, Build & Sync:**
   - Update `tests/markdown.test.mjs` with coverage for `<img ...>` tags, XSS attribute stripping, Markdown images/badges, and aligned GFM tables (including pipes inside inline code).
   - Update `CHANGELOG.md`, run `npm run build:ui`, `npm test`, and `node server/index.mjs install --global`.
