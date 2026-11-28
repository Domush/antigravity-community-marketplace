import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, mock } from "node:test";
import { computeContentTreeSha256, getPluginsDir } from "../server/lib/installer.mjs";
import {
  acquireWorkerLock,
  parseWorkerArgs,
  runPendingWorker,
} from "../server/lib/pending-worker.mjs";
import { PluginStore } from "../server/lib/store.mjs";

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-worker-rel-"));
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

async function waitFor(predicate, timeoutMs = 4000, intervalMs = 15) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for predicate.`);
}

async function spawnHoldProcess() {
  const child = spawn(
    process.execPath,
    ["-e", "process.stdin.resume(); process.stdin.on('end', () => process.exit(0)); console.log('READY');"],
    { stdio: ["pipe", "pipe", "ignore"] }
  );
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Timed out waiting for child READY"));
    }, 5000);
    child.stdout.on("data", (chunk) => {
      if (chunk.toString("utf8").includes("READY")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Child exited unexpectedly (${code})`));
    });
  });
  return child;
}

async function stopHoldProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.stdin.end();
  const killTimer = setTimeout(() => child.kill("SIGKILL"), 2000);
  try {
    await exited;
  } finally {
    clearTimeout(killTimer);
  }
}

async function allocateDeadPid() {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const { pid } = child;
  await new Promise((resolve) => child.once("exit", resolve));
  return pid;
}

function makeFakeLogger() {
  const entries = { info: [], warn: [], error: [] };
  return {
    entries,
    info: (msg) => entries.info.push(String(msg)),
    warn: (msg) => entries.warn.push(String(msg)),
    error: (msg) => entries.error.push(String(msg)),
    log: (msg) => entries.info.push(String(msg)),
  };
}

describe("acquireWorkerLock & releaseWorkerLockIfOwned", () => {
  it("never steals a lock held by a living PID even when mtimeMs is days old", async () => {
    await withTempDir(async (tmp) => {
      const lockPath = path.join(tmp, "pending-worker.lock");
      await fs.writeFile(lockPath, "424242\n", "utf8");
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      await fs.utimes(lockPath, weekAgo, weekAgo);

      const logger = makeFakeLogger();
      const acquired = await acquireWorkerLock(lockPath, {
        isAliveFn: (pid) => pid === 424242,
        logger,
      });

      assert.equal(acquired, false);
      assert.equal(await fs.readFile(lockPath, "utf8"), "424242\n");
      assert.equal(logger.entries.info.length, 1);
      assert.match(logger.entries.info[0], /Lock held by active PID 424242/);
    });
  });

  it("respects fresh empty lock grace window when writer populates a living PID", async () => {
    await withTempDir(async (tmp) => {
      const lockPath = path.join(tmp, "pending-worker.lock");
      await fs.writeFile(lockPath, "", "utf8");
      let sleptMs = null;

      const acquired = await acquireWorkerLock(lockPath, {
        async sleepFn(ms) {
          sleptMs = ms;
          await fs.writeFile(lockPath, "515151\n", "utf8");
        },
        isAliveFn: (pid) => pid === 515151,
      });

      assert.equal(sleptMs, 50);
      assert.equal(acquired, false);
      assert.equal(await fs.readFile(lockPath, "utf8"), "515151\n");
    });
  });

  it("reclaims dead-PID, corrupt, and past-grace empty locks cleanly", async () => {
    await withTempDir(async (tmp) => {
      const lockPath = path.join(tmp, "pending-worker.lock");
      const logger = makeFakeLogger();

      await fs.writeFile(lockPath, "987654\n", "utf8");
      assert.equal(await acquireWorkerLock(lockPath, { isAliveFn: () => false, logger }), true);
      assert.equal(await fs.readFile(lockPath, "utf8"), `${process.pid}\n`);
      assert.match(logger.entries.warn[0], /dead PID 987654/);

      await fs.writeFile(lockPath, "corrupt-pid!\n", "utf8");
      assert.equal(await acquireWorkerLock(lockPath, { isAliveFn: () => true, logger }), true);
      assert.equal(await fs.readFile(lockPath, "utf8"), `${process.pid}\n`);
      assert.match(logger.entries.warn[1], /corrupt lock \(corrupt-pid!\)/);

      await fs.writeFile(lockPath, "", "utf8");
      const staleEmpty = new Date(Date.now() - 10_000);
      await fs.utimes(lockPath, staleEmpty, staleEmpty);
      let sleepCalls = 0;
      assert.equal(
        await acquireWorkerLock(lockPath, {
          sleepFn: async () => {
            sleepCalls += 1;
          },
          logger,
        }),
        true
      );
      assert.equal(sleepCalls, 0);
      assert.equal(await fs.readFile(lockPath, "utf8"), `${process.pid}\n`);
      assert.match(logger.entries.warn[2], /corrupt lock \(empty\)/);
    });
  });

  it("releaseWorkerLockIfOwned deletes own lock on finish and preserves lock owned by another PID", async () => {
    await withTempDir(async (tmp) => {
      const ownDataDir = path.join(tmp, "own");
      const ownLockPath = path.join(ownDataDir, "pending-worker.lock");
      await runPendingWorker({ dataDir: ownDataDir, maxWaitMs: 0, pollMs: 10, logger: makeFakeLogger() });
      await assert.rejects(() => fs.access(ownLockPath), { code: "ENOENT" });

      const foreignDataDir = path.join(tmp, "foreign");
      const foreignLockPath = path.join(foreignDataDir, "pending-worker.lock");
      const interceptLogger = {
        info(msg) {
          if (String(msg).includes("[worker] Finished")) {
            fsSync.writeFileSync(foreignLockPath, "888888\n", "utf8");
          }
        },
        warn() {},
        error() {},
      };

      await runPendingWorker({ dataDir: foreignDataDir, maxWaitMs: 0, pollMs: 10, logger: interceptLogger });
      assert.equal(await fs.readFile(foreignLockPath, "utf8"), "888888\n");
    });
  });
});

describe("parseWorkerArgs & runPendingWorker multi-PID watching", () => {
  it("parses repeatable and comma-separated --watch-pid flags and filters invalid tokens", () => {
    const parsed = parseWorkerArgs([
      "--data-dir",
      "/tmp/agy-data",
      "--max-wait-ms",
      "5000",
      "--poll-ms",
      "75",
      "--watch-pid",
      "101, 202,abc,-5,0,,101",
      "--watch-pid",
      "303",
      "--watch-pid",
      "202",
    ]);

    assert.equal(parsed.dataDir, "/tmp/agy-data");
    assert.equal(parsed.maxWaitMs, 5000);
    assert.equal(parsed.pollMs, 75);
    assert.deepEqual(parsed.watchPids, [101, 202, 303]);
    assert.equal(parsed.watchPid, 101);

    const invalid = parseWorkerArgs(["--watch-pid", "0,-9,nan,12.5,", "--max-wait-ms", "-1", "--poll-ms", "0"]);
    assert.deepEqual(invalid.watchPids, []);
    assert.equal(invalid.watchPid, null);
    assert.equal(invalid.maxWaitMs, 20_000);
    assert.equal(invalid.pollMs, 150);
  });

  it("waits until ALL watched PIDs exit before starting post-exit window and writes full status JSON", async () => {
    await withTempDir(async (tmp) => {
      const store = new PluginStore(path.join(tmp, "data"));
      await store.init();
      const ws = path.join(tmp, "ws");
      const activeRoot = getPluginsDir("project", ws, { enabled: true });
      const legacyDir = path.join(activeRoot, "demo-plugin");
      const finalDir = path.join(activeRoot, "acme--demo-plugin");
      const stageDir = path.join(store.dataDir, "pending-stages", ".acme--demo-plugin.tmp");

      const v2Files = { "plugin.json": { name: "demo-plugin", version: "2.0.0" } };
      await writeFiles(stageDir, v2Files);
      const v2Hash = await computeContentTreeSha256(stageDir);
      await writeFiles(legacyDir, { "plugin.json": { name: "demo-plugin", version: "1.0.0" } });

      await store.upsertPendingUpdate({
        id: "acme/demo-plugin",
        slug: "acme--demo-plugin",
        scope: "project",
        workspaceRoot: ws,
        stageDir,
        finalDir,
        legacyDir,
        legacySlug: "demo-plugin",
        version: "2.0.0",
        sha: "a".repeat(40),
        contentTreeSha256: v2Hash,
      });

      let childA = null;
      let childB = null;
      let renameMock = null;
      const logger = makeFakeLogger();
      let legacyLocked = true;
      let renameAttempts = 0;

      try {
        childA = await spawnHoldProcess();
        childB = await spawnHoldProcess();
        const origRename = fs.rename.bind(fs);
        renameMock = mock.method(fs, "rename", async (from, to) => {
          if (path.resolve(from) === path.resolve(legacyDir)) {
            renameAttempts += 1;
            if (legacyLocked) {
              const err = new Error("EBUSY: resource busy");
              err.code = "EBUSY";
              throw err;
            }
          }
          return origRename(from, to);
        });

        const workerPromise = runPendingWorker({
          dataDir: store.dataDir,
          maxWaitMs: 300,
          pollMs: 15,
          watchPids: [childA.pid, childB.pid, process.pid],
          logger,
        });

        await waitFor(() => logger.entries.info.some((m) => m.includes("Waiting for watched PID(s)")));
        await stopHoldProcess(childA);

        const attemptsAfterA = renameAttempts;
        await waitFor(() => renameAttempts > attemptsAfterA);
        assert.equal(
          logger.entries.info.some((m) => m.includes("All watched PID(s) exited")),
          false
        );
        const statusPath = path.join(store.dataDir, "pending-worker-status.json");
        await assert.rejects(() => fs.access(statusPath), { code: "ENOENT" });

        legacyLocked = false;
        await stopHoldProcess(childB);
        const result = await workerPromise;

        assert.equal(result.acquired, true);
        assert.equal(result.applied.length, 1);
        assert.equal(result.stillLocked.length, 0);

        const status = JSON.parse(await fs.readFile(statusPath, "utf8"));
        assert.equal(status.workerPid, process.pid);
        assert.deepEqual(status.watchPids, [childA.pid, childB.pid]);
        assert.equal(status.watchPid, childA.pid);
        assert.equal(status.outcome, "completed");
        assert.ok(status.attempts >= 2);
        assert.equal(status.appliedCount, 1);
        assert.equal(status.stillLockedCount, 0);
        assert.equal(status.droppedCount, 0);
        assert.equal(status.failedCount, 0);
        assert.deepEqual(status.applied, [
          { id: "acme/demo-plugin", slug: "acme--demo-plugin", scope: "project", version: "2.0.0" },
        ]);
        assert.equal(status.error, null);
      } finally {
        renameMock?.mock?.restore();
        await stopHoldProcess(childA);
        await stopHoldProcess(childB);
      }
    });
  });

  it("excludes self/invalid watch PIDs and reports outcome=timed_out when lock persists past maxWaitMs", async () => {
    await withTempDir(async (tmp) => {
      const store = new PluginStore(path.join(tmp, "data"));
      await store.init();
      const ws = path.join(tmp, "ws");
      const activeRoot = getPluginsDir("project", ws, { enabled: true });
      const legacyDir = path.join(activeRoot, "locked-plugin");
      const finalDir = path.join(activeRoot, "acme--locked-plugin");
      const stageDir = path.join(store.dataDir, "pending-stages", ".acme--locked-plugin.tmp");

      await writeFiles(stageDir, { "plugin.json": { name: "locked-plugin", version: "2.0.0" } });
      await writeFiles(legacyDir, { "plugin.json": { name: "locked-plugin", version: "1.0.0" } });
      const v2Hash = await computeContentTreeSha256(stageDir);

      await store.upsertPendingUpdate({
        id: "acme/locked-plugin",
        slug: "acme--locked-plugin",
        scope: "project",
        workspaceRoot: ws,
        stageDir,
        finalDir,
        legacyDir,
        legacySlug: "locked-plugin",
        version: "2.0.0",
        sha: "b".repeat(40),
        contentTreeSha256: v2Hash,
      });

      const deadPid = await allocateDeadPid();
      const origRename = fs.rename.bind(fs);
      const renameMock = mock.method(fs, "rename", async (from, to) => {
        if (path.resolve(from) === path.resolve(legacyDir)) {
          const err = new Error("EPERM: locked");
          err.code = "EPERM";
          throw err;
        }
        return origRename(from, to);
      });

      try {
        const res = await runPendingWorker({
          dataDir: store.dataDir,
          maxWaitMs: 45,
          pollMs: 15,
          watchPid: process.pid,
          watchPids: [deadPid, process.pid, -5, 0, "bad"],
          logger: makeFakeLogger(),
        });

        assert.equal(res.acquired, true);
        assert.equal(res.applied.length, 0);
        assert.equal(res.stillLocked.length, 1);

        const status = JSON.parse(
          await fs.readFile(path.join(store.dataDir, "pending-worker-status.json"), "utf8")
        );
        assert.equal(status.outcome, "timed_out");
        assert.deepEqual(status.watchPids, [deadPid]);
        assert.equal(status.watchPid, deadPid);
        assert.ok(status.attempts >= 1);
        assert.equal(status.appliedCount, 0);
        assert.equal(status.stillLockedCount, 1);
        assert.equal(status.stillLocked[0].finalDir, finalDir);
        assert.equal(status.error, null);
      } finally {
        renameMock.mock.restore();
      }
    });
  });
});
