import fs from "node:fs";
import path from "node:path";

const BUSY_DIR_LOCK_CODES = new Set(["EPERM", "EBUSY"]);
const PRUNE_DIR_LOCK_CODES = new Set(["EPERM", "EBUSY", "ENOTEMPTY"]);

/**
 * Resolve a path and strip any trailing directory separators (except filesystem root).
 */
export function stripTrailingSeparators(targetPath) {
  if (typeof targetPath !== "string" || targetPath.trim().length === 0) {
    throw new TypeError("stripTrailingSeparators requires a non-empty targetPath string");
  }
  const resolved = path.resolve(targetPath);
  const root = path.parse(resolved).root;
  if (resolved === root) return resolved;
  return resolved.replace(/[\\/]+$/, "");
}

function lstatOrNull(targetPath, fsOps) {
  try {
    return fsOps.lstatSync(targetPath);
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
}

function entryNameKey(name) {
  return process.platform === "win32" ? name.toLowerCase() : name;
}

/**
 * Safely remove a plugin directory or symlink/junction without deleting symlink targets.
 */
export function removePluginEntry(entryPath, fsOps = fs) {
  if (typeof entryPath !== "string" || entryPath.trim().length === 0) {
    throw new TypeError("removePluginEntry requires a non-empty entryPath string");
  }
  if (!fsOps || typeof fsOps !== "object" || Array.isArray(fsOps)) {
    throw new TypeError("removePluginEntry requires fsOps to be an object");
  }

  const normalizedPath = stripTrailingSeparators(entryPath);
  if (normalizedPath === path.parse(normalizedPath).root) {
    throw new Error(`Refusing to remove filesystem root: ${normalizedPath}`);
  }

  const stat = lstatOrNull(normalizedPath, fsOps);
  if (!stat) return false;

  if (stat.isSymbolicLink()) {
    try {
      fsOps.unlinkSync(normalizedPath);
    } catch (unlinkErr) {
      if (unlinkErr && (unlinkErr.code === "EPERM" || unlinkErr.code === "EISDIR")) {
        try {
          fsOps.rmdirSync(normalizedPath);
        } catch (rmdirErr) {
          if (rmdirErr && (rmdirErr.code === "ENOTDIR" || rmdirErr.code === "EINVAL")) {
            throw unlinkErr;
          }
          throw rmdirErr;
        }
      } else {
        throw unlinkErr;
      }
    }
    return true;
  }

  fsOps.rmSync(normalizedPath, { recursive: true, force: true });
  return true;
}

function copyTreeInPlace(srcDir, destDir, fsOps, removeEntryFn) {
  const existingDest = lstatOrNull(destDir, fsOps);
  if (existingDest && (existingDest.isSymbolicLink() || !existingDest.isDirectory())) {
    removeEntryFn(destDir);
  }
  fsOps.mkdirSync(destDir, { recursive: true });

  const entries = fsOps.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);

    if (entry.isSymbolicLink()) {
      const destStat = lstatOrNull(destPath, fsOps);
      if (destStat) {
        removeEntryFn(destPath);
      }
      fsOps.cpSync(srcPath, destPath, { dereference: false });
      continue;
    }

    if (entry.isDirectory()) {
      copyTreeInPlace(srcPath, destPath, fsOps, removeEntryFn);
      continue;
    }

    const destStat = lstatOrNull(destPath, fsOps);
    if (destStat && (destStat.isSymbolicLink() || destStat.isDirectory())) {
      removeEntryFn(destPath);
    }
    fsOps.copyFileSync(srcPath, destPath);
  }
}

function pruneStaleDir(dirPath, fsOps, removeEntryFn) {
  const entries = fsOps.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name);
    if (!entry.isSymbolicLink() && entry.isDirectory()) {
      pruneStaleDir(entryPath, fsOps, removeEntryFn);
    } else {
      removeEntryFn(entryPath);
    }
  }

  try {
    fsOps.rmdirSync(dirPath);
  } catch (err) {
    if (!err || !PRUNE_DIR_LOCK_CODES.has(err.code)) {
      throw err;
    }
  }
}

function pruneStaleEntries(srcDir, destDir, fsOps, removeEntryFn) {
  const srcEntries = fsOps.readdirSync(srcDir, { withFileTypes: true });
  const srcMap = new Map();
  for (const entry of srcEntries) {
    srcMap.set(entryNameKey(entry.name), entry);
  }

  const destEntries = fsOps.readdirSync(destDir, { withFileTypes: true });
  for (const destEntry of destEntries) {
    const destPath = path.join(destDir, destEntry.name);
    const srcEntry = srcMap.get(entryNameKey(destEntry.name));
    if (!srcEntry) {
      if (!destEntry.isSymbolicLink() && destEntry.isDirectory()) {
        pruneStaleDir(destPath, fsOps, removeEntryFn);
      } else {
        removeEntryFn(destPath);
      }
      continue;
    }

    if (
      !destEntry.isSymbolicLink() &&
      destEntry.isDirectory() &&
      !srcEntry.isSymbolicLink() &&
      srcEntry.isDirectory()
    ) {
      pruneStaleEntries(path.join(srcDir, srcEntry.name), destPath, fsOps, removeEntryFn);
    }
  }
}

/**
 * Synchronize srcDir into destDir, falling back to safe in-place overwrite and
 * stale-entry pruning when destDir cannot be removed due to an active EPERM/EBUSY lock.
 */
export function syncPluginDirectory(srcDir, destDir, options = {}) {
  if (typeof srcDir !== "string" || srcDir.trim().length === 0) {
    throw new TypeError("syncPluginDirectory requires a non-empty srcDir string");
  }
  if (typeof destDir !== "string" || destDir.trim().length === 0) {
    throw new TypeError("syncPluginDirectory requires a non-empty destDir string");
  }
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("syncPluginDirectory requires options to be a plain object when provided");
  }

  const fsOps = options.fsOps === undefined ? fs : options.fsOps;
  if (!fsOps || typeof fsOps !== "object" || Array.isArray(fsOps)) {
    throw new TypeError("syncPluginDirectory requires options.fsOps to be an object");
  }
  const removeEntryFn =
    options.removeEntryFn === undefined
      ? (targetPath) => removePluginEntry(targetPath, fsOps)
      : options.removeEntryFn;
  if (typeof removeEntryFn !== "function") {
    throw new TypeError("syncPluginDirectory requires options.removeEntryFn to be a function");
  }

  const srcStat = fsOps.statSync(srcDir);
  if (!srcStat.isDirectory()) {
    throw new Error(`syncPluginDirectory requires srcDir to be a directory: ${srcDir}`);
  }

  const normalizedDest = stripTrailingSeparators(destDir);
  if (normalizedDest === path.parse(normalizedDest).root) {
    throw new Error(`Refusing to sync into filesystem root: ${normalizedDest}`);
  }

  try {
    removeEntryFn(normalizedDest);
  } catch (err) {
    if (!err || !BUSY_DIR_LOCK_CODES.has(err.code)) {
      throw err;
    }

    const destStat = lstatOrNull(normalizedDest, fsOps);
    if (destStat && destStat.isSymbolicLink()) {
      throw new Error(`Refusing in-place sync into locked symlinked directory: ${normalizedDest}`);
    }
    if (destStat && !destStat.isDirectory()) {
      throw new Error(`Refusing in-place sync into non-directory path: ${normalizedDest}`);
    }

    copyTreeInPlace(srcDir, normalizedDest, fsOps, removeEntryFn);
    pruneStaleEntries(srcDir, normalizedDest, fsOps, removeEntryFn);
    return { mode: "in-place" };
  }

  fsOps.cpSync(srcDir, normalizedDest, { recursive: true, dereference: false });
  return { mode: "replaced" };
}
