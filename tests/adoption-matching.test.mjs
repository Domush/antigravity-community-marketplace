import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { computeContentTreeSha256, getPluginsDir } from "../server/lib/installer.mjs";
import { parseGitHubRepoId, scanInstalledPlugins } from "../server/lib/scanner-local.mjs";
import { PluginStore } from "../server/lib/store.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-adopt-match-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function writeFiles(rootDir, fileMap) {
  for (const [relPath, content] of Object.entries(fileMap)) {
    const abs = path.join(rootDir, ...relPath.split("/"));
    await fs.mkdir(path.dirname(abs), { recursive: true });
    const body = typeof content === "string" ? content : JSON.stringify(content, null, 2) + "\n";
    await fs.writeFile(abs, body, "utf8");
  }
}

async function hashFileMap(fileMap) {
  return withTempDir(async (dir) => {
    await writeFiles(dir, fileMap);
    return computeContentTreeSha256(dir);
  });
}

function makeCatalogEntry({
  id,
  name = "Context Mode",
  pluginName = "context-mode",
  version = "1.2.0",
  sha = "a".repeat(40),
  contentTreeSha256,
  tarballUrl = "http://127.0.0.1/tarball",
  stars = 100,
  capabilities = ["mcp_local_exec"],
}) {
  const [owner] = id.split("/");
  return {
    id,
    name,
    pluginName,
    version,
    author: { login: owner },
    release: { sha, tarballUrl, contentTreeSha256 },
    stats: { stars },
    security: { riskTier: "elevated", capabilities },
  };
}

// ---------------------------------------------------------------------------
// 1. Unit Tests: parseGitHubRepoId()
// ---------------------------------------------------------------------------
describe("parseGitHubRepoId — repository URL normalization", () => {
  it("parses HTTPS, SSH, git+, and github: shorthand URLs and rejects non-GitHub hosts", () => {
    assert.equal(parseGitHubRepoId("https://github.com/acme-dev/context-mode.git"), "acme-dev/context-mode");
    assert.equal(parseGitHubRepoId("https://github.com/acme-dev/context-mode/"), "acme-dev/context-mode");
    assert.equal(parseGitHubRepoId("git@github.com:acme-dev/context-mode.git"), "acme-dev/context-mode");
    assert.equal(parseGitHubRepoId("ssh://git@github.com/acme-dev/context-mode.git"), "acme-dev/context-mode");
    assert.equal(parseGitHubRepoId("git+https://github.com/acme-dev/context-mode.git"), "acme-dev/context-mode");
    assert.equal(parseGitHubRepoId("github:acme-dev/context-mode"), "acme-dev/context-mode");

    assert.equal(parseGitHubRepoId("https://gitlab.com/acme-dev/context-mode.git"), null);
    assert.equal(parseGitHubRepoId("not-a-url"), null);
    assert.equal(parseGitHubRepoId(""), null);
  });
});

// ---------------------------------------------------------------------------
// 2. Tier 1: Exact-Hash Auto-Linking (Including .git/ Exclusion)
// ---------------------------------------------------------------------------
describe("Tier 1 matching — exact contentTreeSha256 auto-linking with .git exclusion", () => {
  it("auto-links an unmodified git-cloned manual plugin even when .git metadata is present", async () => {
    const releaseFiles = {
      "plugin.json": { name: "context-mode", version: "1.2.0" },
      "skills/context-mode/SKILL.md": "# Context Mode v1.2.0\n",
      "mcp_config.json": { mcpServers: { ctx: { command: "node", args: ["server.mjs"] } } },
    };
    const releaseHash = await hashFileMap(releaseFiles);

    await withTempDir(async (tmp) => {
      const store = new PluginStore(path.join(tmp, "data"));
      await store.init();
      const workspaceRoot = path.join(tmp, "workspace");
      const manualDir = path.join(
        getPluginsDir("project", workspaceRoot, { enabled: true }),
        "context-mode"
      );

      // Simulate a manual `git clone` containing .git/ files absent from GitHub tarballs
      await writeFiles(manualDir, {
        ...releaseFiles,
        ".git/HEAD": "ref: refs/heads/main\n",
        ".git/config": '[remote "origin"]\n\turl = git@github.com:acme-dev/context-mode.git\n',
        ".git/objects/pack/mock.idx": "binary-pack-data",
      });

      // Verify excludeDotGit behavior directly
      const hashWithGit = await computeContentTreeSha256(manualDir, { excludeDotGit: false });
      const hashWithoutGit = await computeContentTreeSha256(manualDir, { excludeDotGit: true });
      assert.notEqual(hashWithGit, releaseHash);
      assert.equal(hashWithoutGit, releaseHash);

      const catalog = [
        makeCatalogEntry({
          id: "acme-dev/context-mode",
          version: "1.2.0",
          sha: "1".repeat(40),
          contentTreeSha256: releaseHash,
          capabilities: ["mcp_local_exec", "fs_read_workspace"],
        }),
      ];

      const installs = (
        await scanInstalledPlugins({ store, workspaceRoot, catalogPlugins: catalog })
      ).filter((p) => p.scope === "project");

      assert.equal(installs.length, 1);
      const matched = installs[0];
      assert.equal(matched.matchTier, "exact_hash");
      assert.equal(matched.manual, false);
      assert.equal(matched.id, "acme-dev/context-mode");
      assert.equal(matched.slug, "context-mode");
      assert.equal(matched.sha, "1".repeat(40));
      assert.equal(matched.contentTreeSha256, releaseHash);
      assert.deepEqual(matched.capabilities, ["mcp_local_exec", "fs_read_workspace"]);
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Tier 2: .git/config Origin & manifest.repository Matching
// ---------------------------------------------------------------------------
describe("Tier 2 matching — .git/config origin and manifest.repository fallback", () => {
  it("matches an older or locally edited git checkout via .git/config origin without auto-marking managed", async () => {
    const latestHash = await hashFileMap({
      "plugin.json": { name: "context-mode", version: "2.0.0" },
      "rules/main.md": "v2 rules",
    });

    await withTempDir(async (tmp) => {
      const store = new PluginStore(path.join(tmp, "data"));
      await store.init();
      const workspaceRoot = path.join(tmp, "workspace");
      const manualDir = path.join(
        getPluginsDir("project", workspaceRoot, { enabled: true }),
        "context-mode"
      );

      // Older v1.0.0 checkout with local edits (hash will NOT match v2.0.0)
      await writeFiles(manualDir, {
        "plugin.json": { name: "context-mode", version: "1.0.0" },
        "rules/main.md": "v1 rules with local tweaks",
        ".git/config": [
          "[core]",
          "\trepositoryformatversion = 0",
          '[remote "origin"]',
          "\turl = https://github.com/Acme-Dev/Context-Mode.git",
          "\tfetch = +refs/heads/*:refs/remotes/origin/*",
        ].join("\n"),
      });

      const catalog = [
        makeCatalogEntry({
          id: "acme-dev/context-mode",
          version: "2.0.0",
          sha: "2".repeat(40),
          contentTreeSha256: latestHash,
        }),
      ];

      const installs = (
        await scanInstalledPlugins({ store, workspaceRoot, catalogPlugins: catalog })
      ).filter((p) => p.scope === "project");

      assert.equal(installs.length, 1);
      const matched = installs[0];
      assert.equal(matched.matchTier, "repo_origin");
      assert.equal(matched.manual, true);
      assert.equal(matched.id, "acme-dev/context-mode");
      assert.equal(matched.originRepoId, "acme-dev/context-mode");
      assert.equal(matched.version, "1.0.0");
      assert.equal(matched.sha, null);
    });
  });

  it("falls back to manifest.repository when no .git directory exists", async () => {
    await withTempDir(async (tmp) => {
      const store = new PluginStore(path.join(tmp, "data"));
      await store.init();
      const workspaceRoot = path.join(tmp, "workspace");
      const manualDir = path.join(
        getPluginsDir("project", workspaceRoot, { enabled: true }),
        "my-extracted-zip"
      );

      await writeFiles(manualDir, {
        "plugin.json": {
          name: "shader-lint",
          version: "0.8.0",
          repository: { type: "git", url: "git+https://github.com/vogel-tools/shader-lint.git" },
        },
        "rules/hlsl.md": "Check half precision.",
      });

      const catalog = [
        makeCatalogEntry({
          id: "vogel-tools/shader-lint",
          name: "Shader Lint",
          pluginName: "shader-lint",
          version: "1.0.0",
          contentTreeSha256: "f".repeat(64),
        }),
      ];

      const installs = (
        await scanInstalledPlugins({ store, workspaceRoot, catalogPlugins: catalog })
      ).filter((p) => p.scope === "project");

      assert.equal(installs.length, 1);
      assert.equal(installs[0].matchTier, "repo_origin");
      assert.equal(installs[0].id, "vogel-tools/shader-lint");
      assert.equal(installs[0].originRepoId, "vogel-tools/shader-lint");
      assert.equal(installs[0].manual, true);
    });
  });
});

// ---------------------------------------------------------------------------
// 4. Tier 3: Name-Squatting Protection
// ---------------------------------------------------------------------------
describe("Tier 3 matching — name-squatting defense and opt-in suggestions", () => {
  it("never auto-links by manifest.name alone, preserves manual id, and caps star-sorted suggestions at 3", async () => {
    await withTempDir(async (tmp) => {
      const store = new PluginStore(path.join(tmp, "data"));
      await store.init();
      const workspaceRoot = path.join(tmp, "workspace");
      const manualDir = path.join(
        getPluginsDir("project", workspaceRoot, { enabled: true }),
        "context-mode"
      );

      // Manual install with no .git/config, no repository field, and different hash
      await writeFiles(manualDir, {
        "plugin.json": { name: "context-mode", version: "1.0.0" },
        "rules/private.md": "Internal custom context rules.",
      });

      // Four repos claiming pluginName "context-mode" (including a rogue squatter with version 9.9.9)
      const catalog = [
        makeCatalogEntry({
          id: "rogue-squatter/context-mode",
          pluginName: "context-mode",
          version: "9.9.9",
          stars: 2,
          contentTreeSha256: "1".repeat(64),
        }),
        makeCatalogEntry({
          id: "official-org/context-mode",
          pluginName: "context-mode",
          version: "1.5.0",
          stars: 420,
          contentTreeSha256: "2".repeat(64),
        }),
        makeCatalogEntry({
          id: "community-fork/context-mode",
          pluginName: "context-mode",
          version: "1.6.0",
          stars: 85,
          contentTreeSha256: "3".repeat(64),
        }),
        makeCatalogEntry({
          id: "tiny-clone/context-mode",
          pluginName: "context-mode",
          version: "1.0.0",
          stars: 1,
          contentTreeSha256: "4".repeat(64),
        }),
      ];

      const installs = (
        await scanInstalledPlugins({ store, workspaceRoot, catalogPlugins: catalog })
      ).filter((p) => p.scope === "project");

      assert.equal(installs.length, 1);
      const item = installs[0];

      // Must NOT hijack id or mark as managed
      assert.equal(item.matchTier, "name_suggestion");
      assert.equal(item.manual, true);
      assert.equal(item.id, "context-mode");
      assert.equal(item.originRepoId, null);
      assert.equal(item.sha, null);

      // Suggestions sorted by stars descending, capped at 3 (tiny-clone excluded)
      assert.equal(item.suggestedMatches.length, 3);
      assert.deepEqual(
        item.suggestedMatches.map((m) => m.id),
        ["official-org/context-mode", "community-fork/context-mode", "rogue-squatter/context-mode"]
      );
    });
  });

  it("leaves truly private local plugins unmatched when neither hash, origin, nor name match", async () => {
    await withTempDir(async (tmp) => {
      const store = new PluginStore(path.join(tmp, "data"));
      await store.init();
      const workspaceRoot = path.join(tmp, "workspace");
      const manualDir = path.join(
        getPluginsDir("project", workspaceRoot, { enabled: true }),
        "vogel-internal-tools"
      );

      await writeFiles(manualDir, {
        "plugin.json": { name: "vogel-internal-tools", version: "0.1.0" },
        "rules/internal.md": "Studio-only rules.",
      });

      const catalog = [
        makeCatalogEntry({
          id: "someone/unrelated-plugin",
          pluginName: "unrelated-plugin",
          contentTreeSha256: "9".repeat(64),
        }),
      ];

      const installs = (
        await scanInstalledPlugins({ store, workspaceRoot, catalogPlugins: catalog })
      ).filter((p) => p.scope === "project");

      assert.equal(installs.length, 1);
      assert.equal(installs[0].matchTier, "unmatched");
      assert.equal(installs[0].manual, true);
      assert.deepEqual(installs[0].suggestedMatches, []);
    });
  });
});
