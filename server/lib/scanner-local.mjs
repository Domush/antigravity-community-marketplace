import fs from "node:fs/promises";
import path from "node:path";
import { computeContentTreeSha256, getPluginsDir } from "./installer.mjs";

const HOOK_EVENTS = new Set([
  "SessionStart",
  "PreToolUse",
  "PostToolUse",
  "PreInvocation",
  "PostInvocation",
  "Stop",
]);

/** Lightweight zero-dependency YAML frontmatter parser for SKILL.md and agents/*.md. */
function parseFrontmatter(markdown) {
  const match = markdown.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return { data: {}, body: markdown };

  const data = {};
  const lines = match[1].split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!kv) continue;

    const key = kv[1];
    const rawVal = kv[2].trim();
    if (rawVal === "|" || rawVal === ">" || rawVal === "|-" || rawVal === ">-") {
      const block = [];
      while (i + 1 < lines.length && (/^\s+/.test(lines[i + 1]) || lines[i + 1].trim() === "")) {
        i += 1;
        block.push(lines[i].trim());
      }
      data[key] = block.join(rawVal.startsWith(">") ? " " : "\n").trim();
    } else if (rawVal === "true") {
      data[key] = true;
    } else if (rawVal === "false") {
      data[key] = false;
    } else if (
      (rawVal.startsWith('"') && rawVal.endsWith('"')) ||
      (rawVal.startsWith("'") && rawVal.endsWith("'"))
    ) {
      data[key] = rawVal.slice(1, -1);
    } else {
      data[key] = rawVal;
    }
  }

  return { data, body: markdown.slice(match[0].length) };
}

async function readJsonSafe(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function readPluginManifest(pluginDir) {
  const candidates = [
    path.join(pluginDir, ".antigravity-plugin", "plugin.json"),
    path.join(pluginDir, "plugin.json"),
  ];
  for (const p of candidates) {
    const parsed = await readJsonSafe(p);
    if (parsed && typeof parsed === "object") return parsed;
  }
  return null;
}

/** Extract "owner/repo" from HTTPS, SSH, git+, or github: repository strings. */
export function parseGitHubRepoId(raw) {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();

  const shorthand = trimmed.match(/^github:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git|\/)?$/i);
  if (shorthand) return shorthand[1];

  const urlMatch = trimmed.match(
    /(?:https?:\/\/|ssh:\/\/git@|git\+https?:\/\/|git@)github\.com[:/]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git|\/|#.*)?$/i
  );
  return urlMatch ? urlMatch[1] : null;
}

/** Read GitHub owner/repo from .git/config [remote "origin"] or manifest.repository without spawning git. */
async function detectOriginRepoId(pluginDir, manifest) {
  const gitConfigPath = path.join(pluginDir, ".git", "config");
  try {
    const cfg = await fs.readFile(gitConfigPath, "utf8");
    const originSection = cfg.match(/\[remote\s+"origin"\]([\s\S]*?)(?:\r?\n\[|$)/i);
    if (originSection) {
      const urlLine = originSection[1].match(/^\s*url\s*=\s*(.+)$/m);
      const parsed = parseGitHubRepoId(urlLine?.[1]);
      if (parsed) return parsed;
    }
  } catch {
    // Not a git checkout
  }

  const repoField = manifest?.repository;
  const repoUrl = typeof repoField === "string" ? repoField : repoField?.url;
  return parseGitHubRepoId(repoUrl);
}

function buildCatalogLookup(catalogPlugins = []) {
  const byTreeHash = new Map();
  const byRepoId = new Map();
  const byPluginName = new Map();

  for (const p of catalogPlugins) {
    if (p.release?.contentTreeSha256) byTreeHash.set(p.release.contentTreeSha256, p);
    if (p.id) byRepoId.set(p.id.toLowerCase(), p);
    const pName = (p.pluginName || p.id?.split("/")[1] || "").toLowerCase();
    if (pName) {
      const list = byPluginName.get(pName) || [];
      list.push(p);
      byPluginName.set(pName, list);
    }
  }
  return { byTreeHash, byRepoId, byPluginName };
}

/** Extract runtime-namespaced MCP server keys, hook events, /slash commands, and agent names. */
async function inspectLocalSurfaces(pluginDir, manifest) {
  const mcpServerNames = new Set();
  const hookEvents = new Set();
  const slashCommands = new Set();
  const agentNames = new Set();
  const pluginName = (typeof manifest?.name === "string" && manifest.name.trim())
    ? manifest.name.trim()
    : path.basename(pluginDir);

  // 1. mcp_config.json -> runtime-namespaced keys (<pluginName>_<serverKey>)
  const mcpConfig = await readJsonSafe(path.join(pluginDir, "mcp_config.json"));
  const rawServers = mcpConfig?.mcpServers || manifest?.mcpServers || {};
  if (rawServers && typeof rawServers === "object" && !Array.isArray(rawServers)) {
    for (const key of Object.keys(rawServers)) {
      mcpServerNames.add(`${pluginName}_${key}`);
    }
  }

  // 2. hooks.json -> canonical named hook groups, flat event maps, or { hooks: { ... } }
  const hooksConfig = await readJsonSafe(path.join(pluginDir, "hooks.json"));
  const rawHooks = hooksConfig || manifest?.hooks || {};
  const collectEvents = (obj) => {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return;
    for (const [k, v] of Object.entries(obj)) {
      if (HOOK_EVENTS.has(k) && Array.isArray(v)) hookEvents.add(k);
    }
  };
  if (rawHooks && typeof rawHooks === "object" && !Array.isArray(rawHooks)) {
    for (const [topKey, topVal] of Object.entries(rawHooks)) {
      if (topKey === "$schema" || topKey === "version") continue;
      if (HOOK_EVENTS.has(topKey) && Array.isArray(topVal)) {
        hookEvents.add(topKey);
      } else if (topKey === "hooks" && topVal && typeof topVal === "object") {
        collectEvents(topVal);
      } else if (topVal && typeof topVal === "object" && topVal.enabled !== false) {
        collectEvents(topVal);
      }
    }
  }

  // 3. Skills (skills/<dir>/SKILL.md) -> prefer frontmatter `name`, fallback to folder name
  const skillsDir = path.join(pluginDir, "skills");
  try {
    const skillEntries = await fs.readdir(skillsDir, { withFileTypes: true });
    for (const entry of skillEntries) {
      if (!entry.isDirectory()) continue;
      const skillMd = path.join(skillsDir, entry.name, "SKILL.md");
      const content = await fs.readFile(skillMd, "utf8").catch(() => null);
      if (content === null) continue;
      const { data } = parseFrontmatter(content);
      const skillName =
        typeof data.name === "string" && data.name.trim() ? data.name.trim() : entry.name;
      slashCommands.add(skillName.startsWith("/") ? skillName : `/${skillName}`);
    }
  } catch {
    // No skills directory
  }

  // 4. Custom agents (agents/*.md or agents/<dir>/agent.md)
  const agentsDir = path.join(pluginDir, "agents");
  try {
    const agentEntries = await fs.readdir(agentsDir, { withFileTypes: true });
    for (const entry of agentEntries) {
      let agentMdPath = null;
      let fallbackName = null;
      if (entry.isFile() && entry.name.endsWith(".md")) {
        agentMdPath = path.join(agentsDir, entry.name);
        fallbackName = entry.name.replace(/\.md$/i, "");
      } else if (entry.isDirectory()) {
        agentMdPath = path.join(agentsDir, entry.name, "agent.md");
        fallbackName = entry.name;
      }
      if (!agentMdPath) continue;
      const content = await fs.readFile(agentMdPath, "utf8").catch(() => null);
      if (content === null) continue;
      const { data } = parseFrontmatter(content);
      const agentName =
        typeof data.name === "string" && data.name.trim() ? data.name.trim() : fallbackName;
      if (agentName) agentNames.add(agentName);
    }
  } catch {
    // No agents directory
  }

  // Explicit commands declared in manifest (if any)
  if (Array.isArray(manifest?.commands)) {
    for (const cmd of manifest.commands) {
      const name = typeof cmd === "string" ? cmd : cmd?.name;
      if (name) slashCommands.add(name.startsWith("/") ? name : `/${name}`);
    }
  }

  return {
    mcpServerNames: [...mcpServerNames].sort(),
    hookEvents: [...hookEvents].sort(),
    slashCommands: [...slashCommands].sort(),
    agentNames: [...agentNames].sort(),
  };
}

async function scanScopeDirectory(rootDir, scope, lockByPath, { enabled, catalogLookup }) {
  const results = [];
  let entries;
  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    // Skip hidden temp staging dirs (.slug.install.*.tmp) and backups
    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name.includes(".bak.")) {
      continue;
    }

    const pluginDir = path.join(rootDir, entry.name);
    const manifest = await readPluginManifest(pluginDir);
    if (!manifest) continue;

    const normalizedPath = path.resolve(pluginDir).toLowerCase();
    const lockRecord = lockByPath.get(normalizedPath) || null;
    const surfaces = await inspectLocalSurfaces(pluginDir, manifest);

    const record = {
      id: lockRecord?.id || manifest.name || entry.name,
      slug: entry.name,
      name: manifest.name || entry.name,
      scope,
      installPath: pluginDir,
      enabled,
      version: lockRecord?.version || manifest.version || "local",
      sha: lockRecord?.sha || null,
      contentTreeSha256: lockRecord?.contentTreeSha256 || null,
      capabilities: lockRecord?.capabilities || [],
      installedAt: lockRecord?.installedAt || null,
      manual: !lockRecord,
      matchTier: lockRecord ? "managed" : "unmatched",
      originRepoId: null,
      suggestedMatches: [],
      surfaces,
    };

    // 3-Tier Reconciliation for unmanaged manual installs against the signed catalog
    if (!lockRecord && catalogLookup && catalogLookup.byRepoId.size > 0) {
      const localHash = await computeContentTreeSha256(pluginDir, { excludeDotGit: true }).catch(() => null);
      const hashMatch = localHash ? catalogLookup.byTreeHash.get(localHash) : null;

      if (hashMatch) {
        // Tier 1: Cryptographically identical to a verified registry release -> auto-link & track
        record.id = hashMatch.id;
        record.version = hashMatch.version;
        record.sha = hashMatch.release.sha;
        record.contentTreeSha256 = localHash;
        record.capabilities = hashMatch.security?.capabilities || [];
        record.manual = false;
        record.matchTier = "exact_hash";
      } else {
        // Tier 2: Verified GitHub origin (.git/config or manifest.repository) -> link for denylist & Adopt/Update
        const originRepoId = await detectOriginRepoId(pluginDir, manifest);
        const originMatch = originRepoId ? catalogLookup.byRepoId.get(originRepoId.toLowerCase()) : null;

        if (originMatch) {
          record.id = originMatch.id;
          record.originRepoId = originMatch.id;
          record.contentTreeSha256 = localHash;
          record.matchTier = "repo_origin";
        } else {
          // Tier 3: Unverified plugin.json name match -> suggest opt-in linking only (prevents name squatting)
          const localName = (manifest.name || entry.name).toLowerCase();
          const candidates = catalogLookup.byPluginName.get(localName) || [];
          if (candidates.length > 0) {
            record.matchTier = "name_suggestion";
            record.suggestedMatches = candidates
              .slice()
              .sort((a, b) => (b.stats?.stars || 0) - (a.stats?.stars || 0))
              .slice(0, 3)
              .map((c) => ({
                id: c.id,
                name: c.name,
                author: c.author?.login || c.id.split("/")[0],
                version: c.version,
                stars: c.stats?.stars || 0,
              }));
          }
        }
      }
    }

    results.push(record);
  }
  return results;
}

export async function scanInstalledPlugins({ store, workspaceRoot, catalogPlugins = [] }) {
  const lockfile = await store.getLockfile();
  const lockByPath = new Map(
    lockfile.installs.map((i) => [path.resolve(i.installPath).toLowerCase(), i])
  );
  const catalogLookup = catalogPlugins.length > 0 ? buildCatalogLookup(catalogPlugins) : null;

  const globalActive = await scanScopeDirectory(
    getPluginsDir("global", null, { enabled: true }), "global", lockByPath, { enabled: true, catalogLookup }
  );
  const globalDisabled = await scanScopeDirectory(
    getPluginsDir("global", null, { enabled: false }), "global", lockByPath, { enabled: false, catalogLookup }
  );

  let projectActive = [];
  let projectDisabled = [];
  if (workspaceRoot) {
    try {
      projectActive = await scanScopeDirectory(
        getPluginsDir("project", workspaceRoot, { enabled: true }), "project", lockByPath, { enabled: true, catalogLookup }
      );
      projectDisabled = await scanScopeDirectory(
        getPluginsDir("project", workspaceRoot, { enabled: false }), "project", lockByPath, { enabled: false, catalogLookup }
      );
    } catch {
      projectActive = [];
      projectDisabled = [];
    }
  }

  return [...globalActive, ...globalDisabled, ...projectActive, ...projectDisabled];
}

/**
 * Compare candidate plugin's declared surfaces against every OTHER locally installed plugin.
 * Returns human-readable warning strings rendered in the Audit Drawer.
 */
export function detectLiveCollisions({ candidateId, candidateCollisions, installedPlugins }) {
  const warnings = [];
  if (!candidateCollisions) return warnings;

  const targetIdLower = candidateId.toLowerCase();
  const candidateSlash = new Set(candidateCollisions.slashCommands || []);
  const candidateMcp = new Set(candidateCollisions.mcpServerNames || []);
  const candidateAgents = new Set(candidateCollisions.agentNames || []);

  for (const inst of installedPlugins) {
    // Skip self-updates and disabled plugins (not loaded at runtime)
    if ((inst.id || "").toLowerCase() === targetIdLower) continue;
    if (inst.enabled === false) continue;

    const label = `${inst.name} (${inst.scope})`;

    for (const cmd of inst.surfaces?.slashCommands || []) {
      if (candidateSlash.has(cmd)) {
        warnings.push(`Slash command "${cmd}" collides with installed plugin ${label}.`);
      }
    }
    for (const srv of inst.surfaces?.mcpServerNames || []) {
      if (candidateMcp.has(srv)) {
        warnings.push(`MCP server name "${srv}" collides with installed plugin ${label}.`);
      }
    }
    for (const agent of inst.surfaces?.agentNames || []) {
      if (candidateAgents.has(agent)) {
        warnings.push(`Custom agent "${agent}" collides with installed plugin ${label}.`);
      }
    }
  }
  return warnings;
}
