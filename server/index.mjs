#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runCli } from "./lib/cli.mjs";
import {
  CLIENT_MANIFEST_PATH,
  createCatalogAndStore,
  createMarketplaceService,
  loadClientVersion,
  parseServerArgs,
  ROOT_DIR,
  TOOL_SCHEMAS,
} from "./lib/service.mjs";
import { registerMutatingTools, toolError } from "./tools-mutating.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_RESOURCE_URI = "ui://marketplace/app.html";
const UI_HTML_PATH = path.resolve(__dirname, "../ui/dist/marketplace.html");

const cliResult = runCli({ rootDir: ROOT_DIR });
if (cliResult.handled) {
  process.exit(cliResult.exitCode);
}

const CLIENT_VERSION = await loadClientVersion(CLIENT_MANIFEST_PATH);
const OPTS = parseServerArgs(process.argv.slice(2));
const { store, catalog } = createCatalogAndStore(OPTS);

const server = new McpServer({
  name: "community-marketplace",
  version: CLIENT_VERSION,
});

// ---------------------------------------------------------------------------
// Helpers: Workspace Roots
// ---------------------------------------------------------------------------
async function discoverWorkspaceRoots() {
  const clientCaps = server.server.getClientCapabilities();
  if (!clientCaps?.roots) {
    return [];
  }

  const roots = [];
  try {
    const res = await server.server.listRoots();
    for (const root of res?.roots || []) {
      if (root?.uri?.startsWith("file://")) {
        roots.push(fileURLToPath(root.uri));
      }
    }
  } catch (err) {
    // JSON-RPC -32601 (Method not found) can occur if a client omits roots at runtime
    if (err?.code !== -32601) {
      console.error(`[marketplace-mcp] Failed to list MCP workspace roots: ${err?.message || err}`);
    }
  }
  return [...new Set(roots)];
}

const service = createMarketplaceService({
  catalog,
  store,
  clientVersion: CLIENT_VERSION,
  resolveWorkspaceRoots: discoverWorkspaceRoots,
});

function toToolResponse(result) {
  return {
    content: [{ type: "text", text: result.text }],
    structuredContent: result.structuredContent,
  };
}

// ---------------------------------------------------------------------------
// 1. Register Single-File MCP App UI Resource
// ---------------------------------------------------------------------------
server.registerResource(
  "marketplace-ui",
  UI_RESOURCE_URI,
  {
    title: "Community Plugin Marketplace",
    mimeType: "text/html;profile=mcp-app",
    _meta: {
      ui: {
        csp: {
          resourceDomains: ["https://avatars.githubusercontent.com"],
        },
      },
    },
  },
  async () => {
    const html = await fs.readFile(UI_HTML_PATH, "utf8");
    return {
      contents: [
        {
          uri: UI_RESOURCE_URI,
          mimeType: "text/html;profile=mcp-app",
          text: html,
        },
      ],
    };
  }
);

// ---------------------------------------------------------------------------
// 2. Entrypoint Tool (Visible to Model & Sidebar Entrypoints)
// ---------------------------------------------------------------------------
server.registerTool(
  "open_marketplace",
  {
    title: "Community Marketplace",
    description: "Opens the Community Plugin Marketplace to browse, audit, install, and update Antigravity plugins.",
    inputSchema: {
      initialQuery: z.string().optional(),
      tab: z.enum(["browse", "installed", "updates", "favorites"]).optional(),
    },
    _meta: {
      ui: {
        resourceUri: UI_RESOURCE_URI,
        visibility: ["model", "app"],
      },
      "com.google.antigravity/ui": {
        entrypoints: [
          { type: "global", title: "Community Plugins" },
          { type: "aux_pane", title: "Community Plugins" },
        ],
      },
    },
  },
  async ({ initialQuery = "", tab = "browse" } = {}) => {
    try {
      return toToolResponse(await service.getSummary({ initialQuery, tab }));
    } catch (err) {
      return toolError(`Marketplace initialization failed: ${err.message}`);
    }
  }
);

// ---------------------------------------------------------------------------
// 3. App-Only Tool: Bootstrap Catalog, Denylist, Prefs & Local Installs
// ---------------------------------------------------------------------------
server.registerTool(
  "mp_get_bootstrap",
  {
    title: "Get Marketplace Bootstrap Data",
    description: "Returns cached/fresh registry index, denylist, user preferences, and locally installed plugins.",
    inputSchema: TOOL_SCHEMAS.mp_get_bootstrap,
    _meta: { ui: { visibility: ["app"] } },
  },
  async ({ workspaceRoot } = {}) => {
    try {
      return toToolResponse(await service.getBootstrap({ workspaceRoot }));
    } catch (err) {
      return toolError(`Bootstrap failed: ${err.message}`);
    }
  }
);

// ---------------------------------------------------------------------------
// 4. App-Only Tool: Force Conditional ETag Refresh
// ---------------------------------------------------------------------------
server.registerTool(
  "mp_check_updates",
  {
    title: "Check Registry Updates",
    description: "Revalidates index.json and denylist.json via ETag conditional requests.",
    inputSchema: TOOL_SCHEMAS.mp_check_updates,
    _meta: { ui: { visibility: ["app"] } },
  },
  async ({ workspaceRoot } = {}) => {
    try {
      return toToolResponse(await service.checkUpdates({ workspaceRoot }));
    } catch (err) {
      return toolError(`Update check failed: ${err.message}`);
    }
  }
);

// ---------------------------------------------------------------------------
// 5. App-Only Tool: Lazy-Load Plugin Detail + Live Collision Checks
// ---------------------------------------------------------------------------
server.registerTool(
  "mp_get_plugin_detail",
  {
    title: "Get Plugin Detail and Live Collisions",
    description: "Fetches per-plugin security findings, README, credentials, and checks collisions against local plugins.",
    inputSchema: TOOL_SCHEMAS.mp_get_plugin_detail,
    _meta: { ui: { visibility: ["app"] } },
  },
  async ({ id, workspaceRoot }) => {
    try {
      return toToolResponse(await service.getPluginDetail({ id, workspaceRoot }));
    } catch (err) {
      return toolError(`Failed loading detail for ${id}: ${err.message}`);
    }
  }
);

registerMutatingTools(server, { service });

// ---------------------------------------------------------------------------
// Boot Stdio Transport
// ---------------------------------------------------------------------------
async function main() {
  await store.init();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[marketplace-mcp] Ready (dataDir=${OPTS.dataDir}, registry=${OPTS.registryUrl})`);
}

main().catch((err) => {
  console.error("[marketplace-mcp] Fatal startup error:", err);
  process.exit(1);
});
