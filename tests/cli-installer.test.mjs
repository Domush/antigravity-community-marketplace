import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  LEGACY_PLUGIN_DIR_NAME,
  loadPackageVersion,
  PLUGIN_DIR_NAME,
  removePluginEntry,
  REQUIRED_DIRS,
  REQUIRED_FILES,
  runCli,
} from "../server/lib/cli.mjs";

function createFakeBundle(bundleDir, { version = "1.0.0", includeUiBundle = true } = {}) {
  fs.mkdirSync(bundleDir, { recursive: true });
  for (const file of REQUIRED_FILES) {
    const content =
      file === "package.json"
        ? JSON.stringify({ name: "antigravity-community-marketplace", version })
        : `content:${file}`;
    fs.writeFileSync(path.join(bundleDir, file), content, "utf8");
  }
  for (const dir of REQUIRED_DIRS) {
    const subDir = path.join(bundleDir, dir);
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, "index.mjs"), "// server entry\n", "utf8");
  }
  if (includeUiBundle) {
    const uiDistDir = path.join(bundleDir, "ui", "dist");
    fs.mkdirSync(uiDistDir, { recursive: true });
    fs.writeFileSync(path.join(uiDistDir, "marketplace.html"), "<html><body>Marketplace</body></html>", "utf8");
  }
  return bundleDir;
}

function execCli(opts) {
  const outLines = [];
  const errLines = [];
  const res = runCli({
    ...opts,
    stdout: (msg = "") => outLines.push(String(msg)),
    stderr: (msg = "") => errLines.push(String(msg)),
  });
  return { res, out: outLines.join("\n"), err: errLines.join("\n") };
}

test("loadPackageVersion validates rootDir and package.json version", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agy-mp-cli-ver-"));
  try {
    for (const invalid of ["", "   ", null, undefined, 42]) {
      assert.throws(() => loadPackageVersion(invalid), TypeError);
    }

    const missingDir = path.join(tmpRoot, "missing");
    fs.mkdirSync(missingDir);
    assert.throws(() => loadPackageVersion(missingDir), /Failed to read package\.json/);

    const badJsonDir = path.join(tmpRoot, "bad-json");
    fs.mkdirSync(badJsonDir);
    fs.writeFileSync(path.join(badJsonDir, "package.json"), "{invalid", "utf8");
    assert.throws(() => loadPackageVersion(badJsonDir), /Failed to parse package\.json/);

    const validDir = path.join(tmpRoot, "valid");
    fs.mkdirSync(validDir);
    fs.writeFileSync(path.join(validDir, "package.json"), JSON.stringify({ version: " 1.2.3 " }), "utf8");
    assert.equal(loadPackageVersion(validDir), "1.2.3");
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("runCli passes through empty argv and MCP server flags without intercepting", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agy-mp-cli-pass-"));
  try {
    const bundleDir = createFakeBundle(path.join(tmpRoot, "bundle"));
    const passthroughArgvs = [
      [],
      ["--data-dir", "/tmp/data", "--registry-url", "https://example.invalid"],
      ["--registry-url", "https://example.invalid"],
      ["--public-key-file", "/tmp/key.pem"],
      ["--insecure-skip-verify"],
    ];

    for (const argv of passthroughArgvs) {
      const r = execCli({ argv, rootDir: bundleDir, env: {} });
      assert.deepEqual(r.res, { handled: false, exitCode: 0 });
      assert.equal(r.out, "");
      assert.equal(r.err, "");
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("runCli handles --version, --help, and rejects invalid commands or flags", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agy-mp-cli-flags-"));
  try {
    const bundleDir = createFakeBundle(path.join(tmpRoot, "bundle"), { version: "1.4.2" });

    for (const flag of ["--version", "-v"]) {
      const r = execCli({ argv: [flag], rootDir: bundleDir, env: {} });
      assert.deepEqual(r.res, { handled: true, exitCode: 0 });
      assert.equal(r.out, "antigravity-community-marketplace v1.4.2");
    }

    for (const flag of ["--help", "-h"]) {
      const r = execCli({ argv: [flag], rootDir: bundleDir, env: {} });
      assert.deepEqual(r.res, { handled: true, exitCode: 0 });
      assert.ok(r.out.includes("Antigravity Community Plugin Marketplace CLI (v1.4.2)"));
      assert.ok(r.out.includes("--global, -g"));
      assert.ok(r.out.includes("--workspace, -w"));
      assert.ok(r.out.includes(".agents/plugins/agy-community-marketplace"));
    }

    const extraVer = execCli({ argv: ["--version", "--extra"], rootDir: bundleDir, env: {} });
    assert.deepEqual(extraVer.res, { handled: true, exitCode: 1 });
    assert.ok(extraVer.err.includes("Unknown option(s) for --version"));

    const extraHelp = execCli({ argv: ["-h", "extra"], rootDir: bundleDir, env: {} });
    assert.deepEqual(extraHelp.res, { handled: true, exitCode: 1 });
    assert.ok(extraHelp.err.includes("Unknown option(s) for -h"));

    const unknownCmd = execCli({ argv: ["bogus"], rootDir: bundleDir, env: {} });
    assert.deepEqual(unknownCmd.res, { handled: true, exitCode: 1 });
    assert.ok(unknownCmd.err.includes("Unknown CLI command or option"));

    const unknownFlag = execCli({ argv: ["install", "--nope"], rootDir: bundleDir, env: { HOME: tmpRoot } });
    assert.deepEqual(unknownFlag.res, { handled: true, exitCode: 1 });
    assert.ok(unknownFlag.err.includes('Unknown option "--nope"'));

    const conflict = execCli({
      argv: ["install", "--global", "--workspace"],
      rootDir: bundleDir,
      cwd: tmpRoot,
      env: { HOME: tmpRoot },
    });
    assert.deepEqual(conflict.res, { handled: true, exitCode: 1 });
    assert.ok(conflict.err.includes("Cannot specify both --global and --workspace"));

    const noHome = execCli({ argv: ["install"], rootDir: bundleDir, env: {} });
    assert.deepEqual(noHome.res, { handled: true, exitCode: 1 });
    assert.ok(noHome.err.includes("Could not determine home directory"));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("runCli fails when built ui/dist/marketplace.html is missing or target causes self-overwrite", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agy-mp-cli-guards-"));
  try {
    const noUiBundle = createFakeBundle(path.join(tmpRoot, "no-ui-bundle"), { includeUiBundle: false });
    const homeDir = path.join(tmpRoot, "home");
    fs.mkdirSync(homeDir);

    let depsCalled = false;
    const missingUiRes = execCli({
      argv: ["install"],
      rootDir: noUiBundle,
      env: { HOME: homeDir },
      installDepsFn: () => {
        depsCalled = true;
      },
    });
    assert.deepEqual(missingUiRes.res, { handled: true, exitCode: 1 });
    assert.ok(missingUiRes.err.includes("Missing required built UI bundle"));
    assert.equal(depsCalled, false);

    // Self-overwrite guard when bundle lives at the exact target install directory
    const selfTargetHome = path.join(tmpRoot, "self-home");
    const selfBundle = createFakeBundle(
      path.join(selfTargetHome, ".gemini", "config", "plugins", PLUGIN_DIR_NAME)
    );
    const selfRes = execCli({
      argv: ["install"],
      rootDir: selfBundle,
      env: { USERPROFILE: selfTargetHome },
      installDepsFn: () => {
        depsCalled = true;
      },
    });
    assert.deepEqual(selfRes.res, { handled: true, exitCode: 1 });
    assert.ok(selfRes.err.includes("refusing self-overwrite"));
    assert.equal(depsCalled, false);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("runCli performs global and workspace installs with mocked installDepsFn, cleans legacy dir, and uninstalls", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agy-mp-cli-inst-"));
  try {
    const bundleDir = createFakeBundle(path.join(tmpRoot, "bundle"), { version: "1.0.0" });
    const homeDir = path.join(tmpRoot, "home");
    const workspaceDir = path.join(tmpRoot, "workspace");
    fs.mkdirSync(homeDir);
    fs.mkdirSync(workspaceDir);

    // Seed legacy global folder to verify automatic migration cleanup
    const globalPluginsDir = path.join(homeDir, ".gemini", "config", "plugins");
    const legacyGlobalDir = path.join(globalPluginsDir, LEGACY_PLUGIN_DIR_NAME);
    fs.mkdirSync(legacyGlobalDir, { recursive: true });
    fs.writeFileSync(path.join(legacyGlobalDir, "old.txt"), "legacy", "utf8");

    const installedTargets = [];
    const globalInstall = execCli({
      argv: ["install"],
      rootDir: bundleDir,
      cwd: tmpRoot,
      env: { USERPROFILE: homeDir },
      installDepsFn: (dir) => {
        installedTargets.push(dir);
      },
    });

    assert.deepEqual(globalInstall.res, { handled: true, exitCode: 0 });
    const globalTarget = path.join(globalPluginsDir, PLUGIN_DIR_NAME);
    assert.deepEqual(installedTargets, [globalTarget]);
    for (const file of REQUIRED_FILES) {
      assert.equal(fs.existsSync(path.join(globalTarget, file)), true, `Missing ${file}`);
    }
    assert.equal(fs.existsSync(path.join(globalTarget, "server", "index.mjs")), true);
    assert.equal(fs.existsSync(path.join(globalTarget, "ui", "dist", "marketplace.html")), true);
    assert.equal(fs.existsSync(legacyGlobalDir), false);

    // Global uninstall
    const globalUninstall = execCli({
      argv: ["uninstall", "-g"],
      rootDir: bundleDir,
      cwd: tmpRoot,
      env: { USERPROFILE: homeDir },
    });
    assert.deepEqual(globalUninstall.res, { handled: true, exitCode: 0 });
    assert.equal(fs.existsSync(globalTarget), false);
    assert.ok(globalUninstall.out.includes("successfully removed"));

    // Uninstall when already absent
    const absentUninstall = execCli({
      argv: ["uninstall"],
      rootDir: bundleDir,
      cwd: tmpRoot,
      env: { HOME: homeDir },
    });
    assert.deepEqual(absentUninstall.res, { handled: true, exitCode: 0 });
    assert.ok(absentUninstall.out.includes("Plugin not found at:"));

    // Workspace install (--workspace)
    const wsInstalledTargets = [];
    const wsInstall = execCli({
      argv: ["install", "--workspace"],
      rootDir: bundleDir,
      cwd: workspaceDir,
      env: {},
      installDepsFn: (dir) => {
        wsInstalledTargets.push(dir);
      },
    });
    assert.deepEqual(wsInstall.res, { handled: true, exitCode: 0 });
    const wsTarget = path.join(workspaceDir, ".agents", "plugins", PLUGIN_DIR_NAME);
    assert.deepEqual(wsInstalledTargets, [wsTarget]);
    assert.equal(fs.existsSync(path.join(wsTarget, "plugin.json")), true);
    assert.equal(fs.existsSync(path.join(wsTarget, "ui", "dist", "marketplace.html")), true);

    // Workspace uninstall (-w)
    const wsUninstall = execCli({
      argv: ["uninstall", "-w"],
      rootDir: bundleDir,
      cwd: workspaceDir,
      env: {},
    });
    assert.deepEqual(wsUninstall.res, { handled: true, exitCode: 0 });
    assert.equal(fs.existsSync(wsTarget), false);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("removePluginEntry removes symlink/junction without deleting target directory contents", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agy-mp-cli-sym-"));
  try {
    const realTarget = path.join(tmpRoot, "real-target");
    fs.mkdirSync(realTarget, { recursive: true });
    fs.writeFileSync(path.join(realTarget, "keep.txt"), "safe", "utf8");

    const linkPath = path.join(tmpRoot, "link-entry");
    fs.symlinkSync(realTarget, linkPath, process.platform === "win32" ? "junction" : "dir");

    assert.equal(removePluginEntry(linkPath), true);
    assert.equal(fs.existsSync(linkPath), false);
    assert.equal(fs.readFileSync(path.join(realTarget, "keep.txt"), "utf8"), "safe");
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("runCli enforces TypeError guards on invalid parameter types", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agy-mp-cli-types-"));
  try {
    const bundleDir = createFakeBundle(path.join(tmpRoot, "bundle"));

    for (const badArgv of [null, "install", 123, {}]) {
      assert.throws(() => runCli({ argv: badArgv, rootDir: bundleDir }), /argv to be an array/);
    }
    for (const badEnv of [null, "env", 42, ["HOME"]]) {
      assert.throws(() => runCli({ argv: [], rootDir: bundleDir, env: badEnv }), /env to be an object/);
    }
    for (const badFn of ["installDeps", 42, {}]) {
      assert.throws(
        () => runCli({ argv: [], rootDir: bundleDir, installDepsFn: badFn }),
        /installDepsFn to be a function/
      );
    }
    for (const badStream of [null, "log", 42]) {
      assert.throws(() => runCli({ argv: [], rootDir: bundleDir, stdout: badStream }), /stdout to be a function/);
      assert.throws(() => runCli({ argv: [], rootDir: bundleDir, stderr: badStream }), /stderr to be a function/);
    }
    for (const badCwd of ["", "   "]) {
      assert.throws(
        () => runCli({ argv: ["install", "--workspace"], rootDir: bundleDir, cwd: badCwd, env: {} }),
        /non-empty cwd string/
      );
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("runCli rejects installing inside source subdirectories, replaces symlinked target safely, removes stale server files, and preserves active legacy source dir", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agy-mp-cli-edge-"));
  try {
    const bundleDir = createFakeBundle(path.join(tmpRoot, "bundle"));

    // 1. Target inside rootDir/server and rootDir/ui
    for (const subDir of ["server", "ui"]) {
      let depsCalled = false;
      const res = execCli({
        argv: ["install", "--workspace"],
        rootDir: bundleDir,
        cwd: path.join(bundleDir, subDir),
        env: {},
        installDepsFn: () => {
          depsCalled = true;
        },
      });
      assert.deepEqual(res.res, { handled: true, exitCode: 1 });
      assert.ok(res.err.includes(`cannot be inside source bundle directory (${subDir})`));
      assert.equal(depsCalled, false);
    }

    // 2. Replace symlinked/junctioned targetDir without deleting symlink target contents
    const homeDir = path.join(tmpRoot, "home-symlink");
    const globalPluginsDir = path.join(homeDir, ".gemini", "config", "plugins");
    const realSymlinkTarget = path.join(tmpRoot, "real-symlink-target");
    fs.mkdirSync(realSymlinkTarget, { recursive: true });
    fs.writeFileSync(path.join(realSymlinkTarget, "preserve.txt"), "keep-me", "utf8");
    const targetDir = path.join(globalPluginsDir, PLUGIN_DIR_NAME);
    fs.mkdirSync(globalPluginsDir, { recursive: true });
    fs.symlinkSync(realSymlinkTarget, targetDir, process.platform === "win32" ? "junction" : "dir");

    const symInstall = execCli({
      argv: ["install"],
      rootDir: bundleDir,
      env: { USERPROFILE: homeDir },
      installDepsFn: () => {},
    });
    assert.deepEqual(symInstall.res, { handled: true, exitCode: 0 });
    assert.ok(symInstall.out.includes("Replaced symlinked plugin directory"));
    assert.equal(fs.lstatSync(targetDir).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(path.join(realSymlinkTarget, "preserve.txt"), "utf8"), "keep-me");

    // 3. Upgrade removes stale files in server/
    const staleServerFile = path.join(targetDir, "server", "obsolete.mjs");
    fs.writeFileSync(staleServerFile, "// stale", "utf8");
    const upgradeInstall = execCli({
      argv: ["install"],
      rootDir: bundleDir,
      env: { USERPROFILE: homeDir },
      installDepsFn: () => {},
    });
    assert.deepEqual(upgradeInstall.res, { handled: true, exitCode: 0 });
    assert.equal(fs.existsSync(staleServerFile), false);
    assert.equal(fs.existsSync(path.join(targetDir, "server", "index.mjs")), true);

    // 4. cleanupLegacyDir preserves legacyDir when it matches or encloses rootDir
    const activeLegacyHome = path.join(tmpRoot, "home-active-legacy");
    const activeLegacyPluginsDir = path.join(activeLegacyHome, ".gemini", "config", "plugins");
    const activeLegacySource = createFakeBundle(path.join(activeLegacyPluginsDir, LEGACY_PLUGIN_DIR_NAME));
    const legacyPreserveRes = execCli({
      argv: ["install"],
      rootDir: activeLegacySource,
      env: { USERPROFILE: activeLegacyHome },
      installDepsFn: () => {},
    });
    assert.deepEqual(legacyPreserveRes.res, { handled: true, exitCode: 0 });
    assert.ok(legacyPreserveRes.out.includes("Skipping automatic removal of active source directory"));
    assert.equal(fs.existsSync(path.join(activeLegacySource, "plugin.json")), true);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
