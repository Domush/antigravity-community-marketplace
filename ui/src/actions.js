import { renderDrawer } from "./drawer.js";
import { getInstallsFor, state } from "./helpers.js";
import { populateCategoryDropdown, populateProjectSelector, render } from "./render.js";

/** Create marketplace UI action handlers bound to a server tool caller. */
export function createMarketplaceActions(callServerTool) {
  let bootstrapSeq = 0;
  let drawerSeq = 0;

  async function loadBootstrap(forceCheck = false) {
    const seq = ++bootstrapSeq;
    const refreshBtn = document.getElementById("btn-refresh");
    refreshBtn.disabled = true;
    refreshBtn.textContent = "Syncing...";
    state.errorMessage = "";

    try {
      if (forceCheck) {
        await callServerTool("mp_check_updates", { workspaceRoot: state.activeProjectRoot || undefined });
      }
      const data = await callServerTool("mp_get_bootstrap", {
        workspaceRoot: state.activeProjectRoot || undefined,
      });

      if (seq !== bootstrapSeq) return;

      state.catalog = data.index || { plugins: [] };
      state.denylist = data.denylist || { blockedRepos: [], blockedShas: [] };
      state.prefs = data.prefs || { favorites: [], hidden: [] };
      state.installed = data.installed || [];
      state.pendingUpdates = data.pendingUpdates || [];
      state.workspaceRoots = data.workspaceRoots || [];
      if (data.clientVersion) state.clientVersion = data.clientVersion;
      if (data.platform) state.platform = data.platform;

      if (!state.activeProjectRoot && state.workspaceRoots.length > 0) {
        state.activeProjectRoot = state.workspaceRoots[0];
      }

      populateCategoryDropdown();
      populateProjectSelector();
    } catch (err) {
      if (seq !== bootstrapSeq) return;
      state.errorMessage = err.message;
    } finally {
      if (seq === bootstrapSeq) {
        refreshBtn.disabled = false;
        refreshBtn.textContent = "Check Updates";
        render();
      }
    }
  }

  async function togglePref(pluginId, field) {
    const list = new Set(state.prefs[field] || []);
    const nextValue = !list.has(pluginId);
    if (nextValue) list.add(pluginId);
    else list.delete(pluginId);
    state.prefs[field] = [...list];
    render();

    try {
      await callServerTool("mp_update_prefs", { id: pluginId, field, value: nextValue });
    } catch (err) {
      state.errorMessage = `Failed to save preference: ${err.message}`;
      await loadBootstrap(false);
    }
  }

  async function openDrawer(pluginId, { subTab = "overview", pendingAction = null } = {}) {
    const seq = ++drawerSeq;
    state.drawer = {
      open: true,
      pluginId,
      subTab,
      pendingAction,
      loading: true,
      detail: null,
      error: null,
      actionError: null,
    };

    document.getElementById("drawer-backdrop").hidden = false;
    const drawerEl = document.getElementById("audit-drawer");
    drawerEl.classList.add("is-open");
    drawerEl.setAttribute("aria-hidden", "false");
    renderDrawer();

    try {
      const res = await callServerTool("mp_get_plugin_detail", {
        id: pluginId,
        workspaceRoot: state.activeProjectRoot || undefined,
      });
      if (seq !== drawerSeq || !state.drawer.open) return;
      state.drawer.detail = res;
    } catch (err) {
      if (seq !== drawerSeq || !state.drawer.open) return;
      state.drawer.error = err?.message || String(err);
    } finally {
      if (seq === drawerSeq && state.drawer.open) {
        state.drawer.loading = false;
        renderDrawer();
      }
    }
  }

  function closeDrawer() {
    drawerSeq++;
    state.drawer.open = false;
    state.drawer.loading = false;
    document.getElementById("drawer-backdrop").hidden = true;
    const drawerEl = document.getElementById("audit-drawer");
    drawerEl.classList.remove("is-open");
    drawerEl.setAttribute("aria-hidden", "true");
  }

  async function executeInstall(pluginId, scope, { replaceSlug = null, replaceEnabled = true } = {}) {
    if (scope === "project" && !state.activeProjectRoot) {
      const msg = "Select or enter an active project path before installing to Project scope.";
      state.errorMessage = msg;
      if (state.drawer.open && state.drawer.pluginId === pluginId) {
        state.drawer.actionError = msg;
        renderDrawer();
      }
      render();
      return;
    }

    if (
      scope === "global" &&
      !replaceSlug &&
      getInstallsFor(pluginId).some((i) => i.scope === "project")
    ) {
      const msg =
        "This plugin is already installed in your project. Uninstall the project-level install first to prevent double-install issues.";
      state.errorMessage = msg;
      if (state.drawer.open && state.drawer.pluginId === pluginId) {
        state.drawer.actionError = msg;
        renderDrawer();
      }
      render();
      return;
    }

    state.busyIds.add(pluginId);
    state.errorMessage = "";
    if (state.drawer.open && state.drawer.pluginId === pluginId) {
      state.drawer.actionError = null;
    }
    render();
    if (state.drawer.open) renderDrawer();

    try {
      const res = await callServerTool("mp_install_plugin", {
        id: pluginId,
        scope,
        workspaceRoot: scope === "project" ? state.activeProjectRoot : undefined,
        ...(replaceSlug ? { replaceSlug, replaceEnabled } : {}),
      });
      if (res.pendingRestart && res.pendingUpdate) {
        state.requiresReload = true;
        const nextId = String(res.pendingUpdate.id || "").toLowerCase();
        const filtered = (state.pendingUpdates || []).filter(
          (u) =>
            !(
              u.scope === res.pendingUpdate.scope &&
              ((nextId && String(u.id || "").toLowerCase() === nextId) ||
                u.slug === res.pendingUpdate.slug)
            )
        );
        state.pendingUpdates = [...filtered, res.pendingUpdate];
      } else if (res.requiresReload) {
        state.requiresReload = true;
      }
      state.drawer.pendingAction = null;
      if (state.drawer.open && state.drawer.pluginId === pluginId) {
        closeDrawer();
      }
      await loadBootstrap(false);
    } catch (err) {
      state.errorMessage = `Install failed for ${pluginId}: ${err.message}`;
      if (state.drawer.open && state.drawer.pluginId === pluginId) {
        state.drawer.actionError = err.message;
      }
    } finally {
      state.busyIds.delete(pluginId);
      render();
      if (state.drawer.open) renderDrawer();
    }
  }

  async function executeUninstall(inst) {
    const key = inst.id || inst.slug;
    state.busyIds.add(key);
    state.errorMessage = "";
    if (state.drawer.open && state.drawer.pluginId === key) {
      state.drawer.actionError = null;
    }
    render();
    if (state.drawer.open) renderDrawer();

    try {
      await callServerTool("mp_uninstall_plugin", {
        slug: inst.slug,
        id: inst.id,
        scope: inst.scope,
        enabled: inst.enabled !== false,
        workspaceRoot: inst.scope === "project" ? state.activeProjectRoot : undefined,
      });
      state.requiresReload = true;
      await loadBootstrap(false);
      if (state.drawer.open) renderDrawer();
    } catch (err) {
      state.errorMessage = `Uninstall failed for ${key}: ${err.message}`;
      if (state.drawer.open && state.drawer.pluginId === key) {
        state.drawer.actionError = err.message;
      }
    } finally {
      state.busyIds.delete(key);
      render();
      if (state.drawer.open) renderDrawer();
    }
  }

  async function executeToggleEnabled(inst) {
    const key = inst.id || inst.slug;
    const nextEnabled = inst.enabled === false;
    state.busyIds.add(key);
    state.errorMessage = "";
    render();

    try {
      await callServerTool("mp_toggle_plugin", {
        slug: inst.slug,
        scope: inst.scope,
        enabled: nextEnabled,
        workspaceRoot: inst.scope === "project" ? state.activeProjectRoot : undefined,
      });
      state.requiresReload = true;
      await loadBootstrap(false);
    } catch (err) {
      state.errorMessage = `Could not ${nextEnabled ? "enable" : "disable"} ${key}: ${err.message}`;
    } finally {
      state.busyIds.delete(key);
      render();
    }
  }

  return {
    loadBootstrap,
    togglePref,
    executeInstall,
    executeUninstall,
    executeToggleEnabled,
    openDrawer,
    closeDrawer,
  };
}
