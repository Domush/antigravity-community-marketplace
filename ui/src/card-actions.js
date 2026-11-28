import {
  esc,
  getActionTooltip,
  getInstallActionMeta,
  getPendingUpdatesFor,
  state,
} from "./helpers.js";

function buildMainCardAction(
  plugin,
  { globalInst, projectInst, isInstalledAnywhere, stagedEntry, updateEntry, isBusy }
) {
  if (!isInstalledAnywhere) {
    if (plugin.isManualOnly) return null;
    return {
      label: isBusy ? "Working..." : "Install",
      action: "install",
      scope: "global",
      slug: null,
      enabled: true,
      variant: "install",
      isDanger: false,
      isDisabled: false,
      title: "Install plugin globally for all Antigravity workspaces",
    };
  }

  if (stagedEntry) {
    const { inst, meta, staged } = stagedEntry;
    const stagedVersion = staged?.version || meta?.registryVersion || plugin.version;
    return {
      label: "Pending Restart",
      action: "pending-restart",
      scope: inst.scope,
      slug: inst.slug,
      enabled: inst.enabled !== false,
      variant: "default",
      isDanger: false,
      isDisabled: true,
      title: `Update to v${stagedVersion} (${inst.scope}) is pending and will update on restart`,
    };
  }

  if (updateEntry) {
    const { inst, meta } = updateEntry;
    return {
      label: isBusy ? "Working..." : meta.label,
      action: meta.action,
      scope: inst.scope,
      slug: inst.slug,
      replaceSlug: inst.slug,
      replaceEnabled: inst.enabled !== false,
      enabled: inst.enabled !== false,
      variant: meta.isPrimary ? "primary" : "default",
      isDanger: false,
      isDisabled: false,
      title: getActionTooltip(meta, inst.scope),
    };
  }

  const primaryInst = globalInst || projectInst;
  const isEnabled = primaryInst.enabled !== false;
  return {
    label: isBusy ? "Working..." : isEnabled ? "Disable" : "Enable",
    action: "toggle",
    scope: primaryInst.scope,
    slug: primaryInst.slug,
    enabled: isEnabled,
    variant: isEnabled ? "disable" : "default",
    isDanger: false,
    isDisabled: false,
    title: isEnabled
      ? `Pause ${primaryInst.scope} plugin without deleting its files or settings`
      : `Re-enable paused ${primaryInst.scope} plugin`,
  };
}

export function buildCardActionModel(
  plugin,
  installs = [],
  isBusy = false,
  pendingUpdates = null
) {
  const pendingList = Array.isArray(pendingUpdates)
    ? pendingUpdates
    : getPendingUpdatesFor(plugin.id);
  const globalInst = installs.find((i) => i.scope === "global") || null;
  const projectInst = installs.find((i) => i.scope === "project") || null;
  const isInstalledAnywhere = installs.length > 0;

  const actionEntries = installs.map((inst) => ({
    inst,
    meta: getInstallActionMeta(inst, plugin),
    staged: pendingList.find((u) => u.scope === inst.scope) || null,
  }));
  const stagedEntry = actionEntries.find((entry) => Boolean(entry.staged)) || null;
  const updateEntry =
    actionEntries.find((entry) => !entry.staged && Boolean(entry.meta?.hasUpdate)) || null;

  const mainAction = buildMainCardAction(plugin, {
    globalInst,
    projectInst,
    isInstalledAnywhere,
    stagedEntry,
    updateEntry,
    isBusy,
  });

  const menuItems = [];
  if (isInstalledAnywhere && !globalInst && !plugin.isManualOnly) {
    menuItems.push({
      label: "Install (global)",
      action: "install",
      scope: "global",
      slug: null,
      enabled: true,
      isDanger: false,
      title: projectInst
        ? "Uninstall project-level install first before installing globally"
        : "Install plugin globally for all Antigravity workspaces",
    });
  }
  if (!globalInst && !projectInst && !plugin.isManualOnly) {
    menuItems.push({
      label: "Install (project)",
      action: "install",
      scope: "project",
      slug: null,
      enabled: true,
      isDanger: false,
      title: "Install plugin only into the active project workspace",
    });
  }

  const installedScopes = [globalInst, projectInst].filter(Boolean);
  for (const inst of installedScopes) {
    const scopeLabel = inst.scope === "global" ? "Global" : "Project";
    const isEnabled = inst.enabled !== false;
    const isPrimaryToggleSameScope =
      mainAction?.action === "toggle" && mainAction.scope === inst.scope;
    if (!isPrimaryToggleSameScope) {
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
    const entry = actionEntries.find((e) => e.inst.scope === inst.scope);
    if (entry?.meta?.isDowngrade && !entry.staged) {
      menuItems.push({
        label: entry.meta.label,
        action: entry.meta.action,
        scope: inst.scope,
        slug: inst.slug,
        replaceSlug: inst.slug,
        replaceEnabled: isEnabled,
        enabled: isEnabled,
        isDanger: true,
        title: getActionTooltip(entry.meta, inst.scope),
      });
    }
  }

  for (const inst of installedScopes) {
    const scopeLabel = inst.scope === "global" ? "Global" : "Project";
    menuItems.push({
      label: `Uninstall (${scopeLabel})`,
      action: "uninstall",
      scope: inst.scope,
      slug: inst.slug,
      enabled: inst.enabled !== false,
      isDanger: true,
      title: `Remove ${inst.scope} plugin installation from disk`,
    });
  }

  return { globalInst, projectInst, mainAction, menuItems };
}

function getSplitVariantClasses(mainAction) {
  if (mainAction.variant === "install") {
    return { containerClass: "", btnClass: "mp-btn-install" };
  }
  if (mainAction.variant === "primary") {
    return { containerClass: "", btnClass: "mp-btn-primary" };
  }
  if (mainAction.variant === "disable") {
    return { containerClass: "mp-split-btn-disable", btnClass: "mp-btn-disable" };
  }
  if (mainAction.isDanger) {
    return { containerClass: "", btnClass: "mp-btn-danger" };
  }
  return { containerClass: "", btnClass: "" };
}

function buildActionDatasetAttrs(id, item) {
  return [
    `data-action="${esc(item.action)}"`,
    `data-id="${esc(id)}"`,
    `data-scope="${esc(item.scope)}"`,
    item.slug ? `data-slug="${esc(item.slug)}"` : "",
    item.replaceSlug ? `data-replace-slug="${esc(item.replaceSlug)}"` : "",
    item.replaceSlug ? `data-replace-enabled="${item.replaceEnabled !== false}"` : "",
    `data-enabled="${item.enabled}"`,
  ]
    .filter(Boolean)
    .join(" ");
}

export function renderSplitActionButton(p, { mainAction, menuItems }, isBusy) {
  if (!mainAction) return "";
  const isMenuOpen = state.openActionMenuId === p.id && menuItems.length > 0;
  const { containerClass, btnClass } = getSplitVariantClasses(mainAction);
  const mainAttrs = buildActionDatasetAttrs(p.id, mainAction);

  const menuHtml = isMenuOpen
    ? `<div class="mp-split-menu" role="menu">
        ${menuItems
          .map((item) => {
            const itemAttrs = buildActionDatasetAttrs(p.id, item);
            return `<button type="button" role="menuitem" class="mp-split-item ${item.isDanger ? "is-danger" : ""}" ${itemAttrs} title="${esc(item.title)}" ${isBusy ? "disabled" : ""}>${esc(item.label)}</button>`;
          })
          .join("")}
      </div>`
    : "";

  const splitClasses = ["mp-split-btn", containerClass, isMenuOpen ? "is-open" : ""]
    .filter(Boolean)
    .join(" ");
  const mainBtnClasses = ["mp-btn", btnClass, "mp-split-main"].filter(Boolean).join(" ");
  const toggleBtnClasses = ["mp-btn", btnClass, "mp-split-toggle"].filter(Boolean).join(" ");

  return `
    <div class="${splitClasses}" data-split-root="${esc(p.id)}">
      <button type="button" class="${mainBtnClasses}" ${mainAttrs} title="${esc(mainAction.title)}" ${isBusy || mainAction.isDisabled ? "disabled" : ""}>
        ${esc(mainAction.label)}
      </button>${
        menuItems.length > 0
          ? `<button type="button" class="${toggleBtnClasses}" data-toggle-menu="${esc(p.id)}" aria-haspopup="menu" aria-expanded="${isMenuOpen}" aria-label="More plugin actions" title="More install, disable, and uninstall actions" ${isBusy ? "disabled" : ""}>&#9662;</button>`
          : ""
      }
      ${menuHtml}
    </div>
  `;
}
