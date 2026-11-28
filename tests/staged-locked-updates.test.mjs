import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
  moveDirAtomic,
  PluginBusyLockError,
} from "../server/lib/installer.mjs";
import { applyPendingUpdates } from "../server/lib/pending-updates.mjs";
import { runPendingWorker } from "../server/lib/pending-worker.mjs";
import { hasPendingUpdatesSync, PluginStore } from "../server/lib/store.mjs";

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-staged-lock-"));
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

async function buildTarGz(fileMap, topDir = "domush-context-mode-1111") {
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

function makeErr(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

function makeEntry({ id, version, sha, tarballUrl, contentTreeSha256 }) {
  return {
    id,
    name: "Context Mode",
    pluginName: "context-mode",
    version,
    author: { login: id.split("/")[0] },
    release: { sha, tarballUrl, contentTreeSha256 },
    stats: { stars: 42 },
    security: { riskTier: "elevated", capabilities: ["mcp_local_exec"] },
  };
}

describe("moveDirAtomic — EBUSY in-place sync fallback and locked-file preservation", () => {
  it("falls back to in-place sync when destDir handle is locked with EBUSY", async () => {
    await withTempDir(async (tmp) => {
      const srcDir = path.join(tmp, ".stage.tmp");
      const destDir = path.join(tmp, "domush--context-mode");

      await writeFiles(destDir, {
        "plugin.json": { name: "context-mode", version: "1.0.0" },
        "stale.txt": "remove me",
      });
      await writeFiles(srcDir, {
        "plugin.json": { name: "context-mode", version: "2.0.0" },
        "fresh.txt": "new file",
      });

      const lockedFs = {
        ...fs,
        async rename(from, to) {
          if (path.resolve(from) === path.resolve(destDir)) {
            throw makeErr("EBUSY", `EBUSY: resource busy or locked, rename '${from}' -> '${to}'`);
          }
          return fs.rename(from, to);
        },
      };

      const outcome = await moveDirAtomic(srcDir, destDir, { fsOps: lockedFs });
      assert.equal(outcome.syncedInPlace, true);

      const pkg = JSON.parse(await fs.readFile(path.join(destDir, "plugin.json"), "utf8"));
      assert.equal(pkg.version, "2.0.0");
      assert.equal(await fs.readFile(path.join(destDir, "fresh.txt"), "utf8"), "new file");
      await assert.rejects(() => fs.access(path.join(destDir, "stale.txt")), { code: "ENOENT" });
      await assert.rejects(() => fs.access(srcDir), { code: "ENOENT" });
    });
  });

  it("throws PluginBusyLockError and preserves srcDir when files inside destDir remain locked", async () => {
    await withTempDir(async (tmp) => {
      const srcDir = path.join(tmp, ".stage.tmp");
      const destDir = path.join(tmp, "domush--context-mode");

      await writeFiles(destDir, { "plugin.json": { name: "context-mode", version: "1.0.0" } });
      await writeFiles(srcDir, { "plugin.json": { name: "context-mode", version: "2.0.0" } });

      const lockedFs = {
        ...fs,
        async rename() {
          throw makeErr("EBUSY", "EBUSY: dir locked");
        },
      };

      await assert.rejects(
        () =>
          moveDirAtomic(srcDir, destDir, {
            fsOps: lockedFs,
            syncDirFn() {
              throw makeErr("EBUSY", "EBUSY: active sqlite/binary file locked");
            },
          }),
        (err) => err instanceof PluginBusyLockError && err.code === "EBUSY"
      );

      // Staging dir must remain intact so shutdown worker can apply it later
      const staged = JSON.parse(await fs.readFile(path.join(srcDir, "plugin.json"), "utf8"));
      assert.equal(staged.version, "2.0.0");
    });
  });
});

describe("installPlugin + applyPendingUpdates — staged restart migration on EBUSY", () => {
  it("stages legacy migration on EBUSY and completes swap automatically once lock clears", async () => {
    const v2Files = {
      "plugin.json": { name: "context-mode", version: "2.0.0" },
      "skills/context-mode/SKILL.md": "# v2.0.0\n",
    };
    const v2Hash = await hashFileMap(v2Files);
    const v2Tar = await buildTarGz(v2Files);

    await withTempDir(async (tmp) => {
      const store = new PluginStore(path.join(tmp, "data"));
      await store.init();
      const workspaceRoot = path.join(tmp, "workspace");
      const activeRoot = getPluginsDir("project", workspaceRoot, { enabled: true });
      const legacyDir = path.join(activeRoot, "context-mode");

      await writeFiles(legacyDir, {
        "plugin.json": { name: "context-mode", version: "1.0.0" },
        "skills/context-mode/SKILL.md": "# v1.0.0\n",
      });

      await withTarballServer(new Map([["/v2", v2Tar]]), async (baseUrl) => {
        const entry = makeEntry({
          id: "Domush/antigravity-plugin-context-mode",
          version: "2.0.0",
          sha: "2".repeat(40),
          tarballUrl: `${baseUrl}/v2`,
          contentTreeSha256: v2Hash,
        });

        let legacyLocked = true;
        const lockedLegacyFs = {
          ...fs,
          async rename(from, to) {
            if (legacyLocked && path.resolve(from) === path.resolve(legacyDir)) {
              throw makeErr("EBUSY", `EBUSY: resource busy or locked, rename '${from}' -> '${to}'`);
            }
            return fs.rename(from, to);
          },
        };

        const pendingStageRoot = path.join(store.dataDir, "pending-stages");
        const result = await installPlugin({
          pluginEntry: entry,
          denylist: { blockedRepos: [], blockedShas: [] },
          scope: "project",
          workspaceRoot,
          replaceSlug: "context-mode",
          replaceEnabled: true,
          pendingStageRoot,
          fsOps: lockedLegacyFs,
        });

        assert.equal(result.status, "pending_restart");
        assert.equal(result.pendingUpdate.legacyDir, legacyDir);
        assert.equal(path.dirname(result.pendingUpdate.stageDir), pendingStageRoot);
        assert.deepEqual(await fs.readdir(activeRoot), ["context-mode"]);
        await store.upsertPendingUpdate(result.pendingUpdate);
        assert.equal(hasPendingUpdatesSync(store.dataDir), true);

        // Stage dir and legacy dir both remain intact while Antigravity is running
        assert.equal(await fs.access(result.pendingUpdate.stageDir).then(() => true).catch(() => false), true);
        assert.equal(await fs.access(legacyDir).then(() => true).catch(() => false), true);

        // Attempt reconciliation while lock is still held -> stays pending
        const stillBusy = await applyPendingUpdates({ store, fsOps: lockedLegacyFs, logger: null });
        assert.equal(stillBusy.applied.length, 0);
        assert.equal(stillBusy.stillLocked.length, 1);

        // Antigravity shuts down -> lock clears -> worker applies pending update
        legacyLocked = false;
        const workerRes = await runPendingWorker({
          dataDir: store.dataDir,
          maxWaitMs: 500,
          pollMs: 10,
        });

        assert.equal(workerRes.acquired, true);
        assert.equal(workerRes.applied.length, 1);
        assert.equal(workerRes.stillLocked.length, 0);
        assert.equal(hasPendingUpdatesSync(store.dataDir), false);

        const entries = await fs.readdir(activeRoot);
        assert.deepEqual(entries, ["domush--context-mode"]);
        const lock = await store.getLockfile();
        assert.equal(lock.installs.length, 1);
        assert.equal(lock.installs[0].version, "2.0.0");
      });
    });
  });

  it("rejects and discards tampered staged files during applyPendingUpdates without touching live install", async () => {
    await withTempDir(async (tmp) => {
      const store = new PluginStore(path.join(tmp, "data"));
      await store.init();
      const pluginsRoot = path.join(tmp, "plugins");
      const stageDir = path.join(pluginsRoot, ".domush--context-mode.install.abc.tmp");
      const finalDir = path.join(pluginsRoot, "domush--context-mode");

      await writeFiles(finalDir, { "plugin.json": { name: "context-mode", version: "1.0.0" } });
      await writeFiles(stageDir, { "plugin.json": { name: "context-mode", version: "9.9.9" } });

      await store.upsertPendingUpdate({
        id: "Domush/antigravity-plugin-context-mode",
        slug: "domush--context-mode",
        scope: "global",
        workspaceRoot: null,
        stageDir,
        finalDir,
        legacyDir: null,
        legacySlug: null,
        version: "2.0.0",
        sha: "2".repeat(40),
        contentTreeSha256: "0".repeat(64),
        capabilities: [],
        stagedAt: new Date().toISOString(),
      });

      const outcome = await applyPendingUpdates({ store, logger: null });
      assert.equal(outcome.applied.length, 0);
      assert.equal(outcome.failed.length, 1);
      assert.equal(outcome.failed[0].reason, "integrity_mismatch");
      assert.equal(hasPendingUpdatesSync(store.dataDir), false);
      await assert.rejects(() => fs.access(stageDir), { code: "ENOENT" });

      const livePkg = JSON.parse(await fs.readFile(path.join(finalDir, "plugin.json"), "utf8"));
      assert.equal(livePkg.version, "1.0.0");
    });
  });

  it("stages directly in pendingStageRoot without leaving temp copies in pluginsRoot on EPERM", async () => {
    const v2Files = {
      "plugin.json": { name: "context-mode", version: "2.0.1" },
      "skills/context-mode/SKILL.md": "# v2.0.1\n",
    };
    const v2Hash = await hashFileMap(v2Files);
    const v2Tar = await buildTarGz(v2Files);

    await withTempDir(async (tmp) => {
      const store = new PluginStore(path.join(tmp, "data"));
      await store.init();
      const workspaceRoot = path.join(tmp, "workspace");
      const activeRoot = getPluginsDir("project", workspaceRoot, { enabled: true });
      const legacyDir = path.join(activeRoot, "context-mode");

      await writeFiles(legacyDir, {
        "plugin.json": { name: "context-mode", version: "2.0.0" },
      });

      await withTarballServer(new Map([["/v201", v2Tar]]), async (baseUrl) => {
        const entry = makeEntry({
          id: "Domush/antigravity-plugin-context-mode",
          version: "2.0.1",
          sha: "3".repeat(40),
          tarballUrl: `${baseUrl}/v201`,
          contentTreeSha256: v2Hash,
        });

        const pendingStageRoot = path.join(store.dataDir, "pending-stages");
        const epermFs = {
          ...fs,
          async rename(from, to) {
            if (path.resolve(from) === path.resolve(legacyDir)) {
              throw makeErr("EPERM", `EPERM: locked legacy folder '${from}'`);
            }
            return fs.rename(from, to);
          },
        };

        const result = await installPlugin({
          pluginEntry: entry,
          denylist: { blockedRepos: [], blockedShas: [] },
          scope: "project",
          workspaceRoot,
          replaceSlug: "context-mode",
          replaceEnabled: true,
          pendingStageRoot,
          fsOps: epermFs,
        });

        assert.equal(result.status, "pending_restart");
        assert.equal(result.pendingUpdate.slug, "domush--context-mode");
        assert.equal(path.dirname(result.pendingUpdate.stageDir), pendingStageRoot);
        assert.deepEqual(await fs.readdir(activeRoot), ["context-mode"]);
        const stagedPkg = JSON.parse(
          await fs.readFile(path.join(result.pendingUpdate.stageDir, "plugin.json"), "utf8")
        );
        assert.equal(stagedPkg.version, "2.0.1");
        assert.equal(await computeContentTreeSha256(result.pendingUpdate.stageDir), v2Hash);
      });
    });
  });

  it("deduplicates pending updates by (id, scope) across slug changes and applies unlocked updates while watchPid is alive", async () => {
    await withTempDir(async (tmp) => {
      const store = new PluginStore(path.join(tmp, "data"));
      await store.init();
      const ws = path.join(tmp, "ws");
      const activeRoot = getPluginsDir("project", ws, { enabled: true });
      const legacyDir = path.join(activeRoot, "context-mode");
      const oldStage = path.join(store.dataDir, "pending-stages", ".old.tmp");
      const newStage = path.join(store.dataDir, "pending-stages", ".new.tmp");

      const v2Files = { "plugin.json": { name: "context-mode", version: "2.0.1" } };
      const v2Hash = await hashFileMap(v2Files);
      await writeFiles(legacyDir, { "plugin.json": { name: "context-mode", version: "2.0.0" } });
      await writeFiles(oldStage, v2Files);
      await writeFiles(newStage, v2Files);

      await store.upsertPendingUpdate({
        id: "Domush/antigravity-plugin-context-mode",
        slug: "domush--antigravity-plugin-context-mode",
        scope: "project",
        workspaceRoot: ws,
        stageDir: oldStage,
        finalDir: path.join(activeRoot, "domush--antigravity-plugin-context-mode"),
        legacyDir,
        legacySlug: "context-mode",
        version: "2.0.1",
        sha: "1".repeat(40),
        contentTreeSha256: v2Hash,
      });

      await store.upsertPendingUpdate({
        id: "Domush/antigravity-plugin-context-mode",
        slug: "domush--context-mode",
        scope: "project",
        workspaceRoot: ws,
        stageDir: newStage,
        finalDir: path.join(activeRoot, "domush--context-mode"),
        legacyDir,
        legacySlug: "context-mode",
        version: "2.0.1",
        sha: "1".repeat(40),
        contentTreeSha256: v2Hash,
      });

      const pending = await store.getPendingUpdates();
      assert.equal(pending.length, 1);
      assert.equal(pending[0].slug, "domush--context-mode");
      await assert.rejects(() => fs.access(oldStage), { code: "ENOENT" });

      // Run pending worker watching a still-alive PID (e.g. a sibling process) -> should still apply once unlocked
      const watcherParent = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: "ignore",
      });
      try {
        const res = await runPendingWorker({
          dataDir: store.dataDir,
          watchPid: watcherParent.pid,
          maxWaitMs: 500,
          pollMs: 10,
        });
        assert.equal(res.acquired, true);
        assert.equal(res.applied.length, 1);
        assert.equal(hasPendingUpdatesSync(store.dataDir), false);
        assert.deepEqual(await fs.readdir(activeRoot), ["domush--context-mode"]);
      } finally {
        if (watcherParent.exitCode === null && watcherParent.signalCode === null) {
          const exited = new Promise((resolve) => watcherParent.once("exit", resolve));
          watcherParent.kill();
          await exited;
        }
      }
    });
  });
});
