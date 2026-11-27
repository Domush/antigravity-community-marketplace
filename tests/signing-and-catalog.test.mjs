import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  buildSigningTranscript,
  computeKeyId,
  RegistryCatalog,
  SignatureVerificationError,
  verifySignedArtifact,
} from "../server/lib/catalog.mjs";
import { PluginStore } from "../server/lib/store.mjs";

// ---------------------------------------------------------------------------
// Test Helpers: Temp Dirs, Ephemeral Keypairs, Signing & Loopback Registry
// ---------------------------------------------------------------------------
async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-sig-test-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function makeKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return {
    publicKey,
    privateKey,
    keyId: computeKeyId(publicKey),
    publicPem: publicKey.export({ type: "spki", format: "pem" }),
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }),
  };
}

/** Sign raw JSON bytes with an explicit signedAt timestamp for deterministic rollback tests. */
function signArtifact({ fileName, data, keypair, signedAt }) {
  const rawBytes = Buffer.from(JSON.stringify(data, null, 2) + "\n", "utf8");
  const sha256 = crypto.createHash("sha256").update(rawBytes).digest("hex");
  const transcript = buildSigningTranscript({ file: fileName, signedAt, rawBytes });
  const signature = crypto.sign(null, transcript, keypair.privateKey).toString("base64");

  const sigEnvelope = {
    schemaVersion: 1,
    alg: "Ed25519",
    keyId: keypair.keyId,
    file: fileName,
    signedAt,
    sha256,
    signature,
  };
  const sigBytes = Buffer.from(JSON.stringify(sigEnvelope, null, 2) + "\n", "utf8");
  return { rawBytes, sigEnvelope, sigBytes };
}

function makeSampleIndex(generatedAt, extraPlugins = []) {
  return {
    schemaVersion: 1,
    generatedAt,
    crawlerVersion: "1.0.0",
    scannerVersion: "1.1.0",
    totalPlugins: extraPlugins.length,
    plugins: extraPlugins,
  };
}

function makeSampleDenylist(updatedAt, blockedRepos = []) {
  return {
    schemaVersion: 1,
    updatedAt,
    blockedRepos,
    blockedShas: [],
  };
}

/**
 * Loopback HTTP registry server supporting dynamic route swaps, ETags, and 304 Not Modified.
 * Route value can be `{ body: Buffer, etag?: string, status?: number }` or a function `(req, hitCount) => ...`.
 */
async function withMockRegistryServer(initialRoutes, fn) {
  const routes = new Map(Object.entries(initialRoutes));
  const hits = new Map();

  const server = http.createServer((req, res) => {
    const count = (hits.get(req.url) || 0) + 1;
    hits.set(req.url, count);

    const entryOrFn = routes.get(req.url);
    const resolved = typeof entryOrFn === "function" ? entryOrFn(req, count) : entryOrFn;
    if (!resolved) {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }

    const etag = resolved.etag || `"${crypto.createHash("sha256").update(resolved.body).digest("hex").slice(0, 16)}"`;
    if (req.headers["if-none-match"] === etag && (!resolved.status || resolved.status === 200)) {
      res.writeHead(304, { ETag: etag });
      res.end();
      return;
    }

    res.writeHead(resolved.status || 200, {
      "Content-Type": "application/json",
      ETag: etag,
    });
    res.end(resolved.body);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const close = () => new Promise((resolve) => server.close(resolve));
  let closed = false;

  try {
    return await fn({
      baseUrl,
      routes,
      hits,
      stopServer: async () => {
        if (!closed) {
          closed = true;
          await close();
        }
      },
    });
  } finally {
    if (!closed) await close();
  }
}

// ---------------------------------------------------------------------------
// 1. Valid Verification, ETag 304, Offline Cache & Transitive Detail Integrity
// ---------------------------------------------------------------------------
describe("server/lib/catalog.mjs — valid signatures, caching, and transitive detail hashes", () => {
  it("verifies signed artifacts, honors 304 Not Modified, survives offline outages, and recovers from local cache tampering", async () => {
    const kp = makeKeypair();
    await withTempDir(async (tmp) => {
      const dataDir = path.join(tmp, "plugin-data");

      const detailObj = { schemaVersion: 1, id: "acme/tool", readmeMarkdown: "# Tool" };
      const detailBuf = Buffer.from(JSON.stringify(detailObj, null, 2) + "\n", "utf8");
      const detailSha256 = crypto.createHash("sha256").update(detailBuf).digest("hex");

      const indexObj = makeSampleIndex("2026-11-27T01:00:00Z", [
        {
          id: "acme/tool",
          name: "Tool",
          detailPath: "plugins/acme/tool.json",
          detailSha256,
        },
      ]);
      const denylistObj = makeSampleDenylist("2026-11-27T01:00:00Z");

      const signedIndex = signArtifact({
        fileName: "index.json",
        data: indexObj,
        keypair: kp,
        signedAt: "2026-11-27T01:00:05.000Z",
      });
      const signedDenylist = signArtifact({
        fileName: "denylist.json",
        data: denylistObj,
        keypair: kp,
        signedAt: "2026-11-27T01:00:05.000Z",
      });

      const routes = {
        "/index.json": { body: signedIndex.rawBytes },
        "/index.json.sig": { body: signedIndex.sigBytes },
        "/denylist.json": { body: signedDenylist.rawBytes },
        "/denylist.json.sig": { body: signedDenylist.sigBytes },
        "/plugins/acme/tool.json": { body: detailBuf },
      };

      const store = new PluginStore(dataDir);
      await store.init();

      await withMockRegistryServer(routes, async ({ baseUrl, routes: liveRoutes, hits, stopServer }) => {
        const catalog = new RegistryCatalog(baseUrl, store, {
          trustedPublicKeys: { [kp.keyId]: kp.publicPem },
          requireSignatures: true,
        });

        // 1. Initial verified fetches
        const idx1 = await catalog.getIndex({ force: true });
        const deny1 = await catalog.getDenylist({ force: true });
        assert.equal(idx1.totalPlugins, 1);
        assert.equal(deny1.blockedRepos.length, 0);
        assert.equal(hits.get("/index.json"), 1);
        assert.equal(hits.get("/index.json.sig"), 1);

        // 2. Forced revalidation hits 304 Not Modified without re-fetching .sig
        const idx2 = await catalog.getIndex({ force: true });
        assert.equal(idx2.totalPlugins, 1);
        assert.equal(hits.get("/index.json"), 2);
        assert.equal(hits.get("/index.json.sig"), 1);

        // 3. Transitive detailSha256 passes on valid detail, fails closed on tampered detail
        const detail = await catalog.getPluginDetail(idx1.plugins[0], { force: true });
        assert.equal(detail.id, "acme/tool");

        liveRoutes.set("/plugins/acme/tool.json", {
          body: Buffer.from(JSON.stringify({ ...detailObj, readmeMarkdown: "# TAMPERED" })),
        });
        await assert.rejects(
          () => catalog.getPluginDetail(idx1.plugins[0], { force: true }),
          (err) => err instanceof SignatureVerificationError && /Detail shard integrity mismatch/.test(err.message)
        );

        // 4. Local disk cache tampered -> catalog detects bad cached signature and re-fetches clean signed copy
        await fs.writeFile(
          path.join(store.cacheDir, "index.json"),
          JSON.stringify({ ...indexObj, totalPlugins: 999 })
        );
        const recovered = await catalog.getIndex({ force: false });
        assert.equal(recovered.totalPlugins, 1);

        // 5. Network outage -> serves cryptographically verified local cache
        await stopServer();
        const offlineIndex = await catalog.getIndex({ force: true });
        assert.equal(offlineIndex.totalPlugins, 1);
      });
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Tampered JSON, Forged Signature, Cross-File Replay & CDN Desync Recovery
// ---------------------------------------------------------------------------
describe("server/lib/catalog.mjs — tamper, replay, and CDN desync defenses", () => {
  it("fails closed on single-byte JSON tampering even when a valid cached copy exists", async () => {
    const kp = makeKeypair();
    await withTempDir(async (dataDir) => {
      const store = new PluginStore(dataDir);
      await store.init();

      const validSigned = signArtifact({
        fileName: "index.json",
        data: makeSampleIndex("2026-11-27T02:00:00Z"),
        keypair: kp,
        signedAt: "2026-11-27T02:00:00.000Z",
      });

      const routes = {
        "/index.json": { body: validSigned.rawBytes },
        "/index.json.sig": { body: validSigned.sigBytes },
      };

      await withMockRegistryServer(routes, async ({ baseUrl, routes: liveRoutes }) => {
        const catalog = new RegistryCatalog(baseUrl, store, {
          trustedPublicKeys: { [kp.keyId]: kp.publicPem },
          requireSignatures: true,
        });

        await catalog.getIndex({ force: true });

        const tamperedJson = Buffer.from(
          validSigned.rawBytes.toString("utf8").replace('"totalPlugins": 0', '"totalPlugins": 1'),
          "utf8"
        );
        liveRoutes.set("/index.json", { body: tamperedJson });

        await assert.rejects(
          () => catalog.getIndex({ force: true }),
          (err) => err instanceof SignatureVerificationError && /Digest mismatch/.test(err.message)
        );
      });
    });
  });

  it("rejects forged Ed25519 signature bytes even when sha256 matches tampered JSON", () => {
    const kp = makeKeypair();
    const signed = signArtifact({
      fileName: "index.json",
      data: makeSampleIndex("2026-11-27T02:00:00Z"),
      keypair: kp,
      signedAt: "2026-11-27T02:00:00.000Z",
    });

    const forgedRaw = Buffer.from(
      signed.rawBytes.toString("utf8").replace('"totalPlugins": 0', '"totalPlugins": 7'),
      "utf8"
    );
    const forgedEnvelope = {
      ...signed.sigEnvelope,
      sha256: crypto.createHash("sha256").update(forgedRaw).digest("hex"),
    };

    assert.throws(
      () =>
        verifySignedArtifact({
          fileName: "index.json",
          rawBytes: forgedRaw,
          sigEnvelope: forgedEnvelope,
          trustedKeysMap: new Map([[kp.keyId, kp.publicKey]]),
        }),
      (err) => err instanceof SignatureVerificationError && /Invalid Ed25519 signature/.test(err.message)
    );
  });

  it("rejects cross-file replay (valid denylist.json + .sig served as index.json)", async () => {
    const kp = makeKeypair();
    await withTempDir(async (dataDir) => {
      const store = new PluginStore(dataDir);
      await store.init();

      const legitDenylist = signArtifact({
        fileName: "denylist.json",
        data: makeSampleDenylist("2026-11-27T02:00:00Z"),
        keypair: kp,
        signedAt: "2026-11-27T02:00:00.000Z",
      });

      const routes = {
        "/index.json": { body: legitDenylist.rawBytes },
        "/index.json.sig": { body: legitDenylist.sigBytes },
      };

      await withMockRegistryServer(routes, async ({ baseUrl }) => {
        const catalog = new RegistryCatalog(baseUrl, store, {
          trustedPublicKeys: { [kp.keyId]: kp.publicPem },
          requireSignatures: true,
        });

        await assert.rejects(
          () => catalog.getIndex({ force: true }),
          (err) => err instanceof SignatureVerificationError && /Cross-file replay detected/.test(err.message)
        );
      });
    });
  });

  it("recovers automatically when CDN serves a momentarily out-of-sync JSON + .sig pair on attempt 1", async () => {
    const kp = makeKeypair();
    await withTempDir(async (dataDir) => {
      const store = new PluginStore(dataDir);
      await store.init();

      const oldArtifact = signArtifact({
        fileName: "index.json",
        data: makeSampleIndex("2026-11-27T01:00:00Z"),
        keypair: kp,
        signedAt: "2026-11-27T01:00:00.000Z",
      });
      const newArtifact = signArtifact({
        fileName: "index.json",
        data: makeSampleIndex("2026-11-27T02:00:00Z"),
        keypair: kp,
        signedAt: "2026-11-27T02:00:00.000Z",
      });

      const routes = {
        "/index.json": { body: newArtifact.rawBytes },
        "/index.json.sig": (_req, hitCount) => ({
          body: hitCount === 1 ? oldArtifact.sigBytes : newArtifact.sigBytes,
        }),
      };

      await withMockRegistryServer(routes, async ({ baseUrl, hits }) => {
        const catalog = new RegistryCatalog(baseUrl, store, {
          trustedPublicKeys: { [kp.keyId]: kp.publicPem },
          requireSignatures: true,
        });

        const idx = await catalog.getIndex({ force: true });
        assert.equal(idx.generatedAt, "2026-11-27T02:00:00Z");
        assert.equal(hits.get("/index.json"), 2);
        assert.equal(hits.get("/index.json.sig"), 2);
      });
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Denylist Rollback Blocking (signedAt & updatedAt Watermarks)
// ---------------------------------------------------------------------------
describe("server/lib/catalog.mjs — denylist rollback blocking", () => {
  it("blocks replay of an older legitimately signed denylist.json after a newer revocation was seen", async () => {
    const kp = makeKeypair();
    await withTempDir(async (dataDir) => {
      const store = new PluginStore(dataDir);
      await store.init();

      const olderCleanDenylist = signArtifact({
        fileName: "denylist.json",
        data: makeSampleDenylist("2026-11-26T10:00:00Z", []),
        keypair: kp,
        signedAt: "2026-11-26T10:00:05.000Z",
      });
      const newerRevokingDenylist = signArtifact({
        fileName: "denylist.json",
        data: makeSampleDenylist("2026-11-27T10:00:00Z", [
          {
            id: "evil/stealer",
            reason: "Exfiltrates ~/.gemini keys",
            severity: "critical",
            blockedAt: "2026-11-27T09:55:00Z",
          },
        ]),
        keypair: kp,
        signedAt: "2026-11-27T10:00:05.000Z",
      });

      const routes = {
        "/denylist.json": { body: newerRevokingDenylist.rawBytes },
        "/denylist.json.sig": { body: newerRevokingDenylist.sigBytes },
      };

      await withMockRegistryServer(routes, async ({ baseUrl, routes: liveRoutes }) => {
        const catalog = new RegistryCatalog(baseUrl, store, {
          trustedPublicKeys: { [kp.keyId]: kp.publicPem },
          requireSignatures: true,
        });

        const latest = await catalog.getDenylist({ force: true });
        assert.equal(latest.blockedRepos.length, 1);
        assert.equal(latest.blockedRepos[0].id, "evil/stealer");

        liveRoutes.set("/denylist.json", { body: olderCleanDenylist.rawBytes });
        liveRoutes.set("/denylist.json.sig", { body: olderCleanDenylist.sigBytes });

        await assert.rejects(
          () => catalog.getDenylist({ force: true }),
          (err) => err instanceof SignatureVerificationError && /Rollback attack detected/.test(err.message)
        );
      });
    });
  });

  it("blocks document updatedAt rollback even when signedAt is fresh", () => {
    const kp = makeKeypair();
    const rolledBackDoc = signArtifact({
      fileName: "denylist.json",
      data: makeSampleDenylist("2026-11-25T00:00:00Z"),
      keypair: kp,
      signedAt: "2026-11-27T12:00:00.000Z",
    });

    assert.throws(
      () =>
        verifySignedArtifact({
          fileName: "denylist.json",
          rawBytes: rolledBackDoc.rawBytes,
          sigEnvelope: rolledBackDoc.sigEnvelope,
          trustedKeysMap: new Map([[kp.keyId, kp.publicKey]]),
          minSignedAtMs: Date.parse("2026-11-27T11:00:00.000Z"),
          minDocTimestampMs: Date.parse("2026-11-26T00:00:00Z"),
          docTimestampField: "updatedAt",
        }),
      (err) => err instanceof SignatureVerificationError && /Rollback attack detected.*updatedAt/.test(err.message)
    );
  });
});
