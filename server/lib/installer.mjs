import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { syncPluginDirectory } from "./cli-sync.mjs";
import {
  computeContentTreeSha256,
  extractVerifiedTarball,
  resolveInside,
} from "./tarball.mjs";

export { computeContentTreeSha256 };

const BUSY_LOCK_CODES = new Set(["EPERM", "EBUSY", "ENOTEMPTY"]);

/** Return true when err represents an OS file/directory lock or busy-handle failure. */
export function isBusyLockError(err) {
  return Boolean(err && (err instanceof PluginBusyLockError || BUSY_LOCK_CODES.has(err.code)));
}

/** Error thrown when an active process locks a plugin file or folder during swap. */
export class PluginBusyLockError extends Error {
  constructor(message, { code = "EBUSY", targetPath = null, cause = null } = {}) {
    super(message);
    this.name = "PluginBusyLockError";
    this.code = code;
    this.targetPath = targetPath;
    if (cause) this.cause = cause;
  }
}

export function getGlobalPluginsDir() {
  return path.join(os.homedir(), ".gemini", "config", "plugins");
}

export function getProjectPluginsDir(workspaceRoot) {
  if (!workspaceRoot) throw new Error("No active project workspace selected.");
  return path.join(path.resolve(workspaceRoot), ".agents", "plugins");
}

export function getDisabledGlobalPluginsDir() {
  return path.join(os.homedir(), ".gemini", "config", "plugins-disabled");
}

export function getDisabledProjectPluginsDir(workspaceRoot) {
  if (!workspaceRoot) throw new Error("No active project workspace selected.");
  return path.join(path.resolve(workspaceRoot), ".agents", "plugins-disabled");
}

export function getPluginsDir(scope, workspaceRoot, { enabled = true } = {}) {
  if (scope === "global") {
    return enabled ? getGlobalPluginsDir() : getDisabledGlobalPluginsDir();
  }
  return enabled ? getProjectPluginsDir(workspaceRoot) : getDisabledProjectPluginsDir(workspaceRoot);
}

function assertSafeSlug(slug) {
  if (typeof slug !== "string" || !/^(?!\.\.?$)[A-Za-z0-9_.-]+$/.test(slug)) {
    throw new Error(`Invalid plugin folder slug: ${slug}`);
  }
}

/** Convert "owner/repo" (and optional short pluginName) into a safe directory slug ("owner--name"). */
export function pluginSlug(id, pluginName = null) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(id)) {
    throw new Error(`Invalid plugin ID: ${id}`);
  }
  const [owner, repo] = id.split("/");
  let shortName = "";
  if (typeof pluginName === "string" && pluginName.trim()) {
    shortName = pluginName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_.-]+/g, "-")
      .replace(/^[.-]+|[.-]+$/g, "");
  }
  if (!shortName || shortName === "." || shortName === "..") {
    shortName = repo.toLowerCase();
  }
  const slug = `${owner.toLowerCase()}--${shortName}`;
  assertSafeSlug(slug);
  return slug;
}

// ---------------------------------------------------------------------------
// Atomic Same-Volume Publish with Cross-Device (EXDEV) & Busy-Lock Fallbacks
// ---------------------------------------------------------------------------
export async function moveDirAtomic(srcDir, destDir, options = {}) {
  const { allowInPlaceSync = true, fsOps = fs, syncDirFn = syncPluginDirectory } = options;
  const backupDir = `${destDir}.bak.${Date.now()}`;
  const hadExisting = await fsOps.access(destDir).then(() => true).catch(() => false);

  if (hadExisting) {
    try {
      await fsOps.rename(destDir, backupDir);
    } catch (renameErr) {
      if (allowInPlaceSync && isBusyLockError(renameErr)) {
        try {
          syncDirFn(srcDir, destDir);
          await fsOps.rm(srcDir, { recursive: true, force: true }).catch(() => {});
          return { syncedInPlace: true };
        } catch (syncErr) {
          if (isBusyLockError(syncErr)) {
            throw new PluginBusyLockError(
              `Plugin files in "${destDir}" are currently locked by an active process.`,
              { code: syncErr.code || renameErr.code, targetPath: destDir, cause: syncErr }
            );
          }
          throw syncErr;
        }
      }
      if (isBusyLockError(renameErr)) {
        throw new PluginBusyLockError(
          `Plugin folder "${destDir}" is currently locked by an active process.`,
          { code: renameErr.code, targetPath: destDir, cause: renameErr }
        );
      }
      throw renameErr;
    }
  }

  try {
    await fsOps.mkdir(path.dirname(destDir), { recursive: true });
    try {
      await fsOps.rename(srcDir, destDir);
    } catch (err) {
      if (err.code !== "EXDEV") throw err;
      await fsOps.cp(srcDir, destDir, { recursive: true, force: true });
      await fsOps.rm(srcDir, { recursive: true, force: true });
    }
    if (hadExisting) {
      await fsOps.rm(backupDir, { recursive: true, force: true }).catch(() => {});
    }
    return { syncedInPlace: false };
  } catch (err) {
    // Roll back previous version if swap fails mid-flight
    if (hadExisting) {
      await fsOps.rm(destDir, { recursive: true, force: true }).catch(() => {});
      await fsOps.rename(backupDir, destDir).catch(() => {});
    }
    if (isBusyLockError(err)) {
      throw new PluginBusyLockError(
        `Plugin folder "${srcDir}" is currently locked by an active process.`,
        { code: err.code, targetPath: srcDir, cause: err }
      );
    }
    throw err;
  }
}

async function relocateStageDir(stageDir, pendingStageRoot, fsOps) {
  if (!pendingStageRoot) return stageDir;
  const resolvedRoot = path.resolve(pendingStageRoot);
  if (path.resolve(path.dirname(stageDir)) === resolvedRoot) return stageDir;

  await fsOps.mkdir(resolvedRoot, { recursive: true });
  const targetStage = path.join(resolvedRoot, path.basename(stageDir));
  await fsOps.rm(targetStage, { recursive: true, force: true }).catch(() => {});
  try {
    await fsOps.rename(stageDir, targetStage);
  } catch (err) {
    if (err.code !== "EXDEV" && !isBusyLockError(err)) throw err;
    try {
      await fsOps.cp(stageDir, targetStage, { recursive: true, force: true });
    } catch (cpErr) {
      await fsOps.rm(targetStage, { recursive: true, force: true }).catch(() => {});
      throw cpErr;
    }
    await fsOps.rm(stageDir, { recursive: true, force: true }).catch(() => {});
  }
  return targetStage;
}

async function stagePendingUpdate({
  pluginEntry,
  slug,
  scope,
  workspaceRoot,
  stageDir,
  pendingStageRoot,
  finalDir,
  legacyDir,
  replaceSlug,
  fsOps,
}) {
  const safeStageDir = await relocateStageDir(stageDir, pendingStageRoot, fsOps);
  return {
    status: "pending_restart",
    pendingUpdate: {
      id: pluginEntry.id,
      slug,
      scope,
      workspaceRoot: scope === "project" && workspaceRoot ? path.resolve(workspaceRoot) : null,
      stageDir: safeStageDir,
      finalDir,
      legacyDir: legacyDir || null,
      legacySlug: legacyDir ? replaceSlug : null,
      version: pluginEntry.version,
      sha: pluginEntry.release.sha,
      contentTreeSha256: pluginEntry.release.contentTreeSha256,
      capabilities: pluginEntry.security.capabilities,
      stagedAt: new Date().toISOString(),
    },
  };
}

export async function installPlugin({
  pluginEntry,
  denylist,
  scope,
  workspaceRoot,
  replaceSlug = null,
  replaceEnabled = true,
  pendingStageRoot = null,
  fsOps = fs,
  moveDirFn = moveDirAtomic,
}) {
  const idLower = pluginEntry.id.toLowerCase();
  const shaLower = pluginEntry.release.sha.toLowerCase();

  // 1. Hard denylist enforcement
  const blockedRepo = (denylist.blockedRepos || []).find((b) => b.id.toLowerCase() === idLower);
  if (blockedRepo) throw new Error(`Blocked by registry denylist: ${blockedRepo.reason}`);

  const blockedSha = (denylist.blockedShas || []).find(
    (b) => b.id.toLowerCase() === idLower && b.sha.toLowerCase() === shaLower
  );
  if (blockedSha) throw new Error(`Release SHA blocked by denylist: ${blockedSha.reason}`);

  // 2. Always stage outside the live plugins root (in pendingStageRoot or OS temp) so
  // failed or interrupted installs never leave duplicate plugin folders inside plugins/.
  const pluginsRoot = scope === "global"
    ? getGlobalPluginsDir()
    : getProjectPluginsDir(workspaceRoot);
  await fsOps.mkdir(pluginsRoot, { recursive: true });

  const slug = pluginSlug(pluginEntry.id, pluginEntry.pluginName);
  const finalDir = path.join(pluginsRoot, slug);
  const stageRoot = pendingStageRoot
    ? path.resolve(pendingStageRoot)
    : path.join(os.tmpdir(), "agy-marketplace-stage");
  await fsOps.mkdir(stageRoot, { recursive: true });
  const stageDir = path.join(stageRoot, `.${slug}.install.${crypto.randomBytes(6).toString("hex")}.tmp`);

  // Optional migration source when adopting a differently named manual folder (e.g., "context-mode" -> "owner--context-mode")
  let legacyDir = null;
  let legacyBackupDir = null;
  if (replaceSlug && replaceSlug !== slug) {
    assertSafeSlug(replaceSlug);
    const legacyRoot = getPluginsDir(scope, workspaceRoot, { enabled: replaceEnabled });
    legacyDir = resolveInside(legacyRoot, replaceSlug);
  }

  await fsOps.mkdir(stageDir, { recursive: true });

  try {
    await extractVerifiedTarball(
      pluginEntry.release.tarballUrl,
      stageDir,
      pluginEntry.release.contentTreeSha256
    );

    if (legacyDir && (await fsOps.access(legacyDir).then(() => true).catch(() => false))) {
      legacyBackupDir = `${legacyDir}.migrate.${Date.now()}.bak`;
      try {
        await fsOps.rename(legacyDir, legacyBackupDir);
      } catch (err) {
        if (isBusyLockError(err)) {
          return stagePendingUpdate({
            pluginEntry,
            slug,
            scope,
            workspaceRoot,
            stageDir,
            pendingStageRoot,
            finalDir,
            legacyDir,
            replaceSlug,
            fsOps,
          });
        }
        throw err;
      }
    }

    try {
      await moveDirFn(stageDir, finalDir);
    } catch (err) {
      if (isBusyLockError(err)) {
        if (legacyBackupDir && legacyDir) {
          await fsOps.rename(legacyBackupDir, legacyDir).catch(() => {});
        }
        return stagePendingUpdate({
          pluginEntry,
          slug,
          scope,
          workspaceRoot,
          stageDir,
          pendingStageRoot,
          finalDir,
          legacyDir,
          replaceSlug,
          fsOps,
        });
      }
      throw err;
    }

    // Clean up any stale disabled copy of the same plugin so it is not duplicated
    const staleDisabledDir = path.join(getPluginsDir(scope, workspaceRoot, { enabled: false }), slug);
    await fsOps.rm(staleDisabledDir, { recursive: true, force: true }).catch(() => {});

    if (legacyBackupDir) {
      await fsOps.rm(legacyBackupDir, { recursive: true, force: true }).catch(() => {});
    }
  } catch (err) {
    // Restore legacy manual folder if adoption swap fails mid-flight
    if (legacyBackupDir && legacyDir) {
      await fsOps.rename(legacyBackupDir, legacyDir).catch(() => {});
    }
    await fsOps.rm(stageDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }

  return {
    id: pluginEntry.id,
    slug,
    scope,
    installPath: finalDir,
    enabled: true,
    version: pluginEntry.version,
    sha: pluginEntry.release.sha,
    contentTreeSha256: pluginEntry.release.contentTreeSha256,
    capabilities: pluginEntry.security.capabilities,
    installedAt: new Date().toISOString(),
    ...(legacyDir ? { migratedFrom: { slug: replaceSlug, installPath: legacyDir } } : {}),
  };
}

export async function setPluginEnabled({ slug, scope, workspaceRoot, enabled }) {
  assertSafeSlug(slug);
  const fromRoot = getPluginsDir(scope, workspaceRoot, { enabled: !enabled });
  const toRoot = getPluginsDir(scope, workspaceRoot, { enabled });
  await fs.mkdir(toRoot, { recursive: true });

  const srcDir = resolveInside(fromRoot, slug);
  const destDir = resolveInside(toRoot, slug);

  const exists = await fs.access(srcDir).then(() => true).catch(() => false);
  if (!exists) {
    throw new Error(`Plugin "${slug}" is not currently ${enabled ? "disabled" : "enabled"} in ${scope} scope.`);
  }

  try {
    await moveDirAtomic(srcDir, destDir, { allowInPlaceSync: false });
  } catch (err) {
    if (isBusyLockError(err)) {
      throw new PluginBusyLockError(
        `Plugin "${slug}" is currently in use by an active process. Close or restart Antigravity App and try again.`,
        { code: err.code, targetPath: srcDir, cause: err }
      );
    }
    throw err;
  }
  return { slug, scope, enabled, fromPath: srcDir, installPath: destDir };
}

export async function uninstallPlugin({ slug, scope, workspaceRoot, enabled = true }) {
  const pluginsRoot = getPluginsDir(scope, workspaceRoot, { enabled });

  // Prevent path traversal out of the plugins root
  assertSafeSlug(slug);
  const targetDir = resolveInside(pluginsRoot, slug);
  await fs.rm(targetDir, { recursive: true, force: true });
  return { removed: targetDir };
}
