# Summary: Safe `<img>` Tag & Markdown Table Support in README Renderer

**Date:** 2026-11-27

## Implemented & Changed Behavior

1. **Safe HTML `<img>` & Markdown Image/Badge Rendering (`ui/src/markdown.js`)**
   - Added `sanitizeMarkdownImageUrl()` (supporting `https://` / `http://` URLs and resolving relative repository paths to `raw.githubusercontent.com/<owner>/<repo>/<sha>/...`).
   - Added `replaceHtmlImgTags()` and `renderSafeImg()` with a strict attribute allowlist (`src`, `alt`, `title`, `width`, `height`), stripping event handlers/arbitrary attributes and falling back to literal HTML-escaped text when `src` is unsafe or invalid.
   - Updated `replaceMarkdownLinksAndImages()` so standalone `![alt](src)` renders `<img class="md-img" ...>` and linked badges `[![alt](imgSrc)](href)` render `<img class="md-badge-img" ...>` inside the safe link element (with plain-text `alt` extraction via `extractPlainAlt()`).

2. **GFM Pipe Table Support (`ui/src/markdown.js`, `ui/src/drawer.css`)**
   - Added `splitTableRow()`, `parseTableAlignments()`, and `renderTable()` supporting header/separator/body rows, `:---` / `:---:` / `---:` column alignments, escaped `\|` pipes, and inline code spans containing `|`.
   - Added responsive styling in `ui/src/drawer.css` (`.md-img`, `.md-badge-img`, `.md-table-wrap`, `.md-table`).

3. **CSP & Tests (`server/index.mjs`, `tests/markdown.test.mjs`, `CHANGELOG.md`)**
   - Added GitHub README image origins (`https://github.com`, `https://user-images.githubusercontent.com`, `https://camo.githubusercontent.com`, `https://img.shields.io`) to the MCP App CSP `resourceDomains`.
   - Added and updated tests in `tests/markdown.test.mjs` covering `<img>` attribute sanitization, blocked schemes, Markdown images/badges, and aligned GFM tables.
   - Updated `CHANGELOG.md`, rebuilt `ui/dist/marketplace.html`, and synced to `C:\Users\domus\.gemini\config\plugins\agy-community-marketplace`.

## Files Created or Modified

- `.artifacts/2026-11-27_markdown-img-and-table-support.md` (created)
- `.artifacts/2026-11-27_markdown-img-and-table-support-summary.md` (created)
- `ui/src/markdown.js` (modified)
- `ui/src/drawer.css` (modified)
- `server/index.mjs` (modified)
- `tests/markdown.test.mjs` (modified)
- `CHANGELOG.md` (modified)
- `ui/dist/marketplace.html` (rebuilt)
- `Logs/test-results.log` (updated)

## Verification

- `npm run build:ui`: Passed (`dist/marketplace.html`, 365.00 kB).
- `node --test ./tests/*.test.mjs`: Passed 104/104 tests across 28 suites (0 failures, 0 skipped), logged to `Logs/test-results.log`.
- `node server/index.mjs install --global`: Installed cleanly into `C:\Users\domus\.gemini\config\plugins\agy-community-marketplace`.
