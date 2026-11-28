import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { summarizeStatus } from "../server/lib/service.mjs";
import {
  buildAuditBlocks,
  buildDrawerFooterHtml,
  buildProjectInstalledWarning,
  buildStagedUpdateNotice,
} from "../ui/src/drawer-sections.js";
import {
  classifyInstallStatus,
  compareSemver,
  computePermissionDiff,
  getInstallActionMeta,
  getPluginSlug,
  hasUpdateAvailable,
  parseSemver,
  state,
} from "../ui/src/helpers.js";

function makePlugin(overrides = {}) {
  return {
    id: "domush/token-tracker",
    name: "Token Tracker",
    version: "1.1.1",
    release: {
      sha: "reg-sha-111",
      contentTreeSha256: "tree-111",
      ref: "v1.1.1",
    },
    ...overrides,
  };
}

function makeInstall(overrides = {}) {
  return {
    id: "domush/token-tracker",
    slug: "token-tracker",
    scope: "global",
    version: "1.1.1",
    sha: null,
    manual: true,
    matchTier: "repo_origin",
    enabled: true,
    ...overrides,
  };
}

describe("UI semver parsing and comparison", () => {
  it("parses valid semver strings with optional v prefix and prereleases", () => {
    assert.deepEqual(parseSemver("1.1.2"), {
      major: 1,
      minor: 1,
      patch: 2,
      prerelease: [],
    });
    assert.deepEqual(parseSemver("v1.0.10-beta.2+build9"), {
      major: 1,
      minor: 0,
      patch: 10,
      prerelease: ["beta", "2"],
    });
  });

  it("returns null for non-semver values such as local", () => {
    assert.equal(parseSemver("local"), null);
    assert.equal(parseSemver(""), null);
    assert.equal(parseSemver("1.0"), null);
    assert.equal(parseSemver(null), null);
    assert.equal(compareSemver("local", "1.1.1"), null);
    assert.equal(compareSemver("1.1.1", "local"), null);
  });

  it("compares multi-digit components and prerelease precedence accurately", () => {
    assert.equal(compareSemver("1.0.10", "1.0.2"), 1);
    assert.equal(compareSemver("1.0.2", "1.0.10"), -1);
    assert.equal(compareSemver("1.1.2", "1.1.1"), 1);
    assert.equal(compareSemver("v1.1.1", "1.1.1"), 0);
    assert.equal(compareSemver("1.1.2-alpha.1", "1.1.2"), -1);
    assert.equal(compareSemver("1.1.2", "1.1.2-alpha.1"), 1);
    assert.equal(compareSemver("1.1.2-alpha.10", "1.1.2-alpha.2"), 1);
    assert.equal(compareSemver("1.1.2-1", "1.1.2-alpha"), -1);
    assert.equal(compareSemver("1.1.2-alpha", "1.1.2-alpha.1"), -1);
  });
});

describe("UI install version direction and action metadata", () => {
  afterEach(() => {
    state.installed = [];
  });

  it("treats registry > local (1.1.1 -> 1.1.2) as an upgrade", () => {
    const plugin = makePlugin({ version: "1.1.2", release: { sha: "reg-sha-112" } });
    const repoOriginInstall = makeInstall({ version: "1.1.1", matchTier: "repo_origin" });
    const managedInstall = makeInstall({
      version: "1.1.1",
      manual: false,
      matchTier: "managed",
      sha: "old-sha-111",
    });

    state.installed = [repoOriginInstall];
    assert.equal(hasUpdateAvailable(plugin), true);
    const adoptMeta = getInstallActionMeta(repoOriginInstall, plugin);
    assert.equal(adoptMeta.direction, "upgrade");
    assert.equal(adoptMeta.isAhead, false);
    assert.equal(adoptMeta.action, "review-update");
    assert.equal(adoptMeta.label, "Update 1.1.1 → 1.1.2");
    assert.equal(adoptMeta.isPrimary, true);

    state.installed = [managedInstall];
    assert.equal(hasUpdateAvailable(plugin), true);
    const updateMeta = getInstallActionMeta(managedInstall, plugin);
    assert.equal(updateMeta.direction, "upgrade");
    assert.equal(updateMeta.action, "review-update");
    assert.equal(updateMeta.label, "Update 1.1.1 → 1.1.2");
    assert.equal(updateMeta.isPrimary, true);
  });

  it("suppresses updates and shows downgrade metadata when local is ahead (1.1.2 > 1.1.1)", () => {
    const plugin = makePlugin({ version: "1.1.1", release: { sha: "reg-sha-111" } });
    const repoOriginAhead = makeInstall({ version: "1.1.2", matchTier: "repo_origin" });
    const managedAhead = makeInstall({
      version: "1.1.2",
      manual: false,
      matchTier: "managed",
      sha: "local-sha-112",
    });

    state.installed = [repoOriginAhead];
    assert.equal(hasUpdateAvailable(plugin), false);
    const repoStatus = classifyInstallStatus(repoOriginAhead, plugin);
    assert.equal(repoStatus.direction, "downgrade");
    assert.equal(repoStatus.isAhead, true);

    const repoMeta = getInstallActionMeta(repoOriginAhead, plugin);
    assert.equal(repoMeta.action, "review-update");
    assert.equal(repoMeta.isPrimary, false);
    assert.equal(repoMeta.isDowngrade, true);
    assert.equal(repoMeta.badgeLabel, "Local v1.1.2 Ahead");
    assert.equal(repoMeta.label, "Downgrade to v1.1.1");
    assert.equal(repoMeta.label.includes("1.1.2 → 1.1.1"), false);
    assert.equal(repoMeta.label.includes("Adopt"), false);

    state.installed = [managedAhead];
    assert.equal(hasUpdateAvailable(plugin), false);
    const managedMeta = getInstallActionMeta(managedAhead, plugin);
    assert.equal(managedMeta.direction, "downgrade");
    assert.equal(managedMeta.isAhead, true);
    assert.equal(managedMeta.action, "review-update");
    assert.equal(managedMeta.isPrimary, false);
    assert.equal(managedMeta.label, "Downgrade to v1.1.1");
    assert.equal(managedMeta.label.includes("Update 1.1.2 → 1.1.1"), false);
  });

  it("handles equal versions (1.1.1 === 1.1.1) for repo_origin and managed SHA mismatch", () => {
    const plugin = makePlugin({ version: "1.1.1", release: { sha: "reg-sha-111" } });
    const repoOriginSame = makeInstall({ version: "1.1.1", matchTier: "repo_origin" });
    const managedShaMismatch = makeInstall({
      version: "1.1.1",
      manual: false,
      matchTier: "managed",
      sha: "stale-sha-111",
    });
    const managedSynced = makeInstall({
      version: "1.1.1",
      manual: false,
      matchTier: "managed",
      sha: "reg-sha-111",
    });

    state.installed = [repoOriginSame];
    assert.equal(hasUpdateAvailable(plugin), false);
    const adoptSameMeta = getInstallActionMeta(repoOriginSame, plugin);
    assert.equal(adoptSameMeta.direction, "same");
    assert.equal(adoptSameMeta.action, "review-update");
    assert.equal(adoptSameMeta.isPrimary, true);
    assert.equal(adoptSameMeta.label, "Re-sync Verified (v1.1.1)");

    state.installed = [managedShaMismatch];
    assert.equal(hasUpdateAvailable(plugin), true);
    const resyncMeta = getInstallActionMeta(managedShaMismatch, plugin);
    assert.equal(resyncMeta.direction, "same");
    assert.equal(resyncMeta.action, "review-update");
    assert.equal(resyncMeta.isPrimary, true);
    assert.equal(resyncMeta.label, "Re-sync Verified (v1.1.1)");

    state.installed = [managedSynced];
    assert.equal(hasUpdateAvailable(plugin), false);
    assert.equal(getInstallActionMeta(managedSynced, plugin), null);
  });

  it("treats non-semver local version with repo_origin or managed SHA mismatch as updatable", () => {
    const plugin = makePlugin({ version: "1.1.1", release: { sha: "reg-sha-111" } });
    const repoOriginLocal = makeInstall({ version: "local", matchTier: "repo_origin" });
    const managedLocal = makeInstall({
      version: "local",
      manual: false,
      matchTier: "managed",
      sha: "old-local-sha",
    });

    state.installed = [repoOriginLocal];
    assert.equal(hasUpdateAvailable(plugin), true);
    const repoMeta = getInstallActionMeta(repoOriginLocal, plugin);
    assert.equal(repoMeta.direction, "unversioned");
    assert.equal(repoMeta.isAhead, false);
    assert.equal(repoMeta.action, "review-update");
    assert.equal(repoMeta.isPrimary, true);
    assert.equal(repoMeta.label, "Update local → 1.1.1");

    state.installed = [managedLocal];
    assert.equal(hasUpdateAvailable(plugin), true);
    const managedMeta = getInstallActionMeta(managedLocal, plugin);
    assert.equal(managedMeta.direction, "unversioned");
    assert.equal(managedMeta.action, "review-update");
    assert.equal(managedMeta.isPrimary, true);
    assert.equal(managedMeta.label, "Update local → 1.1.1");
  });

  it("evaluates multi-scope installs accurately for Updates tab filtering", () => {
    const plugin = makePlugin({ version: "1.1.1", release: { sha: "reg-sha-111" } });

    state.installed = [
      makeInstall({ scope: "global", version: "1.1.2", matchTier: "repo_origin" }),
      makeInstall({ scope: "project", version: "1.1.1", manual: false, matchTier: "managed", sha: "reg-sha-111" }),
    ];
    assert.equal(hasUpdateAvailable(plugin), false);

    state.installed = [
      makeInstall({ scope: "global", version: "1.1.2", matchTier: "repo_origin" }),
      makeInstall({ scope: "project", version: "1.1.0", matchTier: "repo_origin" }),
    ];
    assert.equal(hasUpdateAvailable(plugin), true);
  });
});

describe("Server summarizeStatus semver direction parity", () => {
  const emptyDenylist = { blockedRepos: [], blockedShas: [] };

  it("does NOT count local-newer repo_origin or managed installs (1.1.2 > 1.1.1) as updates", () => {
    const index = { plugins: [makePlugin({ version: "1.1.1", release: { sha: "reg-sha-111" } })] };

    const repoOriginAhead = summarizeStatus(index, emptyDenylist, [
      makeInstall({ version: "1.1.2", matchTier: "repo_origin" }),
    ]);
    assert.equal(repoOriginAhead.updates, 0);

    const managedAhead = summarizeStatus(index, emptyDenylist, [
      makeInstall({
        version: "1.1.2",
        manual: false,
        matchTier: "managed",
        sha: "local-sha-112",
      }),
    ]);
    assert.equal(managedAhead.updates, 0);

    const repoOriginSame = summarizeStatus(index, emptyDenylist, [
      makeInstall({ version: "1.1.1", matchTier: "repo_origin" }),
    ]);
    assert.equal(repoOriginSame.updates, 0);
  });

  it("counts behind repo_origin, multi-digit semver upgrades, unversioned repo_origin, and managed SHA mismatches", () => {
    const index = { plugins: [makePlugin({ version: "1.0.10", release: { sha: "reg-sha-1010" } })] };

    assert.equal(
      summarizeStatus(index, emptyDenylist, [
        makeInstall({ version: "1.0.2", matchTier: "repo_origin" }),
      ]).updates,
      1
    );
    assert.equal(
      summarizeStatus(index, emptyDenylist, [
        makeInstall({ version: "1.0.11", matchTier: "repo_origin" }),
      ]).updates,
      0
    );
    assert.equal(
      summarizeStatus(index, emptyDenylist, [
        makeInstall({ version: "local", matchTier: "repo_origin" }),
      ]).updates,
      1
    );
    assert.equal(
      summarizeStatus(index, emptyDenylist, [
        makeInstall({
          version: "1.0.10",
          manual: false,
          matchTier: "managed",
          sha: "stale-sha",
        }),
      ]).updates,
      1
    );
  });
});

describe("Drawer update review, tab ordering, and install-aware footer", () => {
  it("renders Release Notes and Permission Diff when reviewing a matched manual update", () => {
    const summary = makePlugin({ version: "2.0.1", release: { sha: "reg-sha-201", ref: "v2.0.1" } });
    const targetInstall = makeInstall({ version: "2.0.0", matchTier: "repo_origin", capabilities: [] });
    const diff = computePermissionDiff(targetInstall.capabilities, ["reads_gemini_data", "mcp_local_exec"]);

    const html = buildAuditBlocks({
      summary,
      detail: { latestReleaseNotes: "## What changed\n- Fixed bug" },
      collisions: [],
      preflight: null,
      findings: [],
      targetCaps: ["reads_gemini_data", "mcp_local_exec"],
      targetInstall,
      diff,
      pending: { type: "update", scope: "global", replaceSlug: "context-mode", replaceEnabled: true },
      isAhead: false,
      isUpdate: true,
    });

    assert.equal(html.includes("Release Notes (v2.0.1)"), true);
    assert.equal(html.includes("Fixed bug"), true);
    assert.equal(html.includes("Permission Diff: v2.0.0 &rarr; v2.0.1"), true);
    assert.equal(html.includes("Adopt Manual Plugin"), false);
  });

  it("shows Confirm Update in Details footer, locks out duplicate staged updates, and hides Install (project) when globally installed", () => {
    const summary = makePlugin({ version: "2.0.1", release: { sha: "reg-sha-201" } });
    const globalOutdated = makeInstall({ scope: "global", version: "2.0.0", matchTier: "repo_origin" });

    const detailsFooter = buildDrawerFooterHtml({
      summary,
      installs: [globalOutdated],
      pending: null,
      pendingUpdates: [],
      isAhead: false,
      isBusy: false,
    });

    assert.equal(detailsFooter.includes("Confirm Update (global)"), true);
    assert.equal(detailsFooter.includes("Install (global)"), false);
    assert.equal(detailsFooter.includes("Install (project)"), false);
    assert.equal(detailsFooter.includes("Adopt"), false);

    const stagedDetailsFooter = buildDrawerFooterHtml({
      summary,
      installs: [globalOutdated],
      pending: null,
      pendingUpdates: [{ id: summary.id, scope: "global", version: "2.0.1" }],
      isAhead: false,
      isBusy: false,
    });
    assert.equal(stagedDetailsFooter.includes("Pending Restart (global)"), true);
    assert.equal(stagedDetailsFooter.includes("Confirm Update"), false);

    const pendingFooter = buildDrawerFooterHtml({
      summary,
      installs: [globalOutdated],
      pending: { type: "update", scope: "global", replaceSlug: "context-mode", replaceEnabled: true },
      pendingUpdates: [],
      isAhead: false,
      isBusy: false,
    });
    assert.equal(pendingFooter.includes("Confirm Update (global)"), true);
    assert.equal(pendingFooter.includes("Adopt &amp; Verify"), false);
  });

  it("warns and disables Install (global) when plugin is already installed in project scope", () => {
    const summary = makePlugin({ version: "2.0.1", release: { sha: "reg-sha-201" } });
    const projectInst = makeInstall({ scope: "project", version: "2.0.1", manual: false, matchTier: "managed", sha: "reg-sha-201" });

    const warningHtml = buildProjectInstalledWarning({
      installs: [projectInst],
      pending: { type: "install", scope: "global" },
    });
    assert.equal(warningHtml.includes("Already Installed in Project Scope"), true);
    assert.equal(warningHtml.includes("Uninstall the project-level install first"), true);

    const footerHtml = buildDrawerFooterHtml({
      summary,
      installs: [projectInst],
      pending: { type: "install", scope: "global" },
      pendingUpdates: [],
      isAhead: false,
      isBusy: false,
    });
    assert.equal(footerHtml.includes("Uninstall (Project)"), true);
    assert.match(footerHtml, /<button[^>]*disabled[^>]*>\s*Install \(global\)\s*<\/button>/);
  });

  it("places README & Notes tab before Security Audit, uses top-left Back button, short owner--name slug, and amber staged notice", () => {
    const drawerSource = fs.readFileSync(path.resolve("ui/src/drawer.js"), "utf8");
    const readmeIdx = drawerSource.indexOf('data-drawer-tab="overview"');
    const auditIdx = drawerSource.indexOf('data-drawer-tab="audit"');
    assert.notEqual(readmeIdx, -1);
    assert.notEqual(auditIdx, -1);
    assert.equal(readmeIdx < auditIdx, true);

    const backIdx = drawerSource.indexOf("mp-drawer-back");
    const identIdx = drawerSource.indexOf("mp-drawer-ident");
    assert.notEqual(backIdx, -1);
    assert.equal(backIdx < identIdx, true);
    assert.equal(drawerSource.includes(">Close<"), false);
    assert.equal(drawerSource.includes("${stagedNoticeHtml}${projectWarningHtml}${actionErrorHtml}${bodyHtml}"), true);

    assert.equal(
      getPluginSlug({ id: "Domush/antigravity-plugin-context-mode", pluginName: "context-mode" }),
      "domush--context-mode"
    );

    const stagedHtml = buildStagedUpdateNotice([{ version: "2.0.1", scope: "global" }]);
    assert.equal(stagedHtml.includes("mp-panel-warning"), true);
    assert.equal(stagedHtml.includes("pending and will update on restart"), true);

    const actionsSource = fs.readFileSync(path.resolve("ui/src/actions.js"), "utf8");
    assert.equal(actionsSource.includes("closeDrawer();"), true);
  });

  it("renders multi-version releaseNotesSinceInstalled with update count heading when skipping versions", () => {
    const summary = makePlugin({ version: "2.0.1", release: { sha: "reg-sha-201", ref: "v2.0.1" } });
    const targetInstall = makeInstall({ version: "1.5.0", matchTier: "repo_origin", capabilities: [] });
    const diff = computePermissionDiff(targetInstall.capabilities, ["mcp_local_exec"]);

    const html = buildAuditBlocks({
      summary,
      detail: {
        latestReleaseNotes: "- Only latest",
        releaseNotesSinceInstalled: "## v2.0.1\n\n- Latest fix\n\n---\n\n## v2.0.0\n\n- Major feature",
        releaseNotesVersions: ["2.0.1", "2.0.0"],
      },
      collisions: [],
      preflight: null,
      findings: [],
      targetCaps: ["mcp_local_exec"],
      targetInstall,
      diff,
      pending: { type: "update", scope: "global" },
      isAhead: false,
      isUpdate: true,
    });

    assert.equal(html.includes("Release Notes (2 updates since v1.5.0)"), true);
    assert.equal(html.includes("Major feature"), true);
    assert.equal(html.includes("Latest fix"), true);
  });
});
