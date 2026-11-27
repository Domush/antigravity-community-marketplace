import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";
import tar from "tar-stream";
import { USER_AGENT } from "./catalog.mjs";

const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;
const MAX_FILES = 5000;
const TARBALL_FETCH_TIMEOUT_MS = 60_000;

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

/** Convert "owner/repo" into a safe directory slug ("owner--repo"). */
export function pluginSlug(id) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(id)) {
    throw new Error(`Invalid plugin ID: ${id}`);
  }
  return id.replace("/", "--").toLowerCase();
}

// ---------------------------------------------------------------------------
// Identical contentTreeSha256 Framing as scripts/crawl.mjs
// ---------------------------------------------------------------------------
async function collectRelativeFiles(
  rootDir,
  currentDir = rootDir,
  out = [],
  { excludeDotGit = false } = {}
) {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    if (excludeDotGit && entry.name === ".git") continue;
    const full = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      await collectRelativeFiles(rootDir, full, out, { excludeDotGit });
    } else if (entry.isFile()) {
      out.push(path.relative(rootDir, full).split(path.sep).join("/"));
    }
  }
  return out;
}

export async function computeContentTreeSha256(rootDir, { excludeDotGit = false } = {}) {
  const files = await collectRelativeFiles(rootDir, rootDir, [], { excludeDotGit });
  files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const hash = crypto.createHash("sha256");
  const nul = Buffer.from([0]);

  for (const relPath of files) {
    const bytes = await fs.readFile(path.join(rootDir, ...relPath.split("/")));
    hash.update(relPath, "utf8");
    hash.update(nul);
    hash.update(String(bytes.length), "utf8");
    hash.update(nul);
    hash.update(bytes);
    hash.update(nul);
  }
  return hash.digest("hex");
}

// ---------------------------------------------------------------------------
// Zip-Slip-Safe & Bomb-Hardened Tarball Extraction
// ---------------------------------------------------------------------------
function stripTopLevelDir(rawName) {
  const normalized = rawName.replaceAll("\\", "/").replace(/^\.\/+/, "");
  if (!normalized || normalized === "pax_global_header") return null;
  const idx = normalized.indexOf("/");
  if (idx === -1) return null;
  const rest = normalized.slice(idx + 1);
  return rest.length > 0 ? rest : null;
}

function resolveInside(rootDir, relPath) {
  const parts = relPath.split("/");
  if (relPath.startsWith("/") || parts.some((p) => p === "..")) {
    throw new Error(`Zip-slip path rejected: ${relPath}`);
  }
  const dest = path.resolve(rootDir, relPath);
  const prefix = rootDir.endsWith(path.sep) ? rootDir : `${rootDir}${path.sep}`;
  if (dest !== rootDir && !dest.startsWith(prefix)) {
    throw new Error(`Path escapes staging directory: ${relPath}`);
  }
  return dest;
}

async function extractVerifiedTarball(tarballUrl, stageDir, expectedTreeSha256) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TARBALL_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(tarballUrl, {
      headers: { "User-Agent": USER_AGENT },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`Download failed (${res.status}) for ${tarballUrl}`);
    }

    let compressedBytes = 0;
    let uncompressedBytes = 0;
    let fileCount = 0;

    const sizeGuard = new Transform({
      transform(chunk, _enc, cb) {
        compressedBytes += chunk.length;
        if (compressedBytes > MAX_ARCHIVE_BYTES) {
          cb(new Error("Archive exceeds 25 MB compressed limit."));
          return;
        }
        cb(null, chunk);
      },
    });

    const extract = tar.extract();
    extract.on("entry", (header, stream, next) => {
      const run = async () => {
        if (header.type === "symlink" || header.type === "link") {
          stream.resume();
          throw new Error(`Refused archive link entry: ${header.name}`);
        }
        const rel = stripTopLevelDir(header.name);
        if (!rel) {
          stream.resume();
          return;
        }
        const dest = resolveInside(stageDir, rel);

        if (header.type === "directory") {
          await fs.mkdir(dest, { recursive: true });
          stream.resume();
          return;
        }
        if (header.type !== "file") {
          stream.resume();
          return;
        }

        fileCount += 1;
        if (fileCount > MAX_FILES) {
          stream.resume();
          throw new Error("Archive exceeds 5,000 file limit.");
        }

        await fs.mkdir(path.dirname(dest), { recursive: true });
        const uncompressedGuard = new Transform({
          transform(chunk, _enc, cb) {
            uncompressedBytes += chunk.length;
            if (uncompressedBytes > MAX_UNCOMPRESSED_BYTES) {
              cb(new Error("Archive exceeds 50 MB uncompressed limit."));
              return;
            }
            cb(null, chunk);
          },
        });
        await pipeline(stream, uncompressedGuard, createWriteStream(dest, { flags: "wx" }));
      };

      run().then(() => next()).catch((err) => {
        stream.destroy(err);
        next(err);
      });
    });

    await pipeline(Readable.fromWeb(res.body), sizeGuard, zlib.createGunzip(), extract);

    // Cryptographic integrity check BEFORE moving into the live plugins folder
    const actualHash = await computeContentTreeSha256(stageDir);
    if (actualHash !== expectedTreeSha256) {
      throw new Error(
        `Integrity mismatch: expected contentTreeSha256 ${expectedTreeSha256.slice(0, 12)}..., got ${actualHash.slice(0, 12)}...`
      );
    }
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Atomic Same-Volume Publish with Cross-Device (EXDEV) Fallback
// ---------------------------------------------------------------------------
async function moveDirAtomic(srcDir, destDir) {
  const backupDir = `${destDir}.bak.${Date.now()}`;
  const hadExisting = await fs.access(destDir).then(() => true).catch(() => false);

  try {
    if (hadExisting) await fs.rename(destDir, backupDir);
    try {
      await fs.rename(srcDir, destDir);
    } catch (err) {
      if (err.code !== "EXDEV") throw err;
      await fs.cp(srcDir, destDir, { recursive: true, force: true });
      await fs.rm(srcDir, { recursive: true, force: true });
    }
    if (hadExisting) await fs.rm(backupDir, { recursive: true, force: true });
  } catch (err) {
    // Roll back previous version if swap fails mid-flight
    if (hadExisting) {
      await fs.rm(destDir, { recursive: true, force: true }).catch(() => {});
      await fs.rename(backupDir, destDir).catch(() => {});
    }
    throw err;
  }
}

export async function installPlugin({
  pluginEntry,
  denylist,
  scope,
  workspaceRoot,
  replaceSlug = null,
  replaceEnabled = true,
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

  // 2. Stage inside the target plugins root so rename() stays on the same filesystem
  const pluginsRoot = scope === "global"
    ? getGlobalPluginsDir()
    : getProjectPluginsDir(workspaceRoot);
  await fs.mkdir(pluginsRoot, { recursive: true });

  const slug = pluginSlug(pluginEntry.id);
  const finalDir = path.join(pluginsRoot, slug);
  const stageDir = path.join(pluginsRoot, `.${slug}.install.${crypto.randomBytes(6).toString("hex")}.tmp`);

  // Optional migration source when adopting a differently named manual folder (e.g., "context-mode" -> "owner--context-mode")
  let legacyDir = null;
  let legacyBackupDir = null;
  if (replaceSlug && replaceSlug !== slug) {
    assertSafeSlug(replaceSlug);
    const legacyRoot = getPluginsDir(scope, workspaceRoot, { enabled: replaceEnabled });
    legacyDir = resolveInside(legacyRoot, replaceSlug);
  }

  await fs.mkdir(stageDir, { recursive: true });

  try {
    await extractVerifiedTarball(
      pluginEntry.release.tarballUrl,
      stageDir,
      pluginEntry.release.contentTreeSha256
    );

    if (legacyDir && (await fs.access(legacyDir).then(() => true).catch(() => false))) {
      legacyBackupDir = `${legacyDir}.migrate.${Date.now()}.bak`;
      await fs.rename(legacyDir, legacyBackupDir);
    }

    await moveDirAtomic(stageDir, finalDir);

    // Clean up any stale disabled copy of the same plugin so it is not duplicated
    const staleDisabledDir = path.join(getPluginsDir(scope, workspaceRoot, { enabled: false }), slug);
    await fs.rm(staleDisabledDir, { recursive: true, force: true }).catch(() => {});

    if (legacyBackupDir) {
      await fs.rm(legacyBackupDir, { recursive: true, force: true }).catch(() => {});
    }
  } catch (err) {
    // Restore legacy manual folder if adoption swap fails mid-flight
    if (legacyBackupDir && legacyDir) {
      await fs.rename(legacyBackupDir, legacyDir).catch(() => {});
    }
    await fs.rm(stageDir, { recursive: true, force: true }).catch(() => {});
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

  await moveDirAtomic(srcDir, destDir);
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
