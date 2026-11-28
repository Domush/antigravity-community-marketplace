# Summary: Bundle `marked` CommonMark/GFM Parser with Strict Sanitization

**Date:** 2026-11-27

## Implemented & Changed Behavior

1. **Bundled `marked` Parser (`package.json`, `ui/src/markdown.js`)**
   - Installed `marked` (`^18.3.0`) as a `devDependency` in `package.json` (bundled into `ui/dist/marketplace.html` by Vite; zero new runtime dependencies for `server/`).
   - Replaced the custom line parser in `ui/src/markdown.js` with `Marked({ gfm: true, breaks: false })` and a custom renderer supporting full CommonMark + GFM (headings, blockquotes, nested & task lists, fenced code, inline code, tables with column alignments, `<img>` tags, Markdown images/badges, and links).
   - Preserved strict URL sanitization (`sanitizeMarkdownUrl`, `sanitizeMarkdownImageUrl`), strict HTML tag/attribute allowlisting (`sanitizeHtmlToken`), `linkMode` (`button` vs `anchor`), and safe flattening for nested link/image labels.

2. **Tests, Build, Changelog & Sync**
   - Updated `tests/markdown.test.mjs` for CommonMark/GFM output and verified XSS blocking, ReDoS bounds, `<img>` tags, badges, and tables.
   - Updated `CHANGELOG.md` under `[Unreleased]`.
   - Rebuilt `ui/dist/marketplace.html` (`420.19 kB`) and synced to `C:\Users\domus\.gemini\config\plugins\agy-community-marketplace`.

## Files Created or Modified

- `.artifacts/2026-11-27_marked-gfm-markdown-parser.md` (created)
- `.artifacts/2026-11-27_marked-gfm-markdown-parser-summary.md` (created)
- `package.json` / `package-lock.json` (modified — `marked` devDependency)
- `ui/src/markdown.js` (rewritten using `marked`)
- `ui/dist/marketplace.html` (rebuilt)
- `tests/markdown.test.mjs` (updated)
- `CHANGELOG.md` (modified)
- `Logs/test-results.log` (updated)

## Verification

- `npm run build:ui`: Passed (`dist/marketplace.html`, 420.19 kB).
- `node --test ./tests/*.test.mjs`: Passed 104/104 tests across 28 suites (0 failures, 0 skipped), logged to `Logs/test-results.log`.
- `node server/index.mjs install --global`: Installed cleanly into `C:\Users\domus\.gemini\config\plugins\agy-community-marketplace`.
