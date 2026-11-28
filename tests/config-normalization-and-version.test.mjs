import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_DATA_DIR,
  parseServerArgs,
  resolveDataDir,
} from "../server/lib/service-config.mjs";
import { createSidecarApp } from "../sidecars/marketplace/server.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");

async function readJson(relPath) {
  const raw = await fs.readFile(path.join(ROOT_DIR, relPath), "utf8");
  return JSON.parse(raw);
}

describe("unified --data-dir & sidecar/config normalization", () => {
  it("normalizes omitted, empty, and unexpanded template placeholders to DEFAULT_DATA_DIR", () => {
    const expectedDefault = path.resolve(DEFAULT_DATA_DIR);

    for (const candidate of [undefined, null, 42, "", "   ", "${PLUGIN_DATA}", " ${PLUGIN_DATA} ", "${ANY_VAR}"]) {
      assert.equal(resolveDataDir(candidate), expectedDefault);
    }

    const customDir = path.join(os.tmpdir(), "agy-custom-data-dir");
    assert.equal(resolveDataDir(customDir), path.resolve(customDir));
    assert.equal(resolveDataDir(`  ${customDir}  `), path.resolve(customDir));
  });

  it("parseServerArgs normalizes --data-dir placeholders and rejects invalid flag arguments", () => {
    const expectedDefault = path.resolve(DEFAULT_DATA_DIR);

    assert.equal(parseServerArgs([]).dataDir, expectedDefault);
    assert.equal(parseServerArgs(["--data-dir", "${PLUGIN_DATA}"]).dataDir, expectedDefault);

    const customDir = path.join(os.tmpdir(), "agy-parsed-data");
    assert.equal(parseServerArgs(["--data-dir", customDir]).dataDir, path.resolve(customDir));

    assert.throws(() => parseServerArgs("not-an-array"), TypeError);
    assert.throws(() => parseServerArgs(["--data-dir", ""]), /Missing required value for --data-dir/);
    assert.throws(
      () => parseServerArgs(["--data-dir", "--registry-url"]),
      /Missing required value for --data-dir/
    );
    assert.throws(() => parseServerArgs(["--unknown-flag"]), /Unknown server argument: --unknown-flag/);
  });

  it("resolves mcp_config.json and sidecars/marketplace/sidecar.json to identical DEFAULT_DATA_DIR", async () => {
    const mcpConfig = await readJson("mcp_config.json");
    const sidecarConfig = await readJson("sidecars/marketplace/sidecar.json");

    const mcpArgs = mcpConfig?.mcpServers?.["community-marketplace"]?.args;
    assert.ok(Array.isArray(mcpArgs) && mcpArgs.length >= 1);
    assert.equal(mcpArgs.some((arg) => /\$\{PLUGIN_DATA\}/.test(String(arg))), false);

    assert.ok(Array.isArray(sidecarConfig?.args) && sidecarConfig.args.length >= 1);
    assert.equal(sidecarConfig.args.some((arg) => /\$\{PLUGIN_DATA\}/.test(String(arg))), false);

    const mcpOpts = parseServerArgs(mcpArgs.slice(1));
    const sidecarOpts = parseServerArgs(sidecarConfig.args.slice(1));

    assert.equal(mcpOpts.dataDir, path.resolve(DEFAULT_DATA_DIR));
    assert.equal(sidecarOpts.dataDir, path.resolve(DEFAULT_DATA_DIR));
    assert.equal(mcpOpts.dataDir, sidecarOpts.dataDir);
  });

  it("createSidecarApp normalizes unexpanded placeholders and empty strings on store.dataDir", async () => {
    const expectedDefault = path.resolve(DEFAULT_DATA_DIR);

    const placeholderApp = await createSidecarApp({
      dataDir: "${PLUGIN_DATA}",
      sdkModule: null,
      clientVersion: "1.0.8",
    });
    assert.equal(placeholderApp.store.dataDir, expectedDefault);

    const emptyApp = await createSidecarApp({
      dataDir: "   ",
      sdkModule: null,
      clientVersion: "1.0.8",
    });
    assert.equal(emptyApp.store.dataDir, expectedDefault);

    const customDir = path.join(os.tmpdir(), "agy-sidecar-custom-store");
    const customApp = await createSidecarApp({
      dataDir: customDir,
      sdkModule: null,
      clientVersion: "1.0.8",
    });
    assert.equal(customApp.store.dataDir, path.resolve(customDir));
  });
});

describe("release version 1.0.8 consistency", () => {
  it("matches version 1.0.8 across package.json, plugin.json, package-lock.json, and CHANGELOG.md", async () => {
    const expectedVersion = "1.0.8";
    const [pkg, plugin, lock, changelog] = await Promise.all([
      readJson("package.json"),
      readJson("plugin.json"),
      readJson("package-lock.json"),
      fs.readFile(path.join(ROOT_DIR, "CHANGELOG.md"), "utf8"),
    ]);

    assert.equal(pkg.version, expectedVersion);
    assert.equal(plugin.version, expectedVersion);
    assert.equal(lock.version, expectedVersion);
    assert.equal(lock.packages?.[""]?.version, expectedVersion);

    const match = changelog.match(
      /^## \[1\.0\.8\][^\r\n]*\r?\n([\s\S]*?)(?=\r?\n## \[|(?![\s\S]))/m
    );
    assert.ok(match, "Expected ## [1.0.8] heading in CHANGELOG.md");
    assert.ok(match[1].trim().length > 0, "Expected non-empty release notes under ## [1.0.8]");
  });
});
