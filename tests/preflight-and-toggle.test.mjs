import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import zlib from "node:zlib";
import tar from "tar-stream";
import {
  computeContentTreeSha256,
  getPluginsDir,
  installPlugin,
  pluginSlug,
  setPluginEnabled,
  uninstallPlugin,
} from "../server/lib/installer.mjs";
import { detectLiveCollisions, scanInstalledPlugins } from "../server/lib/scanner-local.mjs";
import { PluginStore } from "../server/lib/store.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-toggle-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function buildTarGz(entries, topDir = "owner-repo-deadbeef") {
  const pack = tar.pack();
  const gzip = zlib.createGzip();
  const chunks = [];
  const done = new Promise((resolve, reject) => {
    gzip.on("data", (c) => chunks.push(c));
    gzip.on("end", () => resolve(Buffer.concat(chunks)));
    gzip.on("error", reject);
    pack.on("error", reject);
  });
  pack.pipe(gzip);
  for (const e of entries) {
    const content =
      typeof e.content === "string" ? e.content : JSON.stringify(e.content, null, 2) + "\n";
    pack.entry({ name: `${topDir}/${e.path}`, type: "file" }, content);
  }
  pack.finalize();
  return done;
}

async function hashEntries(entries) {
  return withTempDir(async (dir) => {
    for (const e of entries) {
      const abs = path.join(dir, ...e.path.split("/"));
      await fs.mkdir(path.dirname(abs), { recursive: true });
      const content =
        typeof e.content === "string" ? e.content : JSON.stringify(e.content, null, 2) + "\n";
      await fs.writeFile(abs, content, "utf8");
    }
    return computeContentTreeSha256(dir);
  });
}

async function withTarballServer(tarballBuf, fn) {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/gzip" });
    res.end(tarballBuf);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}/tarball`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// ---------------------------------------------------------------------------
// Non-Destructive Enable / Disable Toggling & Collision Isolation
// ---------------------------------------------------------------------------
describe("Non-destructive Enable/Disable toggle — installer.mjs, store.mjs, scanner-local.mjs", () => {
  it("disables and re-enables a plugin without losing files, updates lockfile, and silences collisions while disabled", async () => {
    await withTempDir(async (tmp) => {
      const dataDir = path.join(tmp, "plugin-data");
      const workspaceRoot = path.join(tmp, "workspace");
      const store = new PluginStore(dataDir);
      await store.init();

      const id = "acme-dev/agy-unity-helper";
      const slug = pluginSlug(id);
      const activeDir = path.join(getPluginsDir("project", workspaceRoot, { enabled: true }), slug);
      const disabledDir = path.join(getPluginsDir("project", workspaceRoot, { enabled: false }), slug);

      // Seed active plugin + user-customized config file inside the plugin directory
      await fs.mkdir(path.join(activeDir, "skills", "uitk-check"), { recursive: true });
      await fs.writeFile(
        path.join(activeDir, "plugin.json"),
        JSON.stringify({ name: "unity-helper", version: "1.4.0" })
      );
      await fs.writeFile(
        path.join(activeDir, "mcp_config.json"),
        JSON.stringify({ mcpServers: { "unity-mcp": { command: "node", args: ["server.mjs"] } } })
      );
      await fs.writeFile(
        path.join(activeDir, "skills", "uitk-check", "SKILL.md"),
        "# UITK Check"
      );
      await fs.writeFile(
        path.join(activeDir, "user-settings.local.json"),
        JSON.stringify({ strictFlex: true })
      );

      await store.upsertInstallRecord({
        id,
        slug,
        scope: "project",
        installPath: activeDir,
        enabled: true,
        version: "1.4.0",
        sha: "a".repeat(40),
        contentTreeSha256: "b".repeat(64),
        capabilities: ["mcp_local_exec"],
        installedAt: "2026-11-26T20:00:00Z",
      });

      const candidateCollisions = {
        slashCommands: ["/uitk-check"],
        mcpServerNames: ["unity-helper_unity-mcp"],
        hookEvents: [],
      };

      // Baseline: active plugin triggers 2 collision warnings
      let projectInstalls = (await scanInstalledPlugins({ store, workspaceRoot })).filter(
        (p) => p.scope === "project"
      );
      assert.equal(projectInstalls.length, 1);
      assert.equal(projectInstalls[0].enabled, true);
      assert.equal(projectInstalls[0].manual, false);
      assert.equal(
        detectLiveCollisions({
          candidateId: "other-author/rival",
          candidateCollisions,
          installedPlugins: projectInstalls,
        }).length,
        2
      );

      // --- DISABLE ---
      const disabledMove = await setPluginEnabled({
        slug,
        scope: "project",
        workspaceRoot,
        enabled: false,
      });
      await store.updateInstallEnabled({
        slug,
        scope: "project",
        fromPath: disabledMove.fromPath,
        installPath: disabledMove.installPath,
        enabled: false,
      });

      // Active folder is gone; disabled folder retains all files including local settings
      await assert.rejects(() => fs.access(activeDir));
      const preservedConfig = JSON.parse(
        await fs.readFile(path.join(disabledDir, "user-settings.local.json"), "utf8")
      );
      assert.deepEqual(preservedConfig, { strictFlex: true });

      // Scanner still finds it as managed (not manual), marked enabled: false
      projectInstalls = (await scanInstalledPlugins({ store, workspaceRoot })).filter(
        (p) => p.scope === "project"
      );
      assert.equal(projectInstalls.length, 1);
      assert.equal(projectInstalls[0].enabled, false);
      assert.equal(projectInstalls[0].manual, false);
      assert.equal(projectInstalls[0].installPath, disabledDir);

      // Disabled plugin must NOT trigger live collision warnings
      const collisionsWhileDisabled = detectLiveCollisions({
        candidateId: "other-author/rival",
        candidateCollisions,
        installedPlugins: projectInstalls,
      });
      assert.deepEqual(collisionsWhileDisabled, []);

      // Lockfile persisted enabled: false and new installPath
      const lockWhileDisabled = await store.getLockfile();
      assert.equal(lockWhileDisabled.installs[0].enabled, false);
      assert.equal(lockWhileDisabled.installs[0].installPath, disabledDir);

      // --- RE-ENABLE ---
      const enabledMove = await setPluginEnabled({
        slug,
        scope: "project",
        workspaceRoot,
        enabled: true,
      });
      await store.updateInstallEnabled({
        slug,
        scope: "project",
        fromPath: enabledMove.fromPath,
        installPath: enabledMove.installPath,
        enabled: true,
      });

      await assert.rejects(() => fs.access(disabledDir));
      await fs.access(path.join(activeDir, "user-settings.local.json"));

      projectInstalls = (await scanInstalledPlugins({ store, workspaceRoot })).filter(
        (p) => p.scope === "project"
      );
      assert.equal(projectInstalls.length, 1);
      assert.equal(projectInstalls[0].enabled, true);
      assert.equal(projectInstalls[0].manual, false);

      // Collisions resume immediately once re-enabled
      assert.equal(
        detectLiveCollisions({
          candidateId: "other-author/rival",
          candidateCollisions,
          installedPlugins: projectInstalls,
        }).length,
        2
      );
    });
  });

  it("rejects invalid toggles and traversal slugs, and supports uninstalling a disabled plugin directly", async () => {
    await withTempDir(async (workspaceRoot) => {
      const slug = "demo--paused";
      const disabledDir = path.join(getPluginsDir("project", workspaceRoot, { enabled: false }), slug);
      await fs.mkdir(disabledDir, { recursive: true });
      await fs.writeFile(
        path.join(disabledDir, "plugin.json"),
        JSON.stringify({ name: "paused", version: "1.0.0" })
      );

      // Path traversal rejected
      await assert.rejects(
        () => setPluginEnabled({ slug: "../escape", scope: "project", workspaceRoot, enabled: true }),
        /Invalid plugin folder slug/
      );

      // Disabling an already-disabled plugin fails clearly
      await assert.rejects(
        () => setPluginEnabled({ slug, scope: "project", workspaceRoot, enabled: false }),
        /not currently enabled/
      );

      // Uninstalling directly from disabled scope removes the disabled directory cleanly
      await uninstallPlugin({ slug, scope: "project", workspaceRoot, enabled: false });
      await assert.rejects(() => fs.access(disabledDir));
    });
  });

  it("cleans up a stale disabled copy when reinstalling the same plugin via installPlugin()", async () => {
    const entries = [
      { path: "plugin.json", content: { name: "fresh-kit", version: "2.0.0" } },
      { path: "rules/style.md", content: "Use flex layouts." },
    ];
    const treeHash = await hashEntries(entries);
    const tarBuf = await buildTarGz(entries);

    await withTempDir(async (workspaceRoot) => {
      const id = "acme-dev/fresh-kit";
      const slug = pluginSlug(id);

      // Seed an older disabled v1.0.0 copy in .agents/plugins-disabled/
      const staleDisabledDir = path.join(
        getPluginsDir("project", workspaceRoot, { enabled: false }),
        slug
      );
      await fs.mkdir(staleDisabledDir, { recursive: true });
      await fs.writeFile(
        path.join(staleDisabledDir, "plugin.json"),
        JSON.stringify({ name: "fresh-kit", version: "1.0.0" })
      );

      await withTarballServer(tarBuf, async (tarballUrl) => {
        const record = await installPlugin({
          pluginEntry: {
            id,
            version: "2.0.0",
            release: { sha: "c".repeat(40), tarballUrl, contentTreeSha256: treeHash },
            security: { capabilities: ["prompt_rules_only"] },
          },
          denylist: { blockedRepos: [], blockedShas: [] },
          scope: "project",
          workspaceRoot,
        });

        assert.equal(record.enabled, true);
        assert.equal(record.version, "2.0.0");

        // Active install exists, and stale disabled copy was removed so no duplicate appears
        await fs.access(path.join(record.installPath, "plugin.json"));
        await assert.rejects(() => fs.access(staleDisabledDir));
      });
    });
  });
});
