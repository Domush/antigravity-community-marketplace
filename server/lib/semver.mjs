/**
 * Parse a semantic version string into numeric components and prerelease tags.
 * Returns null for non-semver values (e.g. "local" or empty strings).
 * @param {string} version
 */
export function parseSemver(version) {
  if (typeof version !== "string") return null;
  const trimmed = version.trim();
  if (!trimmed) return null;
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/i.exec(trimmed);
  if (!match) return null;

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) {
    return null;
  }

  let prerelease = [];
  if (match[4] !== undefined) {
    prerelease = match[4].split(".");
    if (prerelease.some((part) => part.length === 0)) {
      return null;
    }
  }

  return { major, minor, patch, prerelease };
}

function comparePrerelease(pa, pb) {
  if (pa.length === 0 && pb.length === 0) return 0;
  if (pa.length === 0) return 1;
  if (pb.length === 0) return -1;

  const len = Math.min(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const segA = pa[i];
    const segB = pb[i];
    if (segA === segB) continue;

    const numA = /^\d+$/.test(segA);
    const numB = /^\d+$/.test(segB);
    if (numA && numB) {
      return Number(segA) < Number(segB) ? -1 : 1;
    }
    if (numA) return -1;
    if (numB) return 1;
    return segA < segB ? -1 : 1;
  }

  if (pa.length === pb.length) return 0;
  return pa.length < pb.length ? -1 : 1;
}

/**
 * Compare two semantic version strings.
 * Returns -1 (a < b), 0 (a === b), 1 (a > b), or null if either is non-semver.
 * @param {string} a
 * @param {string} b
 */
export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return null;

  for (const key of ["major", "minor", "patch"]) {
    if (pa[key] !== pb[key]) {
      return pa[key] < pb[key] ? -1 : 1;
    }
  }
  return comparePrerelease(pa.prerelease, pb.prerelease);
}
