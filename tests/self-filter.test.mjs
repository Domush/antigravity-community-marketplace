import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { scanInstalledPlugins } from "../server/lib/scanner-local.mjs";
import {
  filterSelfFromCatalogIndex,
  isSelfMarketplacePlugin,
} from "../server/lib/self-filter.mjs";
import { createMarketplaceService, summarizeStatus } from "../server/lib/service.mjs";
import { PluginStore } from "../server/lib/store.mjs";
import { getFilteredPlugins, state } from "../ui/src/helpers.js";

function makeCatalogEntry(id, pluginName, extra = {}) {
  return {
    id,
    name: extra.displayName || pluginName,
    pluginName,
    summary: `Plugin ${id}`,
    author: { login: id.split("/")[0] },
    repoUrl: `https://github.com/${id}`,
    version: "1.0.5",
    release: {
      ref: "main",
      sha: "a".repeat(40),
      tarballUrl: `https://api.github.com/repos/${id}/tarball/${"a".repeat(40)}`,
      contentTreeSha256: "b".repeat(64),
    },
    surface: { hasSidebarUi: false, components: ["skills"] },
    categories: ["productivity"],
    tags: [],
    requiresCredentials: false,
    stats: { stars: 10, pushedAt: "2026-11-27T00:00:00Z" },
    security: { riskTier: "low", capabilities: ["prompt_rules_only"], findingCounts: {} },
    ...extra,
  };
}

describe("self-marketplace exclusion filter", () => {
  it("matches self-marketplace identifiers case-insensitively without matching other plugins", () => {
    assert.equal(isSelfMarketplacePlugin({ id: "Domush/antigravity-community-marketplace" }), true);
    assert.equal(isSelfMarketplacePlugin({ id: "agy-community-marketplace" }), true);
    assert.equal(isSelfMarketplacePlugin({ pluginName: "AGY-COMMUNITY-MARKETPLACE" }), true);
    assert.equal(isSelfMarketplacePlugin({ slug: "antigravity-community-marketplace" }), true);
    assert.equal(
      isSelfMarketplacePlugin({ repoUrl: "https://github.com/Domush/antigravity-community-marketplace/" }),
      true
    );

    assert.equal(isSelfMarketplacePlugin({ id: "acme/other-marketplace-helper", pluginName: "other-marketplace" }), false);
    assert.equal(isSelfMarketplacePlugin(null), false);
  });

  it("filters self from catalog index and marketplace service responses", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-self-filter-"));
    try {
      const store = new PluginStore(tmpDir);
      const rawIndex = {
        schemaVersion: 1,
        marketplaceClient: { latestVersion: "1.0.6", minSupportedVersion: "1.0.0" },
        plugins: [
          makeCatalogEntry("Domush/antigravity-community-marketplace", "agy-community-marketplace"),
          makeCatalogEntry("acme/clean-plugin", "clean-plugin"),
        ],
      };

      const filtered = filterSelfFromCatalogIndex(rawIndex);
      assert.deepEqual(filtered.plugins.map((p) => p.id), ["acme/clean-plugin"]);
      assert.deepEqual(filtered.marketplaceClient, rawIndex.marketplaceClient);

      const mockCatalog = {
        getIndex: async () => rawIndex,
        getDenylist: async () => ({ blockedRepos: [], blockedShas: [] }),
        getPluginDetail: async (entry) => ({ id: entry.id, collisions: {} }),
      };

      const service = createMarketplaceService({
        catalog: mockCatalog,
        store,
        clientVersion: "1.0.5",
      });

      const bootstrap = await service.getBootstrap();
      assert.deepEqual(
        bootstrap.structuredContent.index.plugins.map((p) => p.id),
        ["acme/clean-plugin"]
      );

      const summary = await service.getSummary();
      assert.equal(summary.structuredContent.summary.total, 1);

      await assert.rejects(
        () => service.getPluginDetail({ id: "Domush/antigravity-community-marketplace" }),
        /Plugin not found/
      );
      await assert.rejects(
        () => service.installPlugin({ id: "Domush/antigravity-community-marketplace", scope: "global" }),
        /Plugin not found/
      );
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("excludes local self-marketplace installation in scanner-local and summarizeStatus", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-self-scan-"));
    try {
      const store = new PluginStore(path.join(tmpDir, "data"));
      const workspaceRoot = path.join(tmpDir, "ws");
      const selfDir = path.join(workspaceRoot, ".agents", "plugins", "agy-community-marketplace");
      const otherDir = path.join(workspaceRoot, ".agents", "plugins", "other-plugin");

      await fs.mkdir(selfDir, { recursive: true });
      await fs.mkdir(otherDir, { recursive: true });
      await fs.writeFile(
        path.join(selfDir, "plugin.json"),
        JSON.stringify({ name: "agy-community-marketplace", version: "1.0.5" }),
        "utf8"
      );
      await fs.writeFile(
        path.join(otherDir, "plugin.json"),
        JSON.stringify({ name: "other-plugin", version: "1.0.0" }),
        "utf8"
      );

      const installed = await scanInstalledPlugins({
        store,
        workspaceRoot,
        catalogPlugins: [],
      });
      const projectInstalled = installed.filter((i) => i.scope === "project");
      assert.deepEqual(projectInstalled.map((i) => i.slug), ["other-plugin"]);
      assert.equal(installed.some((i) => i.slug === "agy-community-marketplace"), false);

      const counts = summarizeStatus(
        { plugins: [makeCatalogEntry("Domush/antigravity-community-marketplace", "agy-community-marketplace")] },
        { blockedRepos: [], blockedShas: [] },
        [{ id: "agy-community-marketplace", slug: "agy-community-marketplace", version: "1.0.5" }]
      );
      assert.equal(counts.total, 0);
      assert.equal(counts.installed, 0);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("excludes self from UI getFilteredPlugins across browse and installed tabs", () => {
    const prevCatalog = state.catalog;
    const prevInstalled = state.installed;
    const prevTab = state.tab;
    try {
      state.catalog = {
        plugins: [
          makeCatalogEntry("Domush/antigravity-community-marketplace", "agy-community-marketplace"),
          makeCatalogEntry("acme/clean-plugin", "clean-plugin"),
        ],
      };
      state.installed = [
        { id: "agy-community-marketplace", slug: "agy-community-marketplace", name: "agy-community-marketplace", version: "1.0.5" },
        { id: "acme/clean-plugin", slug: "clean-plugin", name: "clean-plugin", version: "1.0.5" },
      ];

      state.tab = "browse";
      assert.deepEqual(getFilteredPlugins().map((p) => p.id), ["acme/clean-plugin"]);

      state.tab = "installed";
      assert.deepEqual(getFilteredPlugins().map((p) => p.id), ["acme/clean-plugin"]);
    } finally {
      state.catalog = prevCatalog;
      state.installed = prevInstalled;
      state.tab = prevTab;
    }
  });
});
