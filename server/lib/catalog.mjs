import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const SOFT_TTL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;
const USER_AGENT = "agy-community-marketplace/1.0.0";
const SIGNING_DOMAIN = "agy-registry-sig-v1";

/**
 * Pin one or more Ed25519 SPKI public keys keyed by 16-char hex SPKI SHA-256 fingerprint.
 * Keeping an old + new key in this map allows zero-downtime key rotation.
 */
export const DEFAULT_TRUSTED_PUBLIC_KEYS = {
  "39619f51b6d74dfa": `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAmuOzO8i/I8liWn2Vk1wY3PAWXciq/yQOaeiU4OfonTg=
-----END PUBLIC KEY-----`,
};

export class SignatureVerificationError extends Error {
  constructor(message) {
    super(message);
    this.name = "SignatureVerificationError";
  }
}

export function computeKeyId(publicKey) {
  const spkiDer = publicKey.export({ type: "spki", format: "der" });
  return crypto.createHash("sha256").update(spkiDer).digest("hex").slice(0, 16);
}

export function buildSigningTranscript({ file, signedAt, rawBytes }) {
  return Buffer.concat([
    Buffer.from(`${SIGNING_DOMAIN}\0${file}\0${signedAt}\0`, "utf8"),
    rawBytes,
  ]);
}

/**
 * Pure verification helper (also directly unit-testable offline).
 * Throws SignatureVerificationError on any mismatch, unknown key, or rollback.
 */
export function verifySignedArtifact({
  fileName,
  rawBytes,
  sigEnvelope,
  trustedKeysMap,
  minSignedAtMs = 0,
  minDocTimestampMs = 0,
  docTimestampField = null,
}) {
  if (!sigEnvelope || typeof sigEnvelope !== "object") {
    throw new SignatureVerificationError(`Missing or malformed signature envelope for ${fileName}.`);
  }
  if (sigEnvelope.schemaVersion !== 1 || sigEnvelope.alg !== "Ed25519") {
    throw new SignatureVerificationError(
      `Unsupported signature envelope format for ${fileName} (alg=${sigEnvelope.alg}).`
    );
  }
  if (sigEnvelope.file !== fileName) {
    throw new SignatureVerificationError(
      `Cross-file replay detected: signature was issued for "${sigEnvelope.file}", not "${fileName}".`
    );
  }

  const keyObj = trustedKeysMap.get(sigEnvelope.keyId);
  if (!keyObj) {
    throw new SignatureVerificationError(
      `Untrusted signing keyId "${sigEnvelope.keyId}" for ${fileName}. Update the marketplace plugin if the registry rotated keys.`
    );
  }

  const signedAtMs = Date.parse(sigEnvelope.signedAt);
  if (Number.isNaN(signedAtMs)) {
    throw new SignatureVerificationError(`Invalid signedAt timestamp in ${fileName}.sig.`);
  }
  if (minSignedAtMs > 0 && signedAtMs < minSignedAtMs) {
    throw new SignatureVerificationError(
      `Rollback attack detected for ${fileName}: signature timestamp (${sigEnvelope.signedAt}) is older than last verified copy.`
    );
  }

  const actualSha256 = crypto.createHash("sha256").update(rawBytes).digest("hex");
  if (sigEnvelope.sha256 !== actualSha256) {
    throw new SignatureVerificationError(
      `Digest mismatch for ${fileName}: expected ${sigEnvelope.sha256}, got ${actualSha256}.`
    );
  }

  const sigBytes = Buffer.from(String(sigEnvelope.signature || ""), "base64");
  const transcript = buildSigningTranscript({
    file: fileName,
    signedAt: sigEnvelope.signedAt,
    rawBytes,
  });
  const ok = crypto.verify(null, transcript, keyObj, sigBytes);
  if (!ok) {
    throw new SignatureVerificationError(`Invalid Ed25519 signature for ${fileName}.`);
  }

  let parsed;
  try {
    parsed = JSON.parse(rawBytes.toString("utf8"));
  } catch (err) {
    throw new SignatureVerificationError(`Signed ${fileName} is not valid JSON: ${err.message}`);
  }

  let docTimestampMs = 0;
  if (docTimestampField && parsed?.[docTimestampField]) {
    docTimestampMs = Date.parse(parsed[docTimestampField]);
    if (Number.isNaN(docTimestampMs)) {
      throw new SignatureVerificationError(`Invalid ${docTimestampField} in ${fileName}.`);
    }
    if (minDocTimestampMs > 0 && docTimestampMs < minDocTimestampMs) {
      throw new SignatureVerificationError(
        `Rollback attack detected for ${fileName}: ${docTimestampField} (${parsed[docTimestampField]}) is older than last verified copy.`
      );
    }
  }

  return { parsed, signedAtMs, docTimestampMs };
}

export class RegistryCatalog {
  constructor(
    registryBaseUrl,
    store,
    { trustedPublicKeys = DEFAULT_TRUSTED_PUBLIC_KEYS, requireSignatures = true } = {}
  ) {
    this.baseUrl = registryBaseUrl.replace(/\/+$/, "");
    this.store = store;
    this.requireSignatures = requireSignatures;
    this.trustedKeysMap = new Map();

    for (const [declaredId, pem] of Object.entries(trustedPublicKeys || {})) {
      if (!pem || !String(pem).trim()) continue;
      const keyObj = crypto.createPublicKey({ key: pem, format: "pem" });
      const derivedId = computeKeyId(keyObj);
      if (declaredId !== derivedId) {
        throw new Error(`Trusted keyId mismatch: declared "${declaredId}" vs derived "${derivedId}".`);
      }
      this.trustedKeysMap.set(derivedId, keyObj);
    }

    this.etagsPath = path.join(store.cacheDir, "etags.json");
    this.indexCachePath = path.join(store.cacheDir, "index.json");
    this.denylistCachePath = path.join(store.cacheDir, "denylist.json");
  }

  async loadMeta() {
    return this.store.readJson(this.etagsPath, {});
  }

  async saveMetaEntry(key, patch) {
    return this.store.enqueue("etags", async () => {
      const meta = await this.loadMeta();
      meta[key] = { ...(meta[key] || {}), ...patch };
      await this.store.writeJsonAtomic(this.etagsPath, meta);
    });
  }

  async writeBufferAtomic(filePath, buf) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    await fs.writeFile(tmpPath, buf);
    await fs.rename(tmpPath, filePath);
  }

  async readVerifiedCache({ fileName, cachePath, docTimestampField }) {
    let rawBytes;
    try {
      rawBytes = await fs.readFile(cachePath);
    } catch (err) {
      if (err.code === "ENOENT") return null;
      throw err;
    }

    if (!this.requireSignatures) {
      return JSON.parse(rawBytes.toString("utf8"));
    }

    const sigRaw = await fs.readFile(`${cachePath}.sig`, "utf8").catch(() => null);
    if (!sigRaw) return null;

    const sigEnvelope = JSON.parse(sigRaw);
    const { parsed } = verifySignedArtifact({
      fileName,
      rawBytes,
      sigEnvelope,
      trustedKeysMap: this.trustedKeysMap,
      docTimestampField,
    });
    return parsed;
  }

  async fetchBufferWithTimeout(url, headers = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, { headers, signal: controller.signal });
      const buf = res.status === 304 ? null : Buffer.from(await res.arrayBuffer());
      return { res, buf };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Fetch and cryptographically verify index.json or denylist.json with ETag caching.
   */
  async fetchSignedJson({ key, fileName, cachePath, docTimestampField, fallback, force = false }) {
    if (this.requireSignatures && this.trustedKeysMap.size === 0) {
      throw new SignatureVerificationError(
        "No trusted Ed25519 public keys configured in catalog.mjs."
      );
    }

    const meta = await this.loadMeta();
    const entry = meta[key] || {};

    let cachedVerified = null;
    try {
      cachedVerified = await this.readVerifiedCache({ fileName, cachePath, docTimestampField });
    } catch (err) {
      // Cached copy on disk was tampered with; force fresh verified download
      console.error(`[catalog] Cached ${fileName} failed verification (${err.message}); re-fetching.`);
      cachedVerified = null;
    }

    if (!force && cachedVerified && entry.fetchedAt && Date.now() - entry.fetchedAt < SOFT_TTL_MS) {
      return { data: cachedVerified, fromCache: true, notModified: false };
    }

    const baseHeaders = { Accept: "application/json", "User-Agent": USER_AGENT };
    const reqHeaders = { ...baseHeaders };
    if (entry.etag && cachedVerified) {
      reqHeaders["If-None-Match"] = entry.etag;
    }

    const dataUrl = `${this.baseUrl}/${fileName}`;
    const sigUrl = `${this.baseUrl}/${fileName}.sig`;

    // Retry once if CDN serves a momentarily out-of-sync JSON + .sig pair right after Pages deploy
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const headersForAttempt =
          attempt === 1 ? reqHeaders : { ...baseHeaders, "Cache-Control": "no-cache" };
        const { res, buf } = await this.fetchBufferWithTimeout(dataUrl, headersForAttempt);

        if (res.status === 304 && cachedVerified) {
          await this.saveMetaEntry(key, { fetchedAt: Date.now() });
          return { data: cachedVerified, fromCache: true, notModified: true };
        }
        if (!res.ok) {
          throw new Error(`HTTP ${res.status} fetching ${fileName}`);
        }

        if (!this.requireSignatures) {
          const parsed = JSON.parse(buf.toString("utf8"));
          await this.writeBufferAtomic(cachePath, buf);
          await this.saveMetaEntry(key, {
            etag: res.headers.get("etag") || null,
            fetchedAt: Date.now(),
          });
          return { data: parsed, fromCache: false, notModified: false };
        }

        const { res: sigRes, buf: sigBuf } = await this.fetchBufferWithTimeout(sigUrl, {
          ...baseHeaders,
          "Cache-Control": "no-cache",
        });
        if (!sigRes.ok) {
          throw new SignatureVerificationError(
            `Missing detached signature ${fileName}.sig (HTTP ${sigRes.status}).`
          );
        }

        let sigEnvelope;
        try {
          sigEnvelope = JSON.parse(sigBuf.toString("utf8"));
        } catch (err) {
          throw new SignatureVerificationError(`Malformed ${fileName}.sig JSON: ${err.message}`);
        }

        const { parsed, signedAtMs, docTimestampMs } = verifySignedArtifact({
          fileName,
          rawBytes: buf,
          sigEnvelope,
          trustedKeysMap: this.trustedKeysMap,
          minSignedAtMs: entry.verifiedSignedAtMs || 0,
          minDocTimestampMs: entry.verifiedDocTimestampMs || 0,
          docTimestampField,
        });

        // Persist exact verified raw bytes + .sig envelope atomically
        await this.writeBufferAtomic(`${cachePath}.sig`, sigBuf);
        await this.writeBufferAtomic(cachePath, buf);
        await this.saveMetaEntry(key, {
          etag: res.headers.get("etag") || null,
          fetchedAt: Date.now(),
          verifiedSignedAtMs: signedAtMs,
          verifiedDocTimestampMs: docTimestampMs,
        });

        return { data: parsed, fromCache: false, notModified: false };
      } catch (err) {
        if (err instanceof SignatureVerificationError) {
          if (attempt === 1 && /Digest mismatch|Invalid Ed25519/.test(err.message)) {
            await new Promise((r) => setTimeout(r, 1200));
            continue;
          }
          // Never fall back silently when cryptographic verification fails
          throw err;
        }
        // Network outage / timeout: serve last cryptographically verified local cache
        console.error(`[catalog] Network error fetching ${fileName}: ${err.message}`);
        if (cachedVerified) {
          return { data: cachedVerified, fromCache: true, staleError: err.message };
        }
        if (fallback !== undefined && !this.requireSignatures) {
          return { data: structuredClone(fallback), fromCache: false, staleError: err.message };
        }
        throw err;
      }
    }
  }

  async getIndex({ force = false } = {}) {
    const res = await this.fetchSignedJson({
      key: "index",
      fileName: "index.json",
      cachePath: this.indexCachePath,
      docTimestampField: "generatedAt",
      force,
    });
    return res.data;
  }

  async getDenylist({ force = false } = {}) {
    const res = await this.fetchSignedJson({
      key: "denylist",
      fileName: "denylist.json",
      cachePath: this.denylistCachePath,
      docTimestampField: "updatedAt",
      force,
    });
    return res.data;
  }

  /**
   * Detail shards remain ETag-cached; all install-critical fields (sha, tarballUrl,
   * contentTreeSha256, riskTier, capabilities) are already anchored in signed index.json.
   */
  async getPluginDetail(pluginEntry, { force = false } = {}) {
    const detailPath = pluginEntry.detailPath || `plugins/${pluginEntry.id}.json`;
    if (
      detailPath.includes("..") ||
      detailPath.startsWith("/") ||
      !/^plugins\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.json$/.test(detailPath)
    ) {
      throw new Error(`Unsafe detailPath rejected: ${detailPath}`);
    }

    const key = `detail:${pluginEntry.id.toLowerCase()}`;
    const safeFile = pluginEntry.id.replace("/", "--").toLowerCase() + ".json";
    const cachePath = path.join(this.store.detailsCacheDir, safeFile);

    const meta = await this.loadMeta();
    const entry = meta[key] || {};
    const cached = await this.store.readJson(cachePath, null);

    if (!force && cached && entry.fetchedAt && Date.now() - entry.fetchedAt < SOFT_TTL_MS) {
      return cached;
    }

    const headers = { Accept: "application/json", "User-Agent": USER_AGENT };
    if (entry.etag && cached) headers["If-None-Match"] = entry.etag;

    try {
      const { res, buf } = await this.fetchBufferWithTimeout(`${this.baseUrl}/${detailPath}`, headers);
      if (res.status === 304 && cached) {
        await this.saveMetaEntry(key, { fetchedAt: Date.now() });
        return cached;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${detailPath}`);

      // Optional transitive integrity check if crawler includes detailSha256 in index.json
      if (pluginEntry.detailSha256) {
        const actual = crypto.createHash("sha256").update(buf).digest("hex");
        if (actual !== pluginEntry.detailSha256) {
          throw new SignatureVerificationError(
            `Detail shard integrity mismatch for ${pluginEntry.id}.`
          );
        }
      }

      const data = JSON.parse(buf.toString("utf8"));
      await this.store.writeJsonAtomic(cachePath, data);
      await this.saveMetaEntry(key, { etag: res.headers.get("etag") || null, fetchedAt: Date.now() });
      return data;
    } catch (err) {
      if (err instanceof SignatureVerificationError) throw err;
      if (cached) return cached;
      throw err;
    }
  }
}
