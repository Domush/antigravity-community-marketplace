import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createMarketplaceService } from "../server/lib/service.mjs";
import { PluginStore } from "../server/lib/store.mjs";
import { readJsonObjectBody } from "../sidecars/marketplace/http-helpers.mjs";
import {
  createSidecarApp,
  createStandaloneServer,
  DEFAULT_HTML_PATH,
  loadSidecarSdk,
  resolveHtmlWithPreload,
  resolveWorkspaceUris,
} from "../sidecars/marketplace/server.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const SIDECAR_MANIFEST_PATH = path.join(ROOT_DIR, "sidecars", "marketplace", "sidecar.json");

function makeFakeCatalog(plugins = []) {
  const index = {
    schemaVersion: 1,
    generatedAt: "2026-11-27T00:00:00Z",
    crawlerVersion: "1.0.0",
    scannerVersion: "1.1.0",
    totalPlugins: plugins.length,
    plugins,
  };
  const denylist = {
    schemaVersion: 1,
    updatedAt: "2026-11-27T00:00:00Z",
    blockedRepos: [],
    blockedShas: [],
  };
  return {
    async getIndex() {
      return index;
    },
    async getDenylist() {
      return denylist;
    },
    async getPluginDetail(entry) {
      return {
        id: entry.id,
        readmeMarkdown: "# Demo Plugin",
        findings: [],
        collisions: {},
        credentials: { envVars: [], oauthProviders: [] },
      };
    },
  };
}

test("sidecars/marketplace/sidecar.json matches Antigravity Aux Pane sidecar schema", () => {
  const raw = fs.readFileSync(SIDECAR_MANIFEST_PATH, "utf8");
  const manifest = JSON.parse(raw);

  assert.equal(manifest.command, "node");
  assert.deepEqual(manifest.args, ["server.mjs"]);
  assert.equal(manifest.restart_policy, "always");
  assert.equal(manifest.has_web_ui, true);
  assert.equal(manifest.agent_permissions?.allows_user_interactions, true);
  assert.equal(manifest.ui_config?.display_name, "Community Plugins");
  assert.ok(Array.isArray(manifest.ui_config?.views) && manifest.ui_config.views.length === 1);
  assert.deepEqual(manifest.ui_config.views[0], {
    path: "/",
    entrypoint: "SIDECAR_UI_ENTRYPOINT_AUX_PANE",
    title: "Community Plugins",
  });
});

test("resolveHtmlWithPreload injects preload.js before </head> and fails fast on missing or invalid HTML", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agy-mp-sidecar-html-"));
  try {
    const validPath = path.join(tmpRoot, "valid.html");
    fs.writeFileSync(
      validPath,
      '<!doctype html><html><head><title>Test</title></head><body><div id="app"></div></body></html>',
      "utf8"
    );
    const injected = resolveHtmlWithPreload(validPath);
    const scriptTag = '<script src="/preload.js"></script>';
    const scriptIdx = injected.indexOf(scriptTag);
    const headCloseIdx = injected.indexOf("</head>");
    assert.ok(scriptIdx !== -1, "Expected /preload.js script tag to be injected");
    assert.ok(scriptIdx < headCloseIdx, "Expected /preload.js script tag before </head>");

    // Also verify the real built bundle works
    const realInjected = resolveHtmlWithPreload(DEFAULT_HTML_PATH);
    assert.ok(realInjected.includes(scriptTag));
    assert.ok(realInjected.indexOf(scriptTag) < realInjected.lastIndexOf("</head>"));

    // Missing HTML file fails fast
    const missingPath = path.join(tmpRoot, "does-not-exist.html");
    assert.throws(() => resolveHtmlWithPreload(missingPath), /Missing or unreadable marketplace UI bundle/);

    // HTML missing </head> fails fast
    const noHeadPath = path.join(tmpRoot, "no-head.html");
    fs.writeFileSync(noHeadPath, "<html><body>No head close</body></html>", "utf8");
    assert.throws(() => resolveHtmlWithPreload(noHeadPath), /missing <\/head> tag/);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("loadSidecarSdk returns null when absent and rethrows syntax/runtime errors", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agy-mp-sdk-load-"));
  try {
    const missingSdkPath = path.join(tmpRoot, "missing", "index.mjs");
    const absentResult = await loadSidecarSdk({ userSdkPath: missingSdkPath });
    assert.equal(absentResult, null);

    const brokenSdkPath = path.join(tmpRoot, "broken-sdk.mjs");
    fs.writeFileSync(brokenSdkPath, "export const SidecarApp = (;\n", "utf8");
    await assert.rejects(() => loadSidecarSdk({ userSdkPath: brokenSdkPath }), SyntaxError);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("resolveWorkspaceUris converts file:// URIs to local paths and rejects invalid input", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agy-mp-uris-"));
  try {
    const folderA = path.join(tmpRoot, "project-a");
    const folderB = path.join(tmpRoot, "project b");
    const uriA = pathToFileURL(folderA).href;
    const uriB = pathToFileURL(folderB).href;

    const resolved = resolveWorkspaceUris([uriA, uriB, uriA, "untitled:scratch"]);
    assert.deepEqual(resolved, [folderA, folderB]);

    assert.throws(() => resolveWorkspaceUris("file:///tmp"), /must be an array/);
    assert.throws(() => resolveWorkspaceUris([42]), /must be a string/);
    assert.throws(() => resolveWorkspaceUris(["file://%ZZ"]), /Invalid file URI/);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("standalone server serves HTML with preload, /preload.js, /api/health, and routes /api/tool cleanly", async () => {
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "agy-mp-sidecar-srv-"));
  const dataDir = path.join(tmpRoot, "data");
  const workspaceDir = path.join(tmpRoot, "my-workspace");
  const projectPluginDir = path.join(workspaceDir, ".agents", "plugins", "local-demo");
  await fsp.mkdir(projectPluginDir, { recursive: true });
  await fsp.writeFile(
    path.join(projectPluginDir, "plugin.json"),
    JSON.stringify({ name: "local-demo", version: "0.4.0" }),
    "utf8"
  );

  const htmlPath = path.join(tmpRoot, "marketplace.html");
  await fsp.writeFile(
    htmlPath,
    "<!doctype html><html><head><title>Marketplace</title></head><body>OK</body></html>",
    "utf8"
  );

  const store = new PluginStore(dataDir);
  await store.init();
  const catalog = makeFakeCatalog([
    {
      id: "acme/sample-plugin",
      name: "Sample Plugin",
      summary: "Demo plugin",
      version: "1.0.0",
      author: { login: "acme" },
      categories: ["productivity"],
      tags: [],
      surface: { hasSidebarUi: false, components: [] },
      requiresCredentials: false,
      stats: { stars: 10, pushedAt: "2026-11-27T00:00:00Z" },
      security: { riskTier: "low", capabilities: [] },
      release: { sha: "abc123", contentTreeSha256: "def456", ref: "v1.0.0" },
    },
  ]);
  const service = createMarketplaceService({ catalog, store, clientVersion: "1.0.2" });
  const srv = createStandaloneServer({ service, htmlPath, clientVersion: "1.0.2", port: 0 });

  try {
    const port = await srv.start();
    const baseUrl = `http://127.0.0.1:${port}`;

    // 1. GET / injects /preload.js before </head>
    const htmlRes = await fetch(`${baseUrl}/`);
    assert.equal(htmlRes.status, 200);
    assert.match(htmlRes.headers.get("content-type") || "", /text\/html/);
    const htmlText = await htmlRes.text();
    assert.ok(htmlText.includes('<script src="/preload.js"></script>\n</head>'));

    // 2. GET /preload.js returns valid harmless JS in standalone mode
    const preloadRes = await fetch(`${baseUrl}/preload.js`);
    assert.equal(preloadRes.status, 200);
    assert.match(preloadRes.headers.get("content-type") || "", /application\/javascript/);
    const preloadText = await preloadRes.text();
    assert.ok(preloadText.includes("Standalone mode"));

    // 3. GET /api/health returns 200 ok
    const healthRes = await fetch(`${baseUrl}/api/health`);
    assert.equal(healthRes.status, 200);
    const healthJson = await healthRes.json();
    assert.equal(healthJson.status, "ok");
    assert.equal(healthJson.mode, "standalone");
    assert.equal(healthJson.port, port);
    assert.equal(healthJson.version, "1.0.2");

    // 4. POST /api/tool -> mp_get_bootstrap with file:// workspaceUris resolution
    const workspaceUri = pathToFileURL(workspaceDir).href;
    const bootRes = await fetch(`${baseUrl}/api/tool`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "mp_get_bootstrap",
        arguments: { workspaceUris: [workspaceUri] },
      }),
    });
    assert.equal(bootRes.status, 200);
    const bootJson = await bootRes.json();
    assert.equal(bootJson.clientVersion, "1.0.2");
    assert.deepEqual(bootJson.workspaceRoots, [workspaceDir]);
    assert.equal(bootJson.index.plugins.length, 1);
    assert.ok(
      bootJson.installed.some((inst) => inst.slug === "local-demo" && inst.scope === "project"),
      "Expected project plugin in resolved workspaceUri to be discovered"
    );

    // 5. POST /api/tool -> mp_update_prefs persists preferences
    const prefRes = await fetch(`${baseUrl}/api/tool`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "mp_update_prefs",
        arguments: { id: "acme/sample-plugin", field: "favorites", value: true },
      }),
    });
    assert.equal(prefRes.status, 200);
    const prefJson = await prefRes.json();
    assert.deepEqual(prefJson.prefs.favorites, ["acme/sample-plugin"]);

    // 6. POST /api/tool rejects unknown tool with 400
    const unknownRes = await fetch(`${baseUrl}/api/tool`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "mp_nonexistent", arguments: {} }),
    });
    assert.equal(unknownRes.status, 400);
    const unknownJson = await unknownRes.json();
    assert.match(unknownJson.error, /Unknown marketplace tool/);

    // 7. POST /api/tool rejects malformed JSON with 400
    const badJsonRes = await fetch(`${baseUrl}/api/tool`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{bad json",
    });
    assert.equal(badJsonRes.status, 400);
    const badJsonBody = await badJsonRes.json();
    assert.match(badJsonBody.error, /Malformed JSON/);

    // 8. POST /api/tool rejects invalid tool parameters fail-fast with 400
    const badParamsRes = await fetch(`${baseUrl}/api/tool`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "mp_get_plugin_detail",
        arguments: { id: "x" },
      }),
    });
    assert.equal(badParamsRes.status, 400);
    const badParamsJson = await badParamsRes.json();
    assert.match(badParamsJson.error, /Invalid arguments for "mp_get_plugin_detail"/);

    const badPrefRes = await fetch(`${baseUrl}/api/tool`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "mp_update_prefs",
        arguments: { id: "acme/sample-plugin", field: "unknownField", value: "nope" },
      }),
    });
    assert.equal(badPrefRes.status, 400);
    const badPrefJson = await badPrefRes.json();
    assert.match(badPrefJson.error, /Invalid arguments for "mp_update_prefs"/);

    // 9. POST /api/tool propagates domain errors (e.g. missing plugin id) cleanly
    const missingPluginRes = await fetch(`${baseUrl}/api/tool`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "mp_get_plugin_detail",
        arguments: { id: "acme/does-not-exist" },
      }),
    });
    assert.equal(missingPluginRes.status, 500);
    const missingPluginJson = await missingPluginRes.json();
    assert.match(missingPluginJson.error, /Plugin not found in registry index/);

    // 10. Security: reject cross-origin Origin (403) and non-JSON Content-Type (415), no wildcard CORS
    const optionsRes = await fetch(`${baseUrl}/api/tool`, { method: "OPTIONS" });
    assert.equal(optionsRes.headers.get("access-control-allow-origin"), null);

    const crossOriginRes = await fetch(`${baseUrl}/api/tool`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://evil.example" },
      body: JSON.stringify({ name: "mp_get_bootstrap", arguments: {} }),
    });
    assert.equal(crossOriginRes.status, 403);
    assert.match((await crossOriginRes.json()).error, /Forbidden cross-origin/);

    const wrongPortOriginRes = await fetch(`${baseUrl}/api/tool`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: `http://127.0.0.1:${port + 1}` },
      body: JSON.stringify({ name: "mp_get_bootstrap", arguments: {} }),
    });
    assert.equal(wrongPortOriginRes.status, 403);

    const sameOriginRes = await fetch(`${baseUrl}/api/tool`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: baseUrl },
      body: JSON.stringify({ name: "mp_get_bootstrap", arguments: {} }),
    });
    assert.equal(sameOriginRes.status, 200);

    const textPlainRes = await fetch(`${baseUrl}/api/tool`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ name: "mp_get_bootstrap", arguments: {} }),
    });
    assert.equal(textPlainRes.status, 415);
    assert.match((await textPlainRes.json()).error, /Unsupported Media Type/);
  } finally {
    await srv.stop();
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  }
});

test("readJsonObjectBody settles deterministically on premature request close", async () => {
  const fakeReq = new EventEmitter();
  fakeReq.complete = false;
  fakeReq.pause = () => {};

  const promise = readJsonObjectBody(fakeReq);
  fakeReq.emit("data", '{"name":"mp_get');
  fakeReq.emit("close");

  await assert.rejects(promise, (err) => {
    assert.equal(err.statusCode, 400);
    assert.match(err.message, /closed prematurely/);
    return true;
  });
});

test("createSidecarApp detects sidecar vs standalone mode, fails fast without sidecar_sdk, and cleans up symmetrically", async () => {
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "agy-mp-sidecar-app-"));
  const dataDir = path.join(tmpRoot, "data");
  const htmlPath = path.join(tmpRoot, "marketplace.html");
  await fsp.writeFile(
    htmlPath,
    "<!doctype html><html><head><title>Test</title></head><body>Body</body></html>",
    "utf8"
  );

  const mountedPages = new Map();
  const mountedApis = new Map();
  let runCalled = false;
  let closed = false;

  class FakeSidecarApp {
    page(route, handler) {
      mountedPages.set(route, handler);
    }
    api(route, handler, method = "POST") {
      mountedApis.set(`${method}:${route}`, handler);
    }
    async run() {
      runCalled = true;
    }
    async close() {
      closed = true;
    }
  }
  class FakeResponse {
    constructor(body, opts = {}) {
      this.body = body;
      this.status = opts.status || 200;
      this.contentType = opts.contentType;
      this.headers = opts.headers;
    }
  }

  let sidecarApp = null;
  let standaloneApp = null;
  try {
    // Fail fast when ANTIGRAVITY_* sidecar env vars are set but sidecar_sdk is missing
    await assert.rejects(
      () =>
        createSidecarApp({
          dataDir,
          htmlPath,
          clientVersion: "1.0.2",
          sdkModule: null,
          env: {
            ANTIGRAVITY_LS_ADDRESS: "127.0.0.1:42000",
            ANTIGRAVITY_CSRF_TOKEN: "test-csrf",
            ANTIGRAVITY_SIDECAR_WEB_PORT: "42001",
          },
        }),
      /sidecar_sdk could not be loaded/
    );

    sidecarApp = await createSidecarApp({
      dataDir,
      htmlPath,
      clientVersion: "1.0.2",
      sdkModule: { SidecarApp: FakeSidecarApp, Response: FakeResponse },
      env: {
        ANTIGRAVITY_LS_ADDRESS: "127.0.0.1:42000",
        ANTIGRAVITY_CSRF_TOKEN: "test-csrf",
        ANTIGRAVITY_SIDECAR_WEB_PORT: "42001",
      },
    });
    assert.equal(sidecarApp.isSidecarEnv, true);
    const started = await sidecarApp.start();
    assert.deepEqual(started, { mode: "sidecar", port: 42001 });
    assert.equal(runCalled, true);
    assert.ok(mountedPages.has("/"));
    assert.ok(mountedPages.get("/")().includes('<script src="/preload.js"></script>\n</head>'));

    const healthResp = await mountedApis.get("GET:/api/health")();
    assert.equal(healthResp.status, 200);
    assert.equal(JSON.parse(healthResp.body).mode, "sidecar");

    const badToolResp = await mountedApis.get("POST:/api/tool")({ name: "bogus" });
    assert.equal(badToolResp.status, 400);
    assert.match(JSON.parse(badToolResp.body).error, /Unknown marketplace tool/);

    await sidecarApp.stop();
    assert.equal(closed, true);
    sidecarApp = null;

    // Standalone mode when sidecar env vars are absent
    standaloneApp = await createSidecarApp({
      dataDir,
      htmlPath,
      clientVersion: "1.0.2",
      sdkModule: null,
      env: {},
      port: 0,
    });
    assert.equal(standaloneApp.isSidecarEnv, false);
    const standaloneStart = await standaloneApp.start();
    assert.equal(standaloneStart.mode, "standalone");
    assert.ok(standaloneStart.port > 0);
  } finally {
    await sidecarApp?.stop();
    await standaloneApp?.stop();
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  }
});
