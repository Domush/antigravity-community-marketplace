import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
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

function stripTopLevelDir(rawName) {
  const normalized = rawName.replaceAll("\\", "/").replace(/^\.\/+/, "");
  if (!normalized || normalized === "pax_global_header") return null;
  const idx = normalized.indexOf("/");
  if (idx === -1) return null;
  const rest = normalized.slice(idx + 1);
  return rest.length > 0 ? rest : null;
}

export function resolveInside(rootDir, relPath) {
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

export async function extractVerifiedTarball(tarballUrl, stageDir, expectedTreeSha256) {
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
