import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { summarizeStatus } from "../server/lib/service.mjs";
import {
  classifyInstallStatus,
  compareSemver,
  getInstallActionMeta,
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
    assert.equal(adoptMeta.action, "review-adopt");
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
    assert.equal(repoMeta.action, "review-adopt");
    assert.equal(repoMeta.isPrimary, false);
    assert.equal(repoMeta.isDowngrade, true);
    assert.equal(repoMeta.badgeLabel, "Local v1.1.2 Ahead");
    assert.equal(repoMeta.label, "Adopt Registry v1.1.1 (Downgrade)");
    assert.equal(repoMeta.label.includes("1.1.2 → 1.1.1"), false);
    assert.equal(repoMeta.label.includes("Adopt & Update"), false);

    state.installed = [managedAhead];
    assert.equal(hasUpdateAvailable(plugin), false);
    const managedMeta = getInstallActionMeta(managedAhead, plugin);
    assert.equal(managedMeta.direction, "downgrade");
    assert.equal(managedMeta.isAhead, true);
    assert.equal(managedMeta.action, "review-update");
    assert.equal(managedMeta.isPrimary, false);
    assert.equal(managedMeta.label, "Adopt Registry v1.1.1 (Downgrade)");
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
    assert.equal(adoptSameMeta.action, "review-adopt");
    assert.equal(adoptSameMeta.isPrimary, false);
    assert.equal(adoptSameMeta.label, "Adopt & Verify (v1.1.1)");

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
    assert.equal(repoMeta.action, "review-adopt");
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
