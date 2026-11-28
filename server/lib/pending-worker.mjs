import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendWorkerLog,
  createWorkerLogger,
  isProcessAlive,
} from "./pending-diagnostics.mjs";
import { applyPendingUpdates } from "./pending-updates.mjs";
import { DEFAULT_DATA_DIR } from "./service-config.mjs";
import { hasPendingUpdatesSync, PluginStore } from "./store.mjs";

const DEFAULT_MAX_WAIT_MS = 20_000;
const DEFAULT_POLL_MS = 150;
const WATCH_POLL_MS = 150;
const WATCH_APPLY_EVERY_TICKS = 3;
const MAX_BACKOFF_MS = 1_000;
const FRESH_EMPTY_LOCK_GRACE_MS = 2_000;
const LOCK_HEARTBEAT_INTERVAL_MS = 5_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { isProcessAlive };

async function tryClaimLock(lockPath) {
  const handle = await fs.open(lockPath, "wx");
  try {
    await handle.writeFile(`${process.pid}\n`, "utf8");
  } finally {
    await handle.close();
  }
}

/**
 * Acquire the exclusive worker lockfile. Never steals a lock held by a living
 * process regardless of file mtime age; only reclaims locks whose recorded PID
 * has exited or whose contents are corrupt/unreadable.
 */
export async function acquireWorkerLock(
  lockPath,
  { sleepFn = sleep, isAliveFn = isProcessAlive, logger = null } = {}
) {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  try {
    await tryClaimLock(lockPath);
    return true;
  } catch (err) {
    if (err?.code !== "EEXIST") throw err;
  }

  try {
    let [rawPid, stat] = await Promise.all([
      fs.readFile(lockPath, "utf8").catch(() => ""),
      fs.stat(lockPath).catch(() => null),
    ]);

    if (rawPid.trim() === "" && stat && Date.now() - stat.mtimeMs < FRESH_EMPTY_LOCK_GRACE_MS) {
      await sleepFn(50);
      rawPid = await fs.readFile(lockPath, "utf8").catch(() => "");
    }

    const trimmed = rawPid.trim();
    const pid = /^\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : NaN;
    if (Number.isInteger(pid) && pid > 0 && isAliveFn(pid)) {
      logger?.info?.(`[worker] Lock held by active PID ${pid}; skipping duplicate worker.`);
      return false;
    }

    const reason =
      Number.isInteger(pid) && pid > 0 ? `dead PID ${pid}` : `corrupt lock (${trimmed || "empty"})`;
    logger?.warn?.(`[worker] Reclaiming stale worker lock due to ${reason}.`);
    await fs.unlink(lockPath).catch(() => {});
    await tryClaimLock(lockPath);
    return true;
  } catch {
    return false;
  }
}

async function releaseWorkerLockIfOwned(lockPath) {
  try {
    const raw = await fs.readFile(lockPath, "utf8");
    const pid = Number.parseInt(raw.trim(), 10);
    if (pid === process.pid) {
      await fs.unlink(lockPath);
    }
  } catch {
    // Lock already removed or inaccessible
  }
}

function addWatchPidTokens(targetSet, rawValue) {
  for (const token of String(rawValue || "").split(",")) {
    const trimmed = token.trim();
    if (!/^\d+$/.test(trimmed)) continue;
    const parsed = Number.parseInt(trimmed, 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      targetSet.add(parsed);
    }
  }
}

export function parseWorkerArgs(argv) {
  const watchSet = new Set();
  const opts = {
    dataDir: DEFAULT_DATA_DIR,
    maxWaitMs: DEFAULT_MAX_WAIT_MS,
    pollMs: DEFAULT_POLL_MS,
    watchPid: null,
    watchPids: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--data-dir" && argv[i + 1]) {
      opts.dataDir = argv[++i];
    } else if (arg === "--max-wait-ms" && argv[i + 1]) {
      const parsed = Number.parseInt(argv[++i], 10);
      if (Number.isFinite(parsed) && parsed >= 0) opts.maxWaitMs = parsed;
    } else if (arg === "--poll-ms" && argv[i + 1]) {
      const parsed = Number.parseInt(argv[++i], 10);
      if (Number.isFinite(parsed) && parsed > 0) opts.pollMs = parsed;
    } else if (arg === "--watch-pid" && argv[i + 1]) {
      addWatchPidTokens(watchSet, argv[++i]);
    }
  }
  opts.watchPids = [...watchSet];
  opts.watchPid = opts.watchPids[0] ?? null;
  return opts;
}

function normalizeWatchedPids(watchPid, watchPids) {
  const set = new Set();
  const candidates = [];
  if (watchPid !== null && watchPid !== undefined) candidates.push(watchPid);
  if (Array.isArray(watchPids)) candidates.push(...watchPids);
  for (const val of candidates) {
    const pid = typeof val === "string" ? Number.parseInt(val.trim(), 10) : val;
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
      set.add(pid);
    }
  }
  return [...set];
}

function summarizeEntry(entry) {
  return {
    id: entry?.id || null,
    slug: entry?.slug || null,
    scope: entry?.scope || null,
    version: entry?.version || null,
  };
}

function determineOutcome({ appliedCount, stillLockedCount, failedCount, error }) {
  if (error) return "failed";
  if (stillLockedCount > 0) return "timed_out";
  if (failedCount > 0) return appliedCount > 0 ? "partial" : "failed";
  return appliedCount > 0 ? "completed" : "no_pending";
}

function buildStatusPayload({
  startedAtMs,
  watchedPids,
  attempts,
  applied,
  lastResult,
  error = null,
}) {
  const finishedAtMs = Date.now();
  const stillLocked = Array.isArray(lastResult?.stillLocked) ? lastResult.stillLocked : [];
  const dropped = Array.isArray(lastResult?.dropped) ? lastResult.dropped : [];
  const failed = Array.isArray(lastResult?.failed) ? lastResult.failed : [];
  const outcome = determineOutcome({
    appliedCount: applied.length,
    stillLockedCount: stillLocked.length,
    failedCount: failed.length,
    error,
  });

  return {
    workerPid: process.pid,
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt: new Date(finishedAtMs).toISOString(),
    ranAt: new Date(finishedAtMs).toISOString(),
    durationMs: Math.max(0, finishedAtMs - startedAtMs),
    watchPid: watchedPids[0] ?? null,
    watchPids: watchedPids,
    attempts,
    outcome,
    appliedCount: applied.length,
    stillLockedCount: stillLocked.length,
    droppedCount: dropped.length,
    failedCount: failed.length,
    applied: applied.map(summarizeEntry),
    stillLocked: stillLocked.map((item) => ({
      ...summarizeEntry(item),
      finalDir: item?.finalDir || null,
    })),
    dropped: dropped.map((item) => summarizeEntry(item)),
    failed: failed.map((item) => ({
      ...summarizeEntry(item?.entry),
      reason: item?.reason || "unknown",
    })),
    error: error
      ? {
          message: error?.message || String(error),
          code: error?.code || null,
          stack: error?.stack || null,
        }
      : null,
  };
}

/**
 * Retry pending plugin updates until all file/directory locks clear (after all
 * watched Antigravity / language-server / MCP processes exit) or maxWaitMs elapses.
 */
export async function runPendingWorker({
  dataDir = DEFAULT_DATA_DIR,
  maxWaitMs = DEFAULT_MAX_WAIT_MS,
  pollMs = DEFAULT_POLL_MS,
  watchPid = null,
  watchPids = [],
  denylist = null,
  logger = null,
} = {}) {
  const store = new PluginStore(dataDir);
  await store.init();

  const workerLogger = logger || createWorkerLogger(store.dataDir);
  const watchedPids = normalizeWatchedPids(watchPid, watchPids);
  const lockPath = path.join(store.dataDir, "pending-worker.lock");
  const statusPath = path.join(store.dataDir, "pending-worker-status.json");

  const acquired = await acquireWorkerLock(lockPath, { logger: workerLogger });
  if (!acquired) {
    return { acquired: false, applied: [], stillLocked: [] };
  }

  const startedAtMs = Date.now();
  const allApplied = [];
  let attempts = 0;
  let delayMs = pollMs;
  let lastHeartbeatAt = Date.now();
  let lastResult = { applied: [], stillLocked: [], dropped: [], failed: [] };

  const touchHeartbeat = async (force = false) => {
    const nowMs = Date.now();
    if (!force && nowMs - lastHeartbeatAt < LOCK_HEARTBEAT_INTERVAL_MS) return;
    lastHeartbeatAt = nowMs;
    const nowDate = new Date(nowMs);
    await fs.utimes(lockPath, nowDate, nowDate).catch(() => {});
  };

  const writeStatus = async (error = null) => {
    const payload = buildStatusPayload({
      startedAtMs,
      watchedPids,
      attempts,
      applied: allApplied,
      lastResult,
      error,
    });
    await store.writeJsonAtomic(statusPath, payload).catch((writeErr) => {
      workerLogger.error(`[worker] Failed writing status JSON: ${writeErr?.message || writeErr}`);
    });
    return payload;
  };

  workerLogger.info(
    `[worker] Started (dataDir=${store.dataDir}, watchPids=${watchedPids.join(",") || "none"}, maxWaitMs=${maxWaitMs}).`
  );

  try {
    if (watchedPids.length > 0) {
      let checks = 0;
      let alivePids = watchedPids.filter((pid) => isProcessAlive(pid));
      if (alivePids.length > 0) {
        workerLogger.info(`[worker] Waiting for watched PID(s) to exit: ${alivePids.join(",")}.`);
      }

      while (alivePids.length > 0) {
        await touchHeartbeat();
        if (checks % WATCH_APPLY_EVERY_TICKS === 0) {
          if (!hasPendingUpdatesSync(store.dataDir)) {
            await writeStatus();
            workerLogger.info("[worker] No pending updates remain while waiting; exiting.");
            return {
              acquired: true,
              applied: allApplied,
              stillLocked: [],
              dropped: lastResult.dropped,
              failed: lastResult.failed,
            };
          }
          attempts += 1;
          lastResult = await applyPendingUpdates({ store, denylist, logger: workerLogger });
          allApplied.push(...lastResult.applied);
          if (!hasPendingUpdatesSync(store.dataDir)) {
            await writeStatus();
            workerLogger.info(
              `[worker] Completed pending updates while watched PIDs alive (applied=${allApplied.length}).`
            );
            return {
              acquired: true,
              applied: allApplied,
              stillLocked: [],
              dropped: lastResult.dropped,
              failed: lastResult.failed,
            };
          }
        }
        checks += 1;
        await sleep(WATCH_POLL_MS);
        alivePids = watchedPids.filter((pid) => isProcessAlive(pid));
      }

      workerLogger.info(
        `[worker] All watched PID(s) exited; starting post-exit swap window (${maxWaitMs}ms).`
      );
    }

    const postExitStartedAt = Date.now();
    if (maxWaitMs > 0) {
      await sleep(Math.min(pollMs, maxWaitMs));
    }

    while (true) {
      await touchHeartbeat();
      attempts += 1;
      lastResult = await applyPendingUpdates({ store, denylist, logger: workerLogger });
      allApplied.push(...lastResult.applied);

      if (lastResult.stillLocked.length === 0) {
        break;
      }
      const elapsed = Date.now() - postExitStartedAt;
      if (elapsed >= maxWaitMs) {
        break;
      }

      const waitFor = Math.min(delayMs, Math.max(1, maxWaitMs - elapsed));
      await sleep(waitFor);
      delayMs = Math.min(MAX_BACKOFF_MS, Math.round(delayMs * 1.5));
    }

    const finalStatus = await writeStatus();
    workerLogger.info(
      `[worker] Finished outcome=${finalStatus.outcome} attempts=${attempts} applied=${finalStatus.appliedCount} stillLocked=${finalStatus.stillLockedCount} failed=${finalStatus.failedCount}.`
    );
  } catch (err) {
    workerLogger.error(`[worker] Fatal worker error: ${err?.stack || err?.message || err}`);
    await writeStatus(err);
    throw err;
  } finally {
    await releaseWorkerLockIfOwned(lockPath);
  }

  return {
    acquired: true,
    applied: allApplied,
    stillLocked: lastResult.stillLocked,
    dropped: lastResult.dropped,
    failed: lastResult.failed,
  };
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const opts = parseWorkerArgs(process.argv.slice(2));
  process.on("uncaughtException", (err) => {
    appendWorkerLog(opts.dataDir, "ERROR", `Uncaught exception: ${err?.stack || err?.message || err}`);
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    appendWorkerLog(
      opts.dataDir,
      "ERROR",
      `Unhandled rejection: ${reason instanceof Error ? reason.stack || reason.message : String(reason)}`
    );
    process.exit(1);
  });

  runPendingWorker(opts).catch((err) => {
    appendWorkerLog(opts.dataDir, "ERROR", `Worker execution failed: ${err?.stack || err?.message || err}`);
    process.exitCode = 1;
  });
}
