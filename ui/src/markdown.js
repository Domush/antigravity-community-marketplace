import { esc } from "./helpers.js";

const TOKEN_RE = /\x00P(\d+)\x00/g;

/**
 * Validate and resolve a Markdown URL safely.
 * Allows http(s) URLs and optional relative repo links pinned to a GitHub commit SHA.
 * Rejects javascript:, data:, vbscript:, protocol-relative //, #-only, and unsafe characters.
 * @param {string} rawUrl
 * @param {{ repoUrl?: string, sha?: string }} [options]
 * @returns {string | null}
 */
export function sanitizeMarkdownUrl(rawUrl, { repoUrl = "", sha = "" } = {}) {
  let cleaned = String(rawUrl || "").replaceAll("\0", "").trim();
  if (cleaned.startsWith("<") && cleaned.endsWith(">")) cleaned = cleaned.slice(1, -1).trim();
  if (!cleaned || cleaned.startsWith("#") || /[\s"'<>\\]/.test(cleaned)) return null;

  if (/^https?:\/\//i.test(cleaned)) {
    try {
      const parsed = new URL(cleaned);
      return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
    } catch {
      return null;
    }
  }
  if (cleaned.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(cleaned)) return null;

  const trimmedSha = typeof sha === "string" ? sha.trim() : "";
  if (repoUrl && trimmedSha && /^https:\/\/github\.com\//i.test(repoUrl)) {
    try {
      let repoEnd = repoUrl.length;
      while (repoEnd > 0 && repoUrl[repoEnd - 1] === "/") repoEnd--;
      const base = `${repoUrl.slice(0, repoEnd)}/blob/${encodeURIComponent(trimmedSha)}/`;
      const resolved = new URL(cleaned.replace(/^\.?\/+/, ""), base);
      return resolved.origin === "https://github.com" ? resolved.href : null;
    } catch {
      return null;
    }
  }
  return null;
}

function renderLinkElement(labelHtml, safeHref, linkMode) {
  if (!safeHref) return labelHtml;
  const hrefAttr = esc(safeHref);
  return linkMode === "button"
    ? `<button type="button" class="md-link" data-open-url="${hrefAttr}" title="${hrefAttr}">${labelHtml}</button>`
    : `<a class="md-link" href="${hrefAttr}" target="_blank" rel="noopener noreferrer">${labelHtml}</a>`;
}

function replacePairedDelimiter(text, delim, openTag, closeTag) {
  let out = "";
  let pos = 0;
  const dLen = delim.length;
  while (pos < text.length) {
    const start = text.indexOf(delim, pos);
    let end = start === -1 ? -1 : text.indexOf(delim, start + dLen);
    if (end === -1) return out + text.slice(pos);
    if (end === start + dLen) {
      out += text.slice(pos, start + dLen);
      pos = start + dLen;
      continue;
    }
    if (delim === "**") while (end + dLen < text.length && text[end + dLen] === "*") end++;
    out += text.slice(pos, start) + openTag + text.slice(start + dLen, end) + closeTag;
    pos = end + dLen;
  }
  return out;
}

function formatEmphasis(escapedText) {
  let s = replacePairedDelimiter(escapedText, "**", "<strong>", "</strong>");
  s = replacePairedDelimiter(s, "__", "<strong>", "</strong>");
  s = s.replace(/(^|[^\w*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
  return replacePairedDelimiter(s, "~~", "<del>", "</del>");
}

function buildDelimiterMaps(line) {
  const n = line.length;
  const closeBracketOf = new Int32Array(n).fill(-1);
  const closeParenOf = new Int32Array(n).fill(-1);
  const bracketStack = [];
  const parenStack = [];
  for (let k = 0; k < n; k++) {
    const ch = line[k];
    if (ch === "[") bracketStack.push(k);
    else if (ch === "]" && bracketStack.length > 0) closeBracketOf[bracketStack.pop()] = k;
    else if (ch === "(") parenStack.push(k);
    else if (ch === ")") {
      if (parenStack.length > 0) closeParenOf[parenStack.pop()] = k;
    } else if (ch === " " || ch === "\t") parenStack.length = 0;
  }
  return { closeBracketOf, closeParenOf };
}

function matchBracketParen(line, openBracket, limit, closeBracketOf, closeParenOf) {
  const cb = closeBracketOf[openBracket];
  if (cb === -1 || cb >= limit || cb + 1 >= limit || line[cb + 1] !== "(") return null;
  const cp = closeParenOf[cb + 1];
  return cp !== -1 && cp < limit ? { cb, cp } : null;
}

function flattenLabelText(line, start, end, closeBracketOf, closeParenOf, stash, restore) {
  let out = "";
  for (let k = start; k < end; ) {
    const isImg = line[k] === "!" && k + 1 < end && line[k + 1] === "[";
    const bracketIdx = isImg ? k + 1 : line[k] === "[" ? k : -1;
    const m = bracketIdx !== -1 ? matchBracketParen(line, bracketIdx, end, closeBracketOf, closeParenOf) : null;
    if (m && (isImg || m.cb > bracketIdx + 1)) {
      const inner = line.slice(bracketIdx + 1, m.cb);
      out += stash(isImg ? restore(esc(inner.trim() || "View image")) : restore(formatEmphasis(esc(inner))));
      k = m.cp + 1;
    } else out += line[k++];
  }
  return out;
}

/**
 * Replace Markdown images, linked badges, and links in linear O(N) time without nested regex quantifiers.
 * @param {string} line
 * @param {(html: string) => string} stash
 * @param {{ linkMode?: "anchor" | "button", repoUrl?: string, sha?: string }} opts
 * @param {(text: string) => string} [restore]
 * @returns {string}
 */
export function replaceMarkdownLinksAndImages(line, stash, opts, restore = (t) => t) {
  if (!line || !line.includes("[")) return line;
  const { closeBracketOf, closeParenOf } = buildDelimiterMaps(line);
  const n = line.length;
  let out = "";

  for (let i = 0; i < n; ) {
    const isImg = line[i] === "!" && i + 1 < n && line[i + 1] === "[";
    const bracketIdx = isImg ? i + 1 : line[i] === "[" ? i : -1;
    const m = bracketIdx !== -1 ? matchBracketParen(line, bracketIdx, n, closeBracketOf, closeParenOf) : null;
    if (m && (isImg || m.cb > bracketIdx + 1)) {
      const safeHref = sanitizeMarkdownUrl(line.slice(m.cb + 2, m.cp), opts);
      if (isImg) {
        const label = restore(esc(line.slice(i + 2, m.cb).trim() || "View image"));
        out += stash(renderLinkElement(label, safeHref, opts.linkMode));
      } else {
        const img = i + 2 < m.cb && line[i + 1] === "!" && line[i + 2] === "["
          ? matchBracketParen(line, i + 2, m.cb, closeBracketOf, closeParenOf) : null;
        if (img && img.cp === m.cb - 1) {
          const label = restore(esc(line.slice(i + 3, img.cb).trim() || "Badge"));
          out += stash(renderLinkElement(label, safeHref, opts.linkMode));
        } else {
          const rawLabel = line.slice(i + 1, m.cb);
          const flat = rawLabel.includes("[")
            ? flattenLabelText(line, i + 1, m.cb, closeBracketOf, closeParenOf, stash, restore)
            : rawLabel;
          out += stash(renderLinkElement(restore(formatEmphasis(esc(flat))), safeHref, opts.linkMode));
        }
      }
      i = m.cp + 1;
    } else out += line[i++];
  }
  return out;
}

function trimTrailingUrlPunctuation(rawMatch) {
  let openParens = 0;
  let closeParens = 0;
  for (let i = 0; i < rawMatch.length; i++) {
    if (rawMatch[i] === "(") openParens++;
    else if (rawMatch[i] === ")") closeParens++;
  }
  let end = rawMatch.length;
  while (end > 0) {
    const ch = rawMatch[end - 1];
    if (ch === ")") {
      if (openParens >= closeParens) break;
      closeParens--;
      end--;
    } else if (".,;:!?".includes(ch)) end--;
    else break;
  }
  return { url: rawMatch.slice(0, end), trailing: rawMatch.slice(end) };
}

function formatInline(rawLine, opts) {
  const tokens = [];
  const stash = (html) => `\x00P${tokens.push(html) - 1}\x00`;
  const restore = (text) => text.replace(TOKEN_RE, (_m, i) => tokens[Number(i)]);

  let s = rawLine.replace(/`([^`\n]+)`/g, (_m, code) => stash(`<code class="md-code">${esc(code)}</code>`));
  s = replaceMarkdownLinksAndImages(s, stash, opts, restore);
  s = formatEmphasis(esc(s));
  s = s.replace(/https?:\/\/(?:[^\s<&]|&(?!(?:quot|#39|lt|gt);))+/g, (rawMatch) => {
    const { url, trailing } = trimTrailingUrlPunctuation(rawMatch);
    const decoded = url.replaceAll("&amp;", "&");
    const safeHref = sanitizeMarkdownUrl(decoded, opts);
    return safeHref ? `${renderLinkElement(esc(decoded), safeHref, opts.linkMode)}${trailing}` : rawMatch;
  });
  return restore(s);
}

function stripTrailingHeadingHashes(rawHeading) {
  let end = rawHeading.length;
  while (end > 0 && /\s/.test(rawHeading[end - 1])) end--;
  while (end > 0 && rawHeading[end - 1] === "#") end--;
  while (end > 0 && /\s/.test(rawHeading[end - 1])) end--;
  return end > 0 ? rawHeading.slice(0, end) : rawHeading.trim();
}

function renderCodeFence(lang, lines) {
  return `<pre class="md-pre"><code${lang ? ` data-lang="${esc(lang)}"` : ""}>${esc(lines.join("\n"))}</code></pre>`;
}

/**
 * Render untrusted Markdown safely to HTML with zero external dependencies.
 * @param {string} markdown
 * @param {{ linkMode?: "anchor" | "button", repoUrl?: string, sha?: string }} [options]
 * @returns {string}
 */
export function renderMarkdown(markdown, { linkMode = "anchor", repoUrl = "", sha = "" } = {}) {
  if (linkMode !== "anchor" && linkMode !== "button") {
    throw new TypeError(`Invalid renderMarkdown linkMode: "${String(linkMode)}". Expected "anchor" or "button".`);
  }
  const input = String(markdown || "").replaceAll("\0", "").replace(/\r\n?/g, "\n");
  if (!input.trim()) return "";

  const opts = { linkMode, repoUrl, sha };
  const out = [];
  let inFence = false, fenceLang = "", fenceLines = [];
  let listType = null, listItems = [], quoteLines = [], paraLines = [];

  const flushPara = () => {
    if (!paraLines.length) return;
    out.push(`<p>${paraLines.map((l) => formatInline(l, opts)).join(" ")}</p>`);
    paraLines = [];
  };
  const flushList = () => {
    if (!listType || !listItems.length) return;
    out.push(`<${listType} class="md-list">${listItems.map((item) => `<li>${formatInline(item, opts)}</li>`).join("")}</${listType}>`);
    listType = null; listItems = [];
  };
  const flushQuote = () => {
    if (!quoteLines.length) return;
    out.push(`<blockquote class="md-quote">${quoteLines.map((l) => formatInline(l, opts)).join("<br />")}</blockquote>`);
    quoteLines = [];
  };
  const flushBlocks = () => { flushPara(); flushList(); flushQuote(); };
  const pushList = (type, item) => {
    flushPara(); flushQuote();
    if (listType && listType !== type) flushList();
    listType = type; listItems.push(item);
  };

  for (const line of input.split("\n")) {
    const trimmedLine = line.trim();
    const fenceMatch = trimmedLine.match(/^(?:```|~~~)\s*([A-Za-z0-9_+-]*)$/);
    if (fenceMatch) {
      if (inFence) { out.push(renderCodeFence(fenceLang, fenceLines)); inFence = false; fenceLang = ""; fenceLines = []; }
      else { flushBlocks(); inFence = true; fenceLang = fenceMatch[1] || ""; fenceLines = []; }
      continue;
    }
    if (inFence) { fenceLines.push(line); continue; }
    if (!trimmedLine) { flushBlocks(); continue; }
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmedLine)) { flushBlocks(); out.push('<hr class="md-hr" />'); continue; }

    const headingMatch = line.match(/^\s*(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      flushBlocks();
      const level = Math.min(6, headingMatch[1].length);
      out.push(`<h${level} class="md-h${level}">${formatInline(stripTrailingHeadingHashes(headingMatch[2]), opts)}</h${level}>`);
      continue;
    }
    const quoteMatch = line.match(/^\s*>\s?(.*)$/);
    if (quoteMatch) { flushPara(); flushList(); quoteLines.push(quoteMatch[1]); continue; }
    const ulMatch = line.match(/^\s*[-*+]\s+(.+)$/);
    if (ulMatch) { pushList("ul", ulMatch[1]); continue; }
    const olMatch = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (olMatch) { pushList("ol", olMatch[1]); continue; }

    flushList(); flushQuote();
    paraLines.push(line.trim());
  }

  if (inFence) out.push(renderCodeFence(fenceLang, fenceLines));
  flushBlocks();
  return `<div class="md-body">${out.join("\n")}</div>`;
}
