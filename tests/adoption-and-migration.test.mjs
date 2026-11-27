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
} from "../server/lib/installer.mjs";
import { scanInstalledPlugins } from "../server/lib/scanner-local.mjs";
import { PluginStore } from "../server/lib/store.mjs";

// ---------------------------------------------------------------------------
// Offline Fixture, Tarball & Loopback HTTP Helpers
// ---------------------------------------------------------------------------
async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-adopt-test-"));
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

async function buildTarGz(fileMap, topDir = "acme-context-mode-1111") {
  const pack = tar.pack();
  const gzip = zlib.createGzip();
  const chunks = [];
  const finished = new Promise((resolve, reject) => {
    gzip.on("data", (c) => chunks.push(c));
    gzip.on("end", () => resolve(Buffer.concat(chunks)));
    gzip.on("error", reject);
    pack.on("error", reject);
  });
  pack.pipe(gzip);
  for (const [relPath, content] of Object.entries(fileMap)) {
    const body = typeof content === "string" ? content : JSON.stringify(content, null, 2) + "\n";
    pack.entry({ name: `${topDir}/${relPath}`, type: "file" }, body);
  }
  pack.finalize();
  return finished;
}

async function hashFileMap(fileMap) {
  return withTempDir(async (dir) => {
    await writeFiles(dir, fileMap);
    return computeContentTreeSha256(dir);
  });
}

async function withTarballServer(routeMap, fn) {
  const server = http.createServer((req, res) => {
    const buf = routeMap.get(req.url);
    if (!buf) {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }
    res.writeHead(200, { "Content-Type": "application/gzip" });
    res.end(buf);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
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
// 5. Atomic Legacy Folder Migration & Rollback on Hash Mismatch
// ---------------------------------------------------------------------------
describe("installPlugin — atomic legacy folder migration and rollback", () => {
  it("migrates a mixed-case active manual folder to owner--repo and updates lockfile without duplicates", async () => {
    const v2Files = {
      "plugin.json": { name: "context-mode", version: "2.0.0" },
      "skills/context-mode/SKILL.md": "# Verified v2.0.0\n",
    };
    const v2Hash = await hashFileMap(v2Files);
    const v2Tar = await buildTarGz(v2Files);

    await withTempDir(async (tmp) => {
      const store = new PluginStore(path.join(tmp, "data"));
      await store.init();
      const workspaceRoot = path.join(tmp, "workspace");
      const activeRoot = getPluginsDir("project", workspaceRoot, { enabled: true });
      const legacyDir = path.join(activeRoot, "ContextMode");

      // Seed mixed-case legacy manual folder
      await writeFiles(legacyDir, {
        "plugin.json": { name: "context-mode", version: "1.0.0" },
        "skills/context-mode/SKILL.md": "# Legacy v1.0.0\n",
      });

      await withTarballServer(new Map([["/v2", v2Tar]]), async (baseUrl) => {
        const entry = makeCatalogEntry({
          id: "acme-dev/context-mode",
          version: "2.0.0",
          sha: "2".repeat(40),
          tarballUrl: `${baseUrl}/v2`,
          contentTreeSha256: v2Hash,
        });

        const record = await installPlugin({
          pluginEntry: entry,
          denylist: { blockedRepos: [], blockedShas: [] },
          scope: "project",
          workspaceRoot,
          replaceSlug: "ContextMode",
          replaceEnabled: true,
        });

        assert.equal(record.slug, pluginSlug("acme-dev/context-mode"));
        assert.deepEqual(record.migratedFrom, { slug: "ContextMode", installPath: legacyDir });

        // Mirror server/index.mjs lockfile update
        const { migratedFrom, ...lockRecord } = record;
        await store.removeInstallRecord({
          slug: migratedFrom.slug,
          scope: "project",
          installPath: migratedFrom.installPath,
        });
        await store.upsertInstallRecord(lockRecord);

        // Legacy folder is gone; only canonical owner--repo folder remains
        const entries = await fs.readdir(activeRoot);
        assert.deepEqual(entries, ["acme-dev--context-mode"]);

        const installedSkill = await fs.readFile(
          path.join(record.installPath, "skills", "context-mode", "SKILL.md"),
          "utf8"
        );
        assert.equal(installedSkill, "# Verified v2.0.0\n");

        // Subsequent scan sees exactly one managed install
        const scanned = (
          await scanInstalledPlugins({ store, workspaceRoot, catalogPlugins: [entry] })
        ).filter((p) => p.scope === "project");
        assert.equal(scanned.length, 1);
        assert.equal(scanned[0].matchTier, "managed");
        assert.equal(scanned[0].manual, false);
        assert.equal(scanned[0].version, "2.0.0");
      });
    });
  });

  it("migrates a disabled legacy manual folder out of plugins-disabled/ into active owner--repo", async () => {
    const v2Files = {
      "plugin.json": { name: "context-mode", version: "2.0.0" },
      "rules/core.md": "Verified active copy",
    };
    const v2Hash = await hashFileMap(v2Files);
    const v2Tar = await buildTarGz(v2Files);

    await withTempDir(async (tmp) => {
      const workspaceRoot = path.join(tmp, "workspace");
      const activeRoot = getPluginsDir("project", workspaceRoot, { enabled: true });
      const disabledRoot = getPluginsDir("project", workspaceRoot, { enabled: false });
      const disabledLegacyDir = path.join(disabledRoot, "context-mode");

      await writeFiles(disabledLegacyDir, {
        "plugin.json": { name: "context-mode", version: "1.0.0" },
        "rules/core.md": "Paused legacy copy",
      });

      await withTarballServer(new Map([["/v2", v2Tar]]), async (baseUrl) => {
        const record = await installPlugin({
          pluginEntry: makeCatalogEntry({
            id: "acme-dev/context-mode",
            version: "2.0.0",
            sha: "2".repeat(40),
            tarballUrl: `${baseUrl}/v2`,
            contentTreeSha256: v2Hash,
          }),
          denylist: { blockedRepos: [], blockedShas: [] },
          scope: "project",
          workspaceRoot,
          replaceSlug: "context-mode",
          replaceEnabled: false,
        });

        assert.equal(record.enabled, true);
        assert.deepEqual(await fs.readdir(activeRoot), ["acme-dev--context-mode"]);
        assert.deepEqual(await fs.readdir(disabledRoot), []);
      });
    });
  });

  it("preserves the legacy manual folder completely untouched on contentTreeSha256 mismatch and rejects traversal replaceSlug", async () => {
    const tamperedTar = await buildTarGz({
      "plugin.json": { name: "context-mode", version: "2.0.0" },
      "rules/core.md": "TAMPERED BYTES",
    });

    await withTempDir(async (tmp) => {
      const workspaceRoot = path.join(tmp, "workspace");
      const activeRoot = getPluginsDir("project", workspaceRoot, { enabled: true });
      const legacyDir = path.join(activeRoot, "ContextMode");

      await writeFiles(legacyDir, {
        "plugin.json": { name: "context-mode", version: "1.0.0" },
        "rules/local-edits.md": "Preserve my custom edits!",
      });

      await withTarballServer(new Map([["/tampered", tamperedTar]]), async (baseUrl) => {
        // 1. Path traversal in replaceSlug must fail immediately before touching disk
        await assert.rejects(
          () =>
            installPlugin({
              pluginEntry: makeCatalogEntry({
                id: "acme-dev/context-mode",
                version: "2.0.0",
                sha: "2".repeat(40),
                tarballUrl: `${baseUrl}/tampered`,
                contentTreeSha256: "e".repeat(64),
              }),
              denylist: { blockedRepos: [], blockedShas: [] },
              scope: "project",
              workspaceRoot,
              replaceSlug: "../outside",
              replaceEnabled: true,
            }),
          /Invalid plugin folder slug/
        );

        // 2. Hash mismatch during adoption leaves legacy manual folder intact with zero leftover temp/backup dirs
        await assert.rejects(
          () =>
            installPlugin({
              pluginEntry: makeCatalogEntry({
                id: "acme-dev/context-mode",
                version: "2.0.0",
                sha: "2".repeat(40),
                tarballUrl: `${baseUrl}/tampered`,
                contentTreeSha256: "e".repeat(64),
              }),
              denylist: { blockedRepos: [], blockedShas: [] },
              scope: "project",
              workspaceRoot,
              replaceSlug: "ContextMode",
              replaceEnabled: true,
            }),
          /Integrity mismatch/
        );

        const remaining = await fs.readdir(activeRoot);
        assert.deepEqual(remaining, ["ContextMode"]);

        const preserved = await fs.readFile(path.join(legacyDir, "rules", "local-edits.md"), "utf8");
        assert.equal(preserved, "Preserve my custom edits!");
      });
    });
  });
});
