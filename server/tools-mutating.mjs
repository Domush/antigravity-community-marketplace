import path from "node:path";
import { z } from "zod";
import {
  getPluginsDir,
  installPlugin,
  setPluginEnabled,
  uninstallPlugin,
} from "./lib/installer.mjs";

export function toolError(message) {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

/**
 * Register all app-only (visibility: ["app"]) mutating marketplace tools.
 * Keeping these isolated from LLM visibility prevents prompt injections from modifying plugins.
 */
export function registerMutatingTools(server, { catalog, store }) {
  // -------------------------------------------------------------------------
  // 6. App-Only Tool: Verified Install / Update
  // -------------------------------------------------------------------------
  server.registerTool(
    "mp_install_plugin",
    {
      title: "Install or Update Plugin",
      description: "Downloads pinned SHA tarball, checks denylist, verifies contentTreeSha256, and installs atomically.",
      inputSchema: {
        id: z.string().min(3),
        scope: z.enum(["global", "project"]),
        workspaceRoot: z.string().optional(),
        replaceSlug: z.string().optional(),
        replaceEnabled: z.boolean().optional(),
      },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ id, scope, workspaceRoot, replaceSlug, replaceEnabled = true }) => {
      try {
        // Always revalidate denylist before installing so emergency revocations take effect immediately
        const [index, denylist] = await Promise.all([
          catalog.getIndex({ force: false }),
          catalog.getDenylist({ force: true }),
        ]);
        const pluginEntry = (index.plugins || []).find(
          (p) => p.id.toLowerCase() === id.toLowerCase()
        );
        if (!pluginEntry) {
          return toolError(`Plugin not found in registry index: ${id}`);
        }

        const record = await installPlugin({
          pluginEntry,
          denylist,
          scope,
          workspaceRoot,
          replaceSlug: replaceSlug || null,
          replaceEnabled,
        });

        const { migratedFrom, ...lockRecord } = record;
        if (migratedFrom) {
          await store.removeInstallRecord({
            slug: migratedFrom.slug,
            scope,
            installPath: migratedFrom.installPath,
          });
        }
        await store.upsertInstallRecord(lockRecord);

        return {
          content: [
            {
              type: "text",
              text: migratedFrom
                ? `Adopted ${record.id}@${record.version} into ${record.scope} scope (migrated "${migratedFrom.slug}" -> "${record.slug}").`
                : `Installed ${record.id}@${record.version} into ${record.scope} scope.`,
            },
          ],
          structuredContent: {
            installed: lockRecord,
            migratedFrom: migratedFrom || null,
            requiresReload: true,
          },
        };
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
      inputSchema: {
        slug: z.string().min(1),
        scope: z.enum(["global", "project"]),
        enabled: z.boolean(),
        workspaceRoot: z.string().optional(),
      },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ slug, scope, enabled, workspaceRoot }) => {
      try {
        const moved = await setPluginEnabled({ slug, scope, workspaceRoot, enabled });
        await store.updateInstallEnabled({
          slug,
          scope,
          fromPath: moved.fromPath,
          installPath: moved.installPath,
          enabled,
        });
        return {
          content: [{ type: "text", text: `${enabled ? "Enabled" : "Disabled"} ${slug} (${scope}).` }],
          structuredContent: { ...moved, requiresReload: true },
        };
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
      inputSchema: {
        slug: z.string().min(1),
        id: z.string().optional(),
        scope: z.enum(["global", "project"]),
        enabled: z.boolean().optional(),
        workspaceRoot: z.string().optional(),
      },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ slug, scope, enabled = true, workspaceRoot }) => {
      try {
        const pluginsRoot = getPluginsDir(scope, workspaceRoot, { enabled });
        const expectedInstallPath = path.join(pluginsRoot, slug);
        const res = await uninstallPlugin({ slug, scope, workspaceRoot, enabled });
        await store.removeInstallRecord({ slug, scope, installPath: expectedInstallPath });

        return {
          content: [{ type: "text", text: `Uninstalled ${slug} (${scope}).` }],
          structuredContent: { removed: res.removed, requiresReload: true },
        };
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
      inputSchema: {
        id: z.string().min(1),
        field: z.enum(["favorites", "hidden"]),
        value: z.boolean(),
      },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ id, field, value }) => {
      try {
        const prefs = await store.updatePref(id, field, value);
        return {
          content: [{ type: "text", text: `Updated ${field} for ${id}.` }],
          structuredContent: { prefs },
        };
      } catch (err) {
        return toolError(`Preference update failed: ${err.message}`);
      }
    }
  );
}
