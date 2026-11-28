import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  fetchReleaseNotesSince,
  filterReleaseNotesSince,
  parseChangelogSections,
  parseGitHubReleaseNotes,
} from "../server/lib/release-notes.mjs";
import { PluginStore } from "../server/lib/store.mjs";

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-relnotes-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("server/lib/release-notes.mjs — multi-version changelog parsing & filtering", () => {
  it("parses Keep-a-Changelog headings, ignores [Unreleased], and filters versions > installedVersion", () => {
    const changelog = `# Changelog

## [Unreleased]
### Added
- Future work

## [2.0.1] - 2026-11-27
### Fixed
- Patched staging lock

## [2.0.0] - 2026-11-25
### Added
- AST-aware chunking engine

## [1.5.0] - 2026-11-20
### Added
- Just-in-time indexing

## [1.4.0] - 2026-11-10
### Added
- Initial release
`;

    const sections = parseChangelogSections(changelog);
    assert.deepEqual(
      sections.map((s) => s.version),
      ["2.0.1", "2.0.0", "1.5.0", "1.4.0"]
    );

    const since = filterReleaseNotesSince({
      sections,
      installedVersion: "1.5.0",
      targetVersion: "2.0.1",
    });

    assert.ok(since);
    assert.deepEqual(since.versions, ["2.0.1", "2.0.0"]);
    assert.equal(since.markdown.includes("Patched staging lock"), true);
    assert.equal(since.markdown.includes("AST-aware chunking engine"), true);
    assert.equal(since.markdown.includes("Just-in-time indexing"), false);
    assert.equal(since.markdown.includes("Future work"), false);
  });

  it("fetches pinned CHANGELOG.md, caches by SHA, and falls back to GitHub Releases when missing", async () => {
    await withTempDir(async (tmp) => {
      const store = new PluginStore(path.join(tmp, "data"));
      await store.init();

      let changelogCalls = 0;
      const pluginEntry = {
        id: "Domush/antigravity-plugin-context-mode",
        version: "2.0.1",
        release: { sha: "abcdef1234567890" },
      };

      const fetchChangelogOk = async (url) => {
        changelogCalls += 1;
        assert.match(url, /raw\.githubusercontent\.com\/Domush\/antigravity-plugin-context-mode\/abcdef1234567890\/CHANGELOG\.md/);
        return {
          ok: true,
          async text() {
            return "## [2.0.1]\n- Patch\n\n## [2.0.0]\n- Major\n\n## [1.0.0]\n- Old";
          },
        };
      };

      const first = await fetchReleaseNotesSince({
        pluginEntry,
        detail: { latestReleaseNotes: "- Patch" },
        installedVersion: "1.0.0",
        store,
        fetchFn: fetchChangelogOk,
      });
      assert.deepEqual(first.versions, ["2.0.1", "2.0.0"]);
      assert.equal(changelogCalls, 1);

      // Second call uses SHA cache without hitting network
      const second = await fetchReleaseNotesSince({
        pluginEntry,
        detail: { latestReleaseNotes: "- Patch" },
        installedVersion: "1.0.0",
        store,
        fetchFn: async () => {
          throw new Error("Should not hit network when SHA cache exists");
        },
      });
      assert.deepEqual(second.versions, ["2.0.1", "2.0.0"]);

      // Different SHA without CHANGELOG.md falls back to GitHub Releases API
      const otherEntry = {
        id: "acme/tool",
        version: "1.3.0",
        release: { sha: "9999999999999999" },
      };
      const ghReleases = parseGitHubReleaseNotes([
        { tag_name: "v1.3.0", published_at: "2026-11-27T00:00:00Z", body: "- Added C" },
        { tag_name: "v1.2.0", published_at: "2026-11-20T00:00:00Z", body: "- Added B" },
        { tag_name: "v1.0.0", published_at: "2026-11-10T00:00:00Z", body: "- Initial" },
      ]);
      assert.equal(ghReleases.length, 3);

      const fallbackRes = await fetchReleaseNotesSince({
        pluginEntry: otherEntry,
        detail: { latestReleaseNotes: "- Added C" },
        installedVersion: "1.0.0",
        store,
        fetchFn: async (url) => {
          if (url.includes("CHANGELOG.md")) return { ok: false, status: 404 };
          return {
            ok: true,
            async json() {
              return [
                { tag_name: "v1.3.0", published_at: "2026-11-27T00:00:00Z", body: "- Added C" },
                { tag_name: "v1.2.0", published_at: "2026-11-20T00:00:00Z", body: "- Added B" },
                { tag_name: "v1.0.0", published_at: "2026-11-10T00:00:00Z", body: "- Initial" },
              ];
            },
          };
        },
      });
      assert.deepEqual(fallbackRes.versions, ["1.3.0", "1.2.0"]);
      assert.equal(fallbackRes.markdown.includes("Added B"), true);
      assert.equal(fallbackRes.markdown.includes("Added C"), true);
    });
  });
});
