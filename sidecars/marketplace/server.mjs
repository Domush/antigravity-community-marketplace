/**
 * Antigravity Community Plugin Marketplace — Native Aux Pane Sidecar Server.
 * Hosts the Marketplace Web UI inside Antigravity's Aux Pane via sidecar_sdk,
 * with a standalone loopback HTTP fallback for local testing and browser inspection.
 */

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CLIENT_MANIFEST_PATH,
  createCatalogAndStore,
  createMarketplaceService,
  DEFAULT_DATA_DIR,
  DEFAULT_REGISTRY_URL,
  loadClientVersion,
  parseServerArgs,
  TOOL_SCHEMAS,
  ToolValidationError,
} from "../../server/lib/service.mjs";
import {
  DEFAULT_STANDALONE_PORT,
  NO_CACHE_HEADERS,
  parsePortValue,
  readJsonObjectBody,
  validateStandaloneToolRequest,
} from "./http-helpers.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_HTML_PATH = path.resolve(__dirname, "../../ui/dist/marketplace.html");

function isModuleNotFound(err) {
  return err?.code === "ERR_MODULE_NOT_FOUND" || err?.code === "ENOENT";
}

export async function loadSidecarSdk({
  userSdkPath = path.join(os.homedir(), ".gemini", "config", "node_modules", "sidecar_sdk", "index.mjs"),
} = {}) {
  try {
    return await import(pathToFileURL(userSdkPath).href);
  } catch (err) {
    if (!isModuleNotFound(err)) {
      throw err;
    }
  }

  try {
    return await import("sidecar_sdk");
  } catch (err) {
    if (!isModuleNotFound(err)) {
      throw err;
    }
    return null;
  }
}

export function resolveHtmlWithPreload(htmlPath = DEFAULT_HTML_PATH) {
  let raw;
  try {
    raw = fs.readFileSync(htmlPath, "utf8");
  } catch (err) {
    throw new Error(`Missing or unreadable marketplace UI bundle at ${htmlPath}: ${err.message}`);
  }

  const lower = raw.toLowerCase();
  const bodyIdx = lower.lastIndexOf("<body");
  let headCloseIdx = bodyIdx !== -1 ? lower.lastIndexOf("</head>", bodyIdx) : lower.lastIndexOf("</head>");
  if (headCloseIdx === -1) {
    headCloseIdx = lower.lastIndexOf("</head>");
  }
  if (headCloseIdx === -1) {
    throw new Error(`Invalid marketplace UI bundle at ${htmlPath}: missing </head> tag.`);
  }

  return `${raw.slice(0, headCloseIdx)}<script src="/preload.js"></script>\n${raw.slice(headCloseIdx)}`;
}

export function resolveWorkspaceUris(workspaceUris) {
  if (workspaceUris === undefined) return undefined;
  if (!Array.isArray(workspaceUris)) {
    throw new ToolValidationError("workspaceUris must be an array of URI strings.");
  }

  const roots = [];
  for (const entry of workspaceUris) {
    if (typeof entry !== "string") {
      throw new ToolValidationError("Each entry in workspaceUris must be a string.");
    }
    const trimmed = entry.trim();
    if (!trimmed || !/^file:\/\//i.test(trimmed)) {
      continue;
    }
    try {
      roots.push(fileURLToPath(trimmed));
    } catch (err) {
      throw new ToolValidationError(`Invalid file URI in workspaceUris "${trimmed}": ${err.message}`);
    }
  }
  return [...new Set(roots)];
}

export async function dispatchSidecarTool({ service, name, arguments: rawArgs }) {
  if (!service || typeof service.executeTool !== "function") {
    throw new TypeError("dispatchSidecarTool requires a valid marketplace service.");
  }
  if (typeof name !== "string" || !name.trim()) {
    throw new ToolValidationError("Missing or invalid tool name.");
  }
  if (rawArgs !== undefined && (rawArgs === null || typeof rawArgs !== "object" || Array.isArray(rawArgs))) {
    throw new ToolValidationError(`Arguments for "${name}" must be a JSON object.`);
  }

  const args = { ...(rawArgs || {}) };
  const hasWorkspaceUris = Object.prototype.hasOwnProperty.call(args, "workspaceUris");
  const rawUris = args.workspaceUris;
  delete args.workspaceUris;

  const resolvedRoots = hasWorkspaceUris && rawUris !== undefined ? resolveWorkspaceUris(rawUris) : undefined;
  const schemaShape = TOOL_SCHEMAS[name];
  if (
    schemaShape &&
    Object.prototype.hasOwnProperty.call(schemaShape, "workspaceRoot") &&
    args.workspaceRoot === undefined &&
    resolvedRoots &&
    resolvedRoots.length > 0
  ) {
    args.workspaceRoot = resolvedRoots[0];
  }

  const result = await service.executeTool(name, args, { workspaceRoots: resolvedRoots });
  return result.structuredContent;
}

export function createStandaloneServer({
  service,
  htmlPath = DEFAULT_HTML_PATH,
  clientVersion = "1.0.5",
  port = 0,
  host = "127.0.0.1",
}) {
  if (!service) {
    throw new TypeError("createStandaloneServer requires a marketplace service instance.");
  }

  let boundPort = port;
  const server = http.createServer(async (req, res) => {
    try {
      const activePort = server.address()?.port ?? boundPort;
      const url = new URL(req.url, `http://${host}:${activePort}`);

      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        const html = resolveHtmlWithPreload(htmlPath);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...NO_CACHE_HEADERS });
        res.end(html);
        return;
      }

      if (req.method === "GET" && url.pathname === "/preload.js") {
        res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8", ...NO_CACHE_HEADERS });
        res.end("// Standalone mode: sidecar preload bridge inactive.\n");
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/health") {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", ...NO_CACHE_HEADERS });
        res.end(
          JSON.stringify({
            status: "ok",
            mode: "standalone",
            pid: process.pid,
            port: activePort,
            version: clientVersion,
          })
        );
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/tool") {
        validateStandaloneToolRequest(req, host, activePort);
        const body = await readJsonObjectBody(req);
        const payload = await dispatchSidecarTool({
          service,
          name: body.name,
          arguments: body.arguments,
        });
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", ...NO_CACHE_HEADERS });
        res.end(JSON.stringify(payload));
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "Not Found" }));
    } catch (err) {
      const status =
        err instanceof URIError || err?.code === "ERR_INVALID_URL"
          ? 400
          : Number.isInteger(err?.statusCode)
            ? err.statusCode
            : 500;
      if (!res.headersSent) {
        res.writeHead(status, {
          "Content-Type": "application/json; charset=utf-8",
          ...(status === 413 ? { Connection: "close" } : {}),
        });
        res.end(JSON.stringify({ error: err?.message || "Internal Server Error" }));
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  });

  return {
    server,
    getPort() {
      return server.address()?.port ?? boundPort;
    },
    start() {
      resolveHtmlWithPreload(htmlPath);
      return new Promise((resolve, reject) => {
        const onError = (err) => {
          server.off("error", onError);
          reject(err);
        };
        server.once("error", onError);
        server.listen(port, host, () => {
          server.off("error", onError);
          boundPort = server.address()?.port ?? port;
          resolve(boundPort);
        });
      });
    },
    stop() {
      return new Promise((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(() => resolve());
      });
    },
  };
}

export async function createSidecarApp({
  dataDir = DEFAULT_DATA_DIR,
  registryUrl = DEFAULT_REGISTRY_URL,
  publicKeyFile = null,
  insecureSkipVerify = false,
  htmlPath = DEFAULT_HTML_PATH,
  clientVersion,
  sdkModule,
  env = process.env,
  port,
} = {}) {
  const hasSidecarEnv = Boolean(
    env.ANTIGRAVITY_LS_ADDRESS &&
      env.ANTIGRAVITY_CSRF_TOKEN &&
      env.ANTIGRAVITY_SIDECAR_WEB_PORT
  );

  const resolvedVersion = clientVersion || (await loadClientVersion(CLIENT_MANIFEST_PATH));
  const resolvedSdk = sdkModule !== undefined ? sdkModule : await loadSidecarSdk();
  const SidecarApp = resolvedSdk?.SidecarApp || null;
  const SidecarResponse = resolvedSdk?.Response || null;

  if (hasSidecarEnv && !SidecarApp) {
    throw new Error(
      "Antigravity sidecar environment detected (ANTIGRAVITY_LS_ADDRESS, ANTIGRAVITY_CSRF_TOKEN, ANTIGRAVITY_SIDECAR_WEB_PORT), but sidecar_sdk could not be loaded."
    );
  }

  const isSidecarEnv = Boolean(hasSidecarEnv && SidecarApp);

  const { store, catalog } = createCatalogAndStore({
    dataDir,
    registryUrl,
    publicKeyFile,
    insecureSkipVerify,
  });

  const service = createMarketplaceService({
    catalog,
    store,
    clientVersion: resolvedVersion,
  });

  let activeSidecarApp = null;
  let standalone = null;

  function createJsonResponse(payload, status = 200) {
    if (SidecarResponse) {
      return new SidecarResponse(JSON.stringify(payload), {
        status,
        contentType: "application/json; charset=utf-8",
        headers: NO_CACHE_HEADERS,
      });
    }
    return payload;
  }

  return {
    store,
    catalog,
    service,
    isSidecarEnv,
    getRenderedHtml() {
      return resolveHtmlWithPreload(htmlPath);
    },
    async dispatchTool(name, args) {
      return dispatchSidecarTool({ service, name, arguments: args });
    },
    async start() {
      await store.init();
      resolveHtmlWithPreload(htmlPath);

      if (isSidecarEnv) {
        const app = new SidecarApp();
        app.page("/", () => resolveHtmlWithPreload(htmlPath));
        app.api(
          "/api/health",
          () =>
            createJsonResponse({
              status: "ok",
              mode: "sidecar",
              pid: process.pid,
              version: resolvedVersion,
            }),
          "GET"
        );
        app.api(
          "/api/tool",
          async (data) => {
            try {
              if (!data || typeof data !== "object" || Array.isArray(data)) {
                return createJsonResponse({ error: "Request body must be a JSON object." }, 400);
              }
              const result = await dispatchSidecarTool({
                service,
                name: data.name,
                arguments: data.arguments,
              });
              return createJsonResponse(result, 200);
            } catch (err) {
              const status = Number.isInteger(err?.statusCode) ? err.statusCode : 500;
              return createJsonResponse({ error: err?.message || "Internal Server Error" }, status);
            }
          },
          "POST"
        );

        await app.run();
        activeSidecarApp = app;
        console.log("[CommunityPlugins Sidecar] Native Aux Pane Web UI mounted.");
        return { mode: "sidecar", port: Number(env.ANTIGRAVITY_SIDECAR_WEB_PORT) };
      }

      const listenPort =
        port !== undefined ? port : parsePortValue(env.ANTIGRAVITY_SIDECAR_WEB_PORT, DEFAULT_STANDALONE_PORT);
      standalone = createStandaloneServer({
        service,
        htmlPath,
        clientVersion: resolvedVersion,
        port: listenPort,
      });
      const boundPort = await standalone.start();
      console.log(
        `[CommunityPlugins Sidecar] Standalone server listening at http://127.0.0.1:${boundPort}`
      );
      return { mode: "standalone", port: boundPort };
    },
    async stop() {
      if (activeSidecarApp && typeof activeSidecarApp.close === "function") {
        await activeSidecarApp.close();
        activeSidecarApp = null;
      }
      if (standalone) {
        await standalone.stop();
        standalone = null;
      }
    },
  };
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}

if (isMainModule()) {
  const opts = parseServerArgs(process.argv.slice(2));
  const app = await createSidecarApp(opts);
  await app.start();
}
