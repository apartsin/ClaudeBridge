// ClaudeBridge Storage Layer
// Manages AppProfiles and InstanceProfiles using chrome.storage.local

// ─── Schemas ───────────────────────────────────────────────────────────────────

export const AppProfileSchema = {
  domain: "",
  appName: "",
  version: "1.0",
  meta: {
    learnedAt: 0,
    lastUpdated: 0,
    updateCount: 0,
    confidence: "unknown",
    changelog: []
  },
  selectors: {
    editModeDetection: null,
    pageContainer: null,
    blocks: {
      heading: null,
      paragraph: null,
      image: null,
      list: null,
      table: null,
      button: null,
      divider: null,
      embed: null
    },
    toolbar: null,
    saveButton: null
  },
  actions: {
    replace_text: null,
    insert_block: null,
    delete_block: null,
    move_block: null,
    set_format: null,
    find_and_replace: null
  },
  quirks: [],
  editMethod: {
    primary: null,
    requiresNativeEvents: false,
    saveRequired: false,
    saveMethod: null
  },
  demonstrations: []
};

export const InstanceProfileSchema = {
  instanceId: "",
  domain: "",
  version: "1.0",
  meta: {
    learnedAt: 0,
    lastUpdated: 0,
    updateCount: 0,
    confidence: "unknown",
    changelog: []
  },
  deltas: {}
};

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * SelectorEntry factory
 * @param {string} value - CSS selector string
 * @param {string} confidence - "confirmed"|"inferred"|"tentative"|"unknown"
 * @param {number} seenCount
 * @returns {{ value: string, confidence: string, seenCount: number }}
 */
function makeSelectorEntry(value, confidence = "unknown", seenCount = 1) {
  return { value, confidence, seenCount };
}

/**
 * ActionEntry factory
 * @param {string} method
 * @param {object} details
 * @param {string} confidence
 * @returns {{ method: string, details: object, confidence: string }}
 */
function makeActionEntry(method, details = {}, confidence = "unknown") {
  return { method, details, confidence };
}

/**
 * QuirkEntry factory
 * @param {string} description
 * @param {string} confidence
 * @param {string} source
 * @returns {{ description: string, confidence: string, source: string }}
 */
function makeQuirkEntry(description, confidence = "unknown", source = "auto") {
  return { description, confidence, source };
}

/**
 * ChangelogEntry factory
 * @param {string} type - e.g. "update", "create", "merge"
 * @param {string} field - dot-path of field changed
 * @param {*} oldValue
 * @param {*} newValue
 * @param {string} source - "claude"|"human"|"auto"
 * @param {string} confidence
 * @param {string} note
 * @returns {object}
 */
function makeChangelogEntry(type, field, oldValue, newValue, source = "auto", confidence = "unknown", note = "") {
  return {
    timestamp: Date.now(),
    type,
    field,
    oldValue,
    newValue,
    source,
    confidence,
    note
  };
}

// Confidence ranking (higher index = higher confidence)
const CONFIDENCE_LEVELS = ["unknown", "tentative", "inferred", "confirmed"];

function confidenceRank(level) {
  const idx = CONFIDENCE_LEVELS.indexOf(level);
  return idx === -1 ? 0 : idx;
}

// ─── StorageManager ────────────────────────────────────────────────────────────

export const StorageManager = {

  // ── Read operations ──────────────────────────────────────────────────────

  /**
   * Return all profiles and instances from storage.
   * @returns {Promise<{ profiles: object, instances: object }>}
   */
  async getAll() {
    const result = await chrome.storage.local.get(["profiles", "instances"]);
    return {
      profiles: result.profiles || {},
      instances: result.instances || {}
    };
  },

  /**
   * Get the AppProfile for a given domain.
   * @param {string} domain
   * @returns {Promise<object|null>}
   */
  async getAppProfile(domain) {
    const { profiles } = await this.getAll();
    return profiles[domain] || null;
  },

  /**
   * Get the InstanceProfile for a given instanceId.
   * @param {string} instanceId
   * @returns {Promise<object|null>}
   */
  async getInstanceProfile(instanceId) {
    const { instances } = await this.getAll();
    return instances[instanceId] || null;
  },

  /**
   * Merge an AppProfile with an InstanceProfile's deltas.
   * Instance deltas win on conflict.
   * @param {string} domain
   * @param {string} instanceId
   * @returns {Promise<object>}
   */
  async getEffectiveProfile(domain, instanceId) {
    const appProfile = await this.getAppProfile(domain);
    const instanceProfile = await this.getInstanceProfile(instanceId);

    if (!appProfile && !instanceProfile) return null;
    if (!appProfile) return instanceProfile.deltas || {};
    if (!instanceProfile || !instanceProfile.deltas) return { ...appProfile };

    // Deep merge: start with app profile, overlay instance deltas
    return this.deepMerge(
      JSON.parse(JSON.stringify(appProfile)),
      instanceProfile.deltas
    );
  },

  // ── Write operations ─────────────────────────────────────────────────────

  /**
   * Update an existing AppProfile with a patch.
   * Respects confidence levels: will NOT overwrite a "confirmed" field
   * unless options.forceConfirmed is true.
   *
   * @param {string} domain
   * @param {object} patch - partial profile data to merge
   * @param {object} options
   * @param {boolean} [options.forceConfirmed=false]
   * @param {string}  [options.source="auto"] - "claude"|"human"|"auto"
   * @param {string}  [options.note=""]
   */
  async updateAppProfile(domain, patch, options = {}) {
    const { forceConfirmed = false, source = "auto", note = "" } = options;
    const { profiles, instances } = await this.getAll();
    let profile = profiles[domain];

    if (!profile) {
      throw new Error(`AppProfile for domain "${domain}" does not exist. Use createAppProfile first.`);
    }

    // Collect changelog entries for changed fields
    const changelogEntries = [];

    // Apply patch with confidence checks
    profile = this._applyPatchWithConfidence(
      profile, patch, forceConfirmed, source, note, changelogEntries, ""
    );

    // Update meta
    profile.meta.lastUpdated = Date.now();
    profile.meta.updateCount = (profile.meta.updateCount || 0) + 1;

    // Append changelog entries (cap at 50)
    if (!Array.isArray(profile.meta.changelog)) {
      profile.meta.changelog = [];
    }
    profile.meta.changelog.push(...changelogEntries);
    if (profile.meta.changelog.length > 50) {
      profile.meta.changelog = profile.meta.changelog.slice(
        profile.meta.changelog.length - 50
      );
    }

    // If patch includes a top-level confidence, update meta.confidence
    if (patch.meta && patch.meta.confidence) {
      profile.meta.confidence = patch.meta.confidence;
    }

    profiles[domain] = profile;
    await chrome.storage.local.set({ profiles, instances });
  },

  /**
   * Update an existing InstanceProfile with a patch.
   * Same confidence semantics as updateAppProfile.
   *
   * @param {string} instanceId
   * @param {object} patch
   * @param {object} options
   */
  async updateInstanceProfile(instanceId, patch, options = {}) {
    const { forceConfirmed = false, source = "auto", note = "" } = options;
    const { profiles, instances } = await this.getAll();
    let instance = instances[instanceId];

    if (!instance) {
      throw new Error(`InstanceProfile "${instanceId}" does not exist. Use createInstanceProfile first.`);
    }

    const changelogEntries = [];

    // For instances, the patch is merged into `deltas`
    instance.deltas = this._applyPatchWithConfidence(
      instance.deltas || {}, patch, forceConfirmed, source, note, changelogEntries, ""
    );

    instance.meta.lastUpdated = Date.now();
    instance.meta.updateCount = (instance.meta.updateCount || 0) + 1;

    if (!Array.isArray(instance.meta.changelog)) {
      instance.meta.changelog = [];
    }
    instance.meta.changelog.push(...changelogEntries);
    if (instance.meta.changelog.length > 50) {
      instance.meta.changelog = instance.meta.changelog.slice(
        instance.meta.changelog.length - 50
      );
    }

    if (patch.meta && patch.meta.confidence) {
      instance.meta.confidence = patch.meta.confidence;
    }

    instances[instanceId] = instance;
    await chrome.storage.local.set({ profiles, instances });
  },

  /**
   * Create a new AppProfile for a domain.
   * @param {string} domain
   * @param {object} initialData - partial profile data
   * @returns {Promise<object>} the created profile
   */
  async createAppProfile(domain, initialData = {}) {
    const { profiles, instances } = await this.getAll();

    const now = Date.now();
    const profile = this.deepMerge(
      JSON.parse(JSON.stringify(AppProfileSchema)),
      initialData
    );
    profile.domain = domain;
    profile.meta.learnedAt = now;
    profile.meta.lastUpdated = now;
    profile.meta.updateCount = 0;
    if (!profile.meta.confidence) {
      profile.meta.confidence = "unknown";
    }
    if (!Array.isArray(profile.meta.changelog)) {
      profile.meta.changelog = [];
    }

    profiles[domain] = profile;
    await chrome.storage.local.set({ profiles, instances });
    return profile;
  },

  /**
   * Create a new InstanceProfile.
   * @param {string} instanceId
   * @param {string} domain - the parent app domain
   * @param {object} initialData - initial delta data
   * @returns {Promise<object>} the created instance profile
   */
  async createInstanceProfile(instanceId, domain, initialData = {}) {
    const { profiles, instances } = await this.getAll();

    const now = Date.now();
    const instance = JSON.parse(JSON.stringify(InstanceProfileSchema));
    instance.instanceId = instanceId;
    instance.domain = domain;
    instance.meta.learnedAt = now;
    instance.meta.lastUpdated = now;
    instance.meta.updateCount = 0;
    instance.meta.confidence = "unknown";
    instance.meta.changelog = [];
    instance.deltas = initialData;

    instances[instanceId] = instance;
    await chrome.storage.local.set({ profiles, instances });
    return instance;
  },

  // ── Import / Export ──────────────────────────────────────────────────────

  /**
   * Export all storage as a JSON string.
   * @returns {Promise<string>}
   */
  async exportAll() {
    const data = await this.getAll();
    return JSON.stringify(data, null, 2);
  },

  /**
   * Import data from a JSON string.
   * @param {string} jsonString
   * @param {boolean} merge - if true, deep-merge with existing data; if false, replace
   */
  async importAll(jsonString, merge = true) {
    const incoming = JSON.parse(jsonString);

    if (merge) {
      const existing = await this.getAll();
      const merged = {
        profiles: this.deepMerge(existing.profiles || {}, incoming.profiles || {}),
        instances: this.deepMerge(existing.instances || {}, incoming.instances || {})
      };
      await chrome.storage.local.set(merged);
    } else {
      await chrome.storage.local.set({
        profiles: incoming.profiles || {},
        instances: incoming.instances || {}
      });
    }
  },

  // ── Utility ──────────────────────────────────────────────────────────────

  /**
   * Deep merge source into target.
   * - Nested plain objects are recursively merged.
   * - Arrays are replaced (source wins).
   * - Primitives: source wins.
   *
   * @param {object} target
   * @param {object} source
   * @returns {object} the mutated target
   */
  deepMerge(target, source) {
    if (!source || typeof source !== "object") return target;
    if (!target || typeof target !== "object") return JSON.parse(JSON.stringify(source));

    for (const key of Object.keys(source)) {
      const srcVal = source[key];
      const tgtVal = target[key];

      if (srcVal === null || srcVal === undefined) {
        target[key] = srcVal;
      } else if (Array.isArray(srcVal)) {
        // Arrays: source replaces target
        target[key] = JSON.parse(JSON.stringify(srcVal));
      } else if (typeof srcVal === "object" && !Array.isArray(srcVal)) {
        // Nested object: recurse
        if (typeof tgtVal === "object" && tgtVal !== null && !Array.isArray(tgtVal)) {
          target[key] = this.deepMerge(tgtVal, srcVal);
        } else {
          target[key] = JSON.parse(JSON.stringify(srcVal));
        }
      } else {
        // Primitive: source wins
        target[key] = srcVal;
      }
    }

    return target;
  },

  /**
   * Normalize a URL into a stable instance storage key.
   *
   * Strips:
   *   - Protocol (https://, http://)
   *   - /edit, /view suffixes
   *   - /u/N/ user-switch segments
   *   - Query parameters and hash fragments
   *   - Trailing slashes
   *
   * Replaces / with __ for a flat key.
   *
   * Example:
   *   "https://sites.google.com/u/0/s/abc/p/xyz/edit"
   *   → "sites.google.com__s__abc"
   *
   * @param {string} url
   * @returns {string}
   */
  normalizeInstanceId(url) {
    let normalized = url;

    // Strip protocol
    normalized = normalized.replace(/^https?:\/\//, "");

    // Strip query params and hash
    normalized = normalized.split("?")[0].split("#")[0];

    // Strip trailing slash
    normalized = normalized.replace(/\/+$/, "");

    // Strip /u/N/ segments (Google multi-account)
    normalized = normalized.replace(/\/u\/\d+\/?/g, "/");

    // Strip trailing /edit or /view
    normalized = normalized.replace(/\/(edit|view)$/i, "");

    // Strip trailing slash again (may appear after stripping edit/view)
    normalized = normalized.replace(/\/+$/, "");

    // Strip /p/... sub-page path segments for sites-style URLs
    // e.g. sites.google.com/s/abc/p/xyz → sites.google.com/s/abc
    normalized = normalized.replace(/\/p\/[^/]+$/, "");

    // Collapse multiple slashes
    normalized = normalized.replace(/\/+/g, "/");

    // Replace / with __
    normalized = normalized.replace(/\//g, "__");

    return normalized;
  },

  // ── Internal helpers ─────────────────────────────────────────────────────

  /**
   * Apply a patch to a target object, respecting confidence levels.
   * Fields with confidence="confirmed" in the target are NOT overwritten
   * unless forceConfirmed is true.
   *
   * Mutates and returns target.
   *
   * @param {object} target
   * @param {object} patch
   * @param {boolean} forceConfirmed
   * @param {string} source
   * @param {string} note
   * @param {Array} changelogEntries - accumulated changelog entries (mutated)
   * @param {string} pathPrefix - dot-path prefix for changelog field names
   * @returns {object}
   */
  _applyPatchWithConfidence(target, patch, forceConfirmed, source, note, changelogEntries, pathPrefix) {
    if (!patch || typeof patch !== "object") return target;
    if (!target || typeof target !== "object") {
      return JSON.parse(JSON.stringify(patch));
    }

    for (const key of Object.keys(patch)) {
      // Skip meta — handled separately by caller
      if (key === "meta" && pathPrefix === "") continue;

      const fieldPath = pathPrefix ? `${pathPrefix}.${key}` : key;
      const srcVal = patch[key];
      const tgtVal = target[key];

      // Check if target value is a SelectorEntry / ActionEntry / QuirkEntry
      // with confidence="confirmed"
      if (this._isConfidenceProtected(tgtVal, forceConfirmed)) {
        // Skip — do not overwrite confirmed field
        continue;
      }

      if (srcVal === null || srcVal === undefined) {
        if (tgtVal !== srcVal) {
          changelogEntries.push(
            makeChangelogEntry("update", fieldPath, tgtVal, srcVal, source, "unknown", note)
          );
        }
        target[key] = srcVal;
      } else if (Array.isArray(srcVal)) {
        const oldVal = Array.isArray(tgtVal) ? JSON.parse(JSON.stringify(tgtVal)) : tgtVal;
        target[key] = JSON.parse(JSON.stringify(srcVal));
        changelogEntries.push(
          makeChangelogEntry("update", fieldPath, oldVal, target[key], source, "unknown", note)
        );
      } else if (typeof srcVal === "object") {
        // Recurse for nested objects
        if (typeof tgtVal === "object" && tgtVal !== null && !Array.isArray(tgtVal)) {
          target[key] = this._applyPatchWithConfidence(
            tgtVal, srcVal, forceConfirmed, source, note, changelogEntries, fieldPath
          );
        } else {
          changelogEntries.push(
            makeChangelogEntry("update", fieldPath, tgtVal, srcVal, source, "unknown", note)
          );
          target[key] = JSON.parse(JSON.stringify(srcVal));
        }
      } else {
        // Primitive
        if (tgtVal !== srcVal) {
          changelogEntries.push(
            makeChangelogEntry("update", fieldPath, tgtVal, srcVal, source, "unknown", note)
          );
        }
        target[key] = srcVal;
      }
    }

    return target;
  },

  /**
   * Returns true if the value is confidence-protected and should not be overwritten.
   * A value is protected if it is an object with confidence="confirmed"
   * and forceConfirmed is false.
   *
   * @param {*} value
   * @param {boolean} forceConfirmed
   * @returns {boolean}
   */
  _isConfidenceProtected(value, forceConfirmed) {
    if (forceConfirmed) return false;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value.confidence === "confirmed";
    }
    return false;
  }
};
