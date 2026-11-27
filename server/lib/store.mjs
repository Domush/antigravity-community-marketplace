import crypto from "node:crypto";
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

export class PluginStore {
  constructor(dataDir) {
    this.dataDir = path.resolve(dataDir);
    this.cacheDir = path.join(this.dataDir, "cache");
    this.detailsCacheDir = path.join(this.cacheDir, "details");
    this.prefsPath = path.join(this.dataDir, "prefs.json");
    this.lockfilePath = path.join(this.dataDir, "lockfile.json");
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
}
