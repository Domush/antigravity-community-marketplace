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
  getProjectPluginsDir,
  installPlugin,
  pluginSlug,
  uninstallPlugin,
} from "../server/lib/installer.mjs";
import { detectLiveCollisions, scanInstalledPlugins } from "../server/lib/scanner-local.mjs";
import { PluginStore } from "../server/lib/store.mjs";

// ---------------------------------------------------------------------------
// Offline Tarball, Hash & Loopback HTTP Server Helpers
// ---------------------------------------------------------------------------
async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-client-test-"));
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

  const finished = new Promise((resolve, reject) => {
    gzip.on("data", (chunk) => chunks.push(chunk));
    gzip.on("end", () => resolve(Buffer.concat(chunks)));
    gzip.on("error", reject);
    pack.on("error", reject);
  });

  pack.pipe(gzip);

  for (const entry of entries) {
    const name = entry.rawName ?? `${topDir}/${entry.path}`;
    if (entry.type === "symlink") {
      pack.entry({ name, type: "symlink", linkname: entry.linkname });
    } else {
      const content =
        typeof entry.content === "string"
          ? entry.content
          : JSON.stringify(entry.content, null, 2) + "\n";
      pack.entry({ name, type: "file" }, content);
    }
  }

  pack.finalize();
  return finished;
}

async function computeHashForEntries(entries) {
  return withTempDir(async (dir) => {
    for (const entry of entries) {
      if (entry.type === "symlink") continue;
      const abs = path.join(dir, ...entry.path.split("/"));
      await fs.mkdir(path.dirname(abs), { recursive: true });
      const content =
        typeof entry.content === "string"
          ? entry.content
          : JSON.stringify(entry.content, null, 2) + "\n";
      await fs.writeFile(abs, content, "utf8");
    }
    return computeContentTreeSha256(dir);
  });
}

async function withLocalTarballServer(routes, fn) {
  const hits = new Map();
  const server = http.createServer((req, res) => {
    hits.set(req.url, (hits.get(req.url) || 0) + 1);
    const body = routes.get(req.url);
    if (!body) {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }
    res.writeHead(200, { "Content-Type": "application/gzip" });
    res.end(body);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    return await fn({ baseUrl, hits });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function makePluginEntry({ id, version, sha, tarballUrl, contentTreeSha256, capabilities = ["prompt_rules_only"] }) {
  return {
    id,
    version,
    release: { sha, tarballUrl, contentTreeSha256 },
    security: { capabilities },
  };
}

// ---------------------------------------------------------------------------
// 1. Installer: Verified Install, Hash Mismatch Rollback & Archive Hardening
// ---------------------------------------------------------------------------
describe("server/lib/installer.mjs — verification, rollback, and hardening", () => {
  it("installs a verified tarball cleanly and rolls back intact on contentTreeSha256 mismatch during update", async () => {
    const v1Entries = [
      { path: "plugin.json", content: { name: "unity-helper", version: "1.0.0" } },
      { path: "skills/uitk-check/SKILL.md", content: "# UITK Check v1" },
    ];
    const v2TamperedEntries = [
      { path: "plugin.json", content: { name: "unity-helper", version: "2.0.0" } },
      { path: "skills/uitk-check/SKILL.md", content: "# TAMPERED PAYLOAD" },
    ];

    const v1Hash = await computeHashForEntries(v1Entries);
    const v1Tar = await buildTarGz(v1Entries, "acme-unity-1111");
    const v2TamperedTar = await buildTarGz(v2TamperedEntries, "acme-unity-2222");

    const routes = new Map([
      ["/tarball/v1", v1Tar],
      ["/tarball/v2-tampered", v2TamperedTar],
    ]);

    await withTempDir(async (workspaceRoot) => {
      await withLocalTarballServer(routes, async ({ baseUrl }) => {
        const emptyDenylist = { blockedRepos: [], blockedShas: [] };

        // Step 1: Clean v1.0.0 install
        const record = await installPlugin({
          pluginEntry: makePluginEntry({
            id: "acme-dev/agy-unity-helper",
            version: "1.0.0",
            sha: "1".repeat(40),
            tarballUrl: `${baseUrl}/tarball/v1`,
            contentTreeSha256: v1Hash,
          }),
          denylist: emptyDenylist,
          scope: "project",
          workspaceRoot,
        });

        assert.equal(record.slug, "acme-dev--agy-unity-helper");
        assert.equal(record.version, "1.0.0");
        assert.equal(record.contentTreeSha256, v1Hash);

        const skillPath = path.join(record.installPath, "skills", "uitk-check", "SKILL.md");
        assert.equal(await fs.readFile(skillPath, "utf8"), "# UITK Check v1");

        // Step 2: Attempt v2.0.0 update where tarball bytes disagree with expected contentTreeSha256
        await assert.rejects(
          () =>
            installPlugin({
              pluginEntry: makePluginEntry({
                id: "acme-dev/agy-unity-helper",
                version: "2.0.0",
                sha: "2".repeat(40),
                tarballUrl: `${baseUrl}/tarball/v2-tampered`,
                contentTreeSha256: "f".repeat(64), // Deliberate mismatch
              }),
              denylist: emptyDenylist,
              scope: "project",
              workspaceRoot,
            }),
          /Integrity mismatch/
        );

        // Verify v1.0.0 remained completely untouched on disk
        const manifestAfter = JSON.parse(
          await fs.readFile(path.join(record.installPath, "plugin.json"), "utf8")
        );
        assert.equal(manifestAfter.version, "1.0.0");
        assert.equal(await fs.readFile(skillPath, "utf8"), "# UITK Check v1");

        // Verify staging (.tmp) and backup (.bak) directories were cleaned up
        const dirEntries = await fs.readdir(getProjectPluginsDir(workspaceRoot));
        assert.deepEqual(dirEntries, ["acme-dev--agy-unity-helper"]);
      });
    });
  });

  it("rejects archives containing symlinks or zip-slip traversal paths before leaving staging", async () => {
    const symlinkTar = await buildTarGz([
      { path: "plugin.json", content: { name: "bad-link", version: "1.0.0" } },
      { path: "escape", type: "symlink", linkname: "/etc/passwd" },
    ]);
    const zipSlipTar = await buildTarGz([
      { rawName: "repo-head/../../pwned.txt", content: "escaped!" },
    ]);

    const routes = new Map([
      ["/tarball/symlink", symlinkTar],
      ["/tarball/zipslip", zipSlipTar],
    ]);

    await withTempDir(async (workspaceRoot) => {
      await withLocalTarballServer(routes, async ({ baseUrl }) => {
        const emptyDenylist = { blockedRepos: [], blockedShas: [] };

        await assert.rejects(
          () =>
            installPlugin({
              pluginEntry: makePluginEntry({
                id: "evil/symlink-plugin",
                version: "1.0.0",
                sha: "a".repeat(40),
                tarballUrl: `${baseUrl}/tarball/symlink`,
                contentTreeSha256: "0".repeat(64),
              }),
              denylist: emptyDenylist,
              scope: "project",
              workspaceRoot,
            }),
          /Refused archive link entry/
        );

        await assert.rejects(
          () =>
            installPlugin({
              pluginEntry: makePluginEntry({
                id: "evil/zipslip-plugin",
                version: "1.0.0",
                sha: "b".repeat(40),
                tarballUrl: `${baseUrl}/tarball/zipslip`,
                contentTreeSha256: "0".repeat(64),
              }),
              denylist: emptyDenylist,
              scope: "project",
              workspaceRoot,
            }),
          /Zip-slip path rejected/
        );

        // Confirm nothing escaped into workspace root or lingered in .agents/plugins
        await assert.rejects(() => fs.access(path.join(workspaceRoot, "pwned.txt")));
        const pluginsEntries = await fs.readdir(getProjectPluginsDir(workspaceRoot));
        assert.deepEqual(pluginsEntries, []);
      });
    });
  });

  it("uninstalls cleanly and blocks path-traversal slugs", async () => {
    await withTempDir(async (workspaceRoot) => {
      const pluginsDir = getProjectPluginsDir(workspaceRoot);
      const target = path.join(pluginsDir, "demo--plugin");
      await fs.mkdir(target, { recursive: true });
      await fs.writeFile(path.join(target, "plugin.json"), '{"name":"demo","version":"1.0.0"}');

      await assert.rejects(
        () => uninstallPlugin({ slug: "../escape", scope: "project", workspaceRoot }),
        /Invalid plugin folder slug|Zip-slip/
      );
      await assert.rejects(
        () => uninstallPlugin({ slug: "..", scope: "project", workspaceRoot }),
        /Invalid plugin folder slug|Zip-slip/
      );

      await uninstallPlugin({ slug: "demo--plugin", scope: "project", workspaceRoot });
      await assert.rejects(() => fs.access(target));
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Installer: Pre-Download Denylist Enforcement
// ---------------------------------------------------------------------------
describe("server/lib/installer.mjs — denylist blocking", () => {
  it("blocks denylisted repos and SHAs before making any HTTP download request", async () => {
    const cleanEntries = [{ path: "plugin.json", content: { name: "good", version: "1.0.1" } }];
    const cleanHash = await computeHashForEntries(cleanEntries);
    const cleanTar = await buildTarGz(cleanEntries);

    const routes = new Map([
      ["/tarball/blocked-repo", cleanTar],
      ["/tarball/blocked-sha", cleanTar],
      ["/tarball/safe-sha", cleanTar],
    ]);

    const badSha = "d".repeat(40);
    const safeSha = "e".repeat(40);
    const denylist = {
      blockedRepos: [
        { id: "Bad-Actor/Stealer", reason: "Credential theft", severity: "critical" },
      ],
      blockedShas: [
        { id: "legit-dev/tool", sha: badSha, reason: "Compromised release commit", severity: "critical" },
      ],
    };

    await withTempDir(async (workspaceRoot) => {
      await withLocalTarballServer(routes, async ({ baseUrl, hits }) => {
        // 1. Case-insensitive repo block must abort before fetch()
        await assert.rejects(
          () =>
            installPlugin({
              pluginEntry: makePluginEntry({
                id: "bad-actor/stealer",
                version: "1.0.0",
                sha: "1".repeat(40),
                tarballUrl: `${baseUrl}/tarball/blocked-repo`,
                contentTreeSha256: cleanHash,
              }),
              denylist,
              scope: "project",
              workspaceRoot,
            }),
          /Blocked by registry denylist: Credential theft/
        );
        assert.equal(hits.get("/tarball/blocked-repo"), undefined);

        // 2. Blocked SHA must abort before fetch()
        await assert.rejects(
          () =>
            installPlugin({
              pluginEntry: makePluginEntry({
                id: "legit-dev/tool",
                version: "1.0.0",
                sha: badSha,
                tarballUrl: `${baseUrl}/tarball/blocked-sha`,
                contentTreeSha256: cleanHash,
              }),
              denylist,
              scope: "project",
              workspaceRoot,
            }),
          /Release SHA blocked by denylist: Compromised release commit/
        );
        assert.equal(hits.get("/tarball/blocked-sha"), undefined);

        // 3. Later safe SHA for the same repo succeeds
        const ok = await installPlugin({
          pluginEntry: makePluginEntry({
            id: "legit-dev/tool",
            version: "1.0.1",
            sha: safeSha,
            tarballUrl: `${baseUrl}/tarball/safe-sha`,
            contentTreeSha256: cleanHash,
          }),
          denylist,
          scope: "project",
          workspaceRoot,
        });
        assert.equal(ok.version, "1.0.1");
        assert.equal(hits.get("/tarball/safe-sha"), 1);
      });
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Local Scanner & Live Collision Detection
// ---------------------------------------------------------------------------
describe("server/lib/scanner-local.mjs — local discovery and collision warnings", () => {
  it("discovers managed and manual plugins, ignores staging dirs, flags slash/MCP/agent collisions, and ignores shared hookEvents", async () => {
    await withTempDir(async (tmp) => {
      const dataDir = path.join(tmp, "plugin-data");
      const workspaceRoot = path.join(tmp, "workspace");
      const pluginsDir = getProjectPluginsDir(workspaceRoot);
      const store = new PluginStore(dataDir);
      await store.init();

      // 1. Managed plugin recorded in lockfile.json
      const managedSlug = pluginSlug("acme-dev/agy-unity-helper");
      const managedDir = path.join(pluginsDir, managedSlug);
      await fs.mkdir(path.join(managedDir, "skills", "uitk-folder"), { recursive: true });
      await fs.mkdir(path.join(managedDir, "agents"), { recursive: true });
      await fs.writeFile(
        path.join(managedDir, "plugin.json"),
        JSON.stringify({ name: "unity-helper", version: "1.4.0" })
      );
      await fs.writeFile(
        path.join(managedDir, "mcp_config.json"),
        JSON.stringify({ mcpServers: { "unity-mcp": { command: "node", args: ["server.mjs"] } } })
      );
      await fs.writeFile(
        path.join(managedDir, "hooks.json"),
        JSON.stringify({
          "unity-guard": {
            PreToolUse: [{ matcher: "*", hooks: [] }],
          },
          "paused-group": {
            enabled: false,
            Stop: [{ matcher: "*", hooks: [] }],
          },
        })
      );
      await fs.writeFile(
        path.join(managedDir, "skills", "uitk-folder", "SKILL.md"),
        "---\nname: uitk-check\ndescription: Validates UXML flex layouts.\n---\n# UITK Check\n"
      );
      await fs.writeFile(
        path.join(managedDir, "agents", "shader-reviewer.md"),
        "---\nname: shader-reviewer\ndescription: Reviews URP shaders.\n---\nCheck precision.\n"
      );

      await store.upsertInstallRecord({
        id: "acme-dev/agy-unity-helper",
        slug: managedSlug,
        scope: "project",
        installPath: managedDir,
        version: "1.4.0",
        sha: "9".repeat(40),
        contentTreeSha256: "8".repeat(64),
        capabilities: ["mcp_local_exec", "runs_shell_hooks"],
        installedAt: "2026-11-26T20:00:00Z",
      });

      // 2. Manual plugin dropped directly into .agents/plugins (not in lockfile)
      const manualDir = path.join(pluginsDir, "custom-manual-kit");
      await fs.mkdir(path.join(manualDir, "skills", "deploy-check"), { recursive: true });
      await fs.writeFile(
        path.join(manualDir, "plugin.json"),
        JSON.stringify({ name: "custom-manual-kit", version: "0.2.0" })
      );
      await fs.writeFile(
        path.join(manualDir, "skills", "deploy-check", "SKILL.md"),
        "# Deploy Check"
      );

      // 3. Temp staging and backup leftovers that must be ignored
      await fs.mkdir(path.join(pluginsDir, ".tmp-staging"), { recursive: true });
      await fs.mkdir(path.join(pluginsDir, "old-plugin.bak.12345"), { recursive: true });

      // Filter to project scope so any real global plugins on the host machine don't affect assertions
      const allInstalled = await scanInstalledPlugins({ store, workspaceRoot });
      const projectInstalled = allInstalled.filter((p) => p.scope === "project");

      assert.equal(projectInstalled.length, 2);

      const managed = projectInstalled.find((p) => p.slug === managedSlug);
      assert.equal(managed.manual, false);
      assert.equal(managed.id, "acme-dev/agy-unity-helper");
      assert.equal(managed.sha, "9".repeat(40));
      assert.deepEqual(managed.surfaces.slashCommands, ["/uitk-check"]);
      assert.deepEqual(managed.surfaces.mcpServerNames, ["unity-helper_unity-mcp"]);
      assert.deepEqual(managed.surfaces.hookEvents, ["PreToolUse"]);
      assert.deepEqual(managed.surfaces.agentNames, ["shader-reviewer"]);

      const manual = projectInstalled.find((p) => p.slug === "custom-manual-kit");
      assert.equal(manual.manual, true);
      assert.deepEqual(manual.surfaces.slashCommands, ["/deploy-check"]);

      // 4. Candidate plugin colliding with both managed and manual plugins
      const warnings = detectLiveCollisions({
        candidateId: "other-author/conflicting-plugin",
        candidateCollisions: {
          slashCommands: ["/uitk-check", "/deploy-check", "/unique-cmd"],
          mcpServerNames: ["unity-helper_unity-mcp"],
          hookEvents: ["PreToolUse"],
          agentNames: ["shader-reviewer"],
        },
        installedPlugins: projectInstalled,
      });

      assert.equal(warnings.length, 4);
      assert.ok(warnings.some((w) => w.includes('Slash command "/uitk-check"') && w.includes("unity-helper")));
      assert.ok(warnings.some((w) => w.includes('Slash command "/deploy-check"') && w.includes("custom-manual-kit")));
      assert.ok(warnings.some((w) => w.includes('MCP server name "unity-helper_unity-mcp"')));
      assert.equal(warnings.some((w) => w.includes("PreToolUse") || w.includes("Lifecycle hook")), false);
      assert.ok(warnings.some((w) => w.includes('Custom agent "shader-reviewer"')));

      // 5. Self-collision exclusion: updating acme-dev/agy-unity-helper in place must emit 0 warnings
      const selfWarnings = detectLiveCollisions({
        candidateId: "acme-dev/agy-unity-helper",
        candidateCollisions: {
          slashCommands: ["/uitk-check"],
          mcpServerNames: ["unity-helper_unity-mcp"],
          hookEvents: ["PreToolUse"],
          agentNames: ["shader-reviewer"],
        },
        installedPlugins: projectInstalled,
      });
      assert.deepEqual(selfWarnings, []);
    });
  });
});
