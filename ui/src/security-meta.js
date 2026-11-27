// ---------------------------------------------------------------------------
// Security Risk, Capability Descriptions & Finding Display Helpers
// ---------------------------------------------------------------------------
export const RISK_ORDER = { low: 0, elevated: 1, high: 2, unverified: 3 };

export const RISK_DESCRIPTIONS = {
  low: "Low risk: prompt rules or read-only workspace tooling with no elevated execution or external network permissions.",
  elevated: "Elevated risk: runs local tools, lifecycle hooks, or makes outbound network calls. Review audit details before installing.",
  high: "High risk: matched sensitive patterns such as dynamic code evaluation, credential access, obfuscated code, or suspicious prompt directives.",
  unverified: "Unverified: local or unindexed plugin that has not been scanned by the community registry.",
};

export const CAPABILITY_LABELS = {
  runs_shell_hooks: "Shell Lifecycle Hooks",
  runs_prompt_hooks: "Prompt Lifecycle Hooks",
  accesses_gemini_dir: "Reads ~/.gemini Data",
  unpinned_remote_runtime: "Unpinned Remote Package (npx/uvx)",
  prompt_injection_suspect: "Suspicious Prompt Directives",
  credential_access: "Accesses Credential Paths",
  process_spawn: "Spawns OS Processes",
  dynamic_code_exec: "Dynamic Code Execution (eval)",
  mcp_local_exec: "Local Executable (stdio MCP)",
  network_external_mcp: "Remote External MCP",
  network_outbound: "Outbound Network Calls",
  fs_write_workspace: "Writes Workspace Files",
  fs_read_workspace: "Reads Workspace Files",
  fs_outside_workspace: "Reads Outside Workspace",
  contains_minified: "Minified / Obfuscated Code",
  prompt_mentions_shell: "Prompt Requests Shell Commands",
  prompt_rules_only: "Prompt / Rules Only",
};

export const CAPABILITY_DESCRIPTIONS = {
  runs_shell_hooks: "Appears because hooks.json or the manifest runs shell commands automatically during Antigravity lifecycle events.",
  runs_prompt_hooks: "Appears because hooks.json registers prompt-only lifecycle hooks without executing shell commands.",
  accesses_gemini_dir: "Reads or writes files under ~/.gemini/ (normal for Antigravity telemetry/config plugins).",
  unpinned_remote_runtime: "Appears because the plugin invokes npx, uvx, or a remote package runner without pinning an exact package version.",
  prompt_injection_suspect: "Appears because skill, rule, or agent Markdown matched static heuristics for hidden directives or instruction overrides.",
  credential_access: "Appears because code or configuration references sensitive credential paths, SSH/AWS folders, or secret environment variables.",
  process_spawn: "Appears because plugin scripts or MCP code spawn child operating system processes (such as exec, spawn, or subprocess).",
  dynamic_code_exec: "Appears because plugin code uses dynamic evaluation (such as eval or Function) that executes strings as code.",
  mcp_local_exec: "Appears because mcp_config.json configures a local stdio MCP server process executed directly on your machine.",
  network_external_mcp: "Appears because mcp_config.json connects to a remote HTTP/SSE MCP server hosted outside your machine.",
  network_outbound: "Appears because plugin code performs outbound HTTP, fetch, or socket network requests.",
  fs_write_workspace: "Appears because plugin code or instructions write or modify files inside your project workspace.",
  fs_read_workspace: "Appears because plugin code reads files inside your project workspace.",
  fs_outside_workspace: "Appears because plugin code reads or accesses paths outside the active project workspace.",
  contains_minified: "Appears because the repository contains minified or heavily obfuscated code that cannot be cleanly audited.",
  prompt_mentions_shell: "Appears because skill or agent instructions tell the AI assistant to execute shell or terminal commands.",
  prompt_rules_only: "Appears because the plugin provides only Markdown prompts, skills, or rules with no executable scripts or servers.",
};

export const ELEVATED_CAPABILITIES = new Set([
  "runs_shell_hooks",
  "unpinned_remote_runtime",
  "prompt_injection_suspect",
  "credential_access",
  "process_spawn",
  "dynamic_code_exec",
  "mcp_local_exec",
  "network_external_mcp",
  "network_outbound",
  "fs_outside_workspace",
  "contains_minified",
]);

const FINDING_CAPABILITY_RULES = [
  [/HOOK_SHELL|SHELL_HOOK/i, "runs_shell_hooks"],
  [/HOOK_PROMPT|PROMPT_HOOK/i, "runs_prompt_hooks"],
  [/UNPINNED|NPX|UVX/i, "unpinned_remote_runtime"],
  [/PROMPT_INJECTION|INJECTION/i, "prompt_injection_suspect"],
  [/CREDENTIAL|SECRET|TOKEN|SSH|AWS/i, "credential_access"],
  [/SPAWN|SUBPROCESS|CHILD_PROCESS|SHELL_EXEC|\bEXEC\b/i, "process_spawn"],
  [/\bEVAL\b|DYNAMIC_CODE|NEW_FUNCTION/i, "dynamic_code_exec"],
  [/MCP_STDIO|MCP_LOCAL/i, "mcp_local_exec"],
  [/MCP_REMOTE|EXTERNAL_MCP/i, "network_external_mcp"],
  [/NETWORK|FETCH|AXIOS|HTTP|SOCKET/i, "network_outbound"],
  [/OUTSIDE_WORKSPACE|PATH_TRAVERSAL|HOMEDIR/i, "fs_outside_workspace"],
  [/GEMINI_DATA_ACCESS|ACCESSES_GEMINI_DIR/i, "accesses_gemini_dir"],
  [/FS_WRITE|WRITE_FILE/i, "fs_write_workspace"],
  [/FS_READ|READ_FILE/i, "fs_read_workspace"],
  [/MINIFIED|OBFUSCAT/i, "contains_minified"],
  [/PROMPT_SHELL/i, "prompt_mentions_shell"],
];

export function capLabel(key) {
  return CAPABILITY_LABELS[key] || String(key || "").replaceAll("_", " ");
}

export function capDescription(key) {
  return CAPABILITY_DESCRIPTIONS[key] || "Capability detected during static security analysis of the plugin.";
}

export function riskDescription(tier) {
  return RISK_DESCRIPTIONS[tier] || RISK_DESCRIPTIONS.unverified;
}

export function severityDescription(severity) {
  if (severity === "critical" || severity === "high") {
    return "High severity finding: inspect the linked source line carefully before trusting or installing this plugin.";
  }
  if (severity === "medium") {
    return "Medium severity finding: verify that the flagged behavior matches what this plugin is expected to do.";
  }
  return "Low or informational finding flagged during automated static analysis.";
}

export function inferFindingCapability(finding) {
  if (finding?.capability && typeof finding.capability === "string") {
    return finding.capability;
  }
  const haystack = `${finding?.id || ""} ${finding?.message || ""}`;
  for (const [pattern, capability] of FINDING_CAPABILITY_RULES) {
    if (pattern.test(haystack)) return capability;
  }
  return null;
}

export function formatFindingSnippet(snippet) {
  if (typeof snippet !== "string") return null;
  const trimmed = snippet.trim();
  if (!trimmed || trimmed.toLowerCase() === "requires login") {
    return null;
  }
  return snippet;
}
