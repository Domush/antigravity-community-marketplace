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
  it("shows Install as main button and Install in Project in dropdown when not installed", () => {
    const model = buildCardActionModel(makePlugin(), [], false);
    assert.equal(model.mainAction.action, "install");
    assert.equal(model.mainAction.scope, "global");
    assert.equal(model.mainAction.label, "Install");
    assert.deepEqual(
      model.menuItems.map((m) => m.label),
      ["Install in Project"]
    );
  });

  it("shows Uninstall as main button with Disable (Global) and Install in Project when installed globally", () => {
    const model = buildCardActionModel(
      makePlugin(),
      [{ id: "acme/tool", slug: "acme--tool", scope: "global", enabled: true, version: "1.2.0" }],
      false
    );
    assert.equal(model.mainAction.action, "uninstall");
    assert.equal(model.mainAction.scope, "global");
    assert.equal(model.mainAction.label, "Uninstall");
    assert.deepEqual(
      model.menuItems.map((m) => m.label),
      ["Install in Project", "Disable (Global)"]
    );
  });

  it("includes Uninstall from Project and Disable/Enable controls when installed in project scope", () => {
    const model = buildCardActionModel(
      makePlugin(),
      [
        { id: "acme/tool", slug: "acme--tool", scope: "global", enabled: false, version: "1.2.0" },
        { id: "acme/tool", slug: "acme--tool", scope: "project", enabled: true, version: "1.2.0" },
      ],
      false
    );
    assert.equal(model.mainAction.action, "uninstall");
    assert.equal(model.mainAction.scope, "global");
    assert.deepEqual(
      model.menuItems.map((m) => m.label),
      ["Install in Project", "Enable (Global)", "Disable (Project)", "Uninstall from Project"]
    );
  });

  it("offers Install (Global) in dropdown when only installed in project scope", () => {
    const model = buildCardActionModel(
      makePlugin(),
      [{ id: "acme/tool", slug: "acme--tool", scope: "project", enabled: true, version: "1.2.0" }],
      false
    );
    assert.equal(model.mainAction.action, "uninstall");
    assert.equal(model.mainAction.scope, "project");
    assert.deepEqual(
      model.menuItems.map((m) => m.label),
      ["Install (Global)", "Install in Project", "Disable (Project)", "Uninstall from Project"]
    );
  });

  it("renders eye icon before favorite star, prominent Details without Audit button, and open split dropdown", () => {
    const prevInstalled = state.installed;
    const prevOpenMenu = state.openActionMenuId;
    try {
      state.installed = [
        { id: "acme/tool", slug: "acme--tool", scope: "global", enabled: true, version: "1.2.0" },
      ];
      state.openActionMenuId = "acme/tool";

      const html = renderCard(makePlugin());
      const eyeIdx = html.indexOf('class="mp-icon-btn mp-eye-btn');
      const favIdx = html.indexOf('class="mp-icon-btn mp-fav-btn');
      assert.ok(eyeIdx !== -1 && favIdx !== -1 && eyeIdx < favIdx, "Eye button must appear left of favorite star");

      assert.match(html, /class="mp-btn mp-btn-details"[^>]*>Details<\/button>/);
      assert.doesNotMatch(html, /Audit &rarr;/);
      assert.match(html, /class="mp-icon-btn mp-fav-btn[^"]*"[^>]*>\s*<svg /);
      assert.match(html, /class="mp-split-menu" role="menu"/);
      assert.match(html, />Install in Project<\/button>/);
      assert.match(html, />Disable \(Global\)<\/button>/);

      state.installed = [];
      state.openActionMenuId = null;
      const uninstalledHtml = renderCard(makePlugin());
      assert.match(uninstalledHtml, /class="mp-btn mp-btn-install mp-split-main"/);
      assert.match(uninstalledHtml, /class="mp-btn mp-btn-install mp-split-toggle"/);
    } finally {
      state.installed = prevInstalled;
      state.openActionMenuId = prevOpenMenu;
    }
  });
});
