# Plan: Bundle `marked` CommonMark/GFM Parser with Strict Sanitization

**Date:** 2026-11-27

## Goal
Replace the custom line-by-line parser in `ui/src/markdown.js` with `marked` (installed as a `devDependency` and bundled into `ui/dist/marketplace.html` by Vite, keeping runtime dependencies at zero for `server/`), paired with strict URL/HTML sanitization and custom `linkMode` (`button` vs `anchor`) rendering.

## Implementation Steps
1. **Install `marked` as a `devDependency`:** `npm install --save-dev marked`.
2. **Rewrite `ui/src/markdown.js`:**
   - Configure a dedicated `Marked` instance (`gfm: true`, `breaks: false`) per `renderMarkdown` call (or pass options cleanly via custom renderer/walkTokens) with:
     - `link`: validates `href` via `sanitizeMarkdownUrl`, renders `<button class="md-link" data-open-url="...">` or `<a class="md-link" ...>`, and flattens nested interactive elements / images inside multi-part link labels safely.
     - `image`: validates `src` via `sanitizeMarkdownImageUrl` (mapping relative paths to `raw.githubusercontent.com`), renders `<img class="md-img" ...>` (or `.md-badge-img` when sole child of a link), and strips unsafe schemes.
     - `html`: parses allowed safe HTML tags (`<img ...>`, `<br>`, `<hr>`, `<details>`, `<summary>`, `<sup>`, `<sub>`, `<kbd>`, `<p>`, `<div>`, `<span>`, `<a>`, `<strong>`, `<b>`, `<em>`, `<i>`, `<del>`, `<code>`, `<pre>`, `<h1>`-`<h6>`, `<ul>`, `<ol>`, `<li>`, `<blockquote>`, `<table>`, `<thead>`, `<tbody>`, `<tr>`, `<th>`, `<td>`) with strict attribute allowlists and URL validation, while HTML-escaping disallowed tags (`<script>`, `<iframe>`, `<svg>`, `<style>`, etc.) and any invalid `<img>` tags as literal text.
     - `heading`, `code`, `blockquote`, `list`, `hr`, `table`, `codespan`: emit our existing `.md-h1`..`.md-h6`, `.md-pre`, `.md-quote`, `.md-list`, `.md-hr`, `.md-table-wrap`/`.md-table`, `.md-code` classes.
3. **Verify & Sync:**
   - Run `npm run build:ui`, `node --test ./tests/*.test.mjs`, and `node server/index.mjs install --global`.
   - Update `CHANGELOG.md` and save the summary artifact.
