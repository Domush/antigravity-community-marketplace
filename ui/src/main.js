import { createHostBridge } from "./bridge.js";
import { renderDrawer } from "./drawer.js";
import { state } from "./helpers.js";
import { populateCategoryDropdown, populateProjectSelector, render } from "./render.js";

// ---------------------------------------------------------------------------
// Dual-Mode Host Bridge (Antigravity Sidecar / HTTP vs MCP App)
// ---------------------------------------------------------------------------
const bridge = createHostBridge({
  clientVersion: state.clientVersion,
  onToolResult(result) {
    const sc = result?.structuredContent;
    if (!sc) return;
    if (typeof sc.initialQuery === "string" && sc.initialQuery.trim()) {
      state.query = sc.initialQuery.trim();
      document.getElementById("search-input").value = state.query;
    }
    if (["browse", "installed", "updates", "favorites"].includes(sc.tab)) {
      state.tab = sc.tab;
    }
    render();
  },
  onWorkspaceChange() {
    const prevRoots = [...state.workspaceRoots];
    if (!state.activeProjectRoot || prevRoots.includes(state.activeProjectRoot)) {
      state.activeProjectRoot = "";
    }
    void loadBootstrap(false);
  },
});

function callServerTool(name, args = {}) {
  return bridge.callTool(name, args);
}

function openExternal(url) {
  bridge.openExternal(url);
}

// ---------------------------------------------------------------------------
// Data Loading & Actions
// ---------------------------------------------------------------------------
let bootstrapSeq = 0;

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

async function executeInstall(pluginId, scope, { replaceSlug = null, replaceEnabled = true } = {}) {
  if (scope === "project" && !state.activeProjectRoot) {
    state.errorMessage = "Select or enter an active project path before installing to Project scope.";
    render();
    return;
  }

  state.busyIds.add(pluginId);
  state.errorMessage = "";
  render();
  if (state.drawer.open) renderDrawer();

  try {
    const res = await callServerTool("mp_install_plugin", {
      id: pluginId,
      scope,
      workspaceRoot: scope === "project" ? state.activeProjectRoot : undefined,
      ...(replaceSlug ? { replaceSlug, replaceEnabled } : {}),
    });
    if (res.requiresReload) state.requiresReload = true;
    state.drawer.pendingAction = null;
    await loadBootstrap(false);
    if (state.drawer.open && state.drawer.pluginId === pluginId) {
      await openDrawer(pluginId, { subTab: state.drawer.subTab });
    }
  } catch (err) {
    state.errorMessage = `Install failed for ${pluginId}: ${err.message}`;
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
  render();

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
  } finally {
    state.busyIds.delete(key);
    render();
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

async function openDrawer(pluginId, { subTab = "audit", pendingAction = null } = {}) {
  state.drawer = {
    open: true,
    pluginId,
    subTab,
    pendingAction,
    loading: true,
    detail: null,
    error: null,
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
    state.drawer.detail = res;
  } catch (err) {
    state.drawer.error = err.message;
  } finally {
    state.drawer.loading = false;
    renderDrawer();
  }
}

function closeDrawer() {
  state.drawer.open = false;
  document.getElementById("drawer-backdrop").hidden = true;
  const drawerEl = document.getElementById("audit-drawer");
  drawerEl.classList.remove("is-open");
  drawerEl.setAttribute("aria-hidden", "true");
}

// ---------------------------------------------------------------------------
// Event Wiring
// ---------------------------------------------------------------------------
function bindEvents() {
  document.getElementById("search-input").addEventListener("input", (e) => {
    state.query = e.target.value;
    render();
  });

  document.getElementById("filter-category").addEventListener("change", (e) => {
    state.category = e.target.value;
    render();
  });

  document.getElementById("filter-surface").addEventListener("change", (e) => {
    state.surface = e.target.value;
    render();
  });

  document.getElementById("filter-risk").addEventListener("change", (e) => {
    state.maxRisk = e.target.value;
    render();
  });

  document.getElementById("sort-select").addEventListener("change", (e) => {
    state.sort = e.target.value;
    render();
  });

  document.getElementById("chk-no-creds").addEventListener("change", (e) => {
    state.noCredsOnly = e.target.checked;
    render();
  });

  document.getElementById("chk-show-hidden").addEventListener("change", (e) => {
    state.showHidden = e.target.checked;
    render();
  });

  document.getElementById("btn-toggle-filters").addEventListener("click", () => {
    state.filtersOpen = !state.filtersOpen;
    render();
  });

  document.getElementById("btn-clear-filters").addEventListener("click", () => {
    state.category = "all";
    state.surface = "all";
    state.maxRisk = "all";
    state.sort = "stars";
    state.noCredsOnly = false;
    document.getElementById("filter-category").value = "all";
    document.getElementById("filter-surface").value = "all";
    document.getElementById("filter-risk").value = "all";
    document.getElementById("sort-select").value = "stars";
    document.getElementById("chk-no-creds").checked = false;
    render();
  });

  // Hide failed plugin/avatar images via capture listener so the monogram fallback shows cleanly
  document.addEventListener(
    "error",
    (e) => {
      const target = e.target;
      if (target instanceof HTMLImageElement && target.classList.contains("mp-plugin-icon-img")) {
        target.remove();
      }
    },
    true
  );

  document.getElementById("project-select").addEventListener("change", (e) => {
    state.activeProjectRoot = e.target.value;
    loadBootstrap(false);
  });

  const projectPill = document.getElementById("project-pill");
  const projectEditor = document.getElementById("custom-project-editor");
  const projectInput = document.getElementById("custom-project-input");

  function openProjectEditor() {
    projectPill.hidden = true;
    projectEditor.hidden = false;
    projectInput.value = state.activeProjectRoot || "";
    projectInput.focus();
    projectInput.select();
  }

  function closeProjectEditor() {
    projectEditor.hidden = true;
    projectPill.hidden = false;
  }

  function applyCustomProject() {
    const next = projectInput.value.trim();
    closeProjectEditor();
    if (next) {
      state.activeProjectRoot = next;
      populateProjectSelector();
      loadBootstrap(false);
    }
  }

  document.getElementById("btn-custom-project").addEventListener("click", openProjectEditor);
  document.getElementById("btn-save-project").addEventListener("click", applyCustomProject);
  document.getElementById("btn-cancel-project").addEventListener("click", closeProjectEditor);
  projectInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      applyCustomProject();
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeProjectEditor();
    }
  });

  document.getElementById("btn-refresh").addEventListener("click", () => loadBootstrap(true));

  for (const tabBtn of document.querySelectorAll(".mp-tabs .mp-tab")) {
    tabBtn.addEventListener("click", () => {
      state.tab = tabBtn.dataset.tab;
      render();
    });
  }

  // Delegated clicks for alerts & plugin grid
  document.getElementById("alerts").addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    if (btn.hasAttribute("data-dismiss-reload")) {
      state.requiresReload = false;
      render();
    } else if (btn.hasAttribute("data-dismiss-self-update")) {
      state.dismissedSelfUpdate = true;
      render();
    } else if (btn.dataset.openUrl) {
      openExternal(btn.dataset.openUrl);
    } else if (btn.hasAttribute("data-dismiss-error")) {
      state.errorMessage = "";
      render();
    } else if (btn.dataset.revokeUninstall) {
      const inst = state.installed.find(
        (i) => i.slug === btn.dataset.revokeUninstall && i.scope === btn.dataset.scope
      );
      if (inst) executeUninstall(inst);
    }
  });

  document.getElementById("plugin-grid").addEventListener("click", (e) => {
    const el = e.target.closest("[data-open-drawer], [data-toggle-desc], [data-pref], [data-action]");
    if (!el) return;

    if (el.dataset.toggleDesc) {
      const id = el.dataset.toggleDesc;
      if (state.expandedIds.has(id)) state.expandedIds.delete(id);
      else state.expandedIds.add(id);
      render();
      return;
    }

    if (el.dataset.openDrawer) {
      const subTab = el.dataset.drawerTab === "overview" ? "overview" : "audit";
      openDrawer(el.dataset.openDrawer, { subTab });
      return;
    }

    if (el.dataset.pref) {
      togglePref(el.dataset.id, el.dataset.pref);
      return;
    }

    const action = el.dataset.action;
    const id = el.dataset.id;
    const scope = el.dataset.scope;
    const plugin = (state.catalog.plugins || []).find((p) => p.id === id);

    if (action === "review-update" || action === "review-adopt") {
      // Always force Permission-Diff & Migration review before updating or adopting
      openDrawer(id, {
        subTab: "audit",
        pendingAction: {
          type: action === "review-adopt" ? "adopt" : "update",
          scope,
          replaceSlug: el.dataset.replaceSlug || null,
          replaceEnabled: el.dataset.replaceEnabled !== "false",
        },
      });
    } else if (action === "install") {
      // Force audit review for elevated/high risk or credential-requiring plugins
      const needsReview =
        plugin && (plugin.security?.riskTier !== "low" || plugin.requiresCredentials);
      if (needsReview) {
        openDrawer(id, { subTab: "audit", pendingAction: { type: "install", scope } });
      } else {
        executeInstall(id, scope);
      }
    } else if (action === "toggle") {
      executeToggleEnabled({ id, slug: el.dataset.slug, scope, enabled: el.dataset.enabled === "true" });
    } else if (action === "uninstall") {
      executeUninstall({ id, slug: el.dataset.slug, scope, enabled: el.dataset.enabled === "true" });
    }
  });

  // Delegated clicks for audit drawer
  document.getElementById("drawer-backdrop").addEventListener("click", closeDrawer);
  document.getElementById("audit-drawer").addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    if (btn.hasAttribute("data-close-drawer")) {
      closeDrawer();
    } else if (btn.dataset.drawerTab) {
      state.drawer.subTab = btn.dataset.drawerTab;
      renderDrawer();
    } else if (btn.dataset.openUrl) {
      openExternal(btn.dataset.openUrl);
    } else if (btn.dataset.confirmInstall) {
      executeInstall(btn.dataset.confirmInstall, btn.dataset.scope, {
        replaceSlug: btn.dataset.replaceSlug || null,
        replaceEnabled: btn.dataset.replaceEnabled !== "false",
      });
    }
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.drawer.open) closeDrawer();
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  bindEvents();
  await bridge.connect();
  await loadBootstrap(false);
}

boot().catch((err) => {
  state.errorMessage = `Failed to connect to marketplace backend: ${err.message}`;
  render();
});
