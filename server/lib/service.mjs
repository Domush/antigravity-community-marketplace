import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  computeKeyId,
  DEFAULT_TRUSTED_PUBLIC_KEYS,
  RegistryCatalog,
} from "./catalog.mjs";
import {
  getPluginsDir,
  installPlugin as installPluginArtifact,
  setPluginEnabled,
  uninstallPlugin as uninstallPluginArtifact,
} from "./installer.mjs";
import { runPreflightChecks } from "./preflight.mjs";
import { detectLiveCollisions, scanInstalledPlugins } from "./scanner-local.mjs";
import { compareSemver, parseSemver } from "./semver.mjs";
import { PluginStore } from "./store.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(__dirname, "../..");
export const CLIENT_MANIFEST_PATH = path.resolve(ROOT_DIR, "plugin.json");
export const DEFAULT_DATA_DIR = path.join(
  os.homedir(),
  ".gemini",
  "config",
  "plugin-data",
  "agy-community-marketplace"
);
export const DEFAULT_REGISTRY_URL = "https://domush.github.io/antigravity-plugin-registry";

export class ToolValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ToolValidationError";
    this.statusCode = 400;
  }
}

export const TOOL_SCHEMAS = {
  mp_get_bootstrap: {
    workspaceRoot: z.string().optional(),
  },
  mp_check_updates: {
    workspaceRoot: z.string().optional(),
  },
  mp_get_plugin_detail: {
    id: z.string().min(3),
    workspaceRoot: z.string().optional(),
  },
  mp_install_plugin: {
    id: z.string().min(3),
    scope: z.enum(["global", "project"]),
    workspaceRoot: z.string().optional(),
    replaceSlug: z.string().optional(),
    replaceEnabled: z.boolean().optional(),
  },
  mp_toggle_plugin: {
    slug: z.string().min(1),
    scope: z.enum(["global", "project"]),
    enabled: z.boolean(),
    workspaceRoot: z.string().optional(),
  },
  mp_uninstall_plugin: {
    slug: z.string().min(1),
    id: z.string().optional(),
    scope: z.enum(["global", "project"]),
    enabled: z.boolean().optional(),
    workspaceRoot: z.string().optional(),
  },
  mp_update_prefs: {
    id: z.string().min(1),
    field: z.enum(["favorites", "hidden"]),
    value: z.boolean(),
  },
};

const STRICT_TOOL_VALIDATORS = Object.fromEntries(
  Object.entries(TOOL_SCHEMAS).map(([name, shape]) => [name, z.object(shape).strict()])
);

export async function loadClientVersion(manifestPath = CLIENT_MANIFEST_PATH) {
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

function requireFlagValue(argv, index, flagName) {
  const val = argv[index + 1];
  if (typeof val !== "string" || val.trim().length === 0 || val.startsWith("--")) {
    throw new Error(`Missing required value for ${flagName}`);
  }
  return val;
}

export function parseServerArgs(argv) {
  if (!Array.isArray(argv)) {
    throw new TypeError("parseServerArgs requires argv to be an array");
  }
  const opts = {
    dataDir: DEFAULT_DATA_DIR,
    registryUrl: DEFAULT_REGISTRY_URL,
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
      throw new Error(`Unknown server argument: ${arg}`);
    }
  }
  return opts;
}

export function loadTrustedPublicKeys(publicKeyFile) {
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

export function createCatalogAndStore({
  dataDir = DEFAULT_DATA_DIR,
  registryUrl = DEFAULT_REGISTRY_URL,
  publicKeyFile = null,
  insecureSkipVerify = false,
} = {}) {
  const store = new PluginStore(dataDir);
  const trustedPublicKeys = loadTrustedPublicKeys(publicKeyFile);
  const catalog = new RegistryCatalog(registryUrl, store, {
    trustedPublicKeys,
    requireSignatures: !insecureSkipVerify,
  });
  return { store, catalog };
}

export function summarizeStatus(index, denylist, installed) {
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
    if (latest) {
      const installedVersion = typeof inst.version === "string" ? inst.version.trim() : "";
      const registryVersion = typeof latest.version === "string" ? latest.version.trim() : "";
      const cmp = compareSemver(installedVersion, registryVersion);
      const isAhead = cmp !== null && cmp > 0;
      const isBehind = cmp !== null && cmp < 0;
      const isOutdatedManaged =
        !inst.manual && inst.sha && latest.release?.sha && inst.sha !== latest.release.sha && !isAhead;
      const isAdoptableOrigin =
        inst.matchTier === "repo_origin" &&
        (isBehind || (parseSemver(installedVersion) === null && Boolean(registryVersion)));
      if (isOutdatedManaged || isAdoptableOrigin) {
        updates += 1;
      }
    }
  }

  return {
    total: (index.plugins || []).length,
    installed: installed.length,
    updates,
    revoked,
  };
}

function formatZodIssues(issues) {
  return issues
    .map((issue) => {
      const loc = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
      return `${loc}${issue.message}`;
    })
    .join("; ");
}

export function createMarketplaceService({
  catalog,
  store,
  clientVersion,
  resolveWorkspaceRoots = async () => [],
}) {
  if (!catalog || !store) {
    throw new TypeError("createMarketplaceService requires catalog and store instances.");
  }
  if (typeof clientVersion !== "string" || !clientVersion.trim()) {
    throw new TypeError("createMarketplaceService requires a non-empty clientVersion string.");
  }

  async function resolveRoots(overrideRoots) {
    if (Array.isArray(overrideRoots)) {
      return [...new Set(overrideRoots)];
    }
    const discovered = await resolveWorkspaceRoots();
    return Array.isArray(discovered) ? [...new Set(discovered)] : [];
  }

  async function getSummary({ initialQuery = "", tab = "browse" } = {}) {
    const [index, denylist, workspaceRoots] = await Promise.all([
      catalog.getIndex({ force: false }),
      catalog.getDenylist({ force: false }),
      resolveRoots(),
    ]);
    const installed = await scanInstalledPlugins({
      store,
      workspaceRoot: workspaceRoots[0],
      catalogPlugins: index.plugins || [],
    });
    const summary = summarizeStatus(index, denylist, installed);
    return {
      text:
        `Community Marketplace ready: ${summary.total} plugins, ${summary.installed} installed, ` +
        `${summary.updates} updates available` +
        (summary.revoked > 0 ? `, ${summary.revoked} SECURITY ALERTS.` : "."),
      structuredContent: { initialQuery, tab, summary },
    };
  }

  async function getBootstrap({ workspaceRoot, workspaceRoots } = {}) {
    const [index, denylist, prefs, resolvedRoots] = await Promise.all([
      catalog.getIndex({ force: false }),
      catalog.getDenylist({ force: false }),
      store.getPrefs(),
      resolveRoots(workspaceRoots),
    ]);

    const activeRoot = workspaceRoot || resolvedRoots[0];
    const installed = await scanInstalledPlugins({
      store,
      workspaceRoot: activeRoot,
      catalogPlugins: index.plugins || [],
    });

    return {
      text: `Loaded ${index.plugins?.length || 0} plugins.`,
      structuredContent: {
        index,
        denylist,
        prefs,
        installed,
        workspaceRoots: resolvedRoots,
        clientVersion,
        platform: process.platform,
      },
    };
  }

  async function checkUpdates({ workspaceRoot, workspaceRoots } = {}) {
    const [index, denylist, resolvedRoots] = await Promise.all([
      catalog.getIndex({ force: true }),
      catalog.getDenylist({ force: true }),
      resolveRoots(workspaceRoots),
    ]);
    const installed = await scanInstalledPlugins({
      store,
      workspaceRoot: workspaceRoot || resolvedRoots[0],
      catalogPlugins: index.plugins || [],
    });
    const summary = summarizeStatus(index, denylist, installed);

    return {
      text: `Checked updates: ${summary.updates} updates available.`,
      structuredContent: {
        refreshedAt: new Date().toISOString(),
        ...summary,
      },
    };
  }

  async function getPluginDetail({ id, workspaceRoot, workspaceRoots } = {}) {
    const index = await catalog.getIndex({ force: false });
    const pluginEntry = (index.plugins || []).find(
      (p) => p.id.toLowerCase() === id.toLowerCase()
    );
    if (!pluginEntry) {
      throw new Error(`Plugin not found in registry index: ${id}`);
    }

    const [detail, resolvedRoots] = await Promise.all([
      catalog.getPluginDetail(pluginEntry, { force: false }),
      resolveRoots(workspaceRoots),
    ]);

    const installed = await scanInstalledPlugins({
      store,
      workspaceRoot: workspaceRoot || resolvedRoots[0],
      catalogPlugins: index.plugins || [],
    });

    const liveCollisions = detectLiveCollisions({
      candidateId: pluginEntry.id,
      candidateCollisions: detail.collisions,
      installedPlugins: installed,
    });

    const preflight = await runPreflightChecks(detail);

    return {
      text: `Loaded audit detail for ${pluginEntry.id}.`,
      structuredContent: { detail, liveCollisions, preflight },
    };
  }

  async function installPlugin({ id, scope, workspaceRoot, replaceSlug, replaceEnabled = true }) {
    // Always revalidate denylist before installing so emergency revocations take effect immediately
    const [index, denylist] = await Promise.all([
      catalog.getIndex({ force: false }),
      catalog.getDenylist({ force: true }),
    ]);
    const pluginEntry = (index.plugins || []).find(
      (p) => p.id.toLowerCase() === id.toLowerCase()
    );
    if (!pluginEntry) {
      throw new Error(`Plugin not found in registry index: ${id}`);
    }

    const record = await installPluginArtifact({
      pluginEntry,
      denylist,
      scope,
      workspaceRoot,
      replaceSlug: replaceSlug || null,
      replaceEnabled,
    });

    const { migratedFrom, ...lockRecord } = record;
    if (migratedFrom) {
      await store.removeInstallRecord({
        slug: migratedFrom.slug,
        scope,
        installPath: migratedFrom.installPath,
      });
    }
    await store.upsertInstallRecord(lockRecord);

    return {
      text: migratedFrom
        ? `Adopted ${record.id}@${record.version} into ${record.scope} scope (migrated "${migratedFrom.slug}" -> "${record.slug}").`
        : `Installed ${record.id}@${record.version} into ${record.scope} scope.`,
      structuredContent: {
        installed: lockRecord,
        migratedFrom: migratedFrom || null,
        requiresReload: true,
      },
    };
  }

  async function togglePlugin({ slug, scope, enabled, workspaceRoot }) {
    const moved = await setPluginEnabled({ slug, scope, workspaceRoot, enabled });
    await store.updateInstallEnabled({
      slug,
      scope,
      fromPath: moved.fromPath,
      installPath: moved.installPath,
      enabled,
    });
    return {
      text: `${enabled ? "Enabled" : "Disabled"} ${slug} (${scope}).`,
      structuredContent: { ...moved, requiresReload: true },
    };
  }

  async function uninstallPlugin({ slug, scope, enabled = true, workspaceRoot }) {
    const pluginsRoot = getPluginsDir(scope, workspaceRoot, { enabled });
    const expectedInstallPath = path.join(pluginsRoot, slug);
    const res = await uninstallPluginArtifact({ slug, scope, workspaceRoot, enabled });
    await store.removeInstallRecord({ slug, scope, installPath: expectedInstallPath });

    return {
      text: `Uninstalled ${slug} (${scope}).`,
      structuredContent: { removed: res.removed, requiresReload: true },
    };
  }

  async function updatePrefs({ id, field, value }) {
    const prefs = await store.updatePref(id, field, value);
    return {
      text: `Updated ${field} for ${id}.`,
      structuredContent: { prefs },
    };
  }

  async function executeTool(name, rawArgs = {}, { workspaceRoots } = {}) {
    if (typeof name !== "string" || !name.trim() || !STRICT_TOOL_VALIDATORS[name]) {
      throw new ToolValidationError(`Unknown marketplace tool: ${String(name)}`);
    }
    if (rawArgs !== undefined && (rawArgs === null || typeof rawArgs !== "object" || Array.isArray(rawArgs))) {
      throw new ToolValidationError(`Arguments for "${name}" must be a JSON object.`);
    }

    const parsed = STRICT_TOOL_VALIDATORS[name].safeParse(rawArgs ?? {});
    if (!parsed.success) {
      throw new ToolValidationError(`Invalid arguments for "${name}": ${formatZodIssues(parsed.error.issues)}`);
    }

    const args = parsed.data;
    switch (name) {
      case "mp_get_bootstrap":
        return getBootstrap({ ...args, workspaceRoots });
      case "mp_check_updates":
        return checkUpdates({ ...args, workspaceRoots });
      case "mp_get_plugin_detail":
        return getPluginDetail({ ...args, workspaceRoots });
      case "mp_install_plugin":
        return installPlugin(args);
      case "mp_toggle_plugin":
        return togglePlugin(args);
      case "mp_uninstall_plugin":
        return uninstallPlugin(args);
      case "mp_update_prefs":
        return updatePrefs(args);
      default:
        throw new ToolValidationError(`Unknown marketplace tool: ${name}`);
    }
  }

  return {
    getSummary,
    getBootstrap,
    checkUpdates,
    getPluginDetail,
    installPlugin,
    togglePlugin,
    uninstallPlugin,
    updatePrefs,
    executeTool,
  };
}
