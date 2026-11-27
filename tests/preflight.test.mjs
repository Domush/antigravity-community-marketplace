import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { findBinaryOnPath, runPreflightChecks } from "../server/lib/preflight.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-preflight-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function createFakeExecutable(binDir, fileName, { executable = true } = {}) {
  const fullPath = path.join(binDir, fileName);
  await fs.writeFile(fullPath, "#!/bin/sh\necho ok\n", "utf8");
  if (process.platform !== "win32") {
    await fs.chmod(fullPath, executable ? 0o755 : 0o644);
  }
  return fullPath;
}

// ---------------------------------------------------------------------------
// 1. Pre-Flight: PATH Resolution & Missing Runtime Detection
// ---------------------------------------------------------------------------
describe("server/lib/preflight.mjs — PATH resolution and missing runtimes", () => {
  it("resolves executables on PATH (POSIX and Windows PATHEXT) and bypasses bundled paths", async () => {
    await withTempDir(async (binDir) => {
      const posixBin = await createFakeExecutable(binDir, "uvx", { executable: true });
      const winBin = await createFakeExecutable(binDir, "custom-cli.CMD", { executable: true });

      // Bundled plugin-relative scripts bypass PATH checks
      const bundled = await findBinaryOnPath("${PLUGIN_ROOT}/bin/runner.mjs", {
        platform: "linux",
        env: { PATH: "" },
      });
      assert.deepEqual(bundled, { bundled: true, resolvedPath: null });

      const relBundled = await findBinaryOnPath("./scripts/run.sh", {
        platform: "linux",
        env: { PATH: "" },
      });
      assert.deepEqual(relBundled, { bundled: true, resolvedPath: null });

      // POSIX resolution
      const foundPosix = await findBinaryOnPath("uvx", {
        platform: "linux",
        env: { PATH: binDir },
      });
      assert.deepEqual(foundPosix, { bundled: false, resolvedPath: posixBin });

      // Windows PATHEXT resolution
      const foundWin = await findBinaryOnPath("custom-cli", {
        platform: "win32",
        env: { PATH: binDir, PATHEXT: ".EXE;.CMD;.BAT" },
      });
      assert.deepEqual(foundWin, { bundled: false, resolvedPath: winBin });

      // Missing binary returns null
      const missing = await findBinaryOnPath("nonexistent-runtime-xyz", {
        platform: "linux",
        env: { PATH: binDir },
      });
      assert.equal(missing, null);

      // Non-executable file rejected on POSIX hosts
      if (process.platform !== "win32") {
        await createFakeExecutable(binDir, "not-exec", { executable: false });
        const nonExec = await findBinaryOnPath("not-exec", {
          platform: "linux",
          env: { PATH: binDir },
        });
        assert.equal(nonExec, null);
      }
    });
  });

  it("flags missing stdio MCP and hook runtimes, skips HTTP MCPs and shell builtins, and deduplicates warnings", async () => {
    await withTempDir(async (binDir) => {
      await createFakeExecutable(binDir, "node", { executable: true });

      const detailDoc = {
        manifest: {
          minAppVersion: "2.34.0",
          mcpServers: [
            { name: "ok-node", transport: "stdio", command: "node" },
            { name: "missing-uv", transport: "stdio", command: "uvx" },
            { name: "dup-uv", transport: "stdio", command: "uvx" },
            { name: "remote-api", transport: "http", url: "https://mcp.example.com" },
          ],
          hooks: [
            { group: "builtin-check", command: "echo starting" },
            { group: "py-check", command: "ENV_FLAG=1 python3 ./lint.py" },
          ],
        },
      };

      const report = await runPreflightChecks(detailDoc, {
        platform: "linux",
        env: { PATH: binDir },
      });

      assert.equal(report.hasBlockers, true);
      assert.deepEqual(report.missingRuntimes.sort(), ["python3", "uvx"]);

      const missingWarnings = report.warnings.filter((w) => w.code === "MISSING_RUNTIME");
      assert.equal(missingWarnings.length, 2);
      assert.ok(missingWarnings.every((w) => w.severity === "error"));

      // Info reminder for minAppVersion is included
      const minApp = report.warnings.find((w) => w.code === "MIN_APP_VERSION");
      assert.ok(minApp);
      assert.equal(minApp.severity, "info");
      assert.match(minApp.message, /v2\.34\.0/);
    });
  });

  it("falls back to HOOK_SHELL_COMMAND findings when manifest.hooks is omitted and reports no blockers for info-only checks", async () => {
    await withTempDir(async (binDir) => {
      await createFakeExecutable(binDir, "node", { executable: true });

      // Info-only plugin (all runtimes present, only minAppVersion notice)
      const cleanReport = await runPreflightChecks(
        {
          manifest: {
            minAppVersion: "2.34.0",
            mcpServers: [{ name: "srv", transport: "stdio", command: "node" }],
            hooks: [],
          },
        },
        { platform: "linux", env: { PATH: binDir } }
      );
      assert.equal(cleanReport.hasBlockers, false);
      assert.deepEqual(cleanReport.missingRuntimes, []);
      assert.equal(cleanReport.warnings.length, 1);
      assert.equal(cleanReport.warnings[0].code, "MIN_APP_VERSION");

      // Legacy detailDoc without manifest.hooks falls back to securityReport.findings
      const fallbackReport = await runPreflightChecks(
        {
          manifest: { mcpServers: [] },
          securityReport: {
            findings: [
              { id: "HOOK_SHELL_COMMAND", snippet: "docker compose exec app test" },
            ],
          },
        },
        { platform: "linux", env: { PATH: binDir } }
      );
      assert.equal(fallbackReport.hasBlockers, true);
      assert.deepEqual(fallbackReport.missingRuntimes, ["docker"]);
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Pre-Flight: Windows vs POSIX Lifecycle Hook Mismatches
// ---------------------------------------------------------------------------
describe("server/lib/preflight.mjs — Windows vs POSIX hook compatibility", () => {
  it("flags POSIX shell hooks when running on Windows", async () => {
    await withTempDir(async (binDir) => {
      await createFakeExecutable(binDir, "bash.EXE", { executable: true });
      await createFakeExecutable(binDir, "chmod.EXE", { executable: true });

      const detailDoc = {
        manifest: {
          mcpServers: [],
          hooks: [
            { group: "posix-subshell", command: 'bash -c "echo hi > /tmp/agy.log"' },
            { group: "posix-chmod", command: "chmod +x ./scripts/hook.sh" },
            { group: "posix-export", command: "export AGY_MODE=1 && echo ok" },
          ],
        },
      };

      const report = await runPreflightChecks(detailDoc, {
        platform: "win32",
        env: { PATH: binDir, PATHEXT: ".EXE;.CMD" },
      });

      assert.equal(report.hasBlockers, true);
      assert.deepEqual(report.missingRuntimes, []);
      const osWarnings = report.warnings.filter((w) => w.code === "OS_POSIX_HOOK_ON_WINDOWS");
      assert.equal(osWarnings.length, 3);
      assert.ok(osWarnings.every((w) => w.severity === "warning"));
    });
  });

  it("flags Windows-only hooks and bare .ps1 scripts on POSIX, while allowing cross-platform pwsh", async () => {
    await withTempDir(async (binDir) => {
      await createFakeExecutable(binDir, "pwsh", { executable: true });
      await createFakeExecutable(binDir, "powershell.exe", { executable: true });
      await createFakeExecutable(binDir, "cmd.exe", { executable: true });

      const detailDoc = {
        manifest: {
          mcpServers: [],
          hooks: [
            { group: "win-ps", command: "powershell.exe -File ./audit.ps1" },
            { group: "win-cmd", command: "cmd.exe /c echo %USERPROFILE%" },
            { group: "bare-ps1", command: "./scripts/audit-gate.ps1" },
            { group: "cross-pwsh", command: "pwsh -NoProfile -File ./scripts/audit-gate.ps1" },
          ],
        },
      };

      const report = await runPreflightChecks(detailDoc, {
        platform: "linux",
        env: { PATH: binDir },
      });

      assert.equal(report.hasBlockers, true);
      assert.deepEqual(report.missingRuntimes, []);

      const codes = report.warnings.map((w) => w.code);
      assert.equal(codes.filter((c) => c === "OS_WINDOWS_HOOK_ON_POSIX").length, 2);
      assert.equal(codes.filter((c) => c === "OS_PS1_WITHOUT_PWSH").length, 1);

      // Verify cross-platform pwsh hook produced zero warnings
      const pwshOnly = await runPreflightChecks(
        {
          manifest: {
            mcpServers: [],
            hooks: [{ group: "cross-pwsh", command: "pwsh -NoProfile -File ./scripts/audit-gate.ps1" }],
          },
        },
        { platform: "darwin", env: { PATH: binDir } }
      );
      assert.equal(pwshOnly.hasBlockers, false);
      assert.deepEqual(pwshOnly.warnings, []);
    });
  });
});
