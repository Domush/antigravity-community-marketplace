import {
  capDescription,
  capLabel,
  classifyInstallStatus,
  computePermissionDiff,
  esc,
  formatFindingSnippet,
  getInstallsFor,
  inferFindingCapability,
  isSafeHttpUrl,
  REGISTRY_ISSUE_REPO,
  renderPluginIcon,
  riskDescription,
  severityDescription,
  state,
} from "./helpers.js";
import { renderMarkdown } from "./markdown.js";

function buildAuditBlocks({
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
}) {
  const blocks = [];

  // 0a. Local-ahead downgrade warning when installed version is newer than registry release
  if (isAhead && targetInstall) {
    blocks.push(`
      <section class="mp-panel mp-panel-danger">
        <h3>Downgrade Warning: Local Version Ahead</h3>
        <div style="font-size:12px">
          The locally installed version (<code>v${esc(targetInstall.version)}</code>) is newer than the verified registry release (<code>v${esc(summary.version)}</code>).
          Confirming will downgrade the plugin to <code>v${esc(summary.version)}</code> and overwrite local changes.
        </div>
      </section>
    `);
  }

  // 0b. Folder migration & local-edit overwrite warning when adopting a manual plugin
  if (pending?.replaceSlug) {
    const canonicalSlug = summary.id.replace("/", "--").toLowerCase();
    const migrating = pending.replaceSlug !== canonicalSlug;
    blocks.push(`
      <section class="mp-panel mp-panel-danger">
        <h3>${pending.type === "adopt" ? "Adopt Manual Plugin" : "Migrate Legacy Plugin Folder"}</h3>
        <div style="font-size:12px">
          ${
            migrating
              ? `Folder <code>${esc(pending.replaceSlug)}</code> will be migrated atomically to <code>${esc(canonicalSlug)}</code>.`
              : `Existing folder <code>${esc(pending.replaceSlug)}</code> will be replaced with the verified release.`
          }
          Any uncommitted local edits inside <code>${esc(pending.replaceSlug)}</code> will be overwritten.
        </div>
      </section>
    `);
  }

  // 1. Permission Escalation Diff (on updates/downgrades) or Granted Capabilities (on fresh install)
  if (diff) {
    const diffHeading = isAhead
      ? `Version &amp; Permission Diff: v${esc(targetInstall.version)} &rarr; v${esc(summary.version)} (Downgrade)`
      : `Permission Diff: v${esc(targetInstall.version)} &rarr; v${esc(summary.version)}`;
    blocks.push(`
      <section class="mp-panel ${diff.hasEscalation || isAhead ? "mp-panel-danger" : ""}">
        <h3>
          ${diffHeading}${diff.hasEscalation ? " (Escalation Detected)" : ""}
        </h3>
        <ul class="mp-diff-list">
          ${diff.added.map((c) => `<li class="mp-diff-added" title="${esc(capDescription(c))}">+ ${esc(capLabel(c))} (${esc(c)})</li>`).join("")}
          ${diff.removed.map((c) => `<li class="mp-diff-removed" title="${esc(capDescription(c))}">- ${esc(capLabel(c))} (${esc(c)})</li>`).join("")}
          ${diff.unchanged.map((c) => `<li class="mp-muted" title="${esc(capDescription(c))}">  ${esc(capLabel(c))}</li>`).join("")}
          ${
            diff.added.length === 0 && diff.removed.length === 0
              ? `<li class="mp-muted">No capability changes since installed version.</li>`
              : ""
          }
        </ul>
      </section>
    `);
  } else {
    blocks.push(`
      <section class="mp-panel">
        <h3>Declared &amp; Detected Capabilities</h3>
        <div class="mp-pill-row">
          ${targetCaps.map((c) => `<span class="mp-badge" title="${esc(capDescription(c))}">${esc(capLabel(c))}</span>`).join("")}
        </div>
        <div class="mp-muted" style="font-size:11px">
          Pinned Commit: <code>${esc(summary.release.sha.slice(0, 12))}</code> &middot;
          Tree SHA-256: <code>${esc(summary.release.contentTreeSha256.slice(0, 12))}...</code>
        </div>
      </section>
    `);
  }

  // 1b. OS & Runtime Pre-Flight Checks
  if (preflight?.warnings?.length > 0) {
    blocks.push(`
      <section class="mp-panel ${preflight.hasBlockers ? "mp-panel-danger" : ""}">
        <h3>OS &amp; Runtime Pre-Flight (${esc(preflight.platform)} / ${esc(preflight.arch)})</h3>
        ${preflight.warnings
          .map(
            (w) => `
              <div class="mp-finding">
                <div>
                  <span class="mp-badge mp-risk-${w.severity === "error" ? "high" : w.severity === "warning" ? "elevated" : "low"}">${esc(w.severity)}</span>
                  <strong>${esc(w.message)}</strong>
                </div>
                ${w.hint ? `<div class="mp-muted" style="font-size:11px">${esc(w.hint)}</div>` : ""}
              </div>
            `
          )
          .join("")}
      </section>
    `);
  }

  // 2. Live Collisions & Required Credentials
  if (collisions.length > 0) {
    blocks.push(`
      <section class="mp-panel mp-panel-danger">
        <h3>Local Collisions Detected</h3>
        <ul class="mp-diff-list">
          ${collisions.map((c) => `<li>${esc(c)}</li>`).join("")}
        </ul>
      </section>
    `);
  }

  const envVars = detail?.credentials?.envVars || [];
  const oauth = detail?.credentials?.oauthProviders || [];
  if (envVars.length > 0 || oauth.length > 0) {
    blocks.push(`
      <section class="mp-panel">
        <h3>Required Credentials</h3>
        <ul class="mp-diff-list">
          ${envVars.map((e) => `<li><code>${esc(e.name)}</code>${e.required ? " (required)" : " (optional)"} &mdash; ${esc(e.description)}</li>`).join("")}
          ${oauth.map((o) => `<li>OAuth Provider: <strong>${esc(o)}</strong></li>`).join("")}
        </ul>
      </section>
    `);
  }

  // 3. Clickable Line-Level Security Findings
  blocks.push(`
    <section class="mp-panel">
      <h3>Static Scan Findings (${findings.length})</h3>
      ${
        findings.length === 0
          ? `<p class="mp-muted" style="margin:0">No code, manifest, or prompt-injection flags triggered.</p>`
          : findings
              .map((f) => {
                const riskClass =
                  f.severity === "critical" || f.severity === "high"
                    ? "high"
                    : f.severity === "medium"
                      ? "elevated"
                      : "low";
                const findingCap = inferFindingCapability(f);
                const snippet = formatFindingSnippet(f.snippet);
                const hasBlobUrl = isSafeHttpUrl(f.githubBlobUrl);
                return `
                  <div class="mp-finding">
                    <div class="mp-finding-head">
                      <span class="mp-finding-badges">
                        <span class="mp-badge mp-risk-${esc(riskClass)}" title="${esc(severityDescription(f.severity))}">
                          ${esc(f.severity)}
                        </span>
                        ${
                          findingCap
                            ? `<span class="mp-badge" title="${esc(capDescription(findingCap))}">${esc(capLabel(findingCap))}</span>`
                            : ""
                        }
                        <strong>${esc(f.id)}</strong>
                        <span class="mp-muted" title="Static analysis detection layer: ${esc(f.layer)}">(${esc(f.layer)})</span>
                      </span>
                      <button
                        type="button"
                        class="mp-btn"
                        data-open-url="${esc(f.githubBlobUrl || "")}"
                        title="${hasBlobUrl ? `Open ${esc(f.file)} at line ${esc(f.line)} on GitHub` : "GitHub source URL unavailable for this finding"}"
                        ${hasBlobUrl ? "" : "disabled"}
                      >
                        Inspect Line &nearr;
                      </button>
                    </div>
                    <div>${esc(f.message)}</div>
                    ${
                      findingCap
                        ? `<div class="mp-muted mp-finding-cap-note">${esc(capDescription(findingCap))}</div>`
                        : ""
                    }
                    <div class="mp-muted" style="font-size:11px">${esc(f.file)}:${esc(f.line)}</div>
                    ${
                      snippet
                        ? `<pre class="mp-code">${esc(snippet)}</pre>`
                        : `<div class="mp-muted mp-finding-fallback">Matched static pattern &mdash; click Inspect Line to view source on GitHub.</div>`
                    }
                  </div>
                `;
              })
              .join("")
      }
    </section>
  `);

  return blocks.join("");
}

function buildOverviewHtml(summary, detail) {
  const reportUrl =
    `${REGISTRY_ISSUE_REPO}/issues/new?title=${encodeURIComponent(`Report plugin: ${summary.id}`)}` +
    `&body=${encodeURIComponent(`Plugin: ${summary.id}\nSHA: ${summary.release.sha}\nReason:\n`)}`;
  const mdOpts = {
    linkMode: "button",
    repoUrl: summary.repoUrl,
    sha: summary.release?.sha || "",
  };
  const releaseNotesHtml = detail?.latestReleaseNotes
    ? renderMarkdown(detail.latestReleaseNotes, mdOpts)
    : "";
  const readmeHtml = detail?.readmeMarkdown
    ? renderMarkdown(detail.readmeMarkdown, mdOpts)
    : "";

  return `
    ${
      releaseNotesHtml
        ? `<section class="mp-panel"><h3>Release Notes (${esc(summary.release.ref)})</h3>${releaseNotesHtml}</section>`
        : ""
    }
    <section class="mp-panel">
      <h3>README</h3>
      ${readmeHtml || `<p class="mp-muted" style="margin:0">No README available.</p>`}
    </section>
    <div class="mp-btn-group">
      <button type="button" class="mp-btn" data-open-url="${esc(summary.repoUrl)}" title="Open this plugin repository on GitHub">Open GitHub Repo &nearr;</button>
      <button type="button" class="mp-btn mp-btn-danger" data-open-url="${esc(reportUrl)}" title="Open a pre-filled GitHub issue to report a malicious or broken plugin">Report Plugin &nearr;</button>
    </div>
  `;
}

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
        <h2 style="margin:0;font-size:15px">Plugin Not Found</h2>
        <button type="button" class="mp-btn" data-close-drawer>Close</button>
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
    targetInstall && (isAhead || (!targetInstall.manual && targetInstall.sha !== summary.release?.sha))
  );
  const diff = isUpdate ? computePermissionDiff(targetInstall.capabilities, targetCaps) : null;
  const isBusy = state.busyIds.has(summary.id);

  let bodyHtml = "";
  if (state.drawer.loading) {
    bodyHtml = `<p class="mp-muted">Fetching full security report and checking local collisions...</p>`;
  } else if (state.drawer.error) {
    bodyHtml = `<div class="mp-alert mp-alert-danger">${esc(state.drawer.error)}</div>`;
  } else if (state.drawer.subTab === "audit") {
    bodyHtml = buildAuditBlocks({
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
    });
  } else {
    bodyHtml = buildOverviewHtml(summary, detail);
  }

  // Footer Confirmation Actions
  const confirmLabel = pending
    ? isBusy
      ? "Verifying & Installing..."
      : isAhead
        ? `Confirm Downgrade to v${esc(summary.version)} (${esc(pending.scope)})`
        : `Confirm ${pending.type === "adopt" ? "Adopt & Verify" : pending.type === "update" ? "Update" : "Install"} (${esc(pending.scope)})`
    : "";
  const confirmBtnClass = isAhead ? "mp-btn mp-btn-danger" : "mp-btn mp-btn-primary";
  const riskTier = summary.security?.riskTier || "unverified";
  const confirmAction = pending
    ? `<button
        type="button"
        class="${confirmBtnClass}"
        data-confirm-install="${esc(summary.id)}"
        data-scope="${esc(pending.scope)}"
        ${pending.replaceSlug ? `data-replace-slug="${esc(pending.replaceSlug)}" data-replace-enabled="${pending.replaceEnabled !== false}"` : ""}
        title="Verify integrity hash and apply ${esc(pending.type)} in ${esc(pending.scope)} scope"
        ${isBusy ? "disabled" : ""}
      >
        ${confirmLabel}
      </button>`
    : `<div class="mp-btn-group">
        <button type="button" class="mp-btn mp-btn-primary" data-confirm-install="${esc(summary.id)}" data-scope="global" title="Verify and install plugin globally for all workspaces" ${isBusy ? "disabled" : ""}>
          ${isBusy ? "Working..." : "Install Global"}
        </button>
        <button type="button" class="mp-btn" data-confirm-install="${esc(summary.id)}" data-scope="project" title="Verify and install plugin in the active project workspace" ${isBusy ? "disabled" : ""}>
          Install Project
        </button>
      </div>`;

  container.innerHTML = `
    <div class="mp-drawer-head">
      <div class="mp-drawer-ident">
        ${renderPluginIcon(summary, "mp-plugin-icon-lg")}
        <div class="mp-drawer-title-meta">
          <h2 style="margin:0;font-size:15px">${esc(summary.name)}</h2>
          <div class="mp-muted" style="font-size:12px">${esc(summary.id)} &middot; v${esc(summary.version)} &middot; ${esc(summary.license || "Unknown license")}</div>
        </div>
      </div>
      <button type="button" class="mp-btn" data-close-drawer title="Close detail drawer (Esc)">Close</button>
    </div>

    <div class="mp-tabs" style="padding:8px 16px;border-bottom:1px solid var(--mp-border)">
      <button type="button" class="mp-tab ${state.drawer.subTab === "audit" ? "is-active" : ""}" data-drawer-tab="audit" title="View permissions, collisions, pre-flight checks, and static scan findings">
        Security Audit (${findings.length})
      </button>
      <button type="button" class="mp-tab ${state.drawer.subTab === "overview" ? "is-active" : ""}" data-drawer-tab="overview" title="Read the plugin README, release notes, and repository links">
        README &amp; Notes
      </button>
    </div>

    <div class="mp-drawer-body">${bodyHtml}</div>

    <div class="mp-drawer-foot">
      <span class="mp-badge mp-risk-${esc(riskTier)}" title="${esc(riskDescription(riskTier))}">
        Risk: ${esc(riskTier)}
      </span>
      ${confirmAction}
    </div>
  `;
}
