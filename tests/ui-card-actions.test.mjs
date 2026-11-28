import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { state } from "../ui/src/helpers.js";
import { buildCardActionModel, renderCard } from "../ui/src/render.js";

function makePlugin(overrides = {}) {
  return {
    id: "acme/tool",
    name: "Acme Tool",
    summary: "Short test summary.",
    author: { login: "acme" },
    version: "1.2.0",
    surface: { hasSidebarUi: false, components: ["skills"] },
    categories: ["productivity"],
    tags: [],
    requiresCredentials: false,
    stats: { stars: 12, pushedAt: "2026-11-27T00:00:00Z" },
    security: { riskTier: "low", capabilities: ["prompt_rules_only"] },
    ...overrides,
  };
}

describe("UI card split action button, prominent Details, and header icons", () => {
  it("shows Install as main button and Install (project) in dropdown when not installed", () => {
    const model = buildCardActionModel(makePlugin(), [], false);
    assert.equal(model.mainAction.action, "install");
    assert.equal(model.mainAction.scope, "global");
    assert.equal(model.mainAction.label, "Install");
    assert.deepEqual(
      model.menuItems.map((m) => m.label),
      ["Install (project)"]
    );
  });

  it("shows Disable as primary button with transparent dark orange/red class and Uninstall (Global) in dropdown when enabled globally", () => {
    const model = buildCardActionModel(
      makePlugin(),
      [{ id: "acme/tool", slug: "acme--tool", scope: "global", enabled: true, version: "1.2.0" }],
      false,
      []
    );
    assert.equal(model.mainAction.action, "toggle");
    assert.equal(model.mainAction.scope, "global");
    assert.equal(model.mainAction.enabled, true);
    assert.equal(model.mainAction.variant, "disable");
    assert.equal(model.mainAction.label, "Disable");
    assert.deepEqual(
      model.menuItems.map((m) => m.label),
      ["Uninstall (Global)"]
    );

    const prevInstalled = state.installed;
    const prevPending = state.pendingUpdates;
    const prevOpenMenu = state.openActionMenuId;
    try {
      state.installed = [
        { id: "acme/tool", slug: "acme--tool", scope: "global", enabled: true, version: "1.2.0" },
      ];
      state.pendingUpdates = [];
      state.openActionMenuId = "acme/tool";

      const html = renderCard(makePlugin());
      assert.match(html, /class="mp-split-btn mp-split-btn-disable is-open"/);
      assert.match(
        html,
        /class="mp-btn mp-btn-disable mp-split-main"[^>]*data-action="toggle"[^>]*data-scope="global"[^>]*data-slug="acme--tool"[^>]*data-enabled="true"[^>]*>\s*Disable\s*<\/button>/
      );
      assert.match(html, /class="mp-btn mp-btn-disable mp-split-toggle"/);
      assert.match(html, /role="menuitem" class="mp-split-item is-danger"[^>]*data-action="uninstall"[^>]*>Uninstall \(Global\)<\/button>/);
    } finally {
      state.installed = prevInstalled;
      state.pendingUpdates = prevPending;
      state.openActionMenuId = prevOpenMenu;
    }
  });

  it("shows Enable as primary button when installed globally and disabled", () => {
    const model = buildCardActionModel(
      makePlugin(),
      [{ id: "acme/tool", slug: "acme--tool", scope: "global", enabled: false, version: "1.2.0" }],
      false,
      []
    );
    assert.equal(model.mainAction.action, "toggle");
    assert.equal(model.mainAction.scope, "global");
    assert.equal(model.mainAction.enabled, false);
    assert.equal(model.mainAction.variant, "default");
    assert.equal(model.mainAction.label, "Enable");
    assert.deepEqual(
      model.menuItems.map((m) => m.label),
      ["Uninstall (Global)"]
    );

    const prevInstalled = state.installed;
    const prevPending = state.pendingUpdates;
    const prevOpenMenu = state.openActionMenuId;
    try {
      state.installed = [
        { id: "acme/tool", slug: "acme--tool", scope: "global", enabled: false, version: "1.2.0" },
      ];
      state.pendingUpdates = [];
      state.openActionMenuId = null;

      const html = renderCard(makePlugin());
      assert.doesNotMatch(html, /mp-split-btn-disable/);
      assert.match(
        html,
        /class="mp-btn mp-split-main"[^>]*data-action="toggle"[^>]*data-scope="global"[^>]*data-slug="acme--tool"[^>]*data-enabled="false"[^>]*>\s*Enable\s*<\/button>/
      );
    } finally {
      state.installed = prevInstalled;
      state.pendingUpdates = prevPending;
      state.openActionMenuId = prevOpenMenu;
    }
  });

  it("includes scope toggles and Uninstall entries in dropdown for dual-scope installs", () => {
    const model = buildCardActionModel(
      makePlugin(),
      [
        { id: "acme/tool", slug: "acme--tool", scope: "global", enabled: false, version: "1.2.0" },
        { id: "acme/tool", slug: "acme--tool", scope: "project", enabled: true, version: "1.2.0" },
      ],
      false,
      []
    );
    assert.equal(model.mainAction.action, "toggle");
    assert.equal(model.mainAction.scope, "global");
    assert.equal(model.mainAction.label, "Enable");
    assert.deepEqual(
      model.menuItems.map((m) => m.label),
      ["Disable (Project)", "Uninstall (Global)", "Uninstall (Project)"]
    );
  });

  it("shows Disable as primary and offers Install (global) and Uninstall (Project) in dropdown when only installed in project scope", () => {
    const model = buildCardActionModel(
      makePlugin(),
      [{ id: "acme/tool", slug: "acme--tool", scope: "project", enabled: true, version: "1.2.0" }],
      false,
      []
    );
    assert.equal(model.mainAction.action, "toggle");
    assert.equal(model.mainAction.scope, "project");
    assert.equal(model.mainAction.variant, "disable");
    assert.equal(model.mainAction.label, "Disable");
    assert.deepEqual(
      model.menuItems.map((m) => m.label),
      ["Install (global)", "Uninstall (Project)"]
    );
  });

  it("renders eye icon before favorite star, Update as primary split button when available, and disabled Pending Restart when staged", () => {
    const prevInstalled = state.installed;
    const prevPending = state.pendingUpdates;
    const prevOpenMenu = state.openActionMenuId;
    try {
      state.installed = [
        { id: "acme/tool", slug: "acme--tool", scope: "global", enabled: true, version: "1.1.0", matchTier: "repo_origin" },
      ];
      state.pendingUpdates = [];
      state.openActionMenuId = "acme/tool";

      const html = renderCard(makePlugin());
      const eyeIdx = html.indexOf('class="mp-icon-btn mp-eye-btn');
      const favIdx = html.indexOf('class="mp-icon-btn mp-fav-btn');
      assert.ok(eyeIdx !== -1 && favIdx !== -1 && eyeIdx < favIdx, "Eye button must appear left of favorite star");

      assert.match(html, /class="mp-btn mp-btn-details"[^>]*>Details<\/button>/);
      assert.doesNotMatch(html, /Audit &rarr;/);
      assert.match(html, /class="mp-icon-btn mp-fav-btn[^"]*"[^>]*>\s*<svg /);
      assert.match(html, /class="mp-split-menu" role="menu"/);
      assert.doesNotMatch(html, />Install \(project\)<\/button>/);
      assert.match(html, /class="mp-btn mp-btn-primary mp-split-main"[^>]*data-action="review-update"[^>]*>\s*Update 1\.1\.0/);
      assert.match(html, />Disable \(Global\)<\/button>/);
      assert.match(html, />Uninstall \(Global\)<\/button>/);

      state.pendingUpdates = [{ id: "acme/tool", slug: "acme--tool", scope: "global", version: "1.2.0" }];
      const stagedHtml = renderCard(makePlugin());
      assert.doesNotMatch(stagedHtml, /data-action="review-update"/);
      assert.match(stagedHtml, /<button[^>]*class="mp-btn mp-split-main"[^>]*disabled[^>]*>\s*Pending Restart\s*<\/button>/);
      assert.match(stagedHtml, /class="mp-btn mp-split-toggle"[^>]*data-toggle-menu="acme\/tool"/);

      state.installed = [];
      state.pendingUpdates = [];
      state.openActionMenuId = null;
      const uninstalledHtml = renderCard(makePlugin());
      assert.match(uninstalledHtml, /class="mp-btn mp-btn-install mp-split-main"/);
      assert.match(uninstalledHtml, /class="mp-btn mp-btn-install mp-split-toggle"/);
    } finally {
      state.installed = prevInstalled;
      state.pendingUpdates = prevPending;
      state.openActionMenuId = prevOpenMenu;
    }
  });
});
