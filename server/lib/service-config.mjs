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
  mp_apply_pending_updates: {},
  mp_cancel_pending_updates: {
    id: z.string().optional(),
    scope: z.enum(["global", "project"]).optional(),
  },
};

export const STRICT_TOOL_VALIDATORS = Object.fromEntries(
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

export function resolveDataDir(rawDir, { defaultDataDir = DEFAULT_DATA_DIR } = {}) {
  if (typeof rawDir !== "string") {
    return path.resolve(defaultDataDir);
  }
  const trimmed = rawDir.trim();
  // Guard against unexpanded host template placeholders such as "${PLUGIN_DATA}"
  if (!trimmed || /^\$\{[^}]+\}$/.test(trimmed)) {
    return path.resolve(defaultDataDir);
  }
  return path.resolve(trimmed);
}

export function parseServerArgs(argv) {
  if (!Array.isArray(argv)) {
    throw new TypeError("parseServerArgs requires argv to be an array");
  }
  const opts = {
    dataDir: resolveDataDir(null),
    registryUrl: DEFAULT_REGISTRY_URL,
    publicKeyFile: null,
    insecureSkipVerify: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--data-dir") {
      opts.dataDir = resolveDataDir(requireFlagValue(argv, i, arg));
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
  const store = new PluginStore(resolveDataDir(dataDir));
  const trustedPublicKeys = loadTrustedPublicKeys(publicKeyFile);
  const catalog = new RegistryCatalog(registryUrl, store, {
    trustedPublicKeys,
    requireSignatures: !insecureSkipVerify,
  });
  return { store, catalog };
}
