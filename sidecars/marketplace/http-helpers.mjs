import { ToolValidationError } from "../../server/lib/service.mjs";

export const DEFAULT_STANDALONE_PORT = 8981;
export const MAX_BODY_BYTES = 262_144;

export const NO_CACHE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate",
  Pragma: "no-cache",
};

export function parsePortValue(rawPort, fallbackPort = DEFAULT_STANDALONE_PORT) {
  if (rawPort === undefined || rawPort === "") return fallbackPort;
  const trimmed = String(rawPort).trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new RangeError(
      `Invalid ANTIGRAVITY_SIDECAR_WEB_PORT "${rawPort}": must be an integer between 0 and 65535.`
    );
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new RangeError(
      `Invalid ANTIGRAVITY_SIDECAR_WEB_PORT "${rawPort}": must be an integer between 0 and 65535.`
    );
  }
  return parsed;
}

export function validateStandaloneToolRequest(req, host, activePort) {
  const secFetchSite = req.headers["sec-fetch-site"];
  if (typeof secFetchSite === "string" && secFetchSite.toLowerCase() === "cross-site") {
    const err = new Error("Forbidden cross-site request.");
    err.statusCode = 403;
    throw err;
  }

  const rawOrigin = req.headers.origin;
  if (typeof rawOrigin === "string" && rawOrigin.length > 0) {
    let originUrl;
    try {
      originUrl = new URL(rawOrigin);
    } catch {
      const err = new Error("Forbidden: invalid Origin header.");
      err.statusCode = 403;
      throw err;
    }
    const allowedHosts = new Set([host, "127.0.0.1", "localhost"]);
    const isSameOrigin =
      originUrl.protocol === "http:" &&
      allowedHosts.has(originUrl.hostname) &&
      originUrl.port === String(activePort);
    if (!isSameOrigin) {
      const err = new Error(`Forbidden cross-origin request from "${rawOrigin}".`);
      err.statusCode = 403;
      throw err;
    }
  }

  const rawContentType = req.headers["content-type"];
  const mediaType =
    typeof rawContentType === "string" ? rawContentType.split(";")[0].trim().toLowerCase() : "";
  if (mediaType !== "application/json") {
    const err = new Error("Unsupported Media Type: Content-Type must be application/json.");
    err.statusCode = 415;
    throw err;
  }
}

export function readJsonObjectBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let settled = false;

    const cleanup = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("close", onClose);
    };

    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const onData = (chunk) => {
      if (settled) return;
      const bufChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
      totalBytes += bufChunk.length;
      if (totalBytes > maxBytes) {
        req.pause();
        const err = new Error("Request body too large.");
        err.statusCode = 413;
        fail(err);
        return;
      }
      chunks.push(bufChunk);
    };

    const onEnd = () => {
      if (settled) return;
      const raw = Buffer.concat(chunks, totalBytes).toString("utf8").trim();
      if (!raw) {
        fail(new ToolValidationError("Request body must be a JSON object with a tool name."));
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        fail(new ToolValidationError(`Malformed JSON request body: ${err.message}`));
        return;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        fail(new ToolValidationError("Request body must be a JSON object."));
        return;
      }
      settled = true;
      cleanup();
      resolve(parsed);
    };

    const onError = (err) => {
      fail(err);
    };

    const onClose = () => {
      if (!settled && !req.complete) {
        const err = new Error("Request stream closed prematurely before completion.");
        err.statusCode = 400;
        fail(err);
      }
    };

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("close", onClose);
  });
}
