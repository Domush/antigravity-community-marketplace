import { Marked } from "marked";
import { esc } from "./helpers.js";

const SAFE_CONTAINER_TAGS = new Set([
  "p", "div", "span", "strong", "b", "em", "i", "del", "s", "code", "pre",
  "kbd", "sup", "sub", "details", "summary", "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li", "blockquote", "table", "thead", "tbody", "tr", "th", "td",
]);
const SAFE_VOID_TAGS = new Set(["br", "hr"]);
const ALIGNABLE_TAGS = new Set(["p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "th", "td"]);
const ATTR_RE = /([a-zA-Z_:][a-zA-Z0-9_.:-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function resolveSafeUrl(rawUrl, { repoUrl = "", sha = "", rawContent = false } = {}) {
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
      const repoPath = repoUrl.slice("https://github.com/".length, repoEnd);
      const base = rawContent
        ? `https://raw.githubusercontent.com/${repoPath}/${encodeURIComponent(trimmedSha)}/`
        : `${repoUrl.slice(0, repoEnd)}/blob/${encodeURIComponent(trimmedSha)}/`;
      const resolved = new URL(cleaned.replace(/^\.?\/+/, ""), base);
      const expectedOrigin = rawContent ? "https://raw.githubusercontent.com" : "https://github.com";
      return resolved.origin === expectedOrigin ? resolved.href : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Validate and resolve a Markdown link URL safely. */
export function sanitizeMarkdownUrl(rawUrl, options = {}) {
  return resolveSafeUrl(rawUrl, { ...options, rawContent: false });
}

/** Validate and resolve an image URL safely, mapping relative repo paths to raw.githubusercontent.com. */
export function sanitizeMarkdownImageUrl(rawUrl, options = {}) {
  return resolveSafeUrl(rawUrl, { ...options, rawContent: true });
}

function sanitizeImageDimension(rawDim) {
  if (typeof rawDim !== "string" && typeof rawDim !== "number") return "";
  const cleaned = String(rawDim).trim().replace(/px$/i, "");
  return /^\d{1,4}%?$/.test(cleaned) ? cleaned : "";
}

function parseTagAttributes(attrSource) {
  const attrs = {};
  ATTR_RE.lastIndex = 0;
  let match;
  while ((match = ATTR_RE.exec(attrSource)) !== null) {
    const key = match[1].toLowerCase();
    attrs[key] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return attrs;
}

function renderSafeImg({ src, alt = "", title = "", width = "", height = "", className = "md-img" }, opts) {
  const safeSrc = sanitizeMarkdownImageUrl(src, opts);
  if (!safeSrc) return null;
  const w = sanitizeImageDimension(width);
  const h = sanitizeImageDimension(height);
  return `<img class="${esc(className)}" src="${esc(safeSrc)}" alt="${esc(alt)}"${
    title ? ` title="${esc(title)}"` : ""
  }${w ? ` width="${esc(w)}"` : ""}${h ? ` height="${esc(h)}"` : ""} loading="lazy" decoding="async" referrerpolicy="no-referrer" />`;
}

function renderLinkElement(labelHtml, safeHref, linkMode, titleText = "") {
  if (!safeHref) return labelHtml;
  const hrefAttr = esc(safeHref);
  const titleAttr = titleText ? esc(titleText) : hrefAttr;
  return linkMode === "button"
    ? `<button type="button" class="md-link" data-open-url="${hrefAttr}" title="${titleAttr}">${labelHtml}</button>`
    : `<a class="md-link" href="${hrefAttr}" target="_blank" rel="noopener noreferrer"${
        titleText ? ` title="${titleAttr}"` : ""
      }>${labelHtml}</a>`;
}

function sanitizeHtmlToken(rawHtml, opts, openHtmlLinks) {
  const tagRe = /<\/?[a-zA-Z][a-zA-Z0-9-]*\b[^>]*>/g;
  let out = "";
  let lastIndex = 0;
  let match;

  while ((match = tagRe.exec(rawHtml)) !== null) {
    if (match.index > lastIndex) {
      out += esc(rawHtml.slice(lastIndex, match.index));
    }
    lastIndex = match.index + match[0].length;
    const rawTag = match[0];
    const isClosing = rawTag.startsWith("</");
    const nameMatch = rawTag.match(/^<\/?([a-zA-Z][a-zA-Z0-9-]*)/);
    const tag = nameMatch ? nameMatch[1].toLowerCase() : "";

    if (tag === "img" && !isClosing) {
      const attrs = parseTagAttributes(rawTag.slice(4, rawTag.endsWith("/>") ? -2 : -1));
      const imgHtml = renderSafeImg(
        {
          src: attrs.src,
          alt: attrs.alt || "",
          title: attrs.title || "",
          width: attrs.width || "",
          height: attrs.height || "",
          className: "md-img",
        },
        opts
      );
      out += imgHtml || esc(rawTag);
      continue;
    }

    if (tag === "a") {
      if (isClosing) {
        const state = openHtmlLinks.pop();
        if (state === "button") out += "</button>";
        else if (state === "anchor") out += "</a>";
        continue;
      }
      const attrs = parseTagAttributes(rawTag.slice(2, -1));
      const safeHref = sanitizeMarkdownUrl(attrs.href, opts);
      if (!safeHref) {
        openHtmlLinks.push("rejected");
        continue;
      }
      openHtmlLinks.push(opts.linkMode);
      const hrefAttr = esc(safeHref);
      out +=
        opts.linkMode === "button"
          ? `<button type="button" class="md-link" data-open-url="${hrefAttr}" title="${hrefAttr}">`
          : `<a class="md-link" href="${hrefAttr}" target="_blank" rel="noopener noreferrer">`;
      continue;
    }

    if (SAFE_VOID_TAGS.has(tag)) {
      out += isClosing ? "" : `<${tag}${tag === "hr" ? ' class="md-hr"' : ""} />`;
      continue;
    }

    if (SAFE_CONTAINER_TAGS.has(tag)) {
      if (isClosing) {
        out += `</${tag}>`;
        continue;
      }
      const attrs = parseTagAttributes(rawTag.slice(tag.length + 1, rawTag.endsWith("/>") ? -2 : -1));
      const keptAttrs = [];
      if (ALIGNABLE_TAGS.has(tag) && typeof attrs.align === "string") {
        const align = attrs.align.trim().toLowerCase();
        if (align === "left" || align === "center" || align === "right") {
          keptAttrs.push(`style="text-align:${align}"`);
        }
      }
      if (tag === "details" && Object.prototype.hasOwnProperty.call(attrs, "open")) {
        keptAttrs.push("open");
      }
      if ((tag === "td" || tag === "th") && /^\d{1,2}$/.test(String(attrs.colspan || ""))) {
        keptAttrs.push(`colspan="${attrs.colspan}"`);
      }
      if ((tag === "td" || tag === "th") && /^\d{1,2}$/.test(String(attrs.rowspan || ""))) {
        keptAttrs.push(`rowspan="${attrs.rowspan}"`);
      }
      if (tag === "table") keptAttrs.push('class="md-table"');
      if (tag === "blockquote") keptAttrs.push('class="md-quote"');
      if (tag === "pre") keptAttrs.push('class="md-pre"');
      if (tag === "code") keptAttrs.push('class="md-code"');
      const attrSuffix = keptAttrs.length > 0 ? ` ${keptAttrs.join(" ")}` : "";
      out += `<${tag}${attrSuffix}>`;
      continue;
    }

    out += esc(rawTag);
  }

  if (lastIndex < rawHtml.length) {
    out += esc(rawHtml.slice(lastIndex));
  }
  return out;
}

function renderFlattenedTokens(tokens, parser, opts) {
  let out = "";
  for (const tok of tokens || []) {
    if (tok.type === "image") {
      out += esc((tok.text || "").trim() || "Image");
    } else if (tok.type === "link") {
      out += renderFlattenedTokens(tok.tokens, parser, opts);
    } else if (tok.type === "strong") {
      out += `<strong>${renderFlattenedTokens(tok.tokens, parser, opts)}</strong>`;
    } else if (tok.type === "em") {
      out += `<em>${renderFlattenedTokens(tok.tokens, parser, opts)}</em>`;
    } else if (tok.type === "del") {
      out += `<del>${renderFlattenedTokens(tok.tokens, parser, opts)}</del>`;
    } else if (tok.type === "codespan") {
      out += `<code class="md-code">${esc(tok.text)}</code>`;
    } else if (tok.type === "br") {
      out += "<br />";
    } else if (tok.type === "html") {
      out += sanitizeHtmlToken(tok.text, opts, []);
    } else if (tok.tokens) {
      out += renderFlattenedTokens(tok.tokens, parser, opts);
    } else {
      out += esc(tok.text ?? tok.raw ?? "");
    }
  }
  return out;
}

function createMarkdownRenderer(opts) {
  const openHtmlLinks = [];
  let inLink = false;

  const renderer = {
    heading({ tokens, depth }) {
      const level = Math.min(6, Math.max(1, depth));
      return `<h${level} class="md-h${level}">${this.parser.parseInline(tokens)}</h${level}>\n`;
    },
    code({ text, lang }) {
      const cleanLang = typeof lang === "string" ? lang.trim().split(/\s+/)[0] : "";
      return `<pre class="md-pre"><code${cleanLang ? ` data-lang="${esc(cleanLang)}"` : ""}>${esc(text)}</code></pre>\n`;
    },
    codespan({ text }) {
      return `<code class="md-code">${esc(text)}</code>`;
    },
    blockquote({ tokens }) {
      return `<blockquote class="md-quote">${this.parser.parse(tokens).trim()}</blockquote>\n`;
    },
    hr() {
      return '<hr class="md-hr" />\n';
    },
    br() {
      return "<br />";
    },
    list(token) {
      const tag = token.ordered ? "ol" : "ul";
      const startAttr = token.ordered && token.start !== 1 ? ` start="${token.start}"` : "";
      const body = token.items.map((item) => this.listitem(item)).join("");
      return `<${tag} class="md-list"${startAttr}>${body}</${tag}>\n`;
    },
    listitem(item) {
      let itemBody = "";
      if (item.task) {
        itemBody += `<input type="checkbox" disabled${item.checked ? " checked" : ""} /> `;
      }
      if (item.loose) {
        itemBody += this.parser.parse(item.tokens);
      } else {
        for (const tok of item.tokens) {
          if (tok.type === "text" && tok.tokens) {
            itemBody += this.parser.parseInline(tok.tokens);
          } else if (tok.type === "text") {
            itemBody += esc(tok.text);
          } else {
            itemBody += this.parser.parse([tok]);
          }
        }
      }
      return `<li>${itemBody.trim()}</li>`;
    },
    paragraph({ tokens }) {
      return `<p>${this.parser.parseInline(tokens)}</p>\n`;
    },
    table(token) {
      const alignAttr = (idx) => (token.align[idx] ? ` style="text-align:${token.align[idx]}"` : "");
      const headCells = token.header
        .map((cell, idx) => `<th${alignAttr(idx)}>${this.parser.parseInline(cell.tokens)}</th>`)
        .join("");
      const bodyRows = token.rows
        .map((row) => {
          const tds = row
            .map((cell, idx) => `<td${alignAttr(idx)}>${this.parser.parseInline(cell.tokens)}</td>`)
            .join("");
          return `<tr>${tds}</tr>`;
        })
        .join("");
      return `<div class="md-table-wrap"><table class="md-table"><thead><tr>${headCells}</tr></thead>${
        bodyRows ? `<tbody>${bodyRows}</tbody>` : ""
      }</table></div>\n`;
    },
    strong({ tokens }) {
      return `<strong>${this.parser.parseInline(tokens)}</strong>`;
    },
    em({ tokens }) {
      return `<em>${this.parser.parseInline(tokens)}</em>`;
    },
    del({ tokens }) {
      return `<del>${this.parser.parseInline(tokens)}</del>`;
    },
    image({ href, title, text }) {
      const altText = (text || "").trim() || "Image";
      const imgHtml = renderSafeImg(
        { src: href, alt: altText, title: title || "", className: "md-img" },
        opts
      );
      return imgHtml || esc(altText);
    },
    link({ href, title, tokens }) {
      const safeHref = sanitizeMarkdownUrl(href, opts);
      if (inLink) {
        return renderFlattenedTokens(tokens, this.parser, opts);
      }

      if (tokens?.length === 1 && tokens[0].type === "image") {
        const imgTok = tokens[0];
        const altText = (imgTok.text || "").trim() || "Badge";
        const badgeHtml = renderSafeImg(
          {
            src: imgTok.href,
            alt: altText,
            title: imgTok.title || "",
            className: "md-badge-img",
          },
          opts
        );
        return renderLinkElement(badgeHtml || esc(altText), safeHref, opts.linkMode, title || "");
      }

      const hasNestedMediaOrLink = (tokens || []).some(
        (t) => t.type === "image" || t.type === "link"
      );
      inLink = true;
      let innerHtml;
      try {
        innerHtml = hasNestedMediaOrLink
          ? renderFlattenedTokens(tokens, this.parser, opts)
          : this.parser.parseInline(tokens);
      } finally {
        inLink = false;
      }
      return renderLinkElement(innerHtml, safeHref, opts.linkMode, title || "");
    },
    html({ text }) {
      return sanitizeHtmlToken(text, opts, openHtmlLinks);
    },
    text(token) {
      if ("tokens" in token && token.tokens) {
        return this.parser.parseInline(token.tokens);
      }
      return esc(token.text);
    },
  };

  return { renderer, openHtmlLinks };
}

/**
 * Render untrusted Markdown safely to HTML using marked (CommonMark + GFM) with strict sanitization.
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
  const { renderer, openHtmlLinks } = createMarkdownRenderer(opts);
  const instance = new Marked({ gfm: true, breaks: false });
  instance.use({ renderer });

  let rendered = instance.parse(input).trim();
  while (openHtmlLinks.length > 0) {
    const state = openHtmlLinks.pop();
    if (state === "button") rendered += "</button>";
    else if (state === "anchor") rendered += "</a>";
  }
  return rendered ? `<div class="md-body">${rendered}</div>` : "";
}
