import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { computeContentTreeSha256, getPluginsDir } from "../server/lib/installer.mjs";
import {
  registerShutdownSwapHook,
  spawnShutdownSwapWorker,
} from "../server/lib/pending-updates.mjs";
import { createMarketplaceService } from "../server/lib/service.mjs";
import { hasPendingUpdatesSync, PluginStore } from "../server/lib/store.mjs";

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-swap-hook-"));
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

async function waitFor(predicate, timeoutMs = 8000, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for predicate.`);
}

describe("registerShutdownSwapHook & service bootstrap integration", () => {
  it("spawns detached swap worker once on stdin close only when pending updates exist", async () => {
    await withTempDir(async (tmp) => {
      const store = new PluginStore(path.join(tmp, "data"));
      await store.init();

      let emptySpawns = 0;
      const fakeStdin = new EventEmitter();
      const fakeProc = new EventEmitter();

      const unregEmpty = registerShutdownSwapHook({
        dataDir: store.dataDir,
        stdin: fakeStdin,
        proc: fakeProc,
        spawnWorkerFn(opts) {
          return spawnShutdownSwapWorker({
            ...opts,
            spawnFn() {
              emptySpawns += 1;
              return { unref() {} };
            },
          });
        },
      });

      fakeStdin.emit("end");
      assert.equal(emptySpawns, 0);
      unregEmpty();

      await store.upsertPendingUpdate({
        id: "acme/demo",
        slug: "acme--demo",
        scope: "global",
        stageDir: path.join(tmp, "stage"),
        finalDir: path.join(tmp, "final"),
        version: "1.0.1",
        sha: "a".repeat(40),
        contentTreeSha256: "b".repeat(64),
      });

      const capturedSpawns = [];
      const unregPending = registerShutdownSwapHook({
        dataDir: store.dataDir,
        stdin: fakeStdin,
        proc: fakeProc,
        spawnWorkerFn(opts) {
          return spawnShutdownSwapWorker({
            ...opts,
            spawnFn(_exec, args, spawnOpts) {
              capturedSpawns.push({ args, spawnOpts });
              return { unref() {} };
            },
          });
        },
      });

      fakeStdin.emit("end");
      fakeProc.emit("SIGTERM");
      unregPending();

      assert.equal(capturedSpawns.length, 1);
      const { args, spawnOpts } = capturedSpawns[0];
      assert.equal(spawnOpts.detached, true);
      assert.ok(Array.isArray(spawnOpts.stdio));
      assert.equal(spawnOpts.stdio.length, 3);
      assert.equal(spawnOpts.stdio[0], "ignore");
      assert.ok(Number.isInteger(spawnOpts.stdio[1]) && spawnOpts.stdio[1] >= 0);
      assert.equal(spawnOpts.stdio[2], spawnOpts.stdio[1]);
      assert.ok(args.includes(store.dataDir));
    });
  });

  it("exposes pendingUpdates via getBootstrap and cleans them on uninstall", async () => {
    await withTempDir(async (tmp) => {
      const store = new PluginStore(path.join(tmp, "data"));
      await store.init();
      const stageDir = path.join(tmp, "plugins", ".acme--demo.tmp");
      const finalDir = path.join(tmp, "plugins", "acme--demo");
      await writeFiles(stageDir, { "plugin.json": { name: "demo", version: "1.0.1" } });

      await store.upsertPendingUpdate({
        id: "acme/demo",
        slug: "acme--demo",
        scope: "global",
        stageDir,
        finalDir,
        version: "1.0.1",
        sha: "a".repeat(40),
        contentTreeSha256: "b".repeat(64),
      });

      const fakeCatalog = {
        async getIndex() {
          return { plugins: [] };
        },
        async getDenylist() {
          return { blockedRepos: [], blockedShas: [] };
        },
      };
      const service = createMarketplaceService({
        catalog: fakeCatalog,
        store,
        clientVersion: "1.0.8",
      });

      const boot = await service.getBootstrap();
      assert.equal(boot.structuredContent.pendingUpdates.length, 1);
      assert.equal(boot.structuredContent.pendingUpdates[0].id, "acme/demo");

      await service.uninstallPlugin({ slug: "acme--demo", scope: "global", enabled: true });
      const bootAfter = await service.getBootstrap();
      assert.equal(bootAfter.structuredContent.pendingUpdates.length, 0);
      await assert.rejects(() => fs.access(stageDir), { code: "ENOENT" });
    });
  });

  it("survives parent SIGKILL and finishes swap via detached watch-pid worker", async () => {
    await withTempDir(async (tmp) => {
      const store = new PluginStore(path.join(tmp, "data"));
      await store.init();
      const activeRoot = getPluginsDir("project", path.join(tmp, "ws"), { enabled: true });
      const legacyDir = path.join(activeRoot, "context-mode");
      const finalDir = path.join(activeRoot, "domush--context-mode");
      const stageDir = path.join(store.dataDir, "pending-stages", ".domush--context-mode.tmp");

      const v2Files = { "plugin.json": { name: "context-mode", version: "2.0.1" } };
      const v2Hash = await hashFileMap(v2Files);
      await writeFiles(legacyDir, { "plugin.json": { name: "context-mode", version: "1.0.0" } });
      await writeFiles(stageDir, v2Files);

      await store.upsertPendingUpdate({
        id: "Domush/antigravity-plugin-context-mode",
        slug: "domush--context-mode",
        scope: "project",
        workspaceRoot: path.join(tmp, "ws"),
        stageDir,
        finalDir,
        legacyDir,
        legacySlug: "context-mode",
        version: "2.0.1",
        sha: "2".repeat(40),
        contentTreeSha256: v2Hash,
        capabilities: [],
        stagedAt: new Date().toISOString(),
      });

      const modUrl = pathToFileURL(path.resolve("server/lib/pending-updates.mjs")).href;
      const parentScript = `
        import { spawnShutdownSwapWorker } from ${JSON.stringify(modUrl)};
        spawnShutdownSwapWorker({ dataDir: ${JSON.stringify(store.dataDir)}, watchPid: process.pid });
        console.log("WATCHING");
        setInterval(() => {}, 1000);
      `;
      const parent = spawn(process.execPath, ["--input-type=module", "-e", parentScript], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            parent.kill("SIGKILL");
            reject(new Error("Timed out waiting for watcher spawn"));
          }, 5000);
          parent.stdout.on("data", (chunk) => {
            if (chunk.toString("utf8").includes("WATCHING")) {
              clearTimeout(timer);
              resolve();
            }
          });
          parent.once("exit", (code) => {
            clearTimeout(timer);
            reject(new Error(`Parent exited unexpectedly with ${code}`));
          });
        });

        // Simulate Windows TerminateProcess / hard kill on the MCP/sidecar parent
        const parentExited = new Promise((resolve) => parent.once("exit", resolve));
        parent.kill("SIGKILL");
        await parentExited;
      } finally {
        if (parent.exitCode === null && parent.signalCode === null) {
          const exited = new Promise((resolve) => parent.once("exit", resolve));
          parent.kill("SIGKILL");
          await exited;
        }
      }

      const statusPath = path.join(store.dataDir, "pending-worker-status.json");
      const lockPath = path.join(store.dataDir, "pending-worker.lock");
      await waitFor(async () => {
        if (hasPendingUpdatesSync(store.dataDir)) return false;
        const statusExists = await fs.access(statusPath).then(() => true, () => false);
        const lockExists = await fs.access(lockPath).then(() => true, () => false);
        return statusExists && !lockExists;
      }, 8000);

      assert.equal(hasPendingUpdatesSync(store.dataDir), false);
      assert.deepEqual(await fs.readdir(activeRoot), ["domush--context-mode"]);
      const pkg = JSON.parse(await fs.readFile(path.join(finalDir, "plugin.json"), "utf8"));
      assert.equal(pkg.version, "2.0.1");
    });
  });

  it("retries applying pending updates through mp_apply_pending_updates", async () => {
    await withTempDir(async (tmp) => {
      const store = new PluginStore(path.join(tmp, "data"));
      await store.init();
      const ws = path.join(tmp, "ws");
      const activeRoot = getPluginsDir("project", ws, { enabled: true });
      const finalDir = path.join(activeRoot, "acme--demo");
      const stageDir = path.join(store.dataDir, "pending-stages", ".acme--demo.tmp");
      const files = { "plugin.json": { name: "demo", version: "1.0.2" } };
      const treeHash = await hashFileMap(files);
      await writeFiles(stageDir, files);

      await store.upsertPendingUpdate({
        id: "acme/demo",
        slug: "acme--demo",
        scope: "project",
        workspaceRoot: ws,
        stageDir,
        finalDir,
        version: "1.0.2",
        sha: "a".repeat(40),
        contentTreeSha256: treeHash,
      });

      const fakeCatalog = {
        async getIndex() {
          return { plugins: [] };
        },
        async getDenylist() {
          return { blockedRepos: [], blockedShas: [] };
        },
      };
      const service = createMarketplaceService({
        catalog: fakeCatalog,
        store,
        clientVersion: "1.0.8",
        spawnPendingWatcher() {
          return false;
        },
      });

      const res = await service.executeTool("mp_apply_pending_updates", {});
      assert.equal(res.structuredContent.applied.length, 1);
      assert.equal(res.structuredContent.pendingUpdates.length, 0);
      assert.equal(res.structuredContent.requiresReload, true);
      assert.deepEqual(await fs.readdir(activeRoot), ["acme--demo"]);
    });
  });

  it("deduplicates legacy duplicate pending-updates.json on read and cancels via mp_cancel_pending_updates", async () => {
    await withTempDir(async (tmp) => {
      const store = new PluginStore(path.join(tmp, "data"));
      await store.init();
      const stageA = path.join(store.dataDir, "pending-stages", ".old.tmp");
      const stageB = path.join(store.dataDir, "pending-stages", ".new.tmp");
      await writeFiles(stageA, { "plugin.json": { name: "context-mode", version: "2.0.1" } });
      await writeFiles(stageB, { "plugin.json": { name: "context-mode", version: "2.0.1" } });

      await store.writeJsonAtomic(store.pendingUpdatesPath, {
        schemaVersion: 1,
        pending: [
          {
            id: "Domush/antigravity-plugin-context-mode",
            slug: "domush--antigravity-plugin-context-mode",
            scope: "global",
            stageDir: stageA,
            finalDir: path.join(tmp, "plugins", "domush--antigravity-plugin-context-mode"),
            version: "2.0.1",
          },
          {
            id: "Domush/antigravity-plugin-context-mode",
            slug: "domush--context-mode",
            scope: "global",
            stageDir: stageB,
            finalDir: path.join(tmp, "plugins", "domush--context-mode"),
            version: "2.0.1",
          },
        ],
      });

      const deduped = await store.getPendingUpdates();
      assert.equal(deduped.length, 1);
      assert.equal(deduped[0].slug, "domush--context-mode");

      const service = createMarketplaceService({
        catalog: { async getIndex() { return { plugins: [] }; }, async getDenylist() { return { blockedRepos: [], blockedShas: [] }; } },
        store,
        clientVersion: "1.0.8",
      });

      const cancelRes = await service.executeTool("mp_cancel_pending_updates", {});
      assert.equal(cancelRes.structuredContent.cancelledCount, 1);
      assert.equal(cancelRes.structuredContent.pendingUpdates.length, 0);
      await assert.rejects(() => fs.access(stageB), { code: "ENOENT" });
    });
  });
});
