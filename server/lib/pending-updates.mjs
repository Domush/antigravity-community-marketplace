import { spawn, spawnSync } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeContentTreeSha256,
  getPluginsDir,
  isBusyLockError,
  moveDirAtomic,
} from "./installer.mjs";
import {
  appendWorkerLog,
  cleanupOrphanedArtifacts,
  createWorkerLogger,
  isProcessAlive,
  openRotatedWorkerLogFd,
  rotateWorkerLogIfNeeded,
  WORKER_LOG_FILENAME,
  WORKER_LOG_MAX_BYTES,
} from "./pending-diagnostics.mjs";
import { hasPendingUpdatesSync } from "./store.mjs";
import {
  discoverWindowsLockHolderPids,
  isNodeExecutablePath,
  launchWindowsDetachedWmi,
  resolveWindowsNodeExecutable,
} from "./windows-process.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_WORKER_SCRIPT = path.resolve(__dirname, "pending-worker.mjs");
export {
  appendWorkerLog,
  cleanupOrphanedArtifacts,
  createWorkerLogger,
  isProcessAlive,
  openRotatedWorkerLogFd,
  rotateWorkerLogIfNeeded,
  WORKER_LOG_FILENAME,
  WORKER_LOG_MAX_BYTES,
};

function isEntryDenied(entry, denylist) {
  if (!denylist || typeof denylist !== "object") return false;
  const idLower = String(entry.id || "").toLowerCase();
  const shaLower = String(entry.sha || "").toLowerCase();

  const blockedRepo = (denylist.blockedRepos || []).find(
    (b) => String(b.id || "").toLowerCase() === idLower
  );
  if (blockedRepo) return blockedRepo.reason || "Repository blocked by denylist";

  const blockedSha = (denylist.blockedShas || []).find(
    (b) =>
      String(b.id || "").toLowerCase() === idLower &&
      String(b.sha || "").toLowerCase() === shaLower
  );
  if (blockedSha) return blockedSha.reason || "Release SHA blocked by denylist";

  return false;
}

async function applySinglePendingUpdate(
  entry,
  { store, denylist = null, fsOps = fs, moveDirFn = moveDirAtomic }
) {
  const stageExists = await fsOps.access(entry.stageDir).then(() => true).catch(() => false);
  if (!stageExists) {
    await store.removePendingUpdate({
      finalDir: entry.finalDir,
      slug: entry.slug,
      scope: entry.scope,
    });
    return { status: "dropped", reason: "missing_stage", entry };
  }

  const actualHash = await computeContentTreeSha256(entry.stageDir);
  if (actualHash !== entry.contentTreeSha256) {
    await fsOps.rm(entry.stageDir, { recursive: true, force: true }).catch(() => {});
    await store.removePendingUpdate({
      finalDir: entry.finalDir,
      slug: entry.slug,
      scope: entry.scope,
    });
    return { status: "failed", reason: "integrity_mismatch", entry };
  }

  const deniedReason = isEntryDenied(entry, denylist);
  if (deniedReason) {
    await fsOps.rm(entry.stageDir, { recursive: true, force: true }).catch(() => {});
    await store.removePendingUpdate({
      finalDir: entry.finalDir,
      slug: entry.slug,
      scope: entry.scope,
    });
    return { status: "failed", reason: `denylist_blocked: ${deniedReason}`, entry };
  }

  let legacyBackupDir = null;
  const hasLegacyDir =
    Boolean(entry.legacyDir) &&
    (await fsOps.access(entry.legacyDir).then(() => true).catch(() => false));

  if (hasLegacyDir) {
    legacyBackupDir = `${entry.legacyDir}.migrate.${Date.now()}.bak`;
    try {
      await fsOps.rename(entry.legacyDir, legacyBackupDir);
    } catch (err) {
      if (isBusyLockError(err)) {
        return { status: "still_locked", entry, error: err };
      }
      throw err;
    }
  }

  try {
    await moveDirFn(entry.stageDir, entry.finalDir);
  } catch (err) {
    if (legacyBackupDir && entry.legacyDir) {
      await fsOps.rename(legacyBackupDir, entry.legacyDir).catch(() => {});
    }
    if (isBusyLockError(err)) {
      return { status: "still_locked", entry, error: err };
    }
    throw err;
  }

  const staleDisabledDir = path.join(
    getPluginsDir(entry.scope, entry.workspaceRoot, { enabled: false }),
    entry.slug
  );
  await fsOps.rm(staleDisabledDir, { recursive: true, force: true }).catch(() => {});

  if (legacyBackupDir) {
    await fsOps.rm(legacyBackupDir, { recursive: true, force: true }).catch(() => {});
  }

  if (entry.legacyDir) {
    await store.removeInstallRecord({
      slug: entry.legacySlug,
      scope: entry.scope,
      installPath: entry.legacyDir,
    });
  }

  const lockRecord = {
    id: entry.id,
    slug: entry.slug,
    scope: entry.scope,
    installPath: entry.finalDir,
    enabled: true,
    version: entry.version,
    sha: entry.sha,
    contentTreeSha256: entry.contentTreeSha256,
    capabilities: Array.isArray(entry.capabilities) ? entry.capabilities : [],
    installedAt: new Date().toISOString(),
  };

  await store.upsertInstallRecord(lockRecord);
  await store.removePendingUpdate({
    finalDir: entry.finalDir,
    slug: entry.slug,
    scope: entry.scope,
  });

  return { status: "applied", record: lockRecord, entry };
}

/**
 * Attempt to finalize any staged plugin updates whose file or folder locks have cleared.
 */
export async function applyPendingUpdates({
  store,
  denylist = null,
  logger = console,
  fsOps = fs,
  moveDirFn = moveDirAtomic,
} = {}) {
  if (!store) {
    throw new TypeError("applyPendingUpdates requires a store instance.");
  }

  const pending = await store.getPendingUpdates();
  const applied = [];
  const stillLocked = [];
  const dropped = [];
  const failed = [];

  for (const entry of pending) {
    try {
      const outcome = await applySinglePendingUpdate(entry, {
        store,
        denylist,
        fsOps,
        moveDirFn,
      });
      if (outcome.status === "applied") {
        applied.push(outcome.record);
        logger?.error?.(
          `[marketplace-pending] Applied staged update ${entry.id}@${entry.version} (${entry.scope}).`
        );
      } else if (outcome.status === "still_locked") {
        stillLocked.push(entry);
      } else if (outcome.status === "dropped") {
        dropped.push(entry);
      } else {
        failed.push({ entry, reason: outcome.reason });
        logger?.error?.(
          `[marketplace-pending] Discarded staged update ${entry.id}: ${outcome.reason}.`
        );
      }
    } catch (err) {
      failed.push({ entry, reason: err?.message || String(err) });
      logger?.error?.(
        `[marketplace-pending] Failed applying ${entry.id}: ${err?.message || err}`
      );
    }
  }

  await cleanupOrphanedArtifacts({ store, fsOps, logger }).catch(() => {});
  return { applied, stillLocked, dropped, failed };
}

function normalizePidList(watchPid, watchPids) {
  const raw = [];
  if (watchPid !== null && watchPid !== undefined) raw.push(watchPid);
  if (Array.isArray(watchPids)) raw.push(...watchPids);
  const unique = new Set();
  for (const val of raw) {
    const num = typeof val === "string" ? Number.parseInt(val.trim(), 10) : val;
    if (Number.isInteger(num) && num > 0) unique.add(num);
  }
  return [...unique];
}

/**
 * Spawn an independent detached background worker to apply staged updates once
 * Antigravity and all watched lock-holder processes exit.
 */
export function spawnShutdownSwapWorker({
  dataDir,
  watchPid = null,
  watchPids = [],
  workerScriptPath = DEFAULT_WORKER_SCRIPT,
  execPath = process.execPath,
  platform = process.platform,
  env = process.env,
  spawnFn = spawn,
  spawnSyncFn = spawnSync,
  discoverWatchPidsFn = null,
  windowsLauncherFn = null,
  hasPendingFn = hasPendingUpdatesSync,
  logger = console,
} = {}) {
  if (!dataDir || !hasPendingFn(dataDir)) {
    return false;
  }

  const resolvedDataDir = path.resolve(dataDir);
  const discoveredPids =
    typeof discoverWatchPidsFn === "function"
      ? discoverWatchPidsFn({ startPid: watchPid || process.pid })
      : platform === "win32" && spawnFn === spawn
        ? discoverWindowsLockHolderPids({ startPid: watchPid || process.pid, spawnSyncFn })
        : [];
  const allWatchPids = normalizePidList(watchPid, [...(watchPids || []), ...(discoveredPids || [])]);

  const args = [workerScriptPath, "--data-dir", resolvedDataDir];
  if (allWatchPids.length > 0) {
    args.push("--watch-pid", allWatchPids.join(","));
  }

  const resolvedExecPath =
    platform === "win32"
      ? resolveWindowsNodeExecutable({ execPath, env })
      : execPath;
  const needsElectronAsNode = !isNodeExecutablePath(resolvedExecPath);

  if (platform === "win32" && (spawnFn === spawn || typeof windowsLauncherFn === "function")) {
    const launcher = windowsLauncherFn || launchWindowsDetachedWmi;
    const wmiResult = launcher({
      executable: resolvedExecPath,
      args,
      envOverrides: needsElectronAsNode ? { ELECTRON_RUN_AS_NODE: "1" } : null,
      env,
      spawnSyncFn,
    });
    if (wmiResult?.ok) {
      appendWorkerLog(
        resolvedDataDir,
        "INFO",
        `Spawned WMI detached swap worker (workerPid=${wmiResult.pid}, exec=${resolvedExecPath}, watchPids=${allWatchPids.join(",") || "none"}).`
      );
      logger?.error?.(
        `[marketplace-pending] Spawned WMI swap worker (workerPid=${wmiResult.pid}, watchPids=${allWatchPids.join(",") || "none"}) for ${resolvedDataDir}.`
      );
      return true;
    }
    appendWorkerLog(
      resolvedDataDir,
      "WARN",
      `WMI detached launch unavailable (${wmiResult?.error || "unknown error"}); falling back to detached spawn.`
    );
  }

  const childEnv = { ...env };
  if (needsElectronAsNode) {
    childEnv.ELECTRON_RUN_AS_NODE = "1";
  } else {
    delete childEnv.ELECTRON_RUN_AS_NODE;
  }

  const logFd = openRotatedWorkerLogFd(resolvedDataDir);
  let child;
  try {
    child = spawnFn(resolvedExecPath, args, {
      detached: true,
      stdio: logFd !== null ? ["ignore", logFd, logFd] : "ignore",
      windowsHide: true,
      env: childEnv,
    });
  } finally {
    if (logFd !== null) {
      fsSync.closeSync(logFd);
    }
  }
  child?.unref?.();

  appendWorkerLog(
    resolvedDataDir,
    "INFO",
    `Spawned detached swap worker (workerPid=${child?.pid || "unknown"}, exec=${resolvedExecPath}, watchPids=${allWatchPids.join(",") || "none"}).`
  );
  logger?.error?.(
    `[marketplace-pending] Spawned swap worker (watchPids=${allWatchPids.join(",") || "none"}) for staged updates in ${resolvedDataDir}.`
  );
  return true;
}

/**
 * Register one-shot shutdown listeners (stdio EOF + OS termination signals) that
 * trigger the detached swap worker when pending updates exist.
 */
export function registerShutdownSwapHook({
  dataDir,
  watchPid = null,
  stdin = process.stdin,
  proc = process,
  spawnWorkerFn = spawnShutdownSwapWorker,
} = {}) {
  let triggered = false;
  const resolvedWatchPid = Number.isInteger(watchPid) && watchPid > 0 ? watchPid : proc?.pid ?? null;
  const trigger = () => {
    if (triggered) return;
    triggered = true;
    try {
      spawnWorkerFn({ dataDir, watchPid: resolvedWatchPid });
    } catch {
      // Shutdown path must never throw unhandled errors
    }
  };

  const stdinEvents = ["end", "close"];
  const procEvents = ["SIGINT", "SIGTERM", "SIGHUP", "beforeExit"];

  if (stdin && typeof stdin.once === "function") {
    for (const ev of stdinEvents) stdin.once(ev, trigger);
  }
  if (proc && typeof proc.once === "function") {
    for (const ev of procEvents) proc.once(ev, trigger);
  }

  return () => {
    if (stdin && typeof stdin.off === "function") {
      for (const ev of stdinEvents) stdin.off(ev, trigger);
    }
    if (proc && typeof proc.off === "function") {
      for (const ev of procEvents) proc.off(ev, trigger);
    }
  };
}
