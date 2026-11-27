const SELF_MARKETPLACE_IDS = new Set([
  "domush/antigravity-community-marketplace",
  "agy-community-marketplace",
  "antigravity-community-marketplace",
]);

const SELF_MARKETPLACE_NAMES = new Set([
  "agy-community-marketplace",
  "antigravity-community-marketplace",
]);

const SELF_MARKETPLACE_REPO_URL_RE =
  /^https?:\/\/github\.com\/domush\/antigravity-community-marketplace(?:\/|\.git|$)/i;

/**
 * Return true if a catalog entry or local install record represents this
 * marketplace plugin itself, so it is excluded from browsable and installed lists.
 */
export function isSelfMarketplacePlugin(entry) {
  if (!entry || typeof entry !== "object") return false;
  for (const field of [entry.id, entry.slug]) {
    if (typeof field === "string" && SELF_MARKETPLACE_IDS.has(field.trim().toLowerCase())) {
      return true;
    }
  }
  for (const field of [entry.pluginName, entry.name]) {
    if (typeof field === "string" && SELF_MARKETPLACE_NAMES.has(field.trim().toLowerCase())) {
      return true;
    }
  }
  if (typeof entry.repoUrl === "string" && SELF_MARKETPLACE_REPO_URL_RE.test(entry.repoUrl.trim())) {
    return true;
  }
  return false;
}

/**
 * Return a shallow copy of a registry index with the marketplace's own entry filtered out.
 */
export function filterSelfFromCatalogIndex(index) {
  if (!index || typeof index !== "object" || !Array.isArray(index.plugins)) {
    return index;
  }
  return {
    ...index,
    plugins: index.plugins.filter((p) => !isSelfMarketplacePlugin(p)),
  };
}
