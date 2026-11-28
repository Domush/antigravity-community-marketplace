import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const SYSTEM_OR_SHELL_ANCESTORS = new Set([
  "explorer.exe",
  "wininit.exe",
  "services.exe",
  "lsass.exe",
  "csrss.exe",
  "smss.exe",
  "winlogon.exe",
  "userinit.exe",
  "svchost.exe",
  "windowsterminal.exe",
  "wt.exe",
  "conhost.exe",
  "pwsh.exe",
  "powershell.exe",
  "bash.exe",
  "zsh.exe",
  "sh.exe",
]);

const LOCK_HOLDER_PATTERN = /antigravity|language[_-]?server/i;
const LANGUAGE_SERVER_PATTERN = /language[_-]?server/i;
const ANTIGRAVITY_PATTERN = /antigravity/i;
const MAX_ANCESTOR_DEPTH = 32;
const POWERSHELL_TIMEOUT_MS = 5000;

function isExistingFile(filePath, existsSyncFn, statSyncFn) {
  if (typeof filePath !== "string" || !filePath.trim()) return false;
  try {
    return existsSyncFn(filePath) && statSyncFn(filePath).isFile();
  } catch {
    return false;
  }
}

export function isNodeExecutablePath(execPath) {
  if (typeof execPath !== "string" || !execPath.trim()) return false;
  const base = path.basename(execPath.trim()).toLowerCase();
  return base === "node.exe" || base === "node";
}

/**
 * Resolve an independent `node.exe` binary on Windows so background workers do
 * not spawn `Antigravity.exe` inside the host shutdown process tree.
 * Falls back cleanly to `execPath` when no standalone `node.exe` is available.
 */
export function resolveWindowsNodeExecutable({
  execPath = process.execPath,
  env = process.env,
  existsSyncFn = fs.existsSync,
  statSyncFn = fs.statSync,
} = {}) {
  if (isNodeExecutablePath(execPath) && isExistingFile(execPath, existsSyncFn, statSyncFn)) {
    return execPath;
  }

  const pathVar = env?.PATH || env?.Path || "";
  for (const rawDir of pathVar.split(path.delimiter)) {
    const dir = rawDir.trim().replace(/^"|"$/g, "");
    if (!dir) continue;
    const candidate = path.join(dir, "node.exe");
    if (isExistingFile(candidate, existsSyncFn, statSyncFn)) {
      return candidate;
    }
  }

  const standardCandidates = [
    env?.NVM_SYMLINK ? path.join(env.NVM_SYMLINK, "node.exe") : null,
    env?.ProgramFiles ? path.join(env.ProgramFiles, "nodejs", "node.exe") : null,
    env?.["ProgramFiles(x86)"] ? path.join(env["ProgramFiles(x86)"], "nodejs", "node.exe") : null,
    env?.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "Programs", "nodejs", "node.exe") : null,
    env?.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "Volta", "bin", "node.exe") : null,
  ];
  for (const candidate of standardCandidates) {
    if (candidate && isExistingFile(candidate, existsSyncFn, statSyncFn)) {
      return candidate;
    }
  }

  return execPath;
}

/**
 * Quote a single argument according to Windows CreateProcess / CommandLineToArgvW rules.
 */
export function quoteWindowsArg(arg) {
  const str = String(arg ?? "");
  if (str.length > 0 && !/[\s"&|<>^()]/.test(str)) {
    return str;
  }
  let out = '"';
  let backslashes = 0;
  for (const ch of str) {
    if (ch === "\\") {
      backslashes += 1;
    } else if (ch === '"') {
      out += "\\".repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
    } else {
      if (backslashes > 0) {
        out += "\\".repeat(backslashes);
        backslashes = 0;
      }
      out += ch;
    }
  }
  if (backslashes > 0) {
    out += "\\".repeat(backslashes * 2);
  }
  out += '"';
  return out;
}

export function buildWindowsCommandLine(executable, args = []) {
  return [quoteWindowsArg(executable), ...args.map(quoteWindowsArg)].join(" ");
}

function encodePowerShellCommand(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

function escapePowerShellSingleQuoted(value) {
  return String(value ?? "").replaceAll("'", "''");
}

function parseJsonLinesOrBlob(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return null;
  return JSON.parse(trimmed);
}

/**
 * Discover ancestor Antigravity and language-server lock-holder PIDs on Windows
 * (plus any child language-server processes under the matched Antigravity parent).
 */
export function discoverWindowsLockHolderPids({
  startPid = process.pid,
  spawnSyncFn = spawnSync,
} = {}) {
  if (!Number.isInteger(startPid) || startPid <= 0) {
    return [];
  }

  const psScript = [
    "$ProgressPreference = 'SilentlyContinue'",
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath | ConvertTo-Json -Compress",
  ].join("; ");

  let result;
  try {
    result = spawnSyncFn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShellCommand(psScript)],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: POWERSHELL_TIMEOUT_MS,
      }
    );
  } catch {
    return [];
  }

  if (!result || result.error || result.status !== 0) {
    return [];
  }

  let parsed;
  try {
    parsed = parseJsonLinesOrBlob(result.stdout);
  } catch {
    return [];
  }

  const rows = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" ? [parsed] : [];
  const byPid = new Map();
  for (const row of rows) {
    const pid = Number(row?.ProcessId);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    byPid.set(pid, {
      pid,
      ppid: Number(row?.ParentProcessId) || 0,
      name: String(row?.Name || ""),
      exe: String(row?.ExecutablePath || ""),
    });
  }

  const collected = new Set();
  const antigravityAncestorPids = new Set();
  const visited = new Set([startPid]);
  let cursor = byPid.get(startPid)?.ppid ?? 0;

  for (let depth = 0; depth < MAX_ANCESTOR_DEPTH && cursor > 0 && !visited.has(cursor); depth += 1) {
    visited.add(cursor);
    const proc = byPid.get(cursor);
    if (!proc) break;

    const baseName = proc.name.toLowerCase();
    if (SYSTEM_OR_SHELL_ANCESTORS.has(baseName)) {
      break;
    }

    const identity = `${proc.name} ${proc.exe}`;
    if (LOCK_HOLDER_PATTERN.test(identity)) {
      collected.add(proc.pid);
      if (ANTIGRAVITY_PATTERN.test(identity)) {
        antigravityAncestorPids.add(proc.pid);
      }
    }

    cursor = proc.ppid;
  }

  // Also include language_server processes spawned by the same parent Antigravity instance
  if (antigravityAncestorPids.size > 0) {
    for (const proc of byPid.values()) {
      if (proc.pid === startPid) continue;
      if (!antigravityAncestorPids.has(proc.ppid)) continue;
      if (LANGUAGE_SERVER_PATTERN.test(`${proc.name} ${proc.exe}`)) {
        collected.add(proc.pid);
      }
    }
  }

  return [...collected];
}

/**
 * Launch a headless Windows process via WMI `Win32_Process.Create` so it runs
 * under `WmiPrvSE.exe` outside the host process tree and Windows Job Object.
 */
export function launchWindowsDetachedWmi({
  executable,
  args = [],
  envOverrides = null,
  env = process.env,
  spawnSyncFn = spawnSync,
} = {}) {
  if (typeof executable !== "string" || !executable.trim()) {
    throw new TypeError("launchWindowsDetachedWmi requires a non-empty executable path.");
  }

  const commandLine = buildWindowsCommandLine(executable, args);
  const psLines = [
    "$ProgressPreference = 'SilentlyContinue'",
    "$startupProps = @{ ShowWindow = [uint16]0 }",
  ];

  if (envOverrides && typeof envOverrides === "object" && Object.keys(envOverrides).length > 0) {
    const mergedEnv = { ...env, ...envOverrides };
    const envPairs = Object.entries(mergedEnv)
      .filter(([k, v]) => k && v !== undefined && v !== null)
      .map(([k, v]) => `'${escapePowerShellSingleQuoted(`${k}=${v}`)}'`);
    psLines.push(`$startupProps['EnvironmentVariables'] = [string[]]@(${envPairs.join(",")})`);
  }

  psLines.push(
    "$startup = New-CimInstance -ClassName Win32_ProcessStartup -Property $startupProps -ClientOnly",
    `$res = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${escapePowerShellSingleQuoted(commandLine)}'; ProcessStartupInformation = $startup }`,
    "Write-Output ($res | Select-Object ReturnValue,ProcessId | ConvertTo-Json -Compress)"
  );

  let result;
  try {
    result = spawnSyncFn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShellCommand(psLines.join("; "))],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: POWERSHELL_TIMEOUT_MS,
      }
    );
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }

  if (!result || result.error || result.status !== 0) {
    const detail = result?.error?.message || result?.stderr?.trim() || `exit ${result?.status ?? "unknown"}`;
    return { ok: false, error: detail };
  }

  try {
    const parsed = parseJsonLinesOrBlob(result.stdout);
    const returnValue = parsed?.ReturnValue;
    const pid = parsed?.ProcessId;
    if (
      Number.isInteger(returnValue) &&
      returnValue === 0 &&
      Number.isInteger(pid) &&
      pid > 0
    ) {
      return { ok: true, pid };
    }
    return { ok: false, error: `Win32_Process.Create returned code ${parsed?.ReturnValue}` };
  } catch (err) {
    return { ok: false, error: `Invalid WMI response: ${err?.message || err}` };
  }
}
