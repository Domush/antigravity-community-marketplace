import path from "node:path";
import { compareSemver, parseSemver } from "./semver.mjs";

const RELEASE_FETCH_TIMEOUT_MS = 4000;
const VERSION_HEADING_RE =
  /^#{1,3}\s+\[?(v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\]?(?:\s|$|[-–—:])(.*)$/;

/** Parse Keep-a-Changelog or Markdown version headings into structured release sections. */
export function parseChangelogSections(markdown) {
  if (typeof markdown !== "string" || !markdown.trim()) return [];
  const lines = markdown.split(/\r?\n/);
  const sections = [];
  let current = null;

  for (const line of lines) {
    const match = line.match(VERSION_HEADING_RE);
    if (match) {
      const parsed = parseSemver(match[1]);
      if (parsed) {
        if (current) {
          current.body = current.lines.join("\n").trim();
          delete current.lines;
          if (current.body) sections.push(current);
        }
        const normalizedVersion = match[1].replace(/^v/i, "");
        const trailing = (match[2] || "").replace(/^[\s\]\-–—:]+/, "").trim();
        current = {
          version: normalizedVersion,
          label: trailing ? `v${normalizedVersion} — ${trailing}` : `v${normalizedVersion}`,
          lines: [],
        };
        continue;
      }
    }
    if (current) {
      current.lines.push(line);
    }
  }

  if (current) {
    current.body = current.lines.join("\n").trim();
    delete current.lines;
    if (current.body) sections.push(current);
  }

  return sections;
}

/** Parse GitHub Releases REST payload into structured release sections. */
export function parseGitHubReleaseNotes(releases) {
  if (!Array.isArray(releases)) return [];
  const sections = [];
  for (const rel of releases) {
    if (!rel || rel.draft || typeof rel.tag_name !== "string") continue;
    if (parseSemver(rel.tag_name) === null) continue;
    const version = rel.tag_name.trim().replace(/^v/i, "");
    const body = typeof rel.body === "string" ? rel.body.trim() : "";
    if (!body) continue;
    const date = typeof rel.published_at === "string" ? rel.published_at.slice(0, 10) : "";
    sections.push({
      version,
      label: date ? `v${version} (${date})` : `v${version}`,
      body,
    });
  }
  return sections;
}

/**
 * Filter release sections to versions strictly newer than installedVersion
 * and up to targetVersion, sorted newest-first.
 */
export function filterReleaseNotesSince({ sections, installedVersion, targetVersion }) {
  if (!Array.isArray(sections) || sections.length === 0) return null;
  if (parseSemver(installedVersion) === null) return null;

  const hasTarget = parseSemver(targetVersion) !== null;
  const matching = sections.filter((sec) => {
    const cmpInstalled = compareSemver(sec.version, installedVersion);
    if (cmpInstalled === null || cmpInstalled <= 0) return false;
    if (hasTarget) {
      const cmpTarget = compareSemver(sec.version, targetVersion);
      if (cmpTarget !== null && cmpTarget > 0) return false;
    }
    return true;
  });

  if (matching.length === 0) return null;

  matching.sort((a, b) => compareSemver(b.version, a.version) ?? 0);
  const markdown = matching
    .map((sec) => `## ${sec.label || `v${sec.version}`}\n\n${sec.body}`)
    .join("\n\n---\n\n");

  return {
    markdown,
    versions: matching.map((sec) => sec.version),
  };
}

async function fetchTextWithTimeout(url, headers, fetchFn) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RELEASE_FETCH_TIMEOUT_MS);
  try {
    return await fetchFn(url, { headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve all release notes since installedVersion for an outdated plugin.
 * Checks registry-provided history, immutable pinned CHANGELOG.md, and GitHub Releases,
 * returning null cleanly if unavailable so caller falls back to latestReleaseNotes.
 */
export async function fetchReleaseNotesSince({
  pluginEntry,
  detail,
  installedVersion,
  store = null,
  fetchFn = fetch,
} = {}) {
  if (!pluginEntry?.id || parseSemver(installedVersion) === null) {
    return null;
  }
  const targetVersion = pluginEntry.version;
  const cmp = compareSemver(installedVersion, targetVersion);
  if (cmp === null || cmp >= 0) {
    return null;
  }

  // 1. Registry-provided multi-version release notes (if present in detail shard)
  if (Array.isArray(detail?.releaseNotesHistory) && detail.releaseNotesHistory.length > 0) {
    const normalized = detail.releaseNotesHistory
      .filter((r) => r && typeof r.version === "string" && typeof r.notes === "string" && r.notes.trim())
      .map((r) => ({
        version: r.version.replace(/^v/i, ""),
        label: `v${r.version.replace(/^v/i, "")}`,
        body: r.notes.trim(),
      }));
    const fromRegistry = filterReleaseNotesSince({
      sections: normalized,
      installedVersion,
      targetVersion,
    });
    if (fromRegistry) return fromRegistry;
  }

  const sha = pluginEntry.release?.sha;
  if (!sha || !/^[A-Za-z0-9._/-]+$/.test(pluginEntry.id)) {
    return null;
  }

  const safeSlug = pluginEntry.id.replace("/", "--").toLowerCase();
  const cachePath = store?.detailsCacheDir
    ? path.join(store.detailsCacheDir, `${safeSlug}.${sha.slice(0, 12)}.changelog.json`)
    : null;

  let sections = null;
  if (cachePath) {
    const cached = await store.readJson(cachePath, null).catch(() => null);
    if (cached && Array.isArray(cached.sections)) {
      sections = cached.sections;
    }
  }

  if (!sections) {
    try {
      const rawUrl = `https://raw.githubusercontent.com/${pluginEntry.id}/${sha}/CHANGELOG.md`;
      const res = await fetchTextWithTimeout(rawUrl, { "User-Agent": "antigravity-community-marketplace" }, fetchFn);
      if (res.ok) {
        sections = parseChangelogSections(await res.text());
      }
    } catch {
      // Fall through to GitHub Releases fallback
    }

    if (!sections || sections.length === 0) {
      try {
        const relUrl = `https://api.github.com/repos/${pluginEntry.id}/releases?per_page=25`;
        const res = await fetchTextWithTimeout(
          relUrl,
          { Accept: "application/vnd.github+json", "User-Agent": "antigravity-community-marketplace" },
          fetchFn
        );
        if (res.ok) {
          sections = parseGitHubReleaseNotes(await res.json());
        }
      } catch {
        // Offline / rate-limited -> fall back to latestReleaseNotes
      }
    }

    if (cachePath && Array.isArray(sections) && sections.length > 0) {
      await store.writeJsonAtomic(cachePath, { sha, sections }).catch(() => {});
    }
  }

  return filterReleaseNotesSince({
    sections,
    installedVersion,
    targetVersion,
  });
}
