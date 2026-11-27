import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";

const RUNTIME_HINTS = {
  node: "Install Node.js (v20+ LTS) from https://nodejs.org/",
  npx: "Install Node.js (includes npx) from https://nodejs.org/",
  npm: "Install Node.js (includes npm) from https://nodejs.org/",
  python: "Install Python 3 from https://www.python.org/",
  python3: "Install Python 3 from https://www.python.org/",
  uv: "Install uv from https://docs.astral.sh/uv/",
  uvx: "Install uv (includes uvx) from https://docs.astral.sh/uv/",
  docker: "Install Docker Desktop or Docker Engine and ensure the daemon is running.",
  pwsh: "Install PowerShell 7+ from https://learn.microsoft.com/powershell/",
  git: "Install Git from https://git-scm.com/",
};

// Shell built-ins / wrappers that do not require a standalone binary lookup on their own
const SHELL_BUILTINS = new Set([
  "echo", "cd", "set", "export", "test", "[", "true", "false", "exit", "if",
]);

/**
 * Resolve an executable on PATH without spawning external `which`/`where` processes.
 */
export async function findBinaryOnPath(command, { platform = process.platform, env = process.env } = {}) {
  if (!command || typeof command !== "string") return null;
  const trimmed = command.trim().replace(/^["']|["']$/g, "");
  if (!trimmed) return null;

  // Skip bundled plugin-relative scripts (they only exist after extraction)
  if (
    trimmed.includes("${PLUGIN_ROOT}") ||
    trimmed.includes("${PLUGIN_DATA}") ||
    trimmed.startsWith("./") ||
    trimmed.startsWith("../") ||
    trimmed.startsWith(".\\")
  ) {
    return { bundled: true, resolvedPath: null };
  }

  const isWin = platform === "win32";
  const accessMode = isWin ? fsConstants.F_OK : fsConstants.X_OK;

  const canExec = async (candidate) => {
    try {
      const stat = await fs.stat(candidate);
      if (!stat.isFile()) return false;
      await fs.access(candidate, accessMode);
      return true;
    } catch {
      return false;
    }
  };

  // Absolute path check
  if (path.isAbsolute(trimmed)) {
    return (await canExec(trimmed)) ? { bundled: false, resolvedPath: trimmed } : null;
  }

  const pathVar = env.PATH || env.Path || "";
  const dirs = pathVar.split(path.delimiter).filter(Boolean);
  const hasExt = path.extname(trimmed).length > 0;
  const exts = isWin
    ? hasExt
      ? [""]
      : (env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
    : [""];

  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, `${trimmed}${ext}`);
      if (await canExec(candidate)) {
        return { bundled: false, resolvedPath: candidate };
      }
    }
  }
  return null;
}

/** Extract the first executable token from a shell hook string (ignoring leading ENV=val pairs). */
function extractHookBinary(commandLine) {
  const tokens = String(commandLine || "").trim().split(/\s+/);
  for (const tok of tokens) {
    if (!tok || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) continue;
    return tok.replace(/^["']|["']$/g, "");
  }
  return "";
}

/** Detect OS-specific shell syntax mismatches in lifecycle hook commands. */
function detectShellOsMismatch(commandLine, platform) {
  const cmd = String(commandLine || "");
  if (!cmd) return null;

  if (platform === "win32") {
    if (/(?:^|\s)(?:bash|sh|zsh)\s+-c\b|(?:^|\s)(?:chmod|chown|mktemp)\b|\/tmp\/|\/dev\/null\b|\bexport\s+[A-Z0-9_]+=/i.test(cmd)) {
      return {
        severity: "warning",
        code: "OS_POSIX_HOOK_ON_WINDOWS",
        message: `Lifecycle hook uses POSIX shell syntax on Windows: "${cmd.slice(0, 90)}"`,
        hint: "May fail unless Git Bash or WSL is configured on PATH.",
      };
    }
  } else {
    if (/\b(?:powershell\.exe|cmd\.exe|cmd\s+\/c)\b|\.bat\b|\.cmd\b|%USERPROFILE%|%APPDATA%|[A-Z]:\\/i.test(cmd)) {
      return {
        severity: "warning",
        code: "OS_WINDOWS_HOOK_ON_POSIX",
        message: `Lifecycle hook uses Windows-specific syntax on ${platform}: "${cmd.slice(0, 90)}"`,
        hint: "This hook likely targets Windows only and may fail on macOS/Linux.",
      };
    }
    if (/\.ps1\b/i.test(cmd) && !/\bpwsh\b/i.test(cmd)) {
      return {
        severity: "warning",
        code: "OS_PS1_WITHOUT_PWSH",
        message: `Hook invokes a .ps1 script without calling cross-platform pwsh: "${cmd.slice(0, 90)}"`,
        hint: "Install PowerShell 7 (pwsh) or inspect the hook before enabling.",
      };
    }
  }

  return null;
}

/**
 * Run local OS and runtime pre-flight checks against a plugin detail document.
 */
export async function runPreflightChecks(detailDoc, { platform = process.platform, env = process.env } = {}) {
  const warnings = [];
  const missingRuntimes = [];
  const checkedBinaries = new Set();

  const checkRequiredBinary = async (binary, sourceLabel) => {
    if (!binary || SHELL_BUILTINS.has(binary.toLowerCase()) || checkedBinaries.has(binary)) {
      return;
    }
    checkedBinaries.add(binary);

    const found = await findBinaryOnPath(binary, { platform, env });
    if (!found) {
      missingRuntimes.push(binary);
      warnings.push({
        severity: "error",
        code: "MISSING_RUNTIME",
        message: `Required runtime "${binary}" (used by ${sourceLabel}) was not found on PATH.`,
        hint: RUNTIME_HINTS[binary.toLowerCase()] || `Install "${binary}" and ensure it is available on PATH.`,
      });
    }
  };

  // 1. Check stdio MCP server commands
  const mcpServers = detailDoc?.manifest?.mcpServers || [];
  for (const srv of mcpServers) {
    if (srv.transport === "stdio" && srv.command) {
      await checkRequiredBinary(srv.command, `MCP server "${srv.name}"`);
    }
  }

  // 2. Check lifecycle hook shell commands (with fallback to HOOK_SHELL_COMMAND findings)
  const hookCommands = Array.isArray(detailDoc?.manifest?.hooks)
    ? detailDoc.manifest.hooks.map((h) => ({ label: `hook "${h.group}"`, command: h.command }))
    : (detailDoc?.securityReport?.findings || [])
        .filter((f) => f.id === "HOOK_SHELL_COMMAND" && f.snippet)
        .map((f) => ({ label: "lifecycle hook", command: f.snippet }));

  for (const h of hookCommands) {
    if (!h.command) continue;
    const osWarning = detectShellOsMismatch(h.command, platform);
    if (osWarning) warnings.push(osWarning);

    const bin = extractHookBinary(h.command);
    if (bin) {
      await checkRequiredBinary(bin, h.label);
    }
  }

  // 3. Minimum Antigravity App version reminder
  const minApp = detailDoc?.manifest?.minAppVersion;
  if (minApp) {
    warnings.push({
      severity: "info",
      code: "MIN_APP_VERSION",
      message: `Requires Antigravity App v${minApp} or newer.`,
      hint: "Ensure your Antigravity App is up to date if the sidebar UI does not appear.",
    });
  }

  return {
    platform,
    arch: process.arch,
    missingRuntimes,
    warnings,
    hasBlockers: warnings.some((w) => w.severity === "error" || w.severity === "warning"),
  };
}
