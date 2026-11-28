import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderMarkdown, sanitizeMarkdownUrl } from "../ui/src/markdown.js";
import {
  capDescription,
  capLabel,
  ELEVATED_CAPABILITIES,
} from "../ui/src/security-meta.js";

describe("sanitizeMarkdownUrl", () => {
  it("allows http/https URLs and strips surrounding angle brackets", () => {
    assert.equal(sanitizeMarkdownUrl("https://example.com/docs?a=1"), "https://example.com/docs?a=1");
    assert.equal(sanitizeMarkdownUrl("<http://example.com/path>"), "http://example.com/path");
  });

  it("blocks dangerous schemes, protocol-relative URLs, fragments, and unsafe chars", () => {
    for (const bad of [
      "javascript:alert(1)",
      "  JaVaScRiPt:alert(1)  ",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
      "//evil.com/payload.js",
      "\\\\evil.com\\share",
      "#section-only",
      "https://example.com/a b",
      'https://example.com/"quote',
      "",
      null,
    ]) {
      assert.equal(sanitizeMarkdownUrl(bad), null, `Expected null for ${String(bad)}`);
    }
  });

  it("resolves relative repo links to pinned GitHub SHA only", () => {
    const opts = {
      repoUrl: "https://github.com/Domush/antigravity-community-marketplace/",
      sha: "deadbeef1234",
    };
    assert.equal(
      sanitizeMarkdownUrl("./docs/guide.md", opts),
      "https://github.com/Domush/antigravity-community-marketplace/blob/deadbeef1234/docs/guide.md"
    );
    assert.equal(
      sanitizeMarkdownUrl("assets/shot.png", opts),
      "https://github.com/Domush/antigravity-community-marketplace/blob/deadbeef1234/assets/shot.png"
    );
    assert.equal(sanitizeMarkdownUrl("./docs/guide.md", { repoUrl: opts.repoUrl, sha: "" }), null);
    assert.equal(
      sanitizeMarkdownUrl("./docs/guide.md", { repoUrl: "https://gitlab.com/org/repo", sha: "abc" }),
      null
    );
  });
});

describe("renderMarkdown", () => {
  it("neutralizes raw HTML and XSS payloads across inline and block contexts", () => {
    const md = [
      '# Title <script>alert("xss")</script>',
      "",
      'Text <img src="x" onerror="alert(1)"> and <iframe src="https://evil.com"></iframe>.',
      "",
      "> Quote <svg onload=alert(1)>",
      "",
      "- Item <a href='javascript:alert(1)'>bad</a>",
    ].join("\n");

    const html = renderMarkdown(md);
    assert.equal(html.includes("<script"), false);
    assert.equal(html.includes("<img"), false);
    assert.equal(html.includes("<iframe"), false);
    assert.equal(html.includes("<svg"), false);
    assert.equal(html.includes("onerror="), true); // escaped as literal text, not an attribute on an element
    assert.ok(html.includes("&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;"));
    assert.ok(html.includes("&lt;img src=&quot;x&quot; onerror=&quot;alert(1)&quot;&gt;"));
    assert.ok(html.includes("&lt;iframe src=&quot;"));
    assert.ok(html.includes("&lt;/iframe&gt;"));
  });

  it("strips null bytes and normalizes CRLF/CR line endings", () => {
    const html = renderMarkdown("Line 1\0\r\nLine 2\r\r# Heading\r\n");
    assert.equal(html.includes("\0"), false);
    assert.match(html, /<p>Line 1[\s\n]+Line 2<\/p>/);
    assert.ok(html.includes('<h1 class="md-h1">Heading</h1>'));
  });

  it("blocks unsafe link schemes while preserving link labels safely", () => {
    const md = [
      "[JS](javascript:alert(1))",
      "[Data](data:text/html;base64,PHNjcmlwdD4=)",
      "[VBS](vbscript:msgbox(1))",
      "[Proto](//evil.com/x)",
      "[<b>Bad</b>](javascript:void(0))",
    ].join(" | ");

    const html = renderMarkdown(md);
    assert.equal(html.includes("<a "), false);
    assert.equal(html.includes("<button "), false);
    assert.equal(html.includes("javascript:"), false);
    assert.ok(html.includes("JS | Data | VBS | Proto | <b>Bad</b>"));
  });

  it("renders safe <img> tags, Markdown images, and linked badges while stripping unsafe URLs/attributes", () => {
    const md = [
      '[![Build Status](https://img.shields.io/badge/ci-pass-green)](https://github.com/org/repo/actions)',
      '![Architecture](./docs/arch.png)',
      '<img width="823" height="646" alt="Demo shot" src="https://github.com/user-attachments/assets/abc-123" onerror="alert(1)" onclick="steal()" />',
      '<img src="javascript:alert(1)" alt="Blocked" />',
      '`<img src="https://example.com/literal-in-code.png" />`',
    ].join("\n\n");

    const html = renderMarkdown(md, {
      linkMode: "button",
      repoUrl: "https://github.com/org/repo",
      sha: "cafebabe",
    });

    assert.ok(
      html.includes(
        '<button type="button" class="md-link" data-open-url="https://github.com/org/repo/actions" title="https://github.com/org/repo/actions"><img class="md-badge-img" src="https://img.shields.io/badge/ci-pass-green" alt="Build Status"'
      )
    );
    assert.ok(
      html.includes(
        '<img class="md-img" src="https://raw.githubusercontent.com/org/repo/cafebabe/docs/arch.png" alt="Architecture"'
      )
    );
    assert.ok(
      html.includes(
        '<img class="md-img" src="https://github.com/user-attachments/assets/abc-123" alt="Demo shot" width="823" height="646" loading="lazy" decoding="async" referrerpolicy="no-referrer" />'
      )
    );
    assert.equal(html.includes("onerror="), false);
    assert.equal(html.includes("onclick="), false);
    assert.equal(html.includes('<img src="javascript:'), false);
    assert.ok(html.includes('&lt;img src=&quot;javascript:alert(1)&quot; alt=&quot;Blocked&quot; /&gt;'));
    assert.ok(html.includes('<code class="md-code">&lt;img src=&quot;https://example.com/literal-in-code.png&quot; /&gt;</code>'));
  });

  it("renders GFM pipe tables with column alignment and escaped code pipes", () => {
    const md = [
      "| Operation | Before | After | Code |",
      "| :--- | :---: | ---: | --- |",
      "| **Build Log** | 65 KB | **550 B** | `a \\| b` |",
      "| Escaped | 1 | 2 | x \\| y |",
    ].join("\n");

    const html = renderMarkdown(md);
    assert.ok(html.includes('<div class="md-table-wrap"><table class="md-table">'));
    assert.ok(html.includes('<th style="text-align:left">Operation</th>'));
    assert.ok(html.includes('<th style="text-align:center">Before</th>'));
    assert.ok(html.includes('<th style="text-align:right">After</th>'));
    assert.ok(html.includes("<th>Code</th>"));
    assert.ok(html.includes('<td style="text-align:left"><strong>Build Log</strong></td>'));
    assert.ok(html.includes('<td><code class="md-code">a | b</code></td>'));
    assert.ok(html.includes("<td>x | y</td>"));
  });

  it("auto-links bare URLs while preserving trailing punctuation and surrounding quotes", () => {
    const md = 'See https://example.com/a?x=1&y=2, (https://example.com/paren), and "https://example.com/q".';
    const html = renderMarkdown(md, { linkMode: "anchor" });

    assert.ok(
      html.includes(
        '<a class="md-link" href="https://example.com/a?x=1&amp;y=2" target="_blank" rel="noopener noreferrer">https://example.com/a?x=1&amp;y=2</a>,'
      )
    );
    assert.ok(
      html.includes(
        '(<a class="md-link" href="https://example.com/paren" target="_blank" rel="noopener noreferrer">https://example.com/paren</a>)'
      )
    );
    assert.ok(
      html.includes(
        '&quot;<a class="md-link" href="https://example.com/q" target="_blank" rel="noopener noreferrer">https://example.com/q</a>&quot;.'
      )
    );
  });

  it("renders headings, lists, blockquotes, fenced code blocks (including unclosed EOF), hrs, and emphasis", () => {
    const md = [
      "## Section **One**",
      "",
      "> Quote line 1",
      "> Quote line 2",
      "",
      "- Unordered `**raw**`",
      "* Second __bold__ *italics* ~~old~~",
      "",
      "1. First",
      "2. Second",
      "",
      "---",
      "",
      "```js",
      "const x = '<tag>';",
      "```",
      "",
      "~~~txt",
      "unclosed fence at EOF",
    ].join("\n");

    const html = renderMarkdown(md);
    assert.ok(html.startsWith('<div class="md-body">'));
    assert.ok(html.endsWith("</div>"));
    assert.ok(html.includes('<h2 class="md-h2">Section <strong>One</strong></h2>'));
    assert.match(html, /<blockquote class="md-quote"><p>Quote line 1[\s\n]+Quote line 2<\/p><\/blockquote>/);
    assert.ok(html.includes('<ul class="md-list"><li>Unordered <code class="md-code">**raw**</code></li>'));
    assert.ok(html.includes("<li>Second <strong>bold</strong> <em>italics</em> <del>old</del></li></ul>"));
    assert.ok(html.includes('<ol class="md-list"><li>First</li><li>Second</li></ol>'));
    assert.ok(html.includes('<hr class="md-hr" />'));
    assert.ok(html.includes('<pre class="md-pre"><code data-lang="js">const x = &#39;&lt;tag&gt;&#39;;</code></pre>'));
    assert.ok(html.includes('<pre class="md-pre"><code data-lang="txt">unclosed fence at EOF</code></pre>'));
  });

  it("supports button vs anchor linkMode and rejects invalid linkMode", () => {
    const btn = renderMarkdown("[Docs](./README.md)", {
      linkMode: "button",
      repoUrl: "https://github.com/org/repo",
      sha: "abc",
    });
    assert.ok(btn.includes('<button type="button" class="md-link" data-open-url="https://github.com/org/repo/blob/abc/README.md"'));

    const anchor = renderMarkdown("[Docs](./README.md)", {
      linkMode: "anchor",
      repoUrl: "https://github.com/org/repo",
      sha: "abc",
    });
    assert.ok(anchor.includes('<a class="md-link" href="https://github.com/org/repo/blob/abc/README.md" target="_blank" rel="noopener noreferrer">Docs</a>'));

    assert.throws(() => renderMarkdown("hi", { linkMode: "invalid" }), TypeError);
    assert.equal(renderMarkdown("   \n  "), "");
  });

  it("handles empty-href linked badges and balanced parentheses in Wikipedia URLs", () => {
    const md = [
      "[![Zero Runtime Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)]()",
      "[![Parens Badge](https://img.shields.io/badge/a_(b)-c-blue)](https://github.com/org/repo)",
      "See [wiki](https://en.wikipedia.org/wiki/Foo_(bar)).",
    ].join("\n\n");

    const anchorHtml = renderMarkdown(md, { linkMode: "anchor" });
    assert.ok(
      anchorHtml.includes(
        '<p><img class="md-badge-img" src="https://img.shields.io/badge/dependencies-0-brightgreen.svg" alt="Zero Runtime Dependencies"'
      )
    );
    assert.ok(
      anchorHtml.includes(
        '<a class="md-link" href="https://github.com/org/repo" target="_blank" rel="noopener noreferrer"><img class="md-badge-img" src="https://img.shields.io/badge/a_(b)-c-blue" alt="Parens Badge"'
      )
    );
    assert.ok(anchorHtml.includes('<a class="md-link" href="https://en.wikipedia.org/wiki/Foo_(bar)" target="_blank" rel="noopener noreferrer">wiki</a>.'));

    const btnHtml = renderMarkdown("[wiki](https://en.wikipedia.org/wiki/Foo_(bar))", { linkMode: "button" });
    assert.ok(btnHtml.includes('<button type="button" class="md-link" data-open-url="https://en.wikipedia.org/wiki/Foo_(bar)" title="https://en.wikipedia.org/wiki/Foo_(bar)">wiki</button>'));
  });

  it("flattens compound nested images/links without nested interactive <button> or <a> elements", () => {
    const md = "[prefix ![img](https://a.com/x.png)](https://b.com/y)";

    const btnHtml = renderMarkdown(md, { linkMode: "button" });
    assert.equal(btnHtml.includes("<img"), false);
    assert.equal((btnHtml.match(/<button\b/g) || []).length, 1);
    assert.equal((btnHtml.match(/<\/button>/g) || []).length, 1);
    assert.ok(btnHtml.includes('<button type="button" class="md-link" data-open-url="https://b.com/y" title="https://b.com/y">prefix img</button>'));

    const anchorHtml = renderMarkdown(md, { linkMode: "anchor" });
    assert.equal((anchorHtml.match(/<a\b/g) || []).length, 1);
    assert.equal((anchorHtml.match(/<\/a>/g) || []).length, 1);
    assert.ok(anchorHtml.includes('<a class="md-link" href="https://b.com/y" target="_blank" rel="noopener noreferrer">prefix img</a>'));
  });

  it("restores inline code tokens and preserves emphasis inside image, badge, and flattened link labels", () => {
    const cases = [
      ["![alt x](https://a.com/x.png)", 'alt="alt x"'],
      ["[![alt x](https://a.com/x.png)](https://b.com/y)", 'alt="alt x"'],
      ["[**a** ![`code`](https://a.com/x.png)](https://b.com/y)", "<strong>a</strong> `code`"],
      ["[a [b `c`](https://a.com/x)](https://b.com/y)", 'b <code class="md-code">c</code>'],
      ["[a [**b**](https://a.com/x)](https://b.com/y)", "<strong>b</strong>"],
    ];
    for (const [md, expectedInner] of cases) {
      const html = renderMarkdown(md, { linkMode: "button" });
      assert.equal(html.includes("\0"), false, `Unexpected NUL placeholder in: ${html}`);
      assert.ok(html.includes(expectedInner), `Expected ${expectedInner} in ${html}`);
    }
  });

  it("renders 10KB+ adversarial ReDoS inputs and 15KB badge-heavy READMEs without exponential backtracking", () => {
    const adversarial = [
      `[a](https://example.com/${"(".repeat(5000)}${"x".repeat(5000)}`,
      "[a](".repeat(3000),
      "![alt](".repeat(3000),
      `${"[".repeat(5000)}a${"](x)".repeat(5000)}`,
      `${"**".repeat(5000)} and **unclosed ${"x*".repeat(5000)}`,
      `${"https://".repeat(2000)} and https://example.com/${")".repeat(10000)}`,
      `# a${" ".repeat(10000)}b`,
      `\`\`\`${" ".repeat(50000)}!`,
      `~~~${" ".repeat(50000)}!`,
    ];
    const t0 = performance.now();
    for (const sample of adversarial) {
      assert.ok(renderMarkdown(sample, { linkMode: "button" }).startsWith('<div class="md-body">'));
    }
    const elapsedMs = performance.now() - t0;
    assert.ok(elapsedMs < 1000, `Expected < 1000ms for adversarial ReDoS suite, got ${elapsedMs.toFixed(2)}ms`);

    const badgeLine =
      "[![Zero Runtime Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)]() " +
      "[![Build](https://img.shields.io/badge/build-passing-green)](https://github.com/Domush/antigravity-plugin-context-mode)";
    const largeReadme = Array.from({ length: 65 }, (_, i) =>
      `## Section ${i} **Summary**\n\n${badgeLine}\n\n- Uses [wiki](https://en.wikipedia.org/wiki/Foo_(bar)) and \`code\`\n`
    ).join("\n");
    assert.ok(largeReadme.length >= 15000);

    const t1 = performance.now();
    const readmeHtml = renderMarkdown(largeReadme, { linkMode: "button" });
    const readmeMs = performance.now() - t1;
    assert.ok(readmeHtml.includes("Zero Runtime Dependencies"));
    assert.ok(readmeMs < 200, `Expected < 200ms for 15KB README, got ${readmeMs.toFixed(2)}ms`);
  });
});

describe("accesses_gemini_dir capability metadata", () => {
  it("provides a clear non-elevated label and description", () => {
    assert.equal(capLabel("accesses_gemini_dir"), "Reads ~/.gemini Data");
    assert.equal(
      capDescription("accesses_gemini_dir"),
      "Reads or writes files under ~/.gemini/ (normal for Antigravity telemetry/config plugins)."
    );
    assert.equal(ELEVATED_CAPABILITIES.has("accesses_gemini_dir"), false);
  });
});
