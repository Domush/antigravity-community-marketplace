import {
  buildAuditBlocks,
  buildDrawerFooterHtml,
  buildOverviewHtml,
  buildProjectInstalledWarning,
  buildStagedUpdateNotice,
} from "./drawer-sections.js";
import {
  classifyInstallStatus,
  computePermissionDiff,
  esc,
  getInstallsFor,
  getPendingUpdatesFor,
  renderPluginIcon,
  riskDescription,
  state,
} from "./helpers.js";

export { buildAuditBlocks, buildDrawerFooterHtml, buildOverviewHtml, buildStagedUpdateNotice };

// ---------------------------------------------------------------------------
// Slide-Over Permission-Diff & Security Audit Drawer
// ---------------------------------------------------------------------------
export function renderDrawer() {
  const container = document.getElementById("drawer-content");
  if (!state.drawer.open) return;

  const summary = (state.catalog.plugins || []).find((p) => p.id === state.drawer.pluginId);
  if (!summary) {
    container.innerHTML = `
      <div class="mp-drawer-head">
        <button type="button" class="mp-btn mp-drawer-back" data-close-drawer title="Back to plugin list (Esc)">&larr; Back</button>
        <h2 style="margin:0;font-size:15px">Plugin Not Found</h2>
      </div>
      <div class="mp-drawer-body"><p>Plugin not found in catalog.</p></div>
    `;
    return;
  }

  const installs = getInstallsFor(summary.id);
  const pending = state.drawer.pendingAction;
  const targetInstall = pending
    ? installs.find((i) => i.scope === pending.scope)
    : installs.find((i) => classifyInstallStatus(i, summary).isAhead) || installs[0];

  const detail = state.drawer.detail?.detail || null;
  const collisions = state.drawer.detail?.liveCollisions || [];
  const preflight = state.drawer.detail?.preflight || null;
  const findings = detail?.securityReport?.findings || [];
  const targetCaps = detail?.securityReport?.capabilities || summary.security?.capabilities || [];
  const installStatus = targetInstall ? classifyInstallStatus(targetInstall, summary) : null;
  const isAhead = Boolean(installStatus?.isAhead);
  const isUpdate = Boolean(
    targetInstall &&
      (isAhead ||
        targetInstall.matchTier === "repo_origin" ||
        (!targetInstall.manual && targetInstall.sha !== summary.release?.sha))
  );
  const diff = isUpdate ? computePermissionDiff(targetInstall.capabilities, targetCaps) : null;
  const isBusy = state.busyIds.has(summary.id);

  let bodyHtml = "";
  if (state.drawer.loading) {
    bodyHtml = `<p class="mp-muted">Fetching full security report and checking local collisions...</p>`;
  } else if (state.drawer.error) {
    bodyHtml = `<div class="mp-alert mp-alert-danger">${esc(state.drawer.error)}</div>`;
  } else {
    try {
      bodyHtml =
        state.drawer.subTab === "audit"
          ? buildAuditBlocks({
              summary,
              detail,
              collisions,
              preflight,
              findings,
              targetCaps,
              targetInstall,
              diff,
              pending,
              isAhead,
              isUpdate,
            })
          : buildOverviewHtml(summary, detail, targetInstall?.version || "");
    } catch (renderErr) {
      console.error("[marketplace-drawer] Failed to render drawer body:", renderErr);
      bodyHtml = `<div class="mp-alert mp-alert-danger">Failed to render drawer details: ${esc(renderErr?.message || String(renderErr))}</div>`;
    }
  }

  const pendingUpdates = getPendingUpdatesFor(summary.id);
  const stagedNoticeHtml = buildStagedUpdateNotice(pendingUpdates);
  const projectWarningHtml = buildProjectInstalledWarning({ installs, pending });
  const actionErrorHtml = state.drawer.actionError
    ? `<div class="mp-alert mp-alert-danger"><div>${esc(state.drawer.actionError)}</div></div>`
    : "";

  const riskTier = summary.security?.riskTier || "unverified";
  const confirmAction = buildDrawerFooterHtml({
    summary,
    installs,
    pending,
    pendingUpdates,
    isAhead,
    isBusy,
  });

  container.innerHTML = `
    <div class="mp-drawer-head">
      <button type="button" class="mp-btn mp-drawer-back" data-close-drawer title="Back to plugin list (Esc)">&larr; Back</button>
      <div class="mp-drawer-ident">
        ${renderPluginIcon(summary, "mp-plugin-icon-lg")}
        <div class="mp-drawer-title-meta">
          <h2 style="margin:0;font-size:15px">${esc(summary.name)}</h2>
          <div class="mp-muted" style="font-size:12px">${esc(summary.id)} &middot; v${esc(summary.version)} &middot; ${esc(summary.license || "Unknown license")}</div>
        </div>
      </div>
    </div>

    <div class="mp-tabs" style="padding:8px 16px;border-bottom:1px solid var(--mp-border)">
      <button type="button" class="mp-tab ${state.drawer.subTab === "overview" ? "is-active" : ""}" data-drawer-tab="overview" title="Read the plugin README, release notes, and repository links">
        README &amp; Notes
      </button>
      <button type="button" class="mp-tab ${state.drawer.subTab === "audit" ? "is-active" : ""}" data-drawer-tab="audit" title="View permissions, collisions, pre-flight checks, and static scan findings">
        Security Audit (${findings.length})
      </button>
    </div>

    <div class="mp-drawer-body">${stagedNoticeHtml}${projectWarningHtml}${actionErrorHtml}${bodyHtml}</div>

    <div class="mp-drawer-foot">
      <span class="mp-badge mp-risk-${esc(riskTier)}" title="${esc(riskDescription(riskTier))}">
        Risk: ${esc(riskTier)}
      </span>
      ${confirmAction}
    </div>
  `;
}
