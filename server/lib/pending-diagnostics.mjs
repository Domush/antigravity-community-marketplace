import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export const WORKER_LOG_FILENAME = "pending-worker.log";
export const WORKER_LOG_MAX_BYTES = 256 * 1024;
const ORPHAN_TMP_MAX_AGE_MS = 5 * 60_000;
const FRESH_EMPTY_LOCK_GRACE_MS = 2_000;

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code !== "ESRCH";
  }
}

export function rotateWorkerLogIfNeeded(logPath, maxBytes = WORKER_LOG_MAX_BYTES) {
  try {
    const stat = fsSync.statSync(logPath);
    if (stat.size < maxBytes) return;
    const backupPath = `${logPath}.1`;
    fsSync.rmSync(backupPath, { force: true });
    fsSync.renameSync(logPath, backupPath);
  } catch {
    // Missing or busy log file must not block worker startup
  }
}

export function appendWorkerLog(
  dataDir,
  level,
  message,
  { maxBytes = WORKER_LOG_MAX_BYTES } = {}
) {
  if (typeof dataDir !== "string" || !dataDir.trim()) return;
  try {
    const resolvedDir = path.resolve(dataDir);
    fsSync.mkdirSync(resolvedDir, { recursive: true });
    const logPath = path.join(resolvedDir, WORKER_LOG_FILENAME);
    rotateWorkerLogIfNeeded(logPath, maxBytes);
    const line = `[${new Date().toISOString()}] [pid=${process.pid}] [${String(level || "INFO").toUpperCase()}] ${message}\n`;
    fsSync.appendFileSync(logPath, line, "utf8");
  } catch {
    // Logging must never crash update or shutdown paths
  }
}

export function createWorkerLogger(dataDir, { maxBytes = WORKER_LOG_MAX_BYTES } = {}) {
  const formatArgs = (args) =>
    args
      .map((item) => (item instanceof Error ? item.stack || item.message : String(item)))
      .join(" ");
  return {
    info: (...args) => appendWorkerLog(dataDir, "INFO", formatArgs(args), { maxBytes }),
    warn: (...args) => appendWorkerLog(dataDir, "WARN", formatArgs(args), { maxBytes }),
    error: (...args) => appendWorkerLog(dataDir, "ERROR", formatArgs(args), { maxBytes }),
    log: (...args) => appendWorkerLog(dataDir, "INFO", formatArgs(args), { maxBytes }),
  };
}

export function openRotatedWorkerLogFd(dataDir, { maxBytes = WORKER_LOG_MAX_BYTES } = {}) {
  if (typeof dataDir !== "string" || !dataDir.trim()) return null;
  try {
    const resolvedDir = path.resolve(dataDir);
    fsSync.mkdirSync(resolvedDir, { recursive: true });
    const logPath = path.join(resolvedDir, WORKER_LOG_FILENAME);
    rotateWorkerLogIfNeeded(logPath, maxBytes);
    return fsSync.openSync(logPath, "a");
  } catch {
    return null;
  }
}

/**
 * Clean up orphaned `.install.*.tmp` stage directories, stale atomic JSON temp
 * files, and dead-PID worker lockfiles inside `store.dataDir`.
 */
export async function cleanupOrphanedArtifacts({
  store,
  fsOps = fs,
  logger = console,
  orphanMaxAgeMs = ORPHAN_TMP_MAX_AGE_MS,
} = {}) {
  if (!store?.dataDir || typeof fsOps.readdir !== "function" || typeof fsOps.stat !== "function") {
    return { removedStages: 0, removedTempFiles: 0, clearedDeadLock: false };
  }

  const now = Date.now();
  let removedStages = 0;
  let removedTempFiles = 0;
  let clearedDeadLock = false;

  const activePending = await store.getPendingUpdates().catch(() => []);
  const activeStageDirs = new Set(
    activePending
      .map((item) => (item?.stageDir ? path.resolve(item.stageDir).toLowerCase() : null))
      .filter(Boolean)
  );

  const stageRoot = path.join(store.dataDir, "pending-stages");
  const stageEntries = await fsOps.readdir(stageRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of stageEntries) {
    if (!/^\..+\.install\.[a-f0-9]+\.tmp$/i.test(entry.name)) continue;
    const candidate = path.join(stageRoot, entry.name);
    if (activeStageDirs.has(path.resolve(candidate).toLowerCase())) continue;
    const stat = await fsOps.stat(candidate).catch(() => null);
    if (!stat || now - stat.mtimeMs < orphanMaxAgeMs) continue;
    await fsOps.rm(candidate, { recursive: true, force: true }).catch(() => {});
    removedStages += 1;
  }

  const dataEntries = await fsOps.readdir(store.dataDir, { withFileTypes: true }).catch(() => []);
  for (const entry of dataEntries) {
    if (!entry.isFile() || !/\.json\.[a-f0-9]+\.tmp$/i.test(entry.name)) continue;
    const candidate = path.join(store.dataDir, entry.name);
    const stat = await fsOps.stat(candidate).catch(() => null);
    if (!stat || now - stat.mtimeMs < orphanMaxAgeMs) continue;
    await fsOps.rm(candidate, { force: true }).catch(() => {});
    removedTempFiles += 1;
  }

  const lockPath = path.join(store.dataDir, "pending-worker.lock");
  const rawLock = await fsOps.readFile(lockPath, "utf8").catch(() => null);
  if (rawLock !== null) {
    const trimmed = rawLock.trim();
    const lockStat = await fsOps.stat(lockPath).catch(() => null);
    const isFreshEmpty = trimmed === "" && lockStat && now - lockStat.mtimeMs < FRESH_EMPTY_LOCK_GRACE_MS;
    if (!isFreshEmpty) {
      const pid = /^\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : NaN;
      if (!Number.isInteger(pid) || pid <= 0 || !isProcessAlive(pid)) {
        await fsOps.unlink(lockPath).catch(() => {});
        clearedDeadLock = true;
      }
    }
  }

  if (removedStages > 0 || removedTempFiles > 0 || clearedDeadLock) {
    logger?.info?.(
      `[marketplace-pending] Cleaned orphaned artifacts (stages=${removedStages}, tmpFiles=${removedTempFiles}, deadLock=${clearedDeadLock}).`
    );
  }
  return { removedStages, removedTempFiles, clearedDeadLock };
}
