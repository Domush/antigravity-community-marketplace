import {
  capDescription,
  capLabel,
  classifyInstallStatus,
  esc,
  getActiveFilterCount,
  getFilteredPlugins,
  getInstallActionMeta,
  getInstallsFor,
  getRevokedInstalls,
  getSelfUpdateInfo,
  hasUpdateAvailable,
  renderPluginIcon,
  riskDescription,
  state,
} from "./helpers.js";

// ---------------------------------------------------------------------------
// Header Controls, Alerts, and Cards
// ---------------------------------------------------------------------------
export function populateCategoryDropdown() {
  const select = document.getElementById("filter-category");
  const categories = new Set();
  for (const p of state.catalog.plugins || []) {
    for (const c of p.categories || []) categories.add(c);
  }
  const prev = state.category;
  select.innerHTML = `<option value="all">All Categories</option>` +
    [...categories]
      .sort()
      .map((c) => `<option value="${esc(c)}">${esc(c)}</option>`)
      .join("");
  select.value = categories.has(prev) ? prev : "all";
  state.category = select.value;
}

export function populateProjectSelector() {
  const select = document.getElementById("project-select");
  const roots = [...new Set([...state.workspaceRoots, state.activeProjectRoot].filter(Boolean))];
  if (roots.length === 0) {
    select.innerHTML = `<option value="">None selected</option>`;
    return;
  }
  select.innerHTML = roots
    .map((r) => {
      const label = r.split(/[\\/]/).filter(Boolean).slice(-2).join("/") || r;
      return `<option value="${esc(r)}" title="${esc(r)}">${esc(label)}</option>`;
    })
    .join("");
  select.value = state.activeProjectRoot;
}

export function renderAlerts() {
  const el = document.getElementById("alerts");
  const parts = [];

  for (const { install, rule } of getRevokedInstalls()) {
    parts.push(`
      <div class="mp-alert mp-alert-danger">
        <div>
          <strong>Security Alert:</strong> Installed plugin <code>${esc(install.id)}</code> (${esc(install.scope)})
          was revoked by the registry denylist: ${esc(rule.reason)}
        </div>
        <div class="mp-alert-actions">
          <button type="button" class="mp-btn mp-btn-danger" data-revoke-uninstall="${esc(install.slug)}" data-scope="${esc(install.scope)}">
            Uninstall Now
          </button>
        </div>
      </div>
    `);
  }

  const selfUpdate = getSelfUpdateInfo();
  if (selfUpdate && (!state.dismissedSelfUpdate || selfUpdate.unsupported)) {
    parts.push(`
      <div class="mp-alert ${selfUpdate.unsupported ? "mp-alert-danger" : "mp-alert-info"}">
        <div>
          <strong>Marketplace Update Available (v${esc(state.clientVersion)} &rarr; v${esc(selfUpdate.latestVersion)}):</strong>
          ${esc(selfUpdate.notes || "A newer version of Community Plugin Marketplace is available.")}
        </div>
        <div class="mp-alert-actions">
          <button type="button" class="mp-btn mp-btn-primary" data-open-url="${esc(selfUpdate.releaseUrl)}">
            Get Update &nearr;
          </button>
          ${
            selfUpdate.unsupported
              ? ""
              : `<button type="button" class="mp-btn" data-dismiss-self-update>Dismiss</button>`
          }
        </div>
      </div>
    `);
  }

  if (state.requiresReload) {
    parts.push(`
      <div class="mp-alert mp-alert-warning">
        <div>
          Plugin files updated on disk. Reload Antigravity App to activate added or removed MCP servers and hooks.
        </div>
        <button type="button" class="mp-btn" data-dismiss-reload>Dismiss</button>
      </div>
    `);
  }

  if (state.errorMessage) {
    parts.push(`
      <div class="mp-alert mp-alert-danger">
        <div>${esc(state.errorMessage)}</div>
        <button type="button" class="mp-btn" data-dismiss-error>Dismiss</button>
      </div>
    `);
  }

  el.innerHTML = parts.join("");
}

function scopeBadge(inst, label, plugin) {
  if (!inst) return "";
  const status = classifyInstallStatus(inst, plugin);
  const badges = [];
  if (inst.enabled === false) {
    badges.push(
      `<span class="mp-badge mp-badge-disabled" title="Plugin is paused in ${label} scope (files preserved in plugins-disabled)">Disabled: ${label}</span>`
    );
  } else if (inst.matchTier === "exact_hash") {
    badges.push(
      `<span class="mp-badge mp-badge-scope" title="Verified ${label} install matching an exact signed registry tree hash">Installed: ${label} (Auto-Matched)</span>`
    );
  } else if (inst.matchTier === "repo_origin") {
    badges.push(
      `<span class="mp-badge mp-risk-elevated" title="Manually installed in ${label} scope and linked via GitHub repository origin">Manual Origin: ${label}</span>`
    );
  } else {
    badges.push(
      `<span class="mp-badge mp-badge-scope" title="Managed ${label} installation tracked by the marketplace">Installed: ${label}</span>`
    );
  }
  if (status.isAhead) {
    badges.push(
      `<span class="mp-badge mp-badge-ahead" title="Installed local version v${esc(status.installedVersion)} is newer than registry v${esc(status.registryVersion)}">Local v${esc(status.installedVersion)} Ahead</span>`
    );
  }
  return badges.join("");
}

function getActionTooltip(meta, scope) {
  if (meta.isDowngrade) {
    return `Review permission diff and downgrade ${scope} install to registry v${meta.registryVersion}`;
  }
  if (meta.action === "review-adopt") {
    return `Review permissions and adopt this manual ${scope} install into verified marketplace tracking`;
  }
  return `Review permission diff and update ${scope} install to v${meta.registryVersion}`;
}

function eyeIconSvg(isHidden) {
  if (isHidden) {
    return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 20C5 20 1 12 1 12a21.77 21.77 0 0 1 5.06-6.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a21.8 21.8 0 0 1-2.16 3.19"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;
  }
  return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
}

function starIconSvg(isFav) {
  if (isFav) {
    return `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;
  }
  return `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;
}

export function buildCardActionModel(plugin, installs = [], isBusy = false) {
  const globalInst = installs.find((i) => i.scope === "global") || null;
  const projectInst = installs.find((i) => i.scope === "project") || null;
  const isInstalledAnywhere = installs.length > 0;

  let mainAction = null;
  if (isInstalledAnywhere) {
    const primaryInst = globalInst || projectInst;
    mainAction = {
      label: isBusy ? "Working..." : "Uninstall",
      action: "uninstall",
      scope: primaryInst.scope,
      slug: primaryInst.slug,
      enabled: primaryInst.enabled !== false,
      isDanger: true,
      title: `Remove ${primaryInst.scope} plugin installation from disk`,
    };
  } else if (!plugin.isManualOnly) {
    mainAction = {
      label: isBusy ? "Working..." : "Install",
      action: "install",
      scope: "global",
      slug: null,
      enabled: true,
      isDanger: false,
      title: "Install plugin globally for all Antigravity workspaces",
    };
  }

  const menuItems = [];
  if (isInstalledAnywhere && !globalInst && !plugin.isManualOnly) {
    menuItems.push({
      label: "Install (Global)",
      action: "install",
      scope: "global",
      slug: null,
      enabled: true,
      isDanger: false,
      title: "Install plugin globally for all Antigravity workspaces",
    });
  }
  if (!plugin.isManualOnly) {
    menuItems.push({
      label: "Install in Project",
      action: "install",
      scope: "project",
      slug: null,
      enabled: true,
      isDanger: false,
      title: projectInst
        ? "Reinstall plugin in the active project workspace"
        : "Install plugin only into the active project workspace",
    });
  }
  for (const inst of [globalInst, projectInst].filter(Boolean)) {
    const scopeLabel = inst.scope === "global" ? "Global" : "Project";
    const isEnabled = inst.enabled !== false;
    menuItems.push({
      label: `${isEnabled ? "Disable" : "Enable"} (${scopeLabel})`,
      action: "toggle",
      scope: inst.scope,
      slug: inst.slug,
      enabled: isEnabled,
      isDanger: false,
      title: isEnabled
        ? `Pause ${inst.scope} plugin without deleting its files or settings`
        : `Re-enable paused ${inst.scope} plugin`,
    });
  }
  if (projectInst) {
    menuItems.push({
      label: "Uninstall from Project",
      action: "uninstall",
      scope: "project",
      slug: projectInst.slug,
      enabled: projectInst.enabled !== false,
      isDanger: true,
      title: "Remove project plugin installation from disk",
    });
  }

  return { globalInst, projectInst, mainAction, menuItems };
}

function renderSplitActionButton(p, { mainAction, menuItems }, isBusy) {
  if (!mainAction) return "";
  const isMenuOpen = state.openActionMenuId === p.id && menuItems.length > 0;
  const variantClass = mainAction.isDanger
    ? "mp-btn-danger"
    : mainAction.action === "install"
      ? "mp-btn-install"
      : "";
  const mainAttrs = [
    `data-action="${esc(mainAction.action)}"`,
    `data-id="${esc(p.id)}"`,
    `data-scope="${esc(mainAction.scope)}"`,
    mainAction.slug ? `data-slug="${esc(mainAction.slug)}"` : "",
    `data-enabled="${mainAction.enabled}"`,
  ]
    .filter(Boolean)
    .join(" ");

  const menuHtml = isMenuOpen
    ? `<div class="mp-split-menu" role="menu">
        ${menuItems
          .map((item) => {
            const itemAttrs = [
              `data-action="${esc(item.action)}"`,
              `data-id="${esc(p.id)}"`,
              `data-scope="${esc(item.scope)}"`,
              item.slug ? `data-slug="${esc(item.slug)}"` : "",
              `data-enabled="${item.enabled}"`,
            ]
              .filter(Boolean)
              .join(" ");
            return `<button type="button" role="menuitem" class="mp-split-item ${item.isDanger ? "is-danger" : ""}" ${itemAttrs} title="${esc(item.title)}" ${isBusy ? "disabled" : ""}>${esc(item.label)}</button>`;
          })
          .join("")}
      </div>`
    : "";

  return `
    <div class="mp-split-btn ${isMenuOpen ? "is-open" : ""}" data-split-root="${esc(p.id)}">
      <button type="button" class="mp-btn ${variantClass} mp-split-main" ${mainAttrs} title="${esc(mainAction.title)}" ${isBusy ? "disabled" : ""}>
        ${esc(mainAction.label)}
      </button>${
        menuItems.length > 0
          ? `<button type="button" class="mp-btn ${variantClass} mp-split-toggle" data-toggle-menu="${esc(p.id)}" aria-haspopup="menu" aria-expanded="${isMenuOpen}" aria-label="More plugin actions" title="More install, disable, and uninstall actions" ${isBusy ? "disabled" : ""}>&#9662;</button>`
          : ""
      }
      ${menuHtml}
    </div>
  `;
}

export function renderCard(p) {
  const favSet = new Set(state.prefs.favorites || []);
  const hiddenSet = new Set(state.prefs.hidden || []);
  const isFav = favSet.has(p.id);
  const isHidden = hiddenSet.has(p.id);

  const installs = getInstallsFor(p.id);
  const { globalInst, projectInst, mainAction, menuItems } = buildCardActionModel(
    p,
    installs,
    state.busyIds.has(p.id)
  );
  const actionEntries = installs
    .map((inst) => ({ inst, meta: getInstallActionMeta(inst, p) }))
    .filter((entry) => Boolean(entry.meta));
  const primaryAction =
    actionEntries.find((entry) => entry.meta.hasUpdate) || actionEntries[0] || null;
  const isBusy = state.busyIds.has(p.id);

  const riskTier = p.security?.riskTier || "unverified";
  const topCaps = (p.security?.capabilities || []).slice(0, 3);
  const summaryText = p.summary || "No description provided.";
  const isExpanded = state.expandedIds.has(p.id);
  const showDescToggle = summaryText.length > 95;

  const actionButtons = [];
  if (primaryAction) {
    const { inst, meta } = primaryAction;
    actionButtons.push(`
      <button
        type="button"
        class="${esc(meta.buttonClass)}"
        data-action="${esc(meta.action)}"
        data-id="${esc(p.id)}"
        data-scope="${esc(inst.scope)}"
        data-replace-slug="${esc(inst.slug)}"
        data-replace-enabled="${inst.enabled !== false}"
        title="${esc(getActionTooltip(meta, inst.scope))}"
        ${isBusy ? "disabled" : ""}
      >
        ${esc(meta.label)}
      </button>
    `);
  }

  const splitButtonHtml = renderSplitActionButton(p, { mainAction, menuItems }, isBusy);
  if (splitButtonHtml) {
    actionButtons.push(splitButtonHtml);
  }

  // Tier 3 opt-in suggestion banner on unlinked manual plugin cards
  const primaryManual = p.isManualOnly ? installs[0] : null;
  const suggestionBanner =
    p.isManualOnly && primaryManual && (p.suggestedMatches || []).length > 0
      ? `
        <div class="mp-panel" style="padding:8px">
          <div style="font-size:11px;font-weight:600">Possible registry match (verify author before adopting):</div>
          ${p.suggestedMatches
            .map(
              (m) => `
                <div class="mp-finding-head" style="font-size:11px">
                  <span><code>${esc(m.id)}</code> &middot; v${esc(m.version)} &middot; &#9733; ${esc(m.stars)}</span>
                  <button type="button" class="mp-btn" data-action="review-adopt" data-id="${esc(m.id)}" data-scope="${esc(primaryManual.scope)}" data-replace-slug="${esc(primaryManual.slug)}" data-replace-enabled="${primaryManual.enabled !== false}" title="Inspect and adopt ${esc(m.id)} from the verified registry">
                    Review &amp; Adopt
                  </button>
                </div>
              `
            )
            .join("")}
        </div>
      `
      : "";

  const titleHtml = p.isManualOnly
    ? `<div class="mp-card-ident">
          ${renderPluginIcon(p)}
          <div class="mp-card-title">
            <span class="mp-card-name">${esc(p.name)}</span>
            <span class="mp-card-sub">
              ${esc(p.author?.login || "unknown")} &middot; v${esc(p.version)} &middot; &#9733; ${esc(p.stats?.stars ?? 0)}
            </span>
          </div>
        </div>`
    : `<div class="mp-card-ident">
          ${renderPluginIcon(p)}
          <button type="button" class="mp-card-title-btn" data-open-drawer="${esc(p.id)}" data-drawer-tab="overview" title="Open README, release notes, and repository details">
            <span class="mp-card-name">${esc(p.name)}</span>
            <span class="mp-card-sub">
              ${esc(p.author?.login || "unknown")} &middot; v${esc(p.version)} &middot; &#9733; ${esc(p.stats?.stars ?? 0)}
            </span>
          </button>
        </div>`;

  return `
    <article class="mp-card ${isHidden ? "is-hidden-item" : ""}">
      <div class="mp-card-head">
        ${titleHtml}
        <div class="mp-card-quick">
          <button type="button" class="mp-icon-btn mp-eye-btn ${isHidden ? "is-active" : ""}" data-pref="hidden" data-id="${esc(p.id)}" aria-label="${isHidden ? "Unhide plugin in catalog" : "Hide plugin from default view"}" title="${isHidden ? "Unhide plugin in catalog" : "Hide plugin from default view"}">
            ${eyeIconSvg(isHidden)}
          </button>
          <button type="button" class="mp-icon-btn mp-fav-btn ${isFav ? "is-active" : ""}" data-pref="favorites" data-id="${esc(p.id)}" aria-label="${isFav ? "Remove from Favorites" : "Add to Favorites"}" title="${isFav ? "Remove from Favorites" : "Add to Favorites"}">
            ${starIconSvg(isFav)}
          </button>
        </div>
      </div>

      <div class="mp-desc-wrap">
        <p class="mp-summary mp-card-desc ${isExpanded ? "is-expanded" : ""}" title="${esc(summaryText)}">${esc(summaryText)}</p>
        ${
          showDescToggle
            ? `<button type="button" class="mp-desc-toggle" data-toggle-desc="${esc(p.id)}" aria-expanded="${isExpanded}" title="${isExpanded ? "Collapse description" : "Expand full description"}">${isExpanded ? "Show less" : "Read more"}</button>`
            : ""
        }
      </div>

      <div class="mp-pill-row">
        <span class="mp-badge mp-risk-${esc(riskTier)}" title="${esc(riskDescription(riskTier))}">Risk: ${esc(riskTier)}</span>
        ${p.surface?.hasSidebarUi ? `<span class="mp-badge" title="Includes an interactive MCP App sidebar panel inside Antigravity">Sidebar UI</span>` : ""}
        ${p.requiresCredentials ? `<span class="mp-badge mp-risk-elevated" title="Requires external API keys or OAuth login credentials">API Key / OAuth</span>` : ""}
        ${scopeBadge(globalInst, "Global", p)}
        ${scopeBadge(projectInst, "Project", p)}
        ${topCaps.map((c) => `<span class="mp-badge" title="${esc(capDescription(c))}">${esc(capLabel(c))}</span>`).join("")}
      </div>
      ${suggestionBanner}

      <div class="mp-card-footer">
        <div class="mp-btn-group">${actionButtons.join("")}</div>
        ${
          !p.isManualOnly
            ? `<div class="mp-btn-group mp-drawer-actions">
                <button type="button" class="mp-btn mp-btn-details" data-open-drawer="${esc(p.id)}" data-drawer-tab="overview" title="View README, security audit, release notes, and repository links">Details</button>
              </div>`
            : ""
        }
      </div>
    </article>
  `;
}

export function updateFilterControls() {
  const activeCount = getActiveFilterCount();
  const hasNonDefaultSort = state.sort !== "stars";
  const toggleBtn = document.getElementById("btn-toggle-filters");
  const clearBtn = document.getElementById("btn-clear-filters");
  const drawerEl = document.getElementById("filter-drawer");

  if (toggleBtn) {
    toggleBtn.textContent = activeCount > 0 ? `Filters (${activeCount})` : "Filters";
    toggleBtn.setAttribute("aria-expanded", String(state.filtersOpen));
    toggleBtn.classList.toggle("is-active", state.filtersOpen || activeCount > 0);
    toggleBtn.title = activeCount > 0
      ? `Show or hide filters (${activeCount} active)`
      : "Show or hide category, surface, risk, and sort filters";
  }
  if (clearBtn) {
    clearBtn.hidden = activeCount === 0 && !hasNonDefaultSort;
  }
  if (drawerEl) {
    drawerEl.hidden = !state.filtersOpen;
  }
}

export function render() {
  renderAlerts();
  updateFilterControls();

  const plugins = state.catalog.plugins || [];
  const updateCount = plugins.filter(hasUpdateAvailable).length;
  const installedCount = state.installed.length;
  const favCount = (state.prefs.favorites || []).length;

  document.getElementById("count-browse").textContent = String(plugins.length);
  document.getElementById("count-installed").textContent = String(installedCount);
  document.getElementById("count-updates").textContent = String(updateCount);
  document.getElementById("count-favorites").textContent = String(favCount);
  document.getElementById("catalog-meta").textContent = state.catalog.generatedAt
    ? `${plugins.length} verified plugins`
    : "Connecting...";

  for (const btn of document.querySelectorAll(".mp-tab")) {
    const active = btn.dataset.tab === state.tab;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-selected", String(active));
  }

  const filtered = getFilteredPlugins();
  const grid = document.getElementById("plugin-grid");
  if (filtered.length === 0) {
    grid.innerHTML = `<div class="mp-empty">No plugins match the current filters.</div>`;
  } else {
    grid.innerHTML = filtered.map(renderCard).join("");
  }
}
