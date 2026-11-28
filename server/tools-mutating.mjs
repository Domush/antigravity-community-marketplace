import { TOOL_SCHEMAS } from "./lib/service.mjs";

export function toolError(message) {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

function toToolResponse(result) {
  return {
    content: [{ type: "text", text: result.text }],
    structuredContent: result.structuredContent,
  };
}

/**
 * Register all app-only (visibility: ["app"]) mutating marketplace tools.
 * Keeping these isolated from LLM visibility prevents prompt injections from modifying plugins.
 */
export function registerMutatingTools(server, { service }) {
  // -------------------------------------------------------------------------
  // 6. App-Only Tool: Verified Install / Update
  // -------------------------------------------------------------------------
  server.registerTool(
    "mp_install_plugin",
    {
      title: "Install or Update Plugin",
      description: "Downloads pinned SHA tarball, checks denylist, verifies contentTreeSha256, and installs atomically.",
      inputSchema: TOOL_SCHEMAS.mp_install_plugin,
      _meta: { ui: { visibility: ["app"] } },
    },
    async (args) => {
      try {
        return toToolResponse(await service.installPlugin(args));
      } catch (err) {
        return toolError(`Install failed: ${err.message}`);
      }
    }
  );

  // -------------------------------------------------------------------------
  // 6b. App-Only Tool: Non-Destructive Enable / Disable Toggle
  // -------------------------------------------------------------------------
  server.registerTool(
    "mp_toggle_plugin",
    {
      title: "Enable or Disable Plugin",
      description: "Moves an installed plugin between active and disabled directories without deleting files.",
      inputSchema: TOOL_SCHEMAS.mp_toggle_plugin,
      _meta: { ui: { visibility: ["app"] } },
    },
    async (args) => {
      try {
        return toToolResponse(await service.togglePlugin(args));
      } catch (err) {
        return toolError(`Toggle failed: ${err.message}`);
      }
    }
  );

  // -------------------------------------------------------------------------
  // 7. App-Only Tool: Uninstall Plugin
  // -------------------------------------------------------------------------
  server.registerTool(
    "mp_uninstall_plugin",
    {
      title: "Uninstall Plugin",
      description: "Removes an installed plugin folder from global or project scope and cleans lockfile metadata.",
      inputSchema: TOOL_SCHEMAS.mp_uninstall_plugin,
      _meta: { ui: { visibility: ["app"] } },
    },
    async (args) => {
      try {
        return toToolResponse(await service.uninstallPlugin(args));
      } catch (err) {
        return toolError(`Uninstall failed: ${err.message}`);
      }
    }
  );

  // -------------------------------------------------------------------------
  // 8. App-Only Tool: Update Favorites / Hidden Preferences
  // -------------------------------------------------------------------------
  server.registerTool(
    "mp_update_prefs",
    {
      title: "Update Marketplace Preferences",
      description: "Toggles favorite or hidden status for a plugin ID in persistent storage.",
      inputSchema: TOOL_SCHEMAS.mp_update_prefs,
      _meta: { ui: { visibility: ["app"] } },
    },
    async (args) => {
      try {
        return toToolResponse(await service.updatePrefs(args));
      } catch (err) {
        return toolError(`Preference update failed: ${err.message}`);
      }
    }
  );

  // -------------------------------------------------------------------------
  // 9. App-Only Tool: Retry Pending Staged Updates
  // -------------------------------------------------------------------------
  server.registerTool(
    "mp_apply_pending_updates",
    {
      title: "Apply Pending Staged Updates",
      description: "Retries applying any staged plugin updates once active file locks have cleared.",
      inputSchema: TOOL_SCHEMAS.mp_apply_pending_updates,
      _meta: { ui: { visibility: ["app"] } },
    },
    async () => {
      try {
        return toToolResponse(await service.applyPending());
      } catch (err) {
        return toolError(`Pending update apply failed: ${err.message}`);
      }
    }
  );

  server.registerTool(
    "mp_cancel_pending_updates",
    {
      title: "Cancel Pending Staged Updates",
      description: "Cancels pending staged plugin updates and cleans up staged files.",
      inputSchema: TOOL_SCHEMAS.mp_cancel_pending_updates,
      _meta: { ui: { visibility: ["app"] } },
    },
    async (args) => {
      try {
        return toToolResponse(await service.cancelPending(args));
      } catch (err) {
        return toolError(`Pending update cancellation failed: ${err.message}`);
      }
    }
  );
}
