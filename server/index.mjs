#!/usr/bin/env node
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  computeKeyId,
  DEFAULT_TRUSTED_PUBLIC_KEYS,
  RegistryCatalog,
} from "./lib/catalog.mjs";
import { runCli } from "./lib/cli.mjs";
import { runPreflightChecks } from "./lib/preflight.mjs";
import { detectLiveCollisions, scanInstalledPlugins } from "./lib/scanner-local.mjs";
import { PluginStore } from "./lib/store.mjs";
import { registerMutatingTools, toolError } from "./tools-mutating.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const UI_RESOURCE_URI = "ui://marketplace/app.html";
const UI_HTML_PATH = path.resolve(__dirname, "../ui/dist/marketplace.html");
const CLIENT_MANIFEST_PATH = path.resolve(__dirname, "../plugin.json");

const cliResult = runCli({ rootDir: ROOT_DIR });
if (cliResult.handled) {
  process.exit(cliResult.exitCode);
}

async function loadClientVersion(manifestPath) {
  let raw;
  try {
    raw = await fs.readFile(manifestPath, "utf8");
  } catch (err) {
    throw new Error(`Failed to read plugin manifest at ${manifestPath}: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse plugin manifest at ${manifestPath}: ${err.message}`);
  }
  if (!parsed || typeof parsed.version !== "string" || !parsed.version.trim()) {
    throw new Error(`Missing or invalid "version" in plugin manifest at ${manifestPath}`);
  }
  return parsed.version.trim();
}

const CLIENT_VERSION = await loadClientVersion(CLIENT_MANIFEST_PATH);

// ---------------------------------------------------------------------------
// CLI Argument Parsing (--data-dir, --registry-url, --public-key-file, --insecure-skip-verify)
// ---------------------------------------------------------------------------
function requireFlagValue(argv, index, flagName) {
  const val = argv[index + 1];
  if (typeof val !== "string" || val.trim().length === 0 || val.startsWith("--")) {
    throw new Error(`Missing required value for ${flagName}`);
  }
  return val;
}

function parseArgs(argv) {
  const opts = {
    dataDir: path.join(os.homedir(), ".gemini", "config", "plugin-data", "agy-community-marketplace"),
    registryUrl: "https://domush.github.io/antigravity-plugin-registry",
    publicKeyFile: null,
    insecureSkipVerify: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--data-dir") {
      opts.dataDir = requireFlagValue(argv, i, arg);
      i += 1;
    } else if (arg === "--registry-url") {
      opts.registryUrl = requireFlagValue(argv, i, arg);
      i += 1;
    } else if (arg === "--public-key-file") {
      opts.publicKeyFile = requireFlagValue(argv, i, arg);
      i += 1;
    } else if (arg === "--insecure-skip-verify") {
      opts.insecureSkipVerify = true;
    } else {
      throw new Error(`Unknown MCP server argument: ${arg}`);
    }
  }
  return opts;
}

function loadTrustedPublicKeys(publicKeyFile) {
  const keys = { ...DEFAULT_TRUSTED_PUBLIC_KEYS };
  if (!publicKeyFile) return keys;

  const resolved = path.resolve(publicKeyFile);
  const raw = readFileSync(resolved, "utf8").trim();
  if (raw.startsWith("{")) {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Invalid JSON key map in --public-key-file: ${resolved}`);
    }
    return { ...keys, ...parsed };
  }

  const keyObj = crypto.createPublicKey({ key: raw, format: "pem" });
  const keyId = computeKeyId(keyObj);
  keys[keyId] = raw;
  return keys;
}

const OPTS = parseArgs(process.argv.slice(2));
const store = new PluginStore(OPTS.dataDir);
const trustedPublicKeys = loadTrustedPublicKeys(OPTS.publicKeyFile);
const catalog = new RegistryCatalog(OPTS.registryUrl, store, {
  trustedPublicKeys,
  requireSignatures: !OPTS.insecureSkipVerify,
});

const server = new McpServer({
  name: "community-marketplace",
  version: CLIENT_VERSION,
});

// ---------------------------------------------------------------------------
// Helpers: Workspace Roots & Summary Counts
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

function summarizeStatus(index, denylist, installed) {
  const pluginById = new Map((index.plugins || []).map((p) => [p.id.toLowerCase(), p]));
  const blockedRepos = new Set((denylist.blockedRepos || []).map((b) => b.id.toLowerCase()));
  const blockedShas = new Set(
    (denylist.blockedShas || []).map((b) => `${b.id.toLowerCase()}@${b.sha.toLowerCase()}`)
  );

  let updates = 0;
  let revoked = 0;

  for (const inst of installed) {
    const idKey = (inst.id || "").toLowerCase();
    if (blockedRepos.has(idKey) || (inst.sha && blockedShas.has(`${idKey}@${inst.sha.toLowerCase()}`))) {
      revoked += 1;
    }
    const latest = pluginById.get(idKey);
    const isOutdatedManaged =
      latest && !inst.manual && inst.sha && latest.release?.sha && inst.sha !== latest.release.sha;
    const isAdoptableOrigin = latest && inst.matchTier === "repo_origin";
    if (isOutdatedManaged || isAdoptableOrigin) {
      updates += 1;
    }
  }

  return {
    total: (index.plugins || []).length,
    installed: installed.length,
    updates,
    revoked,
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
      const [index, denylist, workspaceRoots] = await Promise.all([
        catalog.getIndex({ force: false }),
        catalog.getDenylist({ force: false }),
        discoverWorkspaceRoots(),
      ]);
      const installed = await scanInstalledPlugins({
        store,
        workspaceRoot: workspaceRoots[0],
        catalogPlugins: index.plugins || [],
      });
      const summary = summarizeStatus(index, denylist, installed);
      return {
        content: [
          {
            type: "text",
            text:
              `Community Marketplace ready: ${summary.total} plugins, ${summary.installed} installed, ` +
              `${summary.updates} updates available` +
              (summary.revoked > 0 ? `, ${summary.revoked} SECURITY ALERTS.` : "."),
          },
        ],
        structuredContent: { initialQuery, tab, summary },
      };
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
    inputSchema: {
      workspaceRoot: z.string().optional(),
    },
    _meta: { ui: { visibility: ["app"] } },
  },
  async ({ workspaceRoot } = {}) => {
    try {
      const [index, denylist, prefs, workspaceRoots] = await Promise.all([
        catalog.getIndex({ force: false }),
        catalog.getDenylist({ force: false }),
        store.getPrefs(),
        discoverWorkspaceRoots(),
      ]);

      const activeRoot = workspaceRoot || workspaceRoots[0];
      const installed = await scanInstalledPlugins({
        store,
        workspaceRoot: activeRoot,
        catalogPlugins: index.plugins || [],
      });

      return {
        content: [{ type: "text", text: `Loaded ${index.plugins?.length || 0} plugins.` }],
        structuredContent: {
          index,
          denylist,
          prefs,
          installed,
          workspaceRoots,
          clientVersion: CLIENT_VERSION,
          platform: process.platform,
        },
      };
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
    inputSchema: {
      workspaceRoot: z.string().optional(),
    },
    _meta: { ui: { visibility: ["app"] } },
  },
  async ({ workspaceRoot } = {}) => {
    try {
      const [index, denylist, workspaceRoots] = await Promise.all([
        catalog.getIndex({ force: true }),
        catalog.getDenylist({ force: true }),
        discoverWorkspaceRoots(),
      ]);
      const installed = await scanInstalledPlugins({
        store,
        workspaceRoot: workspaceRoot || workspaceRoots[0],
        catalogPlugins: index.plugins || [],
      });
      const summary = summarizeStatus(index, denylist, installed);

      return {
        content: [{ type: "text", text: `Checked updates: ${summary.updates} updates available.` }],
        structuredContent: {
          refreshedAt: new Date().toISOString(),
          ...summary,
        },
      };
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
    inputSchema: {
      id: z.string().min(3),
      workspaceRoot: z.string().optional(),
    },
    _meta: { ui: { visibility: ["app"] } },
  },
  async ({ id, workspaceRoot }) => {
    try {
      const index = await catalog.getIndex({ force: false });
      const pluginEntry = (index.plugins || []).find(
        (p) => p.id.toLowerCase() === id.toLowerCase()
      );
      if (!pluginEntry) {
        return toolError(`Plugin not found in registry index: ${id}`);
      }

      const [detail, workspaceRoots] = await Promise.all([
        catalog.getPluginDetail(pluginEntry, { force: false }),
        discoverWorkspaceRoots(),
      ]);

      const installed = await scanInstalledPlugins({
        store,
        workspaceRoot: workspaceRoot || workspaceRoots[0],
        catalogPlugins: index.plugins || [],
      });

      const liveCollisions = detectLiveCollisions({
        candidateId: pluginEntry.id,
        candidateCollisions: detail.collisions,
        installedPlugins: installed,
      });

      const preflight = await runPreflightChecks(detail);

      return {
        content: [{ type: "text", text: `Loaded audit detail for ${pluginEntry.id}.` }],
        structuredContent: { detail, liveCollisions, preflight },
      };
    } catch (err) {
      return toolError(`Failed loading detail for ${id}: ${err.message}`);
    }
  }
);

registerMutatingTools(server, { catalog, store });

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
