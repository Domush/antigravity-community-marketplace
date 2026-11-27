import { compareSemver, parseSemver } from "../../server/lib/semver.mjs";
import { ELEVATED_CAPABILITIES, RISK_ORDER } from "./security-meta.js";

// ---------------------------------------------------------------------------
// Configuration, Display Labels, Application State & Pure Helpers
// ---------------------------------------------------------------------------
export const REGISTRY_ISSUE_REPO = "https://github.com/Domush/antigravity-plugin-registry";

export {
  CAPABILITY_DESCRIPTIONS,
  CAPABILITY_LABELS,
  capDescription,
  capLabel,
  ELEVATED_CAPABILITIES,
  formatFindingSnippet,
  inferFindingCapability,
  RISK_DESCRIPTIONS,
  RISK_ORDER,
  riskDescription,
  severityDescription,
} from "./security-meta.js";

export const state = {
  catalog: { plugins: [], generatedAt: null },
  denylist: { blockedRepos: [], blockedShas: [] },
  prefs: { favorites: [], hidden: [] },
  installed: [], // [{ id, slug, scope: 'global'|'project', version, sha, capabilities, manual }]
  workspaceRoots: [],
  activeProjectRoot: "",
  clientVersion: "1.0.5",
  platform: "",
  dismissedSelfUpdate: false,
  requiresReload: false,
  busyIds: new Set(),
  expandedIds: new Set(),
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
  filtersOpen: false,

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

export function isSafeHttpUrl(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) return false;
  try {
    const parsed = new URL(rawUrl.trim());
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

export function getPluginInitials(plugin) {
  const raw = String(plugin?.name || plugin?.id?.split("/")[1] || plugin?.id || "PL").trim();
  const words = raw.split(/[\s_-]+/).filter(Boolean);
  if (words.length >= 2) {
    return `${words[0][0]}${words[1][0]}`.toUpperCase();
  }
  const single = (words[0] || "PL").replace(/[^A-Za-z0-9]/g, "");
  return (single.slice(0, 2) || "PL").toUpperCase();
}

export function getPluginIconUrl(plugin) {
  if (isSafeHttpUrl(plugin?.iconUrl)) return plugin.iconUrl.trim();
  if (isSafeHttpUrl(plugin?.author?.avatarUrl)) return plugin.author.avatarUrl.trim();
  return "";
}

export function renderPluginIcon(plugin, sizeClass = "") {
  const initials = getPluginInitials(plugin);
  const iconUrl = getPluginIconUrl(plugin);
  const cls = sizeClass ? `mp-plugin-icon ${sizeClass}` : "mp-plugin-icon";
  return `
    <span class="${cls}" aria-hidden="true">
      <span class="mp-plugin-monogram">${esc(initials)}</span>
      ${
        iconUrl
          ? `<img class="mp-plugin-icon-img" src="${esc(iconUrl)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" />`
          : ""
      }
    </span>
  `;
}

export function getActiveFilterCount() {
  let count = 0;
  if (state.category !== "all") count += 1;
  if (state.surface !== "all") count += 1;
  if (state.maxRisk !== "all") count += 1;
  if (state.noCredsOnly) count += 1;
  return count;
}

export { compareSemver, parseSemver };

export function getSelfUpdateInfo() {
  const mc = state.catalog?.marketplaceClient;
  if (!mc?.latestVersion || !state.clientVersion) return null;
  const latestCmp = compareSemver(mc.latestVersion, state.clientVersion);
  if (latestCmp === null || latestCmp <= 0) return null;
  const minCmp = mc.minSupportedVersion
    ? compareSemver(state.clientVersion, mc.minSupportedVersion)
    : null;
  const unsupported = minCmp !== null && minCmp < 0;
  return { ...mc, unsupported };
}

export function getInstallsFor(pluginId) {
  const lower = pluginId.toLowerCase();
  return state.installed.filter((i) => (i.id || "").toLowerCase() === lower);
}

export function classifyInstallStatus(install, plugin) {
  const installedVersion = typeof install?.version === "string" ? install.version.trim() : "";
  const registryVersion = typeof plugin?.version === "string" ? plugin.version.trim() : "";
  const cmp = compareSemver(installedVersion, registryVersion);

  const isAhead = cmp !== null && cmp > 0;
  const isBehind = cmp !== null && cmp < 0;
  const isSameVersion = cmp === 0;
  const isUnversioned = cmp === null;
  const direction = isAhead
    ? "downgrade"
    : isBehind
      ? "upgrade"
      : isSameVersion
        ? "same"
        : "unversioned";

  const isRepoOrigin = install?.matchTier === "repo_origin";
  const hasShaMismatch = Boolean(
    !install?.manual &&
      install?.sha &&
      plugin?.release?.sha &&
      install.sha !== plugin.release.sha
  );
  const hasUpdate = Boolean(
    (hasShaMismatch && !isAhead) ||
      (isRepoOrigin &&
        (isBehind || (parseSemver(installedVersion) === null && Boolean(registryVersion))))
  );

  return {
    direction,
    isAhead,
    isBehind,
    isSameVersion,
    isUnversioned,
    isRepoOrigin,
    hasShaMismatch,
    hasUpdate,
    installedVersion,
    registryVersion,
  };
}

export function getInstallActionMeta(install, plugin) {
  if (!install || !plugin) return null;
  const status = classifyInstallStatus(install, plugin);
  if (!status.isRepoOrigin && !status.hasShaMismatch && !status.isAhead) {
    return null;
  }

  const action = status.isRepoOrigin ? "review-adopt" : "review-update";
  const regLabel = status.registryVersion || "registry";
  const instLabel = status.installedVersion;

  if (status.isAhead) {
    return {
      ...status,
      action,
      label: `Adopt Registry v${regLabel} (Downgrade)`,
      buttonClass: "mp-btn",
      isPrimary: false,
      isDowngrade: true,
      badgeLabel: `Local v${instLabel} Ahead`,
    };
  }

  if (status.direction === "same") {
    return {
      ...status,
      action,
      label: status.isRepoOrigin
        ? `Adopt & Verify (v${regLabel})`
        : `Re-sync Verified (v${regLabel})`,
      buttonClass: status.isRepoOrigin ? "mp-btn" : "mp-btn mp-btn-primary",
      isPrimary: !status.isRepoOrigin,
      isDowngrade: false,
      badgeLabel: null,
    };
  }

  const prefix = status.isRepoOrigin ? "Adopt & Update" : "Update";
  const label = instLabel
    ? `${prefix} ${instLabel} \u2192 ${regLabel}`
    : status.isRepoOrigin
      ? `Adopt & Verify (v${regLabel})`
      : `Re-sync Verified (v${regLabel})`;

  return {
    ...status,
    action,
    label,
    buttonClass: "mp-btn mp-btn-primary",
    isPrimary: true,
    isDowngrade: false,
    badgeLabel: null,
  };
}

export function hasUpdateAvailable(plugin) {
  if (!plugin?.id) return false;
  const installs = getInstallsFor(plugin.id);
  return installs.some((inst) => classifyInstallStatus(inst, plugin).hasUpdate);
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
