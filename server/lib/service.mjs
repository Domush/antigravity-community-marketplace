import fs from "node:fs/promises";
import path from "node:path";
import {
  getPluginsDir,
  installPlugin as installPluginArtifact,
  setPluginEnabled,
  uninstallPlugin as uninstallPluginArtifact,
} from "./installer.mjs";
import { applyPendingUpdates, spawnShutdownSwapWorker } from "./pending-updates.mjs";
import { runPreflightChecks } from "./preflight.mjs";
import { fetchReleaseNotesSince } from "./release-notes.mjs";
import { detectLiveCollisions, scanInstalledPlugins } from "./scanner-local.mjs";
import { filterSelfFromCatalogIndex, isSelfMarketplacePlugin } from "./self-filter.mjs";
import { compareSemver, parseSemver } from "./semver.mjs";
import {
  CLIENT_MANIFEST_PATH,
  createCatalogAndStore,
  DEFAULT_DATA_DIR,
  DEFAULT_REGISTRY_URL,
  loadClientVersion,
  loadTrustedPublicKeys,
  parseServerArgs,
  resolveDataDir,
  ROOT_DIR,
  STRICT_TOOL_VALIDATORS,
  TOOL_SCHEMAS,
  ToolValidationError,
} from "./service-config.mjs";

export {
  CLIENT_MANIFEST_PATH,
  createCatalogAndStore,
  DEFAULT_DATA_DIR,
  DEFAULT_REGISTRY_URL,
  loadClientVersion,
  loadTrustedPublicKeys,
  parseServerArgs,
  resolveDataDir,
  ROOT_DIR,
  TOOL_SCHEMAS,
  ToolValidationError,
};

export function summarizeStatus(index, denylist, installed) {
  const visiblePlugins = (index.plugins || []).filter((p) => !isSelfMarketplacePlugin(p));
  const pluginById = new Map(visiblePlugins.map((p) => [p.id.toLowerCase(), p]));
  const blockedRepos = new Set((denylist.blockedRepos || []).map((b) => b.id.toLowerCase()));
  const blockedShas = new Set(
    (denylist.blockedShas || []).map((b) => `${b.id.toLowerCase()}@${b.sha.toLowerCase()}`)
  );

  let updates = 0;
  let revoked = 0;

  for (const inst of installed) {
    if (isSelfMarketplacePlugin(inst)) continue;
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
    total: visiblePlugins.length,
    installed: installed.filter((inst) => !isSelfMarketplacePlugin(inst)).length,
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
  spawnPendingWatcher = spawnShutdownSwapWorker,
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
    const [rawIndex, denylist, workspaceRoots] = await Promise.all([
      catalog.getIndex({ force: false }),
      catalog.getDenylist({ force: false }),
      resolveRoots(),
    ]);
    const index = filterSelfFromCatalogIndex(rawIndex);
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
    const [rawIndex, denylist, prefs, pendingUpdates, resolvedRoots] = await Promise.all([
      catalog.getIndex({ force: false }),
      catalog.getDenylist({ force: false }),
      store.getPrefs(),
      store.getPendingUpdates(),
      resolveRoots(workspaceRoots),
    ]);

    const index = filterSelfFromCatalogIndex(rawIndex);
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
        pendingUpdates,
        workspaceRoots: resolvedRoots,
        clientVersion,
        platform: process.platform,
      },
    };
  }

  async function checkUpdates({ workspaceRoot, workspaceRoots } = {}) {
    const [rawIndex, denylist, resolvedRoots] = await Promise.all([
      catalog.getIndex({ force: true }),
      catalog.getDenylist({ force: true }),
      resolveRoots(workspaceRoots),
    ]);
    const index = filterSelfFromCatalogIndex(rawIndex);
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
    const index = filterSelfFromCatalogIndex(await catalog.getIndex({ force: false }));
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

    const matchingInstalls = installed.filter(
      (inst) => (inst.id || "").toLowerCase() === pluginEntry.id.toLowerCase()
    );
    let oldestInstalledVersion = null;
    for (const inst of matchingInstalls) {
      if (parseSemver(inst.version) === null) continue;
      if (!oldestInstalledVersion || compareSemver(inst.version, oldestInstalledVersion) < 0) {
        oldestInstalledVersion = inst.version;
      }
    }

    const [preflight, sinceNotes] = await Promise.all([
      runPreflightChecks(detail),
      fetchReleaseNotesSince({
        pluginEntry,
        detail,
        installedVersion: oldestInstalledVersion,
        store,
      }),
    ]);

    const enrichedDetail = sinceNotes
      ? {
          ...detail,
          releaseNotesSinceInstalled: sinceNotes.markdown,
          releaseNotesVersions: sinceNotes.versions,
        }
      : detail;

    return {
      text: `Loaded audit detail for ${pluginEntry.id}.`,
      structuredContent: { detail: enrichedDetail, liveCollisions, preflight },
    };
  }

  async function installPlugin({ id, scope, workspaceRoot, replaceSlug, replaceEnabled = true }) {
    // Always revalidate denylist before installing so emergency revocations take effect immediately
    const [rawIndex, denylist] = await Promise.all([
      catalog.getIndex({ force: false }),
      catalog.getDenylist({ force: true }),
    ]);
    const index = filterSelfFromCatalogIndex(rawIndex);
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
      pendingStageRoot: path.join(store.dataDir, "pending-stages"),
    });

    if (record.status === "pending_restart") {
      await store.upsertPendingUpdate(record.pendingUpdate);
      spawnPendingWatcher({ dataDir: store.dataDir, watchPid: process.pid });
      return {
        text: `Staged update for ${record.pendingUpdate.id}@${record.pendingUpdate.version} (${record.pendingUpdate.scope}). Restart Antigravity App to complete installation.`,
        structuredContent: {
          pendingUpdate: record.pendingUpdate,
          pendingRestart: true,
          requiresReload: true,
        },
      };
    }

    const { migratedFrom, ...lockRecord } = record;
    if (migratedFrom) {
      await store.removeInstallRecord({
        slug: migratedFrom.slug,
        scope,
        installPath: migratedFrom.installPath,
      });
    }
    await store.upsertInstallRecord(lockRecord);
    await store.removePendingUpdate({
      finalDir: lockRecord.installPath,
      slug: lockRecord.slug,
      scope,
      id: lockRecord.id,
    });

    return {
      text: migratedFrom
        ? `Adopted ${record.id}@${record.version} into ${record.scope} scope (migrated "${migratedFrom.slug}" -> "${record.slug}").`
        : `Installed ${record.id}@${record.version} into ${record.scope} scope.`,
      structuredContent: {
        installed: lockRecord,
        migratedFrom: migratedFrom || null,
        pendingRestart: false,
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
    const removedStages = await store.removePendingUpdate({
      finalDir: expectedInstallPath,
      slug,
      scope,
    });
    for (const stageDir of removedStages) {
      await fs.rm(stageDir, { recursive: true, force: true }).catch(() => {});
    }

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

  async function applyPending() {
    const denylist = await catalog.getDenylist({ force: false }).catch(() => null);
    const result = await applyPendingUpdates({ store, denylist });
    const pendingUpdates = await store.getPendingUpdates();
    return {
      text:
        result.applied.length > 0 && result.stillLocked.length === 0
          ? `Applied ${result.applied.length} staged update(s).`
          : result.stillLocked.length > 0
            ? `${result.stillLocked.length} staged update(s) are still locked by an active plugin process. Close Antigravity App completely to finish.`
            : "No staged updates pending.",
      structuredContent: {
        applied: result.applied,
        stillLocked: result.stillLocked,
        failed: result.failed,
        pendingUpdates,
        requiresReload: result.applied.length > 0,
      },
    };
  }

  async function cancelPending({ id, scope } = {}) {
    const current = await store.getPendingUpdates();
    const targetIdLower = id ? id.toLowerCase() : null;
    let cancelledCount = 0;

    for (const entry of current) {
      if (targetIdLower && String(entry.id || "").toLowerCase() !== targetIdLower) continue;
      if (scope && entry.scope !== scope) continue;
      const removedStages = await store.removePendingUpdate({
        finalDir: entry.finalDir,
        slug: entry.slug,
        scope: entry.scope,
        id: entry.id,
      });
      for (const stageDir of removedStages) {
        await fs.rm(stageDir, { recursive: true, force: true }).catch(() => {});
      }
      cancelledCount += 1;
    }

    const pendingUpdates = await store.getPendingUpdates();
    return {
      text:
        cancelledCount > 0
          ? `Cancelled ${cancelledCount} pending plugin update(s).`
          : "No matching pending updates to cancel.",
      structuredContent: {
        cancelledCount,
        pendingUpdates,
      },
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
      case "mp_apply_pending_updates":
        return applyPending();
      case "mp_cancel_pending_updates":
        return cancelPending(args);
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
    applyPending,
    cancelPending,
    executeTool,
  };
}
