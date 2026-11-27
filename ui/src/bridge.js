import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";
import { isSafeHttpUrl } from "./helpers.js";

const WORKSPACE_INIT_TIMEOUT_MS = 1500;

export function isSidecarOrHttpMode() {
  return Boolean(
    window.sidecar ||
      window.location.protocol === "http:" ||
      window.location.protocol === "https:"
  );
}

function areStringArraysEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function syncHostStyles(ctx) {
  if (!ctx) return;
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
}

function readInitialWorkspaceUrisWithTimeout() {
  if (typeof window.sidecar?.getWorkspaceUris !== "function") {
    return Promise.resolve([]);
  }
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve([]);
      }
    }, WORKSPACE_INIT_TIMEOUT_MS);

    Promise.resolve(window.sidecar.getWorkspaceUris()).then(
      (uris) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(Array.isArray(uris) ? uris.filter((u) => typeof u === "string") : []);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        console.warn("[marketplace-bridge] Failed reading initial workspace URIs:", err);
        resolve([]);
      }
    );
  });
}

export function createHostBridge({
  clientVersion = "1.0.3",
  onToolResult,
  onWorkspaceChange,
} = {}) {
  const sidecarMode = isSidecarOrHttpMode();

  if (sidecarMode) {
    let latestWorkspaceUris = [];
    let connected = false;
    let unsubscribeWorkspace = null;

    async function connect() {
      latestWorkspaceUris = await readInitialWorkspaceUrisWithTimeout();
      if (typeof window.sidecar?.onWorkspaceChange === "function" && !unsubscribeWorkspace) {
        unsubscribeWorkspace = window.sidecar.onWorkspaceChange((nextUris) => {
          const normalized = Array.isArray(nextUris)
            ? nextUris.filter((u) => typeof u === "string")
            : [];
          if (!connected) {
            latestWorkspaceUris = normalized;
            return;
          }
          if (areStringArraysEqual(latestWorkspaceUris, normalized)) {
            return;
          }
          latestWorkspaceUris = normalized;
          if (typeof onWorkspaceChange === "function") {
            onWorkspaceChange([...latestWorkspaceUris]);
          }
        });
      }
      connected = true;
    }

    async function callTool(name, args = {}) {
      const payloadArgs = { ...(args || {}) };
      if (
        (name === "mp_get_bootstrap" || name === "mp_check_updates") &&
        payloadArgs.workspaceUris === undefined &&
        (window.sidecar || latestWorkspaceUris.length > 0)
      ) {
        payloadArgs.workspaceUris = [...latestWorkspaceUris];
      }

      const fetcher =
        typeof window.sidecar?.fetch === "function"
          ? window.sidecar.fetch
          : window.fetch.bind(window);

      const res = await fetcher("/api/tool", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, arguments: payloadArgs }),
      });

      const raw = await res.text();
      let parsed = null;
      if (raw) {
        try {
          parsed = JSON.parse(raw);
        } catch (err) {
          throw new Error(`Invalid JSON response from /api/tool (HTTP ${res.status}): ${err.message}`);
        }
      }

      if (!res.ok) {
        throw new Error(parsed?.error || `Server tool "${name}" failed (HTTP ${res.status}).`);
      }
      return parsed || {};
    }

    function openExternal(url) {
      if (!isSafeHttpUrl(url)) return;
      window.open(url.trim(), "_blank", "noopener,noreferrer");
    }

    return {
      mode: "sidecar",
      connect,
      callTool,
      openExternal,
      dispose() {
        if (typeof unsubscribeWorkspace === "function") {
          unsubscribeWorkspace();
          unsubscribeWorkspace = null;
        }
      },
    };
  }

  // MCP App Host Mode
  const app = new App({ name: "Community Plugin Marketplace", version: clientVersion });
  app.onhostcontextchanged = syncHostStyles;
  app.ontoolresult = (result) => {
    if (typeof onToolResult === "function") {
      onToolResult(result);
    }
  };

  return {
    mode: "mcp",
    async connect() {
      await app.connect();
      syncHostStyles(app.getHostContext());
    },
    async callTool(name, args = {}) {
      const res = await app.callServerTool({ name, arguments: args });
      if (res.isError) {
        throw new Error(res.content?.[0]?.text || `Server tool "${name}" failed.`);
      }
      return res.structuredContent || {};
    },
    openExternal(url) {
      if (!isSafeHttpUrl(url)) return;
      app.openLink({ url: url.trim() });
    },
    dispose() {},
  };
}
