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
  if (cleaned.startsWith("<") && cleaned.endsWith(">")) {
    cleaned = cleaned.slice(1, -1).trim();
  }
  if (!cleaned || cleaned.startsWith("#") || /[\s"'<>\\]/.test(cleaned)) {
    return null;
  }

  if (/^https?:\/\//i.test(cleaned)) {
    try {
      const parsed = new URL(cleaned);
      return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
    } catch {
      return null;
    }
  }

  if (cleaned.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(cleaned)) {
    return null;
  }

  const trimmedSha = typeof sha === "string" ? sha.trim() : "";
  if (repoUrl && trimmedSha && /^https:\/\/github\.com\//i.test(repoUrl)) {
    try {
      const base = `${repoUrl.replace(/\/+$/, "")}/blob/${encodeURIComponent(trimmedSha)}/`;
      const rel = cleaned.replace(/^\.?\/+/, "");
      const resolved = new URL(rel, base);
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
  if (linkMode === "button") {
    return `<button type="button" class="md-link" data-open-url="${hrefAttr}" title="${hrefAttr}">${labelHtml}</button>`;
  }
  return `<a class="md-link" href="${hrefAttr}" target="_blank" rel="noopener noreferrer">${labelHtml}</a>`;
}

function formatEmphasis(escapedText) {
  return escapedText
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/__(.+?)__/g, "<strong>$1</strong>")
    .replace(/(^|[^\w*])\*([^*\n]+?)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/~~(.+?)~~/g, "<del>$1</del>");
}

function formatInline(rawLine, opts) {
  const tokens = [];
  const stash = (html) => {
    const idx = tokens.push(html) - 1;
    return `\x00P${idx}\x00`;
  };
  const restore = (text) => text.replace(TOKEN_RE, (_m, i) => tokens[Number(i)]);

  let s = rawLine;

  // 1. Protect inline code spans first so Markdown/HTML inside `...` stays literal
  s = s.replace(/`([^`\n]+)`/g, (_m, code) => stash(`<code class="md-code">${esc(code)}</code>`));

  // 2. Linked badge images [![alt](img)](href) -> host-safe clickable link
  s = s.replace(
    /\[!\[([^\]]*)\]\((?:[^()\s]+|\([^()\s]*\))+\)\]\(((?:[^()\s]+|\([^()\s]*\))+)\)/g,
    (_m, alt, href) => {
      const safeHref = sanitizeMarkdownUrl(href, opts);
      const label = esc(alt.trim() || "Badge");
      return stash(renderLinkElement(label, safeHref, opts.linkMode));
    }
  );

  // 3. Standalone images ![alt](src) -> host-safe clickable link (avoids CSP-blocked images)
  s = s.replace(/!\[([^\]]*)\]\(((?:[^()\s]+|\([^()\s]*\))+)\)/g, (_m, alt, src) => {
    const safeHref = sanitizeMarkdownUrl(src, opts);
    const label = esc(alt.trim() || "View image");
    return stash(renderLinkElement(label, safeHref, opts.linkMode));
  });

  // 4. Standard links [label](href)
  s = s.replace(/\[([^\]]+)\]\(((?:[^()\s]+|\([^()\s]*\))+)\)/g, (_m, label, href) => {
    const safeHref = sanitizeMarkdownUrl(href, opts);
    const labelHtml = restore(formatEmphasis(esc(label)));
    return stash(renderLinkElement(labelHtml, safeHref, opts.linkMode));
  });

  // 5. Escape all remaining raw HTML before emphasis or bare URL auto-linking
  s = formatEmphasis(esc(s));

  // 6. Auto-link bare http(s):// URLs while preserving trailing punctuation and HTML entities
  s = s.replace(/https?:\/\/(?:[^\s<&]|&(?!(?:quot|#39|lt|gt);))+/g, (rawMatch) => {
    let url = rawMatch;
    let trailing = "";
    while (/[.,;:!?)]$/.test(url)) {
      if (url.endsWith(")") && (url.match(/\(/g) || []).length >= (url.match(/\)/g) || []).length) {
        break;
      }
      trailing = url.slice(-1) + trailing;
      url = url.slice(0, -1);
    }
    const decoded = url.replaceAll("&amp;", "&");
    const safeHref = sanitizeMarkdownUrl(decoded, opts);
    if (!safeHref) return rawMatch;
    return `${renderLinkElement(esc(decoded), safeHref, opts.linkMode)}${trailing}`;
  });

  // 7. Restore stashed inline code & link tokens
  return restore(s);
}

function renderCodeFence(lang, lines) {
  const langAttr = lang ? ` data-lang="${esc(lang)}"` : "";
  return `<pre class="md-pre"><code${langAttr}>${esc(lines.join("\n"))}</code></pre>`;
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
  const lines = input.split("\n");
  const out = [];

  let inFence = false;
  let fenceLang = "";
  let fenceLines = [];
  let listType = null;
  let listItems = [];
  let quoteLines = [];
  let paraLines = [];

  const flushPara = () => {
    if (paraLines.length === 0) return;
    out.push(`<p>${paraLines.map((l) => formatInline(l, opts)).join(" ")}</p>`);
    paraLines = [];
  };

  const flushList = () => {
    if (!listType || listItems.length === 0) return;
    const tag = listType;
    out.push(
      `<${tag} class="md-list">${listItems.map((item) => `<li>${formatInline(item, opts)}</li>`).join("")}</${tag}>`
    );
    listType = null;
    listItems = [];
  };

  const flushQuote = () => {
    if (quoteLines.length === 0) return;
    out.push(`<blockquote class="md-quote">${quoteLines.map((l) => formatInline(l, opts)).join("<br />")}</blockquote>`);
    quoteLines = [];
  };

  const flushBlocks = () => {
    flushPara();
    flushList();
    flushQuote();
  };

  for (const line of lines) {
    const fenceMatch = line.match(/^\s*(?:```|~~~)\s*([A-Za-z0-9_+-]*)\s*$/);
    if (fenceMatch) {
      if (inFence) {
        out.push(renderCodeFence(fenceLang, fenceLines));
        inFence = false;
        fenceLang = "";
        fenceLines = [];
      } else {
        flushBlocks();
        inFence = true;
        fenceLang = fenceMatch[1] || "";
        fenceLines = [];
      }
      continue;
    }

    if (inFence) {
      fenceLines.push(line);
      continue;
    }

    if (!line.trim()) {
      flushBlocks();
      continue;
    }

    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushBlocks();
      out.push('<hr class="md-hr" />');
      continue;
    }

    const headingMatch = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*$/);
    if (headingMatch) {
      flushBlocks();
      const level = Math.min(6, headingMatch[1].length);
      out.push(`<h${level} class="md-h${level}">${formatInline(headingMatch[2], opts)}</h${level}>`);
      continue;
    }

    const quoteMatch = line.match(/^\s*>\s?(.*)$/);
    if (quoteMatch) {
      flushPara();
      flushList();
      quoteLines.push(quoteMatch[1]);
      continue;
    }

    const ulMatch = line.match(/^\s*[-*+]\s+(.+)$/);
    if (ulMatch) {
      flushPara();
      flushQuote();
      if (listType && listType !== "ul") flushList();
      listType = "ul";
      listItems.push(ulMatch[1]);
      continue;
    }

    const olMatch = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (olMatch) {
      flushPara();
      flushQuote();
      if (listType && listType !== "ol") flushList();
      listType = "ol";
      listItems.push(olMatch[1]);
      continue;
    }

    flushList();
    flushQuote();
    paraLines.push(line.trim());
  }

  if (inFence) {
    out.push(renderCodeFence(fenceLang, fenceLines));
  }
  flushBlocks();

  return `<div class="md-body">${out.join("\n")}</div>`;
}
