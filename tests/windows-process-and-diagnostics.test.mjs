import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  appendWorkerLog,
  cleanupOrphanedArtifacts,
  openRotatedWorkerLogFd,
  rotateWorkerLogIfNeeded,
  WORKER_LOG_FILENAME,
} from "../server/lib/pending-diagnostics.mjs";
import { spawnShutdownSwapWorker } from "../server/lib/pending-updates.mjs";
import { PluginStore } from "../server/lib/store.mjs";
import {
  buildWindowsCommandLine,
  discoverWindowsLockHolderPids,
  launchWindowsDetachedWmi,
  quoteWindowsArg,
  resolveWindowsNodeExecutable,
} from "../server/lib/windows-process.mjs";

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-win-diag-"));
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

function decodeEncodedPsCommand(args) {
  const idx = args.indexOf("-EncodedCommand");
  assert.notEqual(idx, -1, "Expected -EncodedCommand argument");
  return Buffer.from(args[idx + 1], "base64").toString("utf16le");
}

describe("windows-process helpers & spawnShutdownSwapWorker", () => {
  it("quotes Windows arguments and builds command lines across edge cases", () => {
    assert.equal(quoteWindowsArg(""), '""');
    assert.equal(quoteWindowsArg(null), '""');
    assert.equal(quoteWindowsArg("simple-flag"), "simple-flag");
    assert.equal(
      quoteWindowsArg("C:\\Program Files\\nodejs\\node.exe"),
      '"C:\\Program Files\\nodejs\\node.exe"'
    );
    assert.equal(quoteWindowsArg("C:\\My Dir\\"), '"C:\\My Dir\\\\"');
    assert.equal(quoteWindowsArg('say "hi"'), '"say \\"hi\\""');
    assert.equal(quoteWindowsArg('a\\"b'), '"a\\\\\\"b"');
    assert.equal(quoteWindowsArg("a&b|c"), '"a&b|c"');

    const cmd = buildWindowsCommandLine("C:\\Program Files\\nodejs\\node.exe", [
      "pending-worker.mjs",
      "--data-dir",
      "C:\\Data Dir\\",
      'say "ok"',
      "",
    ]);
    assert.equal(
      cmd,
      '"C:\\Program Files\\nodejs\\node.exe" pending-worker.mjs --data-dir "C:\\Data Dir\\\\" "say \\"ok\\"" ""'
    );
  });

  it("resolves standalone node.exe when execPath is Antigravity.exe and falls back cleanly", () => {
    const winDirNode = path.win32.join("C:\\Program Files\\nodejs", "node.exe");
    const resolved = resolveWindowsNodeExecutable({
      execPath: "C:\\Antigravity\\Antigravity.exe",
      env: { PATH: '"C:\\EmptyDir"' + path.win32.delimiter + "C:\\Program Files\\nodejs" },
      existsSyncFn: (p) => p === winDirNode,
      statSyncFn: () => ({ isFile: () => true }),
    });
    assert.equal(resolved, winDirNode);

    const fallback = resolveWindowsNodeExecutable({
      execPath: "C:\\Antigravity\\Antigravity.exe",
      env: { PATH: "C:\\NotHere" },
      existsSyncFn: () => true,
      statSyncFn: () => ({ isFile: () => false }),
    });
    assert.equal(fallback, "C:\\Antigravity\\Antigravity.exe");
  });

  it("launchWindowsDetachedWmi validates strict integer ReturnValue===0 && ProcessId>0", () => {
    assert.throws(() => launchWindowsDetachedWmi({ executable: "" }), TypeError);
    assert.throws(() => launchWindowsDetachedWmi({ executable: "   " }), TypeError);
    assert.throws(() => launchWindowsDetachedWmi({ executable: null }), TypeError);

    let capturedArgs = null;
    const okRes = launchWindowsDetachedWmi({
      executable: "C:\\Program Files\\nodejs\\node.exe",
      args: ["worker.mjs", "--data-dir", "C:\\Data Dir\\"],
      envOverrides: { ELECTRON_RUN_AS_NODE: "1" },
      env: { SYSTEMROOT: "C:\\Windows" },
      spawnSyncFn(_cmd, args) {
        capturedArgs = args;
        return { status: 0, stdout: '{"ReturnValue":0,"ProcessId":4321}\r\n' };
      },
    });
    assert.deepEqual(okRes, { ok: true, pid: 4321 });
    const decoded = decodeEncodedPsCommand(capturedArgs);
    assert.match(decoded, /Win32_Process/);
    assert.match(decoded, /ELECTRON_RUN_AS_NODE=1/);

    const invalidResponses = [
      { status: 0, stdout: '{"ReturnValue":0,"ProcessId":null}' },
      { status: 0, stdout: '{"ReturnValue":0,"ProcessId":""}' },
      { status: 0, stdout: '{"ReturnValue":0,"ProcessId":0}' },
      { status: 0, stdout: '{"ReturnValue":0,"ProcessId":-3}' },
      { status: 0, stdout: '{"ReturnValue":0,"ProcessId":12.5}' },
      { status: 0, stdout: '{"ReturnValue":false,"ProcessId":123}' },
      { status: 0, stdout: '{"ReturnValue":"0","ProcessId":123}' },
      { status: 0, stdout: '{"ReturnValue":2,"ProcessId":123}' },
      { status: 0, stdout: "not-json" },
      { status: 0, stdout: "" },
      { status: 1, stderr: "Access denied", stdout: "" },
      { status: null, error: new Error("ETIMEDOUT") },
    ];
    for (const fakeResult of invalidResponses) {
      const res = launchWindowsDetachedWmi({
        executable: "node.exe",
        spawnSyncFn: () => fakeResult,
      });
      assert.equal(res.ok, false);
      assert.equal(typeof res.error, "string");
      assert.ok(res.error.length > 0);
    }
  });

  it("discoverWindowsLockHolderPids matches Antigravity/language_server tree and stops at system/shell ancestors", () => {
    assert.deepEqual(discoverWindowsLockHolderPids({ startPid: 0 }), []);
    assert.deepEqual(discoverWindowsLockHolderPids({ startPid: -1 }), []);

    const rows = [
      { ProcessId: 1, ParentProcessId: 0, Name: "Antigravity.exe", ExecutablePath: "C:\\ignore\\Antigravity.exe" },
      { ProcessId: 10, ParentProcessId: 1, Name: "explorer.exe", ExecutablePath: "C:\\Windows\\explorer.exe" },
      { ProcessId: 20, ParentProcessId: 10, Name: "Antigravity.exe", ExecutablePath: "C:\\App\\Antigravity.exe" },
      { ProcessId: 30, ParentProcessId: 20, Name: "language_server_windows_x64.exe", ExecutablePath: "C:\\App\\ls.exe" },
      { ProcessId: 40, ParentProcessId: 30, Name: "node.exe", ExecutablePath: "C:\\nodejs\\node.exe" },
      { ProcessId: 50, ParentProcessId: 20, Name: "language_server_helper.exe", ExecutablePath: "C:\\App\\ls2.exe" },
      { ProcessId: 60, ParentProcessId: 20, Name: "unrelated-renderer.exe", ExecutablePath: "C:\\App\\other.exe" },
    ];

    const pids = discoverWindowsLockHolderPids({
      startPid: 40,
      spawnSyncFn: () => ({ status: 0, stdout: JSON.stringify(rows) }),
    });
    assert.deepEqual(pids.sort((a, b) => a - b), [20, 30, 50]);

    assert.deepEqual(
      discoverWindowsLockHolderPids({
        startPid: 40,
        spawnSyncFn: () => ({ status: 0, stdout: "{not-valid-json" }),
      }),
      []
    );
    assert.deepEqual(
      discoverWindowsLockHolderPids({
        startPid: 40,
        spawnSyncFn: () => ({ status: 1, stderr: "timeout" }),
      }),
      []
    );
    assert.deepEqual(
      discoverWindowsLockHolderPids({
        startPid: 40,
        spawnSyncFn: () => {
          throw new Error("spawn EPERM");
        },
      }),
      []
    );
  });

  it("spawnShutdownSwapWorker uses rotated log FD array and falls back to stdio=ignore on unwritable dataDir", async () => {
    await withTempDir(async (tmp) => {
      const dataDir = path.join(tmp, "data");
      let spawnedOpts = null;
      const ok = spawnShutdownSwapWorker({
        dataDir,
        platform: "win32",
        watchPid: 100,
        watchPids: [200, 100],
        discoverWatchPidsFn: () => [300],
        windowsLauncherFn: () => ({ ok: false, error: "WMI unavailable" }),
        hasPendingFn: () => true,
        spawnFn(_exec, args, opts) {
          spawnedOpts = { args, opts };
          return { pid: 9001, unref() {} };
        },
      });
      assert.equal(ok, true);
      assert.ok(Array.isArray(spawnedOpts.opts.stdio));
      assert.equal(spawnedOpts.opts.stdio[0], "ignore");
      assert.ok(Number.isInteger(spawnedOpts.opts.stdio[1]) && spawnedOpts.opts.stdio[1] >= 0);
      assert.equal(spawnedOpts.opts.stdio[2], spawnedOpts.opts.stdio[1]);
      assert.ok(spawnedOpts.args.includes("100,200,300"));
      const logContent = await fs.readFile(path.join(dataDir, WORKER_LOG_FILENAME), "utf8");
      assert.match(logContent, /WMI detached launch unavailable/);
      assert.match(logContent, /workerPid=9001/);

      const blockerFile = path.join(tmp, "not-a-directory");
      await fs.writeFile(blockerFile, "file-blocks-mkdir", "utf8");
      let fallbackOpts = null;
      const okFallback = spawnShutdownSwapWorker({
        dataDir: blockerFile,
        platform: "linux",
        hasPendingFn: () => true,
        spawnFn(_exec, _args, opts) {
          fallbackOpts = opts;
          return { pid: 9002, unref() {} };
        },
      });
      assert.equal(okFallback, true);
      assert.equal(fallbackOpts.stdio, "ignore");
    });
  });
});

describe("pending-diagnostics log rotation & cleanupOrphanedArtifacts", () => {
  it("rotates oversized worker logs and handles invalid/unwritable directories without throwing", async () => {
    await withTempDir(async (tmp) => {
      const dataDir = path.join(tmp, "logs");
      appendWorkerLog(dataDir, "INFO", "first entry " + "x".repeat(80), { maxBytes: 50 });
      appendWorkerLog(dataDir, "WARN", "second entry", { maxBytes: 50 });

      const activeLog = await fs.readFile(path.join(dataDir, WORKER_LOG_FILENAME), "utf8");
      const rotatedLog = await fs.readFile(path.join(dataDir, `${WORKER_LOG_FILENAME}.1`), "utf8");
      assert.match(activeLog, /\[WARN\] second entry/);
      assert.match(rotatedLog, /\[INFO\] first entry/);

      const fd = openRotatedWorkerLogFd(dataDir, { maxBytes: 10 });
      try {
        assert.ok(Number.isInteger(fd) && fd >= 0);
      } finally {
        if (Number.isInteger(fd) && fd >= 0) {
          fsSync.closeSync(fd);
        }
      }

      const blockerFile = path.join(tmp, "blocker");
      await fs.writeFile(blockerFile, "locked", "utf8");
      assert.equal(openRotatedWorkerLogFd(null), null);
      assert.equal(openRotatedWorkerLogFd("   "), null);
      assert.equal(openRotatedWorkerLogFd(blockerFile), null);
      assert.doesNotThrow(() => appendWorkerLog(blockerFile, "ERROR", "ignored"));
      assert.doesNotThrow(() => rotateWorkerLogIfNeeded(path.join(tmp, "missing.log"), 10));
    });
  });

  it("cleans stale orphaned tmp artifacts and dead locks while preserving fresh/active entries and live locks", async () => {
    await withTempDir(async (tmp) => {
      const store = new PluginStore(path.join(tmp, "data"));
      await store.init();

      const stageRoot = path.join(store.dataDir, "pending-stages");
      const activeStage = path.join(stageRoot, ".acme--active.install.1111abcd.tmp");
      const staleStage = path.join(stageRoot, ".acme--stale.install.deadbeef.tmp");
      const freshStage = path.join(stageRoot, ".acme--fresh.install.cafebabe.tmp");
      await writeFiles(activeStage, { "plugin.json": { version: "1.0.0" } });
      await writeFiles(staleStage, { "plugin.json": { version: "1.0.0" } });
      await writeFiles(freshStage, { "plugin.json": { version: "1.0.0" } });

      await store.upsertPendingUpdate({
        id: "acme/active",
        slug: "acme--active",
        scope: "global",
        stageDir: activeStage,
        finalDir: path.join(tmp, "plugins", "acme--active"),
        version: "1.0.0",
      });

      const staleTmp = path.join(store.dataDir, "lockfile.json.abcdef123456.tmp");
      const freshTmp = path.join(store.dataDir, "prefs.json.abcdef123456.tmp");
      await fs.writeFile(staleTmp, "{}", "utf8");
      await fs.writeFile(freshTmp, "{}", "utf8");

      const oldTime = new Date(Date.now() - 10 * 60_000);
      await fs.utimes(activeStage, oldTime, oldTime);
      await fs.utimes(staleStage, oldTime, oldTime);
      await fs.utimes(staleTmp, oldTime, oldTime);

      const lockPath = path.join(store.dataDir, "pending-worker.lock");
      const deadPid = await allocateDeadPid();
      await fs.writeFile(lockPath, `${deadPid}\n`, "utf8");

      const res1 = await cleanupOrphanedArtifacts({ store, orphanMaxAgeMs: 60_000, logger: makeFakeLogger() });
      assert.deepEqual(res1, { removedStages: 1, removedTempFiles: 1, clearedDeadLock: true });

      await assert.rejects(() => fs.access(staleStage), { code: "ENOENT" });
      await assert.rejects(() => fs.access(staleTmp), { code: "ENOENT" });
      await assert.rejects(() => fs.access(lockPath), { code: "ENOENT" });
      await fs.access(activeStage);
      await fs.access(freshStage);
      await fs.access(freshTmp);

      await fs.writeFile(lockPath, `${process.pid}\n`, "utf8");
      const resLive = await cleanupOrphanedArtifacts({ store, orphanMaxAgeMs: 60_000, logger: makeFakeLogger() });
      assert.deepEqual(resLive, { removedStages: 0, removedTempFiles: 0, clearedDeadLock: false });
      assert.equal(await fs.readFile(lockPath, "utf8"), `${process.pid}\n`);

      assert.deepEqual(await cleanupOrphanedArtifacts({}), {
        removedStages: 0,
        removedTempFiles: 0,
        clearedDeadLock: false,
      });
    });
  });
});
