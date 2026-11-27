# Antigravity Community Plugin Marketplace

Browse, security-audit, install, and update community-made Google Antigravity App plugins directly from the Antigravity sidebar—backed by a public, Ed25519-signed registry.

> **Disclaimer:** This is an independent community project and is not affiliated with or endorsed by Google. Always review audit findings before installing elevated or high-risk plugins.

---

## Requirements

* **Antigravity App:** v2.34.0 or newer (required for MCP App sidebar UIs)
* **Node.js:** v22 or newer available on `PATH`

---

## Installation

### Option 1: Antigravity CLI (Recommended)

```bash
agy plugin install https://github.com/Domush/antigravity-community-marketplace
```

### Option 2: Manual Install

1. Download and extract the latest release archive into your global plugins folder:
   * **macOS / Linux:** `~/.gemini/config/plugins/agy-community-marketplace/`
   * **Windows:** `%USERPROFILE%\.gemini\config\plugins\agy-community-marketplace\`
2. Reload or restart the Antigravity App.

---

## Opening the Marketplace

Click **Community Plugins** under **Plugins** in the Antigravity App left sidebar (or open it in the side panel via the `open_marketplace` tool). You can also browse the catalog in any browser at `https://domush.github.io/antigravity-plugin-registry/`.

---

## Key Features

* **Global & Project Installs:** Install plugins globally (`~/.gemini/config/plugins/`) or scoped to the active project (`.agents/plugins/`).
* **Non-Destructive Enable / Disable:** Pause any installed plugin without deleting its files or local settings; disabled plugins move to a sibling `plugins-disabled/` folder and stop triggering collision warnings.
* **Manual Plugin Detection & Adoption:** Automatically recognizes plugins you installed manually via exact tree hash or `.git/config` origin so you can track updates and denylist alerts, with opt-in adoption for name-only matches.
* **Search, Filters & Organization:** Filter by category, surface (`Sidebar UI`, `Prompt/Rules Only`, `Local MCP`, `Shell Hooks`), maximum risk tier, and credential requirements; favorite or hide plugins across sessions.

---

## Security Guarantees

Every plugin in the registry is scanned by an automated, open-source GitHub Actions pipeline before publication, and the client enforces five local safeguards:

1. **Ed25519-Signed Registry & Rollback Protection:** `index.json` and `denylist.json` are signed with Ed25519. The client verifies signatures against a pinned public key and blocks replay of older signed catalogs or denylists.
2. **Immutable SHA Pinning + `contentTreeSha256`:** Plugins are never downloaded from mutable branches (`main`). Every install fetches the exact audited commit archive, blocks symlinks and zip-slip paths, and verifies the deterministic SHA-256 hash of the extracted file tree before moving files into your plugins directory.
3. **Emergency Denylist Kill-Switch:** Revoked repositories or compromised commit SHAs are checked live before every install and surfaced as red uninstall alerts if already installed.
4. **LLM Isolation:** Mutating tools (install, update, toggle, uninstall) are marked `visibility: ["app"]` so AI agents and untrusted prompts cannot invoke them—only your clicks in the sidebar UI can modify plugins.
5. **Code, Hook & Prompt-Injection Auditing:** Plugins are scanned with Semgrep AST rules, lifecycle hook checks, unpinned `npx`/`uvx` runtime checks, and Markdown prompt-injection heuristics (`SKILL.md`, `agents/*.md`, `rules/*.md`). Every finding links directly to the exact file and line number on GitHub.

---

## Permission Diffs & Pre-Flight Checks

* **Mandatory Audit Gate:** Clicking **Update**, or installing any elevated/high-risk or credential-requiring plugin, opens the **Security Audit Drawer** before anything is downloaded.
* **Permission Escalation Diffs:** On updates, the drawer compares your installed version's capabilities against the new version and highlights newly added permissions (such as a new `Shell Lifecycle Hook` or `Unpinned Remote Package`) in red.
* **OS & Runtime Pre-Flight:** Before installing, the client checks your local `PATH` for required MCP/hook runtimes (`node`, `python3`, `uvx`, `docker`, `pwsh`) and warns if a shell hook uses POSIX-only syntax on Windows or Windows-only syntax on macOS/Linux.
* **Live Collision Detection:** Warns if a plugin registers a `/slash` command, namespaced MCP server, custom agent, or lifecycle hook that conflicts with an active local plugin.

---

## Troubleshooting

* **Installed or toggled plugin doesn't appear yet:** Antigravity loads MCP servers and lifecycle hooks on startup. Reload or restart the Antigravity App whenever the amber reload banner appears.
* **"Select an active project path" on Project install:** When opened from the global sidebar, Antigravity may not attach a workspace root automatically. Click **Edit** in the top-right **Project** pill to enter your project's absolute path.
* **"Untrusted signing keyId" or "Marketplace Update Available" (Red Banner):** The registry rotated its signing key or bumped the minimum supported schema. Update `agy-community-marketplace` to the latest release.
* **"Integrity mismatch" on install:** The downloaded archive did not match the audited `contentTreeSha256`. Your existing installation is left untouched; click **Check Updates** and retry, or report the plugin if the error persists.
* **Missing runtime warning in Pre-Flight:** Install the flagged binary (e.g., `uv` or `python3`), ensure it is on your system `PATH`, and restart the Antigravity App so the local MCP server picks up the updated environment.

---

## Submitting or Reporting a Plugin

* **Submit / Refresh a Plugin:** Tag your public GitHub repository with `agy-plugin` and open a submission issue on [`antigravity-plugin-registry`](https://github.com/Domush/antigravity-plugin-registry) for immediate indexing.
* **Report a Malicious Plugin:** Click **Report** inside any plugin's detail drawer to open a pre-filled issue with the pinned commit SHA.
