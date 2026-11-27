// ---------------------------------------------------------------------------
// Configuration, Display Labels, Application State & Pure Helpers
// ---------------------------------------------------------------------------
export const REGISTRY_ISSUE_REPO = "https://github.com/Domush/antigravity-plugin-registry";

export const RISK_ORDER = { low: 0, elevated: 1, high: 2, unverified: 3 };

export const CAPABILITY_LABELS = {
  runs_shell_hooks: "Shell Lifecycle Hooks",
  runs_prompt_hooks: "Prompt Lifecycle Hooks",
  unpinned_remote_runtime: "Unpinned Remote Package (npx/uvx)",
  prompt_injection_suspect: "Suspicious Prompt Directives",
  credential_access: "Accesses Credential Paths",
  process_spawn: "Spawns OS Processes",
  dynamic_code_exec: "Dynamic Code Execution (eval)",
  mcp_local_exec: "Local Executable (stdio MCP)",
  network_external_mcp: "Remote External MCP",
  network_outbound: "Outbound Network Calls",
  fs_write_workspace: "Writes Workspace Files",
  fs_read_workspace: "Reads Workspace Files",
  fs_outside_workspace: "Reads Outside Workspace",
  contains_minified: "Minified / Obfuscated Code",
  prompt_mentions_shell: "Prompt Requests Shell Commands",
  prompt_rules_only: "Prompt / Rules Only",
};

export const ELEVATED_CAPABILITIES = new Set([
  "runs_shell_hooks",
  "unpinned_remote_runtime",
  "prompt_injection_suspect",
  "credential_access",
  "process_spawn",
  "dynamic_code_exec",
  "mcp_local_exec",
  "network_external_mcp",
  "network_outbound",
  "fs_outside_workspace",
  "contains_minified",
]);

export const state = {
  catalog: { plugins: [], generatedAt: null },
  denylist: { blockedRepos: [], blockedShas: [] },
  prefs: { favorites: [], hidden: [] },
  installed: [], // [{ id, slug, scope: 'global'|'project', version, sha, capabilities, manual }]
  workspaceRoots: [],
  activeProjectRoot: "",
  clientVersion: "1.0.2",
  platform: "",
  dismissedSelfUpdate: false,
  requiresReload: false,
  busyIds: new Set(),
  errorMessage: "",

  // View controls
  tab: "browse",
  query: "",
  category: "all",
  surface: "all",
  maxRisk: "all",
  sort: "stars",
  noCredsOnly: false,
  showHidden: false,

  // Drawer state
  drawer: {
    open: false,
    pluginId: null,
    subTab: "audit", // "audit" | "overview"
    pendingAction: null, // { type: 'install'|'update'|'adopt', scope: 'global'|'project', replaceSlug?, replaceEnabled? } | null
    loading: false,
    detail: null,
    error: null,
  },
};

export function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function capLabel(key) {
  return CAPABILITY_LABELS[key] || key.replaceAll("_", " ");
}

export function compareSemver(a, b) {
  const pa = String(a || "0.0.0").split("-")[0].split(".").map(Number);
  const pb = String(b || "0.0.0").split("-")[0].split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function getSelfUpdateInfo() {
  const mc = state.catalog?.marketplaceClient;
  if (!mc?.latestVersion || !state.clientVersion) return null;
  if (compareSemver(mc.latestVersion, state.clientVersion) <= 0) return null;
  const unsupported =
    Boolean(mc.minSupportedVersion) && compareSemver(state.clientVersion, mc.minSupportedVersion) < 0;
  return { ...mc, unsupported };
}

export function getInstallsFor(pluginId) {
  const lower = pluginId.toLowerCase();
  return state.installed.filter((i) => (i.id || "").toLowerCase() === lower);
}

export function hasUpdateAvailable(plugin) {
  const installs = getInstallsFor(plugin.id);
  return installs.some(
    (i) =>
      (!i.manual && i.sha && plugin.release?.sha && i.sha !== plugin.release.sha) ||
      i.matchTier === "repo_origin"
  );
}

export function getRevokedInstalls() {
  const blockedRepos = new Map(
    (state.denylist.blockedRepos || []).map((b) => [b.id.toLowerCase(), b])
  );
  const blockedShas = new Map(
    (state.denylist.blockedShas || []).map((b) => [`${b.id.toLowerCase()}@${b.sha.toLowerCase()}`, b])
  );

  const alerts = [];
  for (const inst of state.installed) {
    const idKey = (inst.id || "").toLowerCase();
    const repoHit = blockedRepos.get(idKey);
    const shaHit = inst.sha ? blockedShas.get(`${idKey}@${inst.sha.toLowerCase()}`) : null;
    if (repoHit || shaHit) {
      alerts.push({ install: inst, rule: repoHit || shaHit });
    }
  }
  return alerts;
}

export function computePermissionDiff(installedCaps = [], targetCaps = []) {
  const prevSet = new Set(installedCaps);
  const nextSet = new Set(targetCaps);
  const added = [...nextSet].filter((c) => !prevSet.has(c));
  const removed = [...prevSet].filter((c) => !nextSet.has(c));
  const unchanged = [...nextSet].filter((c) => prevSet.has(c));
  const hasEscalation = added.some((c) => ELEVATED_CAPABILITIES.has(c));
  return { added, removed, unchanged, hasEscalation };
}

export function getFilteredPlugins() {
  const favSet = new Set(state.prefs.favorites || []);
  const hiddenSet = new Set(state.prefs.hidden || []);
  const q = state.query.trim().toLowerCase();

  // Merge catalog plugins + any locally installed manual plugins when viewing Installed tab
  let items = [...(state.catalog.plugins || [])];
  if (state.tab === "installed") {
    const knownIds = new Set(items.map((p) => p.id.toLowerCase()));
    for (const inst of state.installed) {
      const idKey = (inst.id || inst.slug).toLowerCase();
      if (!knownIds.has(idKey)) {
        items.push({
          id: inst.id || inst.slug,
          name: inst.name || inst.slug,
          summary: "Manually installed local plugin (not listed in community registry).",
          author: { login: "local" },
          version: inst.version || "local",
          surface: { hasSidebarUi: false, components: [] },
          categories: [],
          tags: [],
          requiresCredentials: false,
          stats: { stars: 0, pushedAt: "" },
          security: { riskTier: "unverified", capabilities: [] },
          isManualOnly: true,
          suggestedMatches: inst.suggestedMatches || [],
        });
      }
    }
  }

  items = items.filter((p) => {
    const isHidden = hiddenSet.has(p.id);
    if (isHidden && !state.showHidden) return false;

    if (state.tab === "installed" && getInstallsFor(p.id).length === 0) return false;
    if (state.tab === "updates" && !hasUpdateAvailable(p)) return false;
    if (state.tab === "favorites" && !favSet.has(p.id)) return false;

    if (state.category !== "all" && !(p.categories || []).includes(state.category)) return false;
    if (state.noCredsOnly && p.requiresCredentials) return false;

    if (state.surface === "sidebar_ui" && !p.surface?.hasSidebarUi) return false;
    if (state.surface === "prompt_only" && !(p.security?.capabilities || []).includes("prompt_rules_only")) return false;
    if (state.surface === "mcp_stdio" && !(p.surface?.components || []).includes("mcp_stdio")) return false;
    if (state.surface === "hooks" && !(p.surface?.components || []).includes("hooks")) return false;

    const riskRank = RISK_ORDER[p.security?.riskTier] ?? 3;
    if (state.maxRisk === "low" && riskRank > 0) return false;
    if (state.maxRisk === "elevated" && riskRank > 1) return false;

    if (q) {
      const haystack = [
        p.id,
        p.name,
        p.summary,
        p.author?.login,
        ...(p.categories || []),
        ...(p.tags || []),
      ]
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(q)) return false;
    }

    return true;
  });

  items.sort((a, b) => {
    if (state.sort === "stars") return (b.stats?.stars || 0) - (a.stats?.stars || 0);
    if (state.sort === "updated") {
      return Date.parse(b.stats?.pushedAt || 0) - Date.parse(a.stats?.pushedAt || 0);
    }
    if (state.sort === "risk") {
      return (RISK_ORDER[a.security?.riskTier] ?? 3) - (RISK_ORDER[b.security?.riskTier] ?? 3);
    }
    return a.name.localeCompare(b.name);
  });

  return items;
}
