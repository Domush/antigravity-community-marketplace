import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  removePluginEntry,
  stripTrailingSeparators,
  syncPluginDirectory,
} from "./cli-sync.mjs";

export { removePluginEntry, syncPluginDirectory };

export const PLUGIN_DIR_NAME = "agy-community-marketplace";
export const LEGACY_PLUGIN_DIR_NAME = "antigravity-community-marketplace";

export const REQUIRED_FILES = [
  "plugin.json",
  "mcp_config.json",
  "package.json",
  "README.md",
  "LICENSE",
  "CHANGELOG.md",
];

export const REQUIRED_DIRS = ["server", "sidecars"];
const REQUIRED_SIDECAR_FILES = [
  ["sidecars", "marketplace", "sidecar.json"],
  ["sidecars", "marketplace", "server.mjs"],
];
const UI_BUNDLE_REL_PARTS = ["ui", "dist", "marketplace.html"];
const VALID_INSTALL_FLAGS = new Set(["--global", "-g", "--workspace", "-w"]);
const MCP_SERVER_FLAGS = new Set([
  "--data-dir",
  "--registry-url",
  "--public-key-file",
  "--insecure-skip-verify",
]);

/**
 * Load and validate the package version from package.json.
 */
export function loadPackageVersion(rootDir) {
  if (typeof rootDir !== "string" || rootDir.trim().length === 0) {
    throw new TypeError("loadPackageVersion requires a non-empty rootDir string");
  }

  const pkgPath = path.join(rootDir, "package.json");
  let raw;
  try {
    raw = fs.readFileSync(pkgPath, "utf8");
  } catch (err) {
    throw new Error(`Failed to read package.json at ${pkgPath}: ${err.message}`);
  }

  let pkg;
  try {
    pkg = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse package.json at ${pkgPath}: ${err.message}`);
  }

  if (!pkg || typeof pkg.version !== "string" || pkg.version.trim().length === 0) {
    throw new Error(`Invalid or missing "version" field in ${pkgPath}`);
  }

  return pkg.version.trim();
}

function canonicalizePath(targetPath) {
  const resolved = stripTrailingSeparators(targetPath);
  let canonical = resolved;
  try {
    canonical = fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
  } catch (err) {
    if (!err || err.code !== "ENOENT") {
      throw err;
    }
    const parent = path.dirname(resolved);
    if (parent !== resolved) {
      canonical = path.join(canonicalizePath(parent), path.basename(resolved));
    }
  }
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

function normalizeLiteralPath(targetPath) {
  const resolved = stripTrailingSeparators(targetPath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isNormalizedPathSameOrNested(parentCanonical, childCanonical) {
  if (parentCanonical === childCanonical) return true;
  const prefix = parentCanonical.endsWith(path.sep) ? parentCanonical : parentCanonical + path.sep;
  return childCanonical.startsWith(prefix);
}

function canonicalizeEntryPath(targetPath) {
  const resolved = stripTrailingSeparators(targetPath);
  const parent = path.dirname(resolved);
  let canonical = resolved;
  try {
    const stat = fs.lstatSync(resolved);
    if (!stat.isSymbolicLink()) {
      return canonicalizePath(resolved);
    }
    canonical = parent === resolved
      ? resolved
      : path.join(canonicalizePath(parent), path.basename(resolved));
  } catch (err) {
    if (!err || err.code !== "ENOENT") {
      throw err;
    }
    canonical = parent === resolved
      ? resolved
      : path.join(canonicalizePath(parent), path.basename(resolved));
  }
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

function isEntrySameOrEnclosesSource(entryPath, sourceDir) {
  const entryCanonical = canonicalizeEntryPath(entryPath);
  return (
    isNormalizedPathSameOrNested(entryCanonical, canonicalizePath(sourceDir)) ||
    isNormalizedPathSameOrNested(entryCanonical, canonicalizeEntryPath(sourceDir)) ||
    isNormalizedPathSameOrNested(normalizeLiteralPath(entryPath), normalizeLiteralPath(sourceDir))
  );
}

function isSourceEnclosingEntry(sourceDir, entryPath) {
  const entryCanonical = canonicalizeEntryPath(entryPath);
  return (
    isNormalizedPathSameOrNested(canonicalizePath(sourceDir), entryCanonical) ||
    isNormalizedPathSameOrNested(canonicalizeEntryPath(sourceDir), entryCanonical)
  );
}

function removeIfSymlinkOrMismatched(destPath, expectDirectory) {
  let stat;
  try {
    stat = fs.lstatSync(destPath);
  } catch (err) {
    if (err && err.code === "ENOENT") return;
    throw err;
  }
  const mismatch = expectDirectory ? !stat.isDirectory() : stat.isDirectory();
  if (stat.isSymbolicLink() || mismatch) {
    removePluginEntry(destPath);
  }
}

function copyFileSafely(srcFile, destFile) {
  removeIfSymlinkOrMismatched(destFile, false);
  fs.copyFileSync(srcFile, destFile);
}

function ensureRealDirectoryPath(baseDir, relParts) {
  let current = baseDir;
  for (const part of relParts) {
    current = path.join(current, part);
    removeIfSymlinkOrMismatched(current, true);
    fs.mkdirSync(current, { recursive: true });
  }
  return current;
}

function validateInstallSourceBundle(rootDir) {
  for (const file of REQUIRED_FILES) {
    const src = path.join(rootDir, file);
    if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
      throw new Error(`Missing required plugin file: ${src}`);
    }
  }
  for (const dir of REQUIRED_DIRS) {
    const srcDir = path.join(rootDir, dir);
    if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) {
      throw new Error(`Missing required plugin directory: ${srcDir}`);
    }
  }
  for (const parts of REQUIRED_SIDECAR_FILES) {
    const sidecarFile = path.join(rootDir, ...parts);
    if (!fs.existsSync(sidecarFile) || !fs.statSync(sidecarFile).isFile()) {
      throw new Error(`Missing required sidecar file: ${sidecarFile}`);
    }
  }
  const uiBundlePath = path.join(rootDir, ...UI_BUNDLE_REL_PARTS);
  if (!fs.existsSync(uiBundlePath) || !fs.statSync(uiBundlePath).isFile()) {
    throw new Error(`Missing required built UI bundle: ${uiBundlePath}`);
  }
}

function resolveNpmCliScript(env) {
  const execPath = typeof env.npm_execpath === "string" ? env.npm_execpath.trim() : "";
  if (execPath && /\.(c|m)?js$/i.test(execPath) && fs.existsSync(execPath)) return execPath;
  const nodeBinDir = path.dirname(process.execPath);
  const candidates = [
    path.join(nodeBinDir, "node_modules", "npm", "bin", "npm-cli.js"),
    path.resolve(nodeBinDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function defaultInstallDependencies(targetDir, env) {
  const npmArgs = ["install", "--omit=dev", "--no-audit", "--no-fund", "--ignore-scripts"];
  const npmCli = resolveNpmCliScript(env);
  const spawnOpts = { cwd: targetDir, stdio: "pipe", encoding: "utf8" };
  const result = npmCli
    ? spawnSync(process.execPath, [npmCli, ...npmArgs], spawnOpts)
    : spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", npmArgs, {
        ...spawnOpts,
        shell: process.platform === "win32",
      });

  if (result.error) {
    throw new Error(`Failed to invoke npm to install runtime dependencies: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(`npm dependency installation exited with status ${result.status}${detail ? `: ${detail}` : ""}`);
  }
}

function parseInstallScopeFlags(cmd, flags) {
  for (const flag of flags) {
    if (!VALID_INSTALL_FLAGS.has(flag)) {
      throw new Error(`Unknown option "${flag}" for ${cmd}. Run with --help for usage.`);
    }
  }
  const isWorkspace = flags.includes("--workspace") || flags.includes("-w");
  const isGlobal = flags.includes("--global") || flags.includes("-g");
  if (isWorkspace && isGlobal) {
    throw new Error(`Cannot specify both --global and --workspace for ${cmd}.`);
  }
  return { isWorkspace };
}

function printHelp(pkgVersion, stdout) {
  stdout(`
Antigravity Community Plugin Marketplace CLI (v${pkgVersion})

Usage:
  npx antigravity-community-marketplace install [options]     Install plugin into Google Antigravity
  npx antigravity-community-marketplace uninstall [options]   Remove installed plugin
  npx antigravity-community-marketplace                      Start MCP stdio JSON-RPC server

Options:
  --global, -g     Install globally in ~/.gemini/config/plugins/${PLUGIN_DIR_NAME} (default)
  --workspace, -w  Install in current workspace (.agents/plugins/${PLUGIN_DIR_NAME})
`);
}

function handleUninstall({ targetDir, legacyDir, stdout, stderr }) {
  try {
    const removedTarget = removePluginEntry(targetDir);
    const removedLegacy = removePluginEntry(legacyDir);

    if (removedTarget) {
      stdout(`\n✔ Antigravity Community Marketplace successfully removed from:`);
      stdout(`  ${targetDir}\n`);
    }
    if (removedLegacy) {
      stdout(`\n🧹 Removed legacy plugin directory:`);
      stdout(`  ${legacyDir}\n`);
    }
    if (!removedTarget && !removedLegacy) {
      stdout(`\nℹ Plugin not found at: ${targetDir}\n`);
    }
    return { handled: true, exitCode: 0 };
  } catch (err) {
    stderr(`\n❌ Uninstall failed: ${err.message}\n`);
    return { handled: true, exitCode: 1 };
  }
}

function cleanupLegacyDir({ legacyDir, targetDir, rootDir, stdout, stderr }) {
  if (canonicalizeEntryPath(legacyDir) === canonicalizeEntryPath(targetDir)) return;
  if (isEntrySameOrEnclosesSource(legacyDir, rootDir)) {
    if (fs.existsSync(legacyDir)) {
      stdout(`ℹ Skipping automatic removal of active source directory: ${legacyDir}`);
    }
    return;
  }
  try {
    if (removePluginEntry(legacyDir)) {
      stdout(`🧹 Migrated legacy plugin directory (removed ${legacyDir})`);
    }
  } catch (legacyErr) {
    if (
      legacyErr?.code === "EPERM" ||
      legacyErr?.code === "EBUSY" ||
      legacyErr?.code === "ENOTEMPTY"
    ) {
      stderr(
        `⚠ Could not remove legacy plugin directory (${legacyDir}) because it is currently in use by an active session (${legacyErr.code}). Restart Antigravity and remove it manually or re-run install/uninstall.`
      );
      return;
    }
    throw legacyErr;
  }
}

/**
 * Execute CLI subcommands when arguments are supplied.
 * Returns { handled: boolean, exitCode: number }.
 */
export function runCli({
  argv = process.argv.slice(2),
  rootDir,
  cwd = process.cwd(),
  env = process.env,
  stdout = console.log,
  stderr = console.error,
  installDepsFn,
} = {}) {
  if (!Array.isArray(argv)) {
    throw new TypeError("runCli requires argv to be an array");
  }
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    throw new TypeError("runCli requires env to be an object");
  }
  if (typeof stdout !== "function") {
    throw new TypeError("runCli requires stdout to be a function");
  }
  if (typeof stderr !== "function") {
    throw new TypeError("runCli requires stderr to be a function");
  }
  if (installDepsFn !== undefined && typeof installDepsFn !== "function") {
    throw new TypeError("runCli requires installDepsFn to be a function when provided");
  }
  if (argv.length === 0 || MCP_SERVER_FLAGS.has(argv[0])) {
    return { handled: false, exitCode: 0 };
  }
  if (typeof rootDir !== "string" || rootDir.trim().length === 0) {
    throw new TypeError("runCli requires a non-empty rootDir string");
  }

  const pkgVersion = loadPackageVersion(rootDir);
  const [cmd, ...rest] = argv;

  if (cmd === "--version" || cmd === "-v") {
    if (rest.length > 0) {
      stderr(`Unknown option(s) for ${cmd}: ${rest.join(" ")}. Run with --help for usage.`);
      return { handled: true, exitCode: 1 };
    }
    stdout(`antigravity-community-marketplace v${pkgVersion}`);
    return { handled: true, exitCode: 0 };
  }

  if (cmd === "--help" || cmd === "-h") {
    if (rest.length > 0) {
      stderr(`Unknown option(s) for ${cmd}: ${rest.join(" ")}. Run with --help for usage.`);
      return { handled: true, exitCode: 1 };
    }
    printHelp(pkgVersion, stdout);
    return { handled: true, exitCode: 0 };
  }

  if (cmd !== "install" && cmd !== "uninstall") {
    stderr(`Unknown CLI command or option: ${argv.join(" ")}. Run with --help for usage.`);
    return { handled: true, exitCode: 1 };
  }

  let isWorkspace;
  try {
    ({ isWorkspace } = parseInstallScopeFlags(cmd, rest));
  } catch (err) {
    stderr(`\n❌ ${err.message}\n`);
    return { handled: true, exitCode: 1 };
  }

  const rawUserProfile = typeof env.USERPROFILE === "string" ? env.USERPROFILE.trim() : "";
  const rawHome = typeof env.HOME === "string" ? env.HOME.trim() : "";
  const homeDir = rawUserProfile || rawHome;
  if (!isWorkspace && !homeDir) {
    stderr("\n❌ Could not determine home directory (USERPROFILE/HOME is not set).\n");
    return { handled: true, exitCode: 1 };
  }
  if (isWorkspace && (typeof cwd !== "string" || cwd.trim().length === 0)) {
    throw new TypeError("runCli requires a non-empty cwd string when using --workspace");
  }

  const pluginsDir = isWorkspace
    ? path.join(cwd, ".agents", "plugins")
    : path.join(homeDir, ".gemini", "config", "plugins");
  const targetDir = path.join(pluginsDir, PLUGIN_DIR_NAME);
  const legacyDir = path.join(pluginsDir, LEGACY_PLUGIN_DIR_NAME);

  if (cmd === "uninstall") {
    return handleUninstall({ targetDir, legacyDir, stdout, stderr });
  }

  stdout(`\n📦 Installing Antigravity Community Marketplace v${pkgVersion}...`);
  try {
    if (isEntrySameOrEnclosesSource(targetDir, rootDir)) {
      throw new Error(`Target directory (${targetDir}) matches or encloses source directory (${rootDir}); refusing self-overwrite.`);
    }
    for (const dir of [...REQUIRED_DIRS, "ui"]) {
      if (isSourceEnclosingEntry(path.join(rootDir, dir), targetDir)) {
        throw new Error(`Target directory (${targetDir}) cannot be inside source bundle directory (${dir}).`);
      }
    }

    validateInstallSourceBundle(rootDir);

    try {
      if (fs.lstatSync(targetDir).isSymbolicLink()) {
        removePluginEntry(targetDir);
        stdout(`🧹 Replaced symlinked plugin directory: ${targetDir}`);
      }
    } catch (statErr) {
      if (!statErr || statErr.code !== "ENOENT") throw statErr;
    }

    fs.mkdirSync(targetDir, { recursive: true });
    for (const file of REQUIRED_FILES) {
      copyFileSafely(path.join(rootDir, file), path.join(targetDir, file));
    }
    const optionalIconPath = path.join(rootDir, "icon.svg");
    if (fs.existsSync(optionalIconPath)) {
      copyFileSafely(optionalIconPath, path.join(targetDir, "icon.svg"));
    }
    for (const dir of REQUIRED_DIRS) {
      const destDir = path.join(targetDir, dir);
      syncPluginDirectory(path.join(rootDir, dir), destDir);
    }

    const uiDestDir = ensureRealDirectoryPath(targetDir, ["ui", "dist"]);
    copyFileSafely(path.join(rootDir, ...UI_BUNDLE_REL_PARTS), path.join(uiDestDir, "marketplace.html"));

    stdout(`📥 Installing runtime dependencies...`);
    if (installDepsFn) installDepsFn(targetDir);
    else defaultInstallDependencies(targetDir, env);

    cleanupLegacyDir({ legacyDir, targetDir, rootDir, stdout, stderr });

    stdout(`\n✨ Installation complete!`);
    stdout(`📍 Location: ${targetDir}`);
    stdout(`🚀 Restart or open the Google Antigravity App to activate Community Plugins.\n`);
    return { handled: true, exitCode: 0 };
  } catch (err) {
    stderr(`\n❌ Installation failed: ${err.message}\n`);
    return { handled: true, exitCode: 1 };
  }
}
