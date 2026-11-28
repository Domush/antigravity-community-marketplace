import { createMarketplaceActions } from "./actions.js";
import { createHostBridge } from "./bridge.js";
import { renderDrawer } from "./drawer.js";
import { getInstallsFor, state } from "./helpers.js";
import { populateProjectSelector, render } from "./render.js";

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

const {
  loadBootstrap,
  togglePref,
  executeInstall,
  executeUninstall,
  executeToggleEnabled,
  openDrawer,
  closeDrawer,
} = createMarketplaceActions(callServerTool);

// ---------------------------------------------------------------------------
// Event Wiring
// ---------------------------------------------------------------------------
function bindEvents() {
  const selectBindings = [
    ["filter-category", "category", "value"],
    ["filter-surface", "surface", "value"],
    ["filter-risk", "maxRisk", "value"],
    ["sort-select", "sort", "value"],
    ["chk-no-creds", "noCredsOnly", "checked"],
    ["chk-show-hidden", "showHidden", "checked"],
  ];

  document.getElementById("search-input").addEventListener("input", (e) => {
    state.query = e.target.value;
    render();
  });

  for (const [elId, stateKey, prop] of selectBindings) {
    document.getElementById(elId).addEventListener("change", (e) => {
      state[stateKey] = e.target[prop];
      render();
    });
  }

  document.getElementById("btn-toggle-filters").addEventListener("click", () => {
    state.filtersOpen = !state.filtersOpen;
    render();
  });

  document.getElementById("btn-clear-filters").addEventListener("click", () => {
    Object.assign(state, { category: "all", surface: "all", maxRisk: "all", sort: "stars", noCredsOnly: false });
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

  function toggleProjectEditor(open) {
    projectPill.hidden = open;
    projectEditor.hidden = !open;
    if (open) {
      projectInput.value = state.activeProjectRoot || "";
      projectInput.focus();
      projectInput.select();
    }
  }

  function applyCustomProject() {
    const next = projectInput.value.trim();
    toggleProjectEditor(false);
    if (next) {
      state.activeProjectRoot = next;
      populateProjectSelector();
      loadBootstrap(false);
    }
  }

  document.getElementById("btn-custom-project").addEventListener("click", () => toggleProjectEditor(true));
  document.getElementById("btn-save-project").addEventListener("click", applyCustomProject);
  document.getElementById("btn-cancel-project").addEventListener("click", () => toggleProjectEditor(false));
  projectInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); applyCustomProject(); }
    else if (e.key === "Escape") { e.preventDefault(); toggleProjectEditor(false); }
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
    } else if (btn.hasAttribute("data-cancel-pending")) {
      btn.disabled = true;
      btn.textContent = "Cancelling...";
      callServerTool("mp_cancel_pending_updates", {})
        .then(async (res) => {
          state.pendingUpdates = res.pendingUpdates || [];
          await loadBootstrap(false);
          if (state.drawer.open) renderDrawer();
        })
        .catch((err) => { state.errorMessage = `Cancel failed: ${err.message}`; render(); });
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
    const el = e.target.closest("[data-open-drawer], [data-toggle-desc], [data-pref], [data-toggle-menu], [data-action]");
    if (!el) return;

    if (el.dataset.toggleMenu) {
      e.stopPropagation();
      const menuId = el.dataset.toggleMenu;
      state.openActionMenuId = state.openActionMenuId === menuId ? null : menuId;
      render();
      return;
    }

    if (el.dataset.toggleDesc) {
      const id = el.dataset.toggleDesc;
      if (state.expandedIds.has(id)) state.expandedIds.delete(id);
      else state.expandedIds.add(id);
      render();
      return;
    }

    if (el.dataset.openDrawer) {
      state.openActionMenuId = null;
      const subTab = el.dataset.drawerTab === "overview" ? "overview" : "audit";
      openDrawer(el.dataset.openDrawer, { subTab });
      return;
    }

    if (el.dataset.pref) {
      togglePref(el.dataset.id, el.dataset.pref);
      return;
    }

    state.openActionMenuId = null;
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
      const hasProjectConflict =
        scope === "global" && getInstallsFor(id).some((i) => i.scope === "project");
      // Force audit review for elevated/high risk, credential-requiring plugins, or project-scope conflicts
      const needsReview =
        hasProjectConflict ||
        (plugin && (plugin.security?.riskTier !== "low" || plugin.requiresCredentials));
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
    } else if (btn.dataset.drawerUninstall) {
      const inst = state.installed.find(
        (i) => i.slug === btn.dataset.drawerUninstall && i.scope === btn.dataset.scope
      );
      if (inst) executeUninstall(inst);
    }
  });

  document.addEventListener("click", (e) => {
    if (state.openActionMenuId && !e.target.closest("[data-split-root]")) {
      state.openActionMenuId = null;
      render();
    }
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (state.openActionMenuId) {
        state.openActionMenuId = null;
        render();
      } else if (state.drawer.open) {
        closeDrawer();
      }
    }
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
