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
} from "../server/lib/catalog.mjs";
import { PluginStore } from "../server/lib/store.mjs";

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-key-rot-"));
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

function makeSampleIndex(generatedAt) {
  return {
    schemaVersion: 1,
    generatedAt,
    crawlerVersion: "1.0.0",
    scannerVersion: "1.1.0",
    totalPlugins: 0,
    plugins: [],
  };
}

async function withMockRegistryServer(initialRoutes, fn) {
  const routes = new Map(Object.entries(initialRoutes));
  const server = http.createServer((req, res) => {
    const resolved = routes.get(req.url);
    if (!resolved) {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }
    const etag = resolved.etag || `"${crypto.createHash("sha256").update(resolved.body).digest("hex").slice(0, 16)}"`;
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, { ETag: etag });
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json", ETag: etag });
    res.end(resolved.body);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await fn({ baseUrl: `http://127.0.0.1:${port}`, routes });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// ---------------------------------------------------------------------------
// Zero-Downtime Key Rotation & Misconfigured Key Guards
// ---------------------------------------------------------------------------
describe("server/lib/catalog.mjs — key rotation and keyId pinning", () => {
  it("supports zero-downtime key rotation and rejects retired keys once removed", async () => {
    const keyV1 = makeKeypair();
    const keyV2 = makeKeypair();

    await withTempDir(async (dataDir) => {
      const store = new PluginStore(dataDir);
      await store.init();

      const signedByV1 = signArtifact({
        fileName: "index.json",
        data: makeSampleIndex("2026-11-27T01:00:00Z"),
        keypair: keyV1,
        signedAt: "2026-11-27T01:00:00.000Z",
      });
      const signedByV2 = signArtifact({
        fileName: "index.json",
        data: makeSampleIndex("2026-11-27T02:00:00Z"),
        keypair: keyV2,
        signedAt: "2026-11-27T02:00:00.000Z",
      });

      const routes = {
        "/index.json": { body: signedByV1.rawBytes },
        "/index.json.sig": { body: signedByV1.sigBytes },
      };

      await withMockRegistryServer(routes, async ({ baseUrl, routes: liveRoutes }) => {
        // Phase 1: Transition client pins both keyV1 and keyV2
        const dualKeyCatalog = new RegistryCatalog(baseUrl, store, {
          trustedPublicKeys: {
            [keyV1.keyId]: keyV1.publicPem,
            [keyV2.keyId]: keyV2.publicPem,
          },
          requireSignatures: true,
        });

        const resV1 = await dualKeyCatalog.getIndex({ force: true });
        assert.equal(resV1.generatedAt, "2026-11-27T01:00:00Z");

        // Phase 2: Registry rotates GitHub Actions secret to keyV2 -> seamless verification
        liveRoutes.set("/index.json", { body: signedByV2.rawBytes });
        liveRoutes.set("/index.json.sig", { body: signedByV2.sigBytes });

        const resV2 = await dualKeyCatalog.getIndex({ force: true });
        assert.equal(resV2.generatedAt, "2026-11-27T02:00:00Z");

        // Phase 3: New client retires keyV1 -> signatures from keyV1 are rejected
        const retiredKeyCatalog = new RegistryCatalog(baseUrl, new PluginStore(path.join(dataDir, "v2")), {
          trustedPublicKeys: { [keyV2.keyId]: keyV2.publicPem },
          requireSignatures: true,
        });
        await retiredKeyCatalog.store.init();

        // Still verifies keyV2 cleanly
        const okV2 = await retiredKeyCatalog.getIndex({ force: true });
        assert.equal(okV2.generatedAt, "2026-11-27T02:00:00Z");

        // Rejects keyV1 with explicit untrusted keyId error
        liveRoutes.set("/index.json", { body: signedByV1.rawBytes });
        liveRoutes.set("/index.json.sig", { body: signedByV1.sigBytes });

        await assert.rejects(
          () => retiredKeyCatalog.getIndex({ force: true }),
          (err) => err instanceof SignatureVerificationError && /Untrusted signing keyId/.test(err.message)
        );
      });
    });
  });

  it("throws immediately if a declared keyId does not match the SPKI public key fingerprint", async () => {
    const kp = makeKeypair();
    await withTempDir(async (dataDir) => {
      const store = new PluginStore(dataDir);
      assert.throws(
        () =>
          new RegistryCatalog("http://127.0.0.1:1", store, {
            trustedPublicKeys: { "0000000000000000": kp.publicPem },
            requireSignatures: true,
          }),
        /Trusted keyId mismatch/
      );
    });
  });
});
