import {
  capDescription,
  capLabel,
  esc,
  formatFindingSnippet,
  getInstallActionMeta,
  getPluginSlug,
  inferFindingCapability,
  isSafeHttpUrl,
  REGISTRY_ISSUE_REPO,
  severityDescription,
} from "./helpers.js";
import { renderMarkdown } from "./markdown.js";

/** Build the prominent amber pending-restart notice when updates are staged. */
export function buildStagedUpdateNotice(stagedUpdates = []) {
  if (!Array.isArray(stagedUpdates) || stagedUpdates.length === 0) return "";
  return `
    <section class="mp-panel mp-panel-warning" role="status">
      <h3>Update Pending Restart</h3>
      <div style="font-size:12px">
        ${stagedUpdates
          .map(
            (u) =>
              `Update to <code>v${esc(u.version)}</code> (${esc(u.scope)}) is pending and will update on restart.`
          )
          .join("<br />")}
      </div>
    </section>
  `;
}

/** Build warning when attempting or viewing a global install while already installed in project scope. */
export function buildProjectInstalledWarning({ installs = [], pending = null } = {}) {
  const globalInst = installs.find((i) => i.scope === "global") || null;
  const projectInst = installs.find((i) => i.scope === "project") || null;
  if (!projectInst || globalInst) return "";
  if (pending && !(pending.type === "install" && pending.scope === "global")) return "";
  return `
    <section class="mp-panel mp-panel-warning" role="alert">
      <h3>Already Installed in Project Scope</h3>
      <div style="font-size:12px">
        This plugin is already installed in your active project (<code>${esc(projectInst.slug)}</code>).
        Uninstall the project-level install first before installing globally to prevent double-install issues.
      </div>
    </section>
  `;
}

function buildReleaseNotesPanel(summary, detail, installedVersion = "", { alwaysShow = false } = {}) {
  const mdOpts = {
    linkMode: "button",
    repoUrl: summary.repoUrl,
    sha: summary.release?.sha || "",
  };
  const notesMarkdown = detail?.releaseNotesSinceInstalled || detail?.latestReleaseNotes || "";
  const releaseNotesHtml = notesMarkdown ? renderMarkdown(notesMarkdown, mdOpts) : "";
  if (!releaseNotesHtml && !alwaysShow) return "";

  const versions = Array.isArray(detail?.releaseNotesVersions) ? detail.releaseNotesVersions : [];
  const heading =
    versions.length > 1 && installedVersion
      ? `Release Notes (${versions.length} updates since v${esc(installedVersion)})`
      : versions.length > 1
        ? `Release Notes (${versions.length} releases)`
        : `Release Notes (${esc(summary.release?.ref || `v${summary.version}`)})`;

  return `
    <section class="mp-panel">
      <h3>${heading}</h3>
      ${releaseNotesHtml || `<p class="mp-muted" style="margin:0">No release notes provided for this release.</p>`}
    </section>
  `;
}

/** Build the Security Audit & Update Review body blocks for the detail drawer. */
export function buildAuditBlocks({
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

  // 0b. Release notes for the target update so reviewers see what changed alongside the permission diff
  if (isUpdate || pending?.type === "update") {
    blocks.push(
      buildReleaseNotesPanel(summary, detail, targetInstall?.version || "", { alwaysShow: true })
    );
  }

  // 0c. Folder migration notice when renaming a legacy folder or linking an unmatched local plugin
  if (pending?.replaceSlug) {
    const canonicalSlug = getPluginSlug(summary);
    const migrating = pending.replaceSlug !== canonicalSlug;
    if (pending.type === "adopt") {
      blocks.push(`
        <section class="mp-panel mp-panel-danger">
          <h3>Link &amp; Replace Local Plugin</h3>
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
    } else if (migrating) {
      blocks.push(`
        <section class="mp-panel">
          <h3>Folder Migration</h3>
          <div style="font-size:12px">
            Folder <code>${esc(pending.replaceSlug)}</code> will be migrated atomically to <code>${esc(canonicalSlug)}</code> during this update.
          </div>
        </section>
      `);
    }
  }

  // 1. Permission Escalation Diff (on updates/downgrades) or Granted Capabilities (on fresh install)
  if (diff) {
    const diffHeading = isAhead
      ? `Version &amp; Permission Diff: v${esc(targetInstall.version)} &rarr; v${esc(summary.version)} (Downgrade)`
      : `Permission Diff: v${esc(targetInstall.version)} &rarr; v${esc(summary.version)}`;
    const baselineNote =
      targetInstall?.manual && (!Array.isArray(targetInstall.capabilities) || targetInstall.capabilities.length === 0)
        ? `<div class="mp-muted" style="font-size:11px">Baseline permissions were not previously tracked for this manual install; showing all capabilities required by v${esc(summary.version)}.</div>`
        : "";
    blocks.push(`
      <section class="mp-panel ${diff.hasEscalation || isAhead ? "mp-panel-danger" : ""}">
        <h3>
          ${diffHeading}${diff.hasEscalation ? " (Escalation Detected)" : ""}
        </h3>
        ${baselineNote}
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
          Pinned Commit: <code>${esc((summary.release?.sha || "").slice(0, 12))}</code> &middot;
          Tree SHA-256: <code>${esc((summary.release?.contentTreeSha256 || "").slice(0, 12))}...</code>
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

/** Build the README & Release Notes tab HTML for the detail drawer. */
export function buildOverviewHtml(summary, detail, installedVersion = "") {
  const reportUrl =
    `${REGISTRY_ISSUE_REPO}/issues/new?title=${encodeURIComponent(`Report plugin: ${summary.id}`)}` +
    `&body=${encodeURIComponent(`Plugin: ${summary.id}\nSHA: ${summary.release?.sha || ""}\nReason:\n`)}`;
  const mdOpts = {
    linkMode: "button",
    repoUrl: summary.repoUrl,
    sha: summary.release?.sha || "",
  };
  const releaseNotesPanel = buildReleaseNotesPanel(summary, detail, installedVersion, {
    alwaysShow: false,
  });
  const readmeHtml = detail?.readmeMarkdown
    ? renderMarkdown(detail.readmeMarkdown, mdOpts)
    : "";

  return `
    ${releaseNotesPanel}
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

/** Build install/update/uninstall footer controls for the detail drawer. */
export function buildDrawerFooterHtml({
  summary,
  installs = [],
  pending = null,
  pendingUpdates = [],
  isAhead = false,
  isBusy = false,
}) {
  const globalInst = installs.find((i) => i.scope === "global") || null;
  const projectInst = installs.find((i) => i.scope === "project") || null;
  const hasStagedFor = (scope) =>
    Array.isArray(pendingUpdates) && pendingUpdates.some((u) => u.scope === scope);

  if (pending) {
    if (pending.type === "update" && hasStagedFor(pending.scope)) {
      return `<button type="button" class="mp-btn" disabled title="Update is pending and will update on restart">Pending Restart (${esc(pending.scope)})</button>`;
    }
    if (pending.type === "install" && pending.scope === "global" && projectInst && !globalInst) {
      return `<div class="mp-btn-group">
        <button type="button" class="mp-btn mp-btn-danger" data-drawer-uninstall="${esc(projectInst.slug)}" data-scope="project" title="Uninstall project-level plugin before installing globally" ${isBusy ? "disabled" : ""}>
          ${isBusy ? "Working..." : "Uninstall (Project)"}
        </button>
        <button type="button" class="mp-btn mp-btn-primary" disabled title="Uninstall the project-level install first before installing globally">
          Install (global)
        </button>
      </div>`;
    }
    const confirmLabel = isBusy
      ? "Verifying & Installing..."
      : isAhead
        ? `Confirm Downgrade to v${esc(summary.version)} (${esc(pending.scope)})`
        : `Confirm ${pending.type === "update" ? "Update" : "Install"} (${esc(pending.scope)})`;
    const confirmBtnClass = isAhead ? "mp-btn mp-btn-danger" : "mp-btn mp-btn-primary";
    return `<button
        type="button"
        class="${confirmBtnClass}"
        data-confirm-install="${esc(summary.id)}"
        data-scope="${esc(pending.scope)}"
        ${pending.replaceSlug ? `data-replace-slug="${esc(pending.replaceSlug)}" data-replace-enabled="${pending.replaceEnabled !== false}"` : ""}
        title="Verify integrity hash and apply ${esc(pending.type)} in ${esc(pending.scope)} scope"
        ${isBusy ? "disabled" : ""}
      >
        ${confirmLabel}
      </button>`;
  }

  const actionEntries = installs
    .map((inst) => ({ inst, meta: getInstallActionMeta(inst, summary) }))
    .filter((entry) => Boolean(entry.meta));

  const buttons = [];
  for (const { inst, meta } of actionEntries) {
    if (hasStagedFor(inst.scope)) {
      buttons.push(`
        <button type="button" class="mp-btn" disabled title="Update is pending and will update on restart">
          Pending Restart (${esc(inst.scope)})
        </button>
      `);
      continue;
    }
    const btnLabel = isBusy
      ? "Verifying & Installing..."
      : meta.isAhead
        ? `Confirm Downgrade to v${esc(summary.version)} (${esc(inst.scope)})`
        : `Confirm Update (${esc(inst.scope)})`;
    const btnClass = meta.isAhead ? "mp-btn mp-btn-danger" : meta.buttonClass;
    buttons.push(`
      <button
        type="button"
        class="${esc(btnClass)}"
        data-confirm-install="${esc(summary.id)}"
        data-scope="${esc(inst.scope)}"
        data-replace-slug="${esc(inst.slug)}"
        data-replace-enabled="${inst.enabled !== false}"
        title="Verify integrity hash and ${meta.isAhead ? "downgrade" : "update"} ${esc(inst.scope)} install to v${esc(summary.version)}"
        ${isBusy ? "disabled" : ""}
      >
        ${btnLabel}
      </button>
    `);
  }

  for (const inst of [globalInst, projectInst].filter(Boolean)) {
    const hasPendingUpdate = actionEntries.some((entry) => entry.inst.scope === inst.scope);
    if (hasPendingUpdate) continue;
    buttons.push(`
      <button
        type="button"
        class="mp-btn mp-btn-danger"
        data-drawer-uninstall="${esc(inst.slug)}"
        data-scope="${esc(inst.scope)}"
        title="Uninstall ${esc(inst.scope)} plugin installation from disk"
        ${isBusy ? "disabled" : ""}
      >
        ${isBusy ? "Working..." : `Uninstall (${esc(inst.scope === "global" ? "Global" : "Project")})`}
      </button>
    `);
  }

  if (!globalInst) {
    const blockedByProject = Boolean(projectInst);
    buttons.push(`
      <button
        type="button"
        class="mp-btn ${actionEntries.length === 0 && !blockedByProject ? "mp-btn-primary" : ""}"
        data-confirm-install="${esc(summary.id)}"
        data-scope="global"
        title="${blockedByProject ? "Uninstall the project-level install first before installing globally" : "Verify and install plugin globally for all workspaces"}"
        ${isBusy || blockedByProject ? "disabled" : ""}
      >
        ${isBusy ? "Working..." : "Install (global)"}
      </button>
    `);
  }

  if (!projectInst && !globalInst) {
    buttons.push(`
      <button type="button" class="mp-btn" data-confirm-install="${esc(summary.id)}" data-scope="project" title="Verify and install plugin in the active project workspace" ${isBusy ? "disabled" : ""}>
        Install (project)
      </button>
    `);
  }

  return `<div class="mp-btn-group">${buttons.join("")}</div>`;
}
