import crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_PREFS = {
  favorites: [],
  hidden: [],
};

const DEFAULT_LOCKFILE = {
  schemaVersion: 1,
  installs: [], // [{ id, slug, scope, installPath, version, sha, contentTreeSha256, capabilities, installedAt }]
};

const DEFAULT_PENDING_UPDATES = {
  schemaVersion: 1,
  pending: [],
};

/**
 * Fast synchronous check used by shutdown hooks to decide whether a detached
 * pending-update worker needs to be spawned before exiting.
 */
export function hasPendingUpdatesSync(dataDir) {
  if (typeof dataDir !== "string" || !dataDir.trim()) return false;
  const pendingPath = path.join(path.resolve(dataDir), "pending-updates.json");
  if (!existsSync(pendingPath)) return false;
  try {
    const parsed = JSON.parse(readFileSync(pendingPath, "utf8"));
    return Array.isArray(parsed?.pending) && parsed.pending.length > 0;
  } catch {
    return false;
  }
}

export class PluginStore {
  constructor(dataDir) {
    this.dataDir = path.resolve(dataDir);
    this.cacheDir = path.join(this.dataDir, "cache");
    this.detailsCacheDir = path.join(this.cacheDir, "details");
    this.prefsPath = path.join(this.dataDir, "prefs.json");
    this.lockfilePath = path.join(this.dataDir, "lockfile.json");
    this.pendingUpdatesPath = path.join(this.dataDir, "pending-updates.json");
    this.writeQueues = new Map();
  }

  async init() {
    await fs.mkdir(this.detailsCacheDir, { recursive: true });
  }

  /** Serialize read-modify-write operations per file path to prevent lost updates. */
  enqueue(key, fn) {
    const prev = this.writeQueues.get(key) || Promise.resolve();
    const next = prev.then(fn, fn);
    this.writeQueues.set(key, next.catch(() => {}));
    return next;
  }

  async readJson(filePath, fallback) {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      return JSON.parse(raw);
    } catch (err) {
      if (err.code !== "ENOENT") {
        console.error(`[store] Failed reading ${filePath}: ${err.message}`);
      }
      return structuredClone(fallback);
    }
  }

  async writeJsonAtomic(filePath, data) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    const payload = JSON.stringify(data, null, 2) + "\n";
    await fs.writeFile(tmpPath, payload, "utf8");
    await fs.rename(tmpPath, filePath);
  }

  // -------------------------------------------------------------------------
  // Preferences (Favorites & Hidden)
  // -------------------------------------------------------------------------
  async getPrefs() {
    const raw = await this.readJson(this.prefsPath, DEFAULT_PREFS);
    return {
      favorites: Array.isArray(raw.favorites) ? raw.favorites : [],
      hidden: Array.isArray(raw.hidden) ? raw.hidden : [],
    };
  }

  async updatePref(pluginId, field, value) {
    if (field !== "favorites" && field !== "hidden") {
      throw new Error(`Unsupported preference field: ${field}`);
    }
    return this.enqueue("prefs", async () => {
      const prefs = await this.getPrefs();
      const set = new Set(prefs[field]);
      if (value) set.add(pluginId);
      else set.delete(pluginId);
      prefs[field] = [...set].sort();
      await this.writeJsonAtomic(this.prefsPath, prefs);
      return prefs;
    });
  }

  // -------------------------------------------------------------------------
  // Install Lockfile (Tracks Managed Plugins & Installed Capabilities)
  // -------------------------------------------------------------------------
  async getLockfile() {
    const raw = await this.readJson(this.lockfilePath, DEFAULT_LOCKFILE);
    return {
      schemaVersion: 1,
      installs: Array.isArray(raw.installs) ? raw.installs : [],
    };
  }

  async upsertInstallRecord(record) {
    return this.enqueue("lockfile", async () => {
      const lock = await this.getLockfile();
      const normalizedPath = path.resolve(record.installPath).toLowerCase();
      const filtered = lock.installs.filter(
        (i) =>
          path.resolve(i.installPath).toLowerCase() !== normalizedPath &&
          !(record.slug && record.scope && i.slug === record.slug && i.scope === record.scope)
      );
      filtered.push(record);
      lock.installs = filtered;
      await this.writeJsonAtomic(this.lockfilePath, lock);
      return record;
    });
  }

  async updateInstallEnabled({ slug, scope, fromPath, installPath, enabled }) {
    return this.enqueue("lockfile", async () => {
      const lock = await this.getLockfile();
      const fromLower = fromPath ? path.resolve(fromPath).toLowerCase() : null;
      let updated = null;

      lock.installs = lock.installs.map((item) => {
        const matchesPath = fromLower && path.resolve(item.installPath).toLowerCase() === fromLower;
        const matchesKey = item.slug === slug && item.scope === scope;
        if (!matchesPath && !matchesKey) return item;
        updated = { ...item, installPath, enabled };
        return updated;
      });

      await this.writeJsonAtomic(this.lockfilePath, lock);
      return updated;
    });
  }

  async removeInstallRecord({ slug, scope, installPath }) {
    return this.enqueue("lockfile", async () => {
      const lock = await this.getLockfile();
      const targetPathLower = installPath ? path.resolve(installPath).toLowerCase() : null;
      lock.installs = lock.installs.filter((i) => {
        if (targetPathLower) {
          return path.resolve(i.installPath).toLowerCase() !== targetPathLower;
        }
        return !(i.slug === slug && i.scope === scope);
      });
      await this.writeJsonAtomic(this.lockfilePath, lock);
    });
  }

  // -------------------------------------------------------------------------
  // Pending Staged Updates (Queued When Active Plugin Files Are Locked)
  // -------------------------------------------------------------------------
  async getPendingUpdates() {
    const raw = await this.readJson(this.pendingUpdatesPath, DEFAULT_PENDING_UPDATES);
    const items = Array.isArray(raw.pending) ? raw.pending : [];
    if (items.length <= 1) return items;

    const deduped = [];
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const itemIdLower = item.id ? String(item.id).toLowerCase() : null;
      const itemFinalLower = item.finalDir ? path.resolve(item.finalDir).toLowerCase() : null;
      const idx = deduped.findIndex((existing) => {
        const sameFinal =
          itemFinalLower &&
          existing.finalDir &&
          path.resolve(existing.finalDir).toLowerCase() === itemFinalLower;
        const sameSlugScope = item.slug && item.scope && existing.slug === item.slug && existing.scope === item.scope;
        const sameIdScope =
          itemIdLower &&
          item.scope &&
          existing.id &&
          String(existing.id).toLowerCase() === itemIdLower &&
          existing.scope === item.scope;
        return sameFinal || sameSlugScope || sameIdScope;
      });
      if (idx !== -1) {
        deduped[idx] = item;
      } else {
        deduped.push(item);
      }
    }
    return deduped;
  }

  async upsertPendingUpdate(entry) {
    if (!entry || typeof entry !== "object" || !entry.finalDir || !entry.stageDir) {
      throw new TypeError("upsertPendingUpdate requires a pending update object with stageDir and finalDir");
    }
    return this.enqueue("pendingUpdates", async () => {
      const current = await this.getPendingUpdates();
      const targetFinalLower = path.resolve(entry.finalDir).toLowerCase();
      const nextStageLower = path.resolve(entry.stageDir).toLowerCase();
      const targetIdLower = entry.id ? String(entry.id).toLowerCase() : null;
      const supersededStages = [];

      const filtered = current.filter((item) => {
        const sameFinal = item.finalDir && path.resolve(item.finalDir).toLowerCase() === targetFinalLower;
        const sameKey = entry.slug && entry.scope && item.slug === entry.slug && item.scope === entry.scope;
        const sameIdScope =
          targetIdLower &&
          entry.scope &&
          item.id &&
          String(item.id).toLowerCase() === targetIdLower &&
          item.scope === entry.scope;
        if (!sameFinal && !sameKey && !sameIdScope) return true;
        if (item.stageDir && path.resolve(item.stageDir).toLowerCase() !== nextStageLower) {
          supersededStages.push(item.stageDir);
        }
        return false;
      });

      filtered.push(entry);
      await this.writeJsonAtomic(this.pendingUpdatesPath, {
        schemaVersion: 1,
        pending: filtered,
      });

      for (const staleStage of supersededStages) {
        await fs.rm(staleStage, { recursive: true, force: true }).catch(() => {});
      }
      return entry;
    });
  }

  async removePendingUpdate({ finalDir, slug, scope, id } = {}) {
    return this.enqueue("pendingUpdates", async () => {
      const current = await this.getPendingUpdates();
      const targetFinalLower = finalDir ? path.resolve(finalDir).toLowerCase() : null;
      const targetIdLower = id ? String(id).toLowerCase() : null;
      const removedStages = [];

      const remaining = current.filter((item) => {
        const matchesFinal =
          targetFinalLower && item.finalDir && path.resolve(item.finalDir).toLowerCase() === targetFinalLower;
        const matchesKey = slug && scope && item.slug === slug && item.scope === scope;
        const matchesIdScope =
          targetIdLower && scope && item.id && String(item.id).toLowerCase() === targetIdLower && item.scope === scope;
        if (matchesFinal || matchesKey || matchesIdScope) {
          if (item.stageDir) removedStages.push(item.stageDir);
          return false;
        }
        return true;
      });

      if (remaining.length !== current.length) {
        await this.writeJsonAtomic(this.pendingUpdatesPath, {
          schemaVersion: 1,
          pending: remaining,
        });
      }
      return removedStages;
    });
  }
}
