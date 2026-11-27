import {
  capLabel,
  computePermissionDiff,
  esc,
  getInstallsFor,
  REGISTRY_ISSUE_REPO,
  state,
} from "./helpers.js";

function buildAuditBlocks({ summary, detail, collisions, preflight, findings, targetCaps, targetInstall, diff, pending }) {
  const blocks = [];

  // 0. Folder migration & local-edit overwrite warning when adopting a manual plugin
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

  // 1. Permission Escalation Diff (on updates) or Granted Capabilities (on fresh install)
  if (diff) {
    blocks.push(`
      <section class="mp-panel ${diff.hasEscalation ? "mp-panel-danger" : ""}">
        <h3>
          Permission Diff: v${esc(targetInstall.version)} &rarr; v${esc(summary.version)}
          ${diff.hasEscalation ? " (Escalation Detected)" : ""}
        </h3>
        <ul class="mp-diff-list">
          ${diff.added.map((c) => `<li class="mp-diff-added">+ ${esc(capLabel(c))} (${esc(c)})</li>`).join("")}
          ${diff.removed.map((c) => `<li class="mp-diff-removed">- ${esc(capLabel(c))} (${esc(c)})</li>`).join("")}
          ${diff.unchanged.map((c) => `<li class="mp-muted">  ${esc(capLabel(c))}</li>`).join("")}
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
          ${targetCaps.map((c) => `<span class="mp-badge">${esc(capLabel(c))}</span>`).join("")}
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
              .map(
                (f) => `
                  <div class="mp-finding">
                    <div class="mp-finding-head">
                      <span>
                        <span class="mp-badge mp-risk-${esc(f.severity === "critical" || f.severity === "high" ? "high" : f.severity === "medium" ? "elevated" : "low")}">
                          ${esc(f.severity)}
                        </span>
                        <strong>${esc(f.id)}</strong> <span class="mp-muted">(${esc(f.layer)})</span>
                      </span>
                      <button type="button" class="mp-btn" data-open-url="${esc(f.githubBlobUrl)}">
                        Inspect Line &nearr;
                      </button>
                    </div>
                    <div>${esc(f.message)}</div>
                    <div class="mp-muted" style="font-size:11px">${esc(f.file)}:${esc(f.line)}</div>
                    ${f.snippet ? `<pre class="mp-code">${esc(f.snippet)}</pre>` : ""}
                  </div>
                `
              )
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

  return `
    ${
      detail?.latestReleaseNotes
        ? `<section class="mp-panel"><h3>Release Notes (${esc(summary.release.ref)})</h3><pre class="mp-readme">${esc(detail.latestReleaseNotes)}</pre></section>`
        : ""
    }
    <section class="mp-panel">
      <h3>README</h3>
      <pre class="mp-readme">${esc(detail?.readmeMarkdown || "No README available.")}</pre>
    </section>
    <div class="mp-btn-group">
      <button type="button" class="mp-btn" data-open-url="${esc(summary.repoUrl)}">Open GitHub Repo &nearr;</button>
      <button type="button" class="mp-btn mp-btn-danger" data-open-url="${esc(reportUrl)}">Report Plugin &nearr;</button>
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
    : installs[0];

  const detail = state.drawer.detail?.detail || null;
  const collisions = state.drawer.detail?.liveCollisions || [];
  const preflight = state.drawer.detail?.preflight || null;
  const findings = detail?.securityReport?.findings || [];
  const targetCaps = detail?.securityReport?.capabilities || summary.security?.capabilities || [];
  const isUpdate = Boolean(targetInstall && !targetInstall.manual && targetInstall.sha !== summary.release?.sha);
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
    });
  } else {
    bodyHtml = buildOverviewHtml(summary, detail);
  }

  // Footer Confirmation Actions
  const confirmAction = pending
    ? `<button
        type="button"
        class="mp-btn mp-btn-primary"
        data-confirm-install="${esc(summary.id)}"
        data-scope="${esc(pending.scope)}"
        ${pending.replaceSlug ? `data-replace-slug="${esc(pending.replaceSlug)}" data-replace-enabled="${pending.replaceEnabled !== false}"` : ""}
        ${isBusy ? "disabled" : ""}
      >
        ${isBusy ? "Verifying & Installing..." : `Confirm ${pending.type === "adopt" ? "Adopt & Verify" : pending.type === "update" ? "Update" : "Install"} (${esc(pending.scope)})`}
      </button>`
    : `<div class="mp-btn-group">
        <button type="button" class="mp-btn mp-btn-primary" data-confirm-install="${esc(summary.id)}" data-scope="global" ${isBusy ? "disabled" : ""}>
          ${isBusy ? "Working..." : "Install Global"}
        </button>
        <button type="button" class="mp-btn" data-confirm-install="${esc(summary.id)}" data-scope="project" ${isBusy ? "disabled" : ""}>
          Install Project
        </button>
      </div>`;

  container.innerHTML = `
    <div class="mp-drawer-head">
      <div>
        <h2 style="margin:0;font-size:15px">${esc(summary.name)}</h2>
        <div class="mp-muted" style="font-size:12px">${esc(summary.id)} &middot; v${esc(summary.version)} &middot; ${esc(summary.license)}</div>
      </div>
      <button type="button" class="mp-btn" data-close-drawer>Close</button>
    </div>

    <div class="mp-tabs" style="padding:8px 16px;border-bottom:1px solid var(--mp-border)">
      <button type="button" class="mp-tab ${state.drawer.subTab === "audit" ? "is-active" : ""}" data-drawer-tab="audit">
        Security Audit (${findings.length})
      </button>
      <button type="button" class="mp-tab ${state.drawer.subTab === "overview" ? "is-active" : ""}" data-drawer-tab="overview">
        README &amp; Notes
      </button>
    </div>

    <div class="mp-drawer-body">${bodyHtml}</div>

    <div class="mp-drawer-foot">
      <span class="mp-badge mp-risk-${esc(summary.security?.riskTier || "unverified")}">
        Risk: ${esc(summary.security?.riskTier || "unverified")}
      </span>
      ${confirmAction}
    </div>
  `;
}
