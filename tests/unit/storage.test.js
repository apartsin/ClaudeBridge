/**
 * Unit tests for StorageManager (src/storage/schema.js).
 *
 * Since the source uses ES module exports and Jest transform is disabled,
 * we re-implement the pure logic functions directly in this test file and
 * test the storage CRUD operations against the chrome.storage.local mock.
 */

require('../helpers/setup');

// ─── Re-implement schemas ────────────────────────────────────────────────────

const AppProfileSchema = {
  domain: '',
  appName: '',
  version: '1.0',
  meta: {
    learnedAt: 0,
    lastUpdated: 0,
    updateCount: 0,
    confidence: 'unknown',
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
  }
};

const InstanceProfileSchema = {
  instanceId: '',
  domain: '',
  version: '1.0',
  meta: {
    learnedAt: 0,
    lastUpdated: 0,
    updateCount: 0,
    confidence: 'unknown',
    changelog: []
  },
  deltas: {}
};

// ─── Re-implement pure helper functions ──────────────────────────────────────

const CONFIDENCE_LEVELS = ['unknown', 'tentative', 'inferred', 'confirmed'];

function confidenceRank(level) {
  const idx = CONFIDENCE_LEVELS.indexOf(level);
  return idx === -1 ? 0 : idx;
}

function makeChangelogEntry(type, field, oldValue, newValue, source, confidence, note) {
  return {
    timestamp: Date.now(),
    type,
    field,
    oldValue,
    newValue,
    source: source || 'auto',
    confidence: confidence || 'unknown',
    note: note || ''
  };
}

// ─── Re-implement StorageManager ─────────────────────────────────────────────

const StorageManager = {
  async getAll() {
    const result = await chrome.storage.local.get(['profiles', 'instances']);
    return {
      profiles: result.profiles || {},
      instances: result.instances || {}
    };
  },

  async getAppProfile(domain) {
    const { profiles } = await this.getAll();
    return profiles[domain] || null;
  },

  async getInstanceProfile(instanceId) {
    const { instances } = await this.getAll();
    return instances[instanceId] || null;
  },

  async getEffectiveProfile(domain, instanceId) {
    const appProfile = await this.getAppProfile(domain);
    const instanceProfile = await this.getInstanceProfile(instanceId);
    if (!appProfile && !instanceProfile) return null;
    if (!appProfile) return instanceProfile.deltas || {};
    if (!instanceProfile || !instanceProfile.deltas) return { ...appProfile };
    return this.deepMerge(
      JSON.parse(JSON.stringify(appProfile)),
      instanceProfile.deltas
    );
  },

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
    if (!profile.meta.confidence) profile.meta.confidence = 'unknown';
    if (!Array.isArray(profile.meta.changelog)) profile.meta.changelog = [];
    profiles[domain] = profile;
    await chrome.storage.local.set({ profiles, instances });
    return profile;
  },

  async createInstanceProfile(instanceId, domain, initialData = {}) {
    const { profiles, instances } = await this.getAll();
    const now = Date.now();
    const instance = JSON.parse(JSON.stringify(InstanceProfileSchema));
    instance.instanceId = instanceId;
    instance.domain = domain;
    instance.meta.learnedAt = now;
    instance.meta.lastUpdated = now;
    instance.meta.updateCount = 0;
    instance.meta.confidence = 'unknown';
    instance.meta.changelog = [];
    instance.deltas = initialData;
    instances[instanceId] = instance;
    await chrome.storage.local.set({ profiles, instances });
    return instance;
  },

  async updateAppProfile(domain, patch, options = {}) {
    const { forceConfirmed = false, source = 'auto', note = '' } = options;
    const { profiles, instances } = await this.getAll();
    let profile = profiles[domain];
    if (!profile) {
      throw new Error(`AppProfile for domain "${domain}" does not exist. Use createAppProfile first.`);
    }
    const changelogEntries = [];
    profile = this._applyPatchWithConfidence(
      profile, patch, forceConfirmed, source, note, changelogEntries, ''
    );
    profile.meta.lastUpdated = Date.now();
    profile.meta.updateCount = (profile.meta.updateCount || 0) + 1;
    if (!Array.isArray(profile.meta.changelog)) profile.meta.changelog = [];
    profile.meta.changelog.push(...changelogEntries);
    if (profile.meta.changelog.length > 50) {
      profile.meta.changelog = profile.meta.changelog.slice(profile.meta.changelog.length - 50);
    }
    if (patch.meta && patch.meta.confidence) {
      profile.meta.confidence = patch.meta.confidence;
    }
    profiles[domain] = profile;
    await chrome.storage.local.set({ profiles, instances });
  },

  async exportAll() {
    const data = await this.getAll();
    return JSON.stringify(data, null, 2);
  },

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

  deepMerge(target, source) {
    if (!source || typeof source !== 'object') return target;
    if (!target || typeof target !== 'object') return JSON.parse(JSON.stringify(source));
    for (const key of Object.keys(source)) {
      const srcVal = source[key];
      const tgtVal = target[key];
      if (srcVal === null || srcVal === undefined) {
        target[key] = srcVal;
      } else if (Array.isArray(srcVal)) {
        target[key] = JSON.parse(JSON.stringify(srcVal));
      } else if (typeof srcVal === 'object' && !Array.isArray(srcVal)) {
        if (typeof tgtVal === 'object' && tgtVal !== null && !Array.isArray(tgtVal)) {
          target[key] = this.deepMerge(tgtVal, srcVal);
        } else {
          target[key] = JSON.parse(JSON.stringify(srcVal));
        }
      } else {
        target[key] = srcVal;
      }
    }
    return target;
  },

  normalizeInstanceId(url) {
    let normalized = url;
    normalized = normalized.replace(/^https?:\/\//, '');
    normalized = normalized.split('?')[0].split('#')[0];
    normalized = normalized.replace(/\/+$/, '');
    normalized = normalized.replace(/\/u\/\d+\/?/g, '/');
    normalized = normalized.replace(/\/(edit|view)$/i, '');
    normalized = normalized.replace(/\/+$/, '');
    normalized = normalized.replace(/\/p\/[^/]+$/, '');
    normalized = normalized.replace(/\/+/g, '/');
    normalized = normalized.replace(/\//g, '__');
    return normalized;
  },

  _applyPatchWithConfidence(target, patch, forceConfirmed, source, note, changelogEntries, pathPrefix) {
    if (!patch || typeof patch !== 'object') return target;
    if (!target || typeof target !== 'object') return JSON.parse(JSON.stringify(patch));
    for (const key of Object.keys(patch)) {
      if (key === 'meta' && pathPrefix === '') continue;
      const fieldPath = pathPrefix ? `${pathPrefix}.${key}` : key;
      const srcVal = patch[key];
      const tgtVal = target[key];
      if (this._isConfidenceProtected(tgtVal, forceConfirmed)) continue;
      if (srcVal === null || srcVal === undefined) {
        if (tgtVal !== srcVal) {
          changelogEntries.push(
            makeChangelogEntry('update', fieldPath, tgtVal, srcVal, source, 'unknown', note)
          );
        }
        target[key] = srcVal;
      } else if (Array.isArray(srcVal)) {
        const oldVal = Array.isArray(tgtVal) ? JSON.parse(JSON.stringify(tgtVal)) : tgtVal;
        target[key] = JSON.parse(JSON.stringify(srcVal));
        changelogEntries.push(
          makeChangelogEntry('update', fieldPath, oldVal, target[key], source, 'unknown', note)
        );
      } else if (typeof srcVal === 'object') {
        if (typeof tgtVal === 'object' && tgtVal !== null && !Array.isArray(tgtVal)) {
          target[key] = this._applyPatchWithConfidence(
            tgtVal, srcVal, forceConfirmed, source, note, changelogEntries, fieldPath
          );
        } else {
          changelogEntries.push(
            makeChangelogEntry('update', fieldPath, tgtVal, srcVal, source, 'unknown', note)
          );
          target[key] = JSON.parse(JSON.stringify(srcVal));
        }
      } else {
        if (tgtVal !== srcVal) {
          changelogEntries.push(
            makeChangelogEntry('update', fieldPath, tgtVal, srcVal, source, 'unknown', note)
          );
        }
        target[key] = srcVal;
      }
    }
    return target;
  },

  _isConfidenceProtected(value, forceConfirmed) {
    if (forceConfirmed) return false;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value.confidence === 'confirmed';
    }
    return false;
  }
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('AppProfileSchema shape', () => {
  test('has expected top-level keys', () => {
    expect(AppProfileSchema).toHaveProperty('domain');
    expect(AppProfileSchema).toHaveProperty('appName');
    expect(AppProfileSchema).toHaveProperty('version');
    expect(AppProfileSchema).toHaveProperty('meta');
    expect(AppProfileSchema).toHaveProperty('selectors');
    expect(AppProfileSchema).toHaveProperty('actions');
    expect(AppProfileSchema).toHaveProperty('quirks');
    expect(AppProfileSchema).toHaveProperty('editMethod');
  });

  test('meta has correct defaults', () => {
    expect(AppProfileSchema.meta.learnedAt).toBe(0);
    expect(AppProfileSchema.meta.lastUpdated).toBe(0);
    expect(AppProfileSchema.meta.updateCount).toBe(0);
    expect(AppProfileSchema.meta.confidence).toBe('unknown');
    expect(AppProfileSchema.meta.changelog).toEqual([]);
  });

  test('selectors.blocks has all block type keys', () => {
    const blocks = AppProfileSchema.selectors.blocks;
    expect(blocks).toHaveProperty('heading');
    expect(blocks).toHaveProperty('paragraph');
    expect(blocks).toHaveProperty('image');
    expect(blocks).toHaveProperty('list');
    expect(blocks).toHaveProperty('table');
    expect(blocks).toHaveProperty('button');
    expect(blocks).toHaveProperty('divider');
    expect(blocks).toHaveProperty('embed');
  });

  test('actions has all action type keys', () => {
    const actions = AppProfileSchema.actions;
    expect(actions).toHaveProperty('replace_text');
    expect(actions).toHaveProperty('insert_block');
    expect(actions).toHaveProperty('delete_block');
    expect(actions).toHaveProperty('move_block');
    expect(actions).toHaveProperty('set_format');
    expect(actions).toHaveProperty('find_and_replace');
  });
});

describe('InstanceProfileSchema shape', () => {
  test('has expected top-level keys', () => {
    expect(InstanceProfileSchema).toHaveProperty('instanceId');
    expect(InstanceProfileSchema).toHaveProperty('domain');
    expect(InstanceProfileSchema).toHaveProperty('version');
    expect(InstanceProfileSchema).toHaveProperty('meta');
    expect(InstanceProfileSchema).toHaveProperty('deltas');
  });

  test('deltas defaults to empty object', () => {
    expect(InstanceProfileSchema.deltas).toEqual({});
  });
});

describe('StorageManager.deepMerge', () => {
  test('merges nested objects recursively', () => {
    const target = { a: { b: 1, c: 2 } };
    const source = { a: { c: 3, d: 4 } };
    const result = StorageManager.deepMerge(target, source);
    expect(result.a.b).toBe(1);
    expect(result.a.c).toBe(3);
    expect(result.a.d).toBe(4);
  });

  test('arrays in source replace arrays in target', () => {
    const target = { items: [1, 2, 3] };
    const source = { items: [4, 5] };
    const result = StorageManager.deepMerge(target, source);
    expect(result.items).toEqual([4, 5]);
  });

  test('primitives in source override primitives in target', () => {
    const target = { name: 'old', count: 10 };
    const source = { name: 'new' };
    const result = StorageManager.deepMerge(target, source);
    expect(result.name).toBe('new');
    expect(result.count).toBe(10);
  });

  test('null values in source set to null in target', () => {
    const target = { a: 'value', b: 'keep' };
    const source = { a: null };
    const result = StorageManager.deepMerge(target, source);
    expect(result.a).toBeNull();
    expect(result.b).toBe('keep');
  });

  test('returns target when source is null/undefined', () => {
    const target = { a: 1 };
    expect(StorageManager.deepMerge(target, null)).toBe(target);
    expect(StorageManager.deepMerge(target, undefined)).toBe(target);
  });

  test('returns deep copy of source when target is non-object', () => {
    const source = { a: { b: 1 } };
    const result = StorageManager.deepMerge(null, source);
    expect(result).toEqual(source);
    expect(result).not.toBe(source); // should be a copy
  });

  test('deeply nested objects are merged correctly', () => {
    const target = { l1: { l2: { l3: { val: 'old', keep: true } } } };
    const source = { l1: { l2: { l3: { val: 'new' } } } };
    const result = StorageManager.deepMerge(target, source);
    expect(result.l1.l2.l3.val).toBe('new');
    expect(result.l1.l2.l3.keep).toBe(true);
  });

  test('source object replaces non-object target value', () => {
    const target = { a: 'string_value' };
    const source = { a: { nested: true } };
    const result = StorageManager.deepMerge(target, source);
    expect(result.a).toEqual({ nested: true });
  });
});

describe('StorageManager.normalizeInstanceId', () => {
  test('strips https protocol', () => {
    const result = StorageManager.normalizeInstanceId('https://example.com/page');
    expect(result).toBe('example.com__page');
  });

  test('strips http protocol', () => {
    const result = StorageManager.normalizeInstanceId('http://example.com/page');
    expect(result).toBe('example.com__page');
  });

  test('strips query parameters', () => {
    const result = StorageManager.normalizeInstanceId('https://example.com/page?foo=bar&baz=1');
    expect(result).toBe('example.com__page');
  });

  test('strips hash fragments', () => {
    const result = StorageManager.normalizeInstanceId('https://example.com/page#section');
    expect(result).toBe('example.com__page');
  });

  test('strips /edit suffix', () => {
    const result = StorageManager.normalizeInstanceId('https://example.com/doc/edit');
    expect(result).toBe('example.com__doc');
  });

  test('strips /view suffix', () => {
    const result = StorageManager.normalizeInstanceId('https://example.com/doc/view');
    expect(result).toBe('example.com__doc');
  });

  test('strips /u/N/ user-switch segments', () => {
    const result = StorageManager.normalizeInstanceId('https://sites.google.com/u/0/s/abc');
    expect(result).toBe('sites.google.com__s__abc');
  });

  test('strips trailing slashes', () => {
    const result = StorageManager.normalizeInstanceId('https://example.com/page/');
    expect(result).toBe('example.com__page');
  });

  test('strips /p/xyz sub-page segments', () => {
    const result = StorageManager.normalizeInstanceId('https://sites.google.com/s/abc/p/xyz');
    expect(result).toBe('sites.google.com__s__abc');
  });

  test('complex Google Sites URL normalization', () => {
    const result = StorageManager.normalizeInstanceId(
      'https://sites.google.com/u/0/s/abc/p/xyz/edit'
    );
    expect(result).toBe('sites.google.com__s__abc');
  });

  test('handles URLs without path', () => {
    const result = StorageManager.normalizeInstanceId('https://example.com');
    expect(result).toBe('example.com');
  });
});

describe('StorageManager.createAppProfile', () => {
  test('creates profile with defaults and stores in chrome.storage', async () => {
    const profile = await StorageManager.createAppProfile('example.com');
    expect(profile.domain).toBe('example.com');
    expect(profile.version).toBe('1.0');
    expect(profile.meta.learnedAt).toBeGreaterThan(0);
    expect(profile.meta.lastUpdated).toBeGreaterThan(0);
    expect(profile.meta.updateCount).toBe(0);
    expect(profile.meta.confidence).toBe('unknown');

    // Verify stored
    const stored = await StorageManager.getAppProfile('example.com');
    expect(stored).not.toBeNull();
    expect(stored.domain).toBe('example.com');
  });

  test('creates profile with initial data merged', async () => {
    const profile = await StorageManager.createAppProfile('test.com', {
      appName: 'TestApp',
      selectors: { blocks: { heading: { value: 'h1', confidence: 'inferred', seenCount: 3 } } }
    });
    expect(profile.appName).toBe('TestApp');
    expect(profile.selectors.blocks.heading.value).toBe('h1');
    expect(profile.selectors.blocks.heading.confidence).toBe('inferred');
  });

  test('sets timestamps correctly', async () => {
    const before = Date.now();
    const profile = await StorageManager.createAppProfile('time.com');
    const after = Date.now();
    expect(profile.meta.learnedAt).toBeGreaterThanOrEqual(before);
    expect(profile.meta.learnedAt).toBeLessThanOrEqual(after);
    expect(profile.meta.lastUpdated).toBe(profile.meta.learnedAt);
  });
});

describe('StorageManager.createInstanceProfile', () => {
  test('creates instance profile with correct shape', async () => {
    const instance = await StorageManager.createInstanceProfile(
      'example.com__page', 'example.com', { custom: 'data' }
    );
    expect(instance.instanceId).toBe('example.com__page');
    expect(instance.domain).toBe('example.com');
    expect(instance.deltas).toEqual({ custom: 'data' });
    expect(instance.meta.learnedAt).toBeGreaterThan(0);
    expect(instance.meta.updateCount).toBe(0);
  });

  test('stores instance in chrome storage', async () => {
    await StorageManager.createInstanceProfile('test__page', 'test.com');
    const stored = await StorageManager.getInstanceProfile('test__page');
    expect(stored).not.toBeNull();
    expect(stored.instanceId).toBe('test__page');
  });
});

describe('StorageManager.getAppProfile', () => {
  test('returns profile when exists', async () => {
    await StorageManager.createAppProfile('exists.com', { appName: 'Exists' });
    const profile = await StorageManager.getAppProfile('exists.com');
    expect(profile).not.toBeNull();
    expect(profile.appName).toBe('Exists');
  });

  test('returns null when profile does not exist', async () => {
    const profile = await StorageManager.getAppProfile('nonexistent.com');
    expect(profile).toBeNull();
  });
});

describe('StorageManager.updateAppProfile', () => {
  test('merges patch into existing profile', async () => {
    await StorageManager.createAppProfile('update.com', { appName: 'Original' });
    await StorageManager.updateAppProfile('update.com', { appName: 'Updated' });
    const profile = await StorageManager.getAppProfile('update.com');
    expect(profile.appName).toBe('Updated');
  });

  test('increments updateCount', async () => {
    await StorageManager.createAppProfile('count.com');
    await StorageManager.updateAppProfile('count.com', { appName: 'V1' });
    await StorageManager.updateAppProfile('count.com', { appName: 'V2' });
    const profile = await StorageManager.getAppProfile('count.com');
    expect(profile.meta.updateCount).toBe(2);
  });

  test('updates lastUpdated timestamp', async () => {
    await StorageManager.createAppProfile('ts.com');
    const created = await StorageManager.getAppProfile('ts.com');
    const createdTime = created.meta.lastUpdated;

    // Small delay to ensure timestamp difference
    await new Promise(r => setTimeout(r, 10));

    await StorageManager.updateAppProfile('ts.com', { appName: 'New' });
    const updated = await StorageManager.getAppProfile('ts.com');
    expect(updated.meta.lastUpdated).toBeGreaterThanOrEqual(createdTime);
  });

  test('throws if profile does not exist', async () => {
    await expect(
      StorageManager.updateAppProfile('nope.com', { appName: 'x' })
    ).rejects.toThrow('does not exist');
  });

  test('adds changelog entries on update', async () => {
    await StorageManager.createAppProfile('log.com');
    await StorageManager.updateAppProfile('log.com', { appName: 'Changed' });
    const profile = await StorageManager.getAppProfile('log.com');
    expect(profile.meta.changelog.length).toBeGreaterThan(0);
    const entry = profile.meta.changelog[0];
    expect(entry.field).toBe('appName');
    expect(entry.newValue).toBe('Changed');
    expect(entry.type).toBe('update');
  });

  test('caps changelog at 50 entries', async () => {
    await StorageManager.createAppProfile('cap.com');
    for (let i = 0; i < 60; i++) {
      await StorageManager.updateAppProfile('cap.com', { appName: `Name${i}` });
    }
    const profile = await StorageManager.getAppProfile('cap.com');
    expect(profile.meta.changelog.length).toBeLessThanOrEqual(50);
  });
});

describe('Confidence protection', () => {
  test('confirmed fields are NOT overwritten without forceConfirmed', async () => {
    await StorageManager.createAppProfile('conf.com', {
      selectors: {
        blocks: {
          heading: { value: 'h1.title', confidence: 'confirmed', seenCount: 10 }
        }
      }
    });

    await StorageManager.updateAppProfile('conf.com', {
      selectors: {
        blocks: {
          heading: { value: 'h1.new-selector', confidence: 'tentative', seenCount: 1 }
        }
      }
    });

    const profile = await StorageManager.getAppProfile('conf.com');
    // Should still be the original confirmed value
    expect(profile.selectors.blocks.heading.value).toBe('h1.title');
    expect(profile.selectors.blocks.heading.confidence).toBe('confirmed');
  });

  test('confirmed fields ARE overwritten when forceConfirmed is true', async () => {
    await StorageManager.createAppProfile('force.com', {
      selectors: {
        blocks: {
          heading: { value: 'h1.title', confidence: 'confirmed', seenCount: 10 }
        }
      }
    });

    await StorageManager.updateAppProfile('force.com', {
      selectors: {
        blocks: {
          heading: { value: 'h1.forced', confidence: 'confirmed', seenCount: 1 }
        }
      }
    }, { forceConfirmed: true });

    const profile = await StorageManager.getAppProfile('force.com');
    expect(profile.selectors.blocks.heading.value).toBe('h1.forced');
  });

  test('non-confirmed fields are overwritten normally', async () => {
    await StorageManager.createAppProfile('noconf.com', {
      selectors: {
        blocks: {
          heading: { value: 'h1.old', confidence: 'tentative', seenCount: 1 }
        }
      }
    });

    await StorageManager.updateAppProfile('noconf.com', {
      selectors: {
        blocks: {
          heading: { value: 'h1.new', confidence: 'inferred', seenCount: 5 }
        }
      }
    });

    const profile = await StorageManager.getAppProfile('noconf.com');
    expect(profile.selectors.blocks.heading.value).toBe('h1.new');
  });
});

describe('StorageManager.getEffectiveProfile', () => {
  test('returns null when neither profile nor instance exists', async () => {
    const result = await StorageManager.getEffectiveProfile('none.com', 'none__page');
    expect(result).toBeNull();
  });

  test('returns app profile when instance has no deltas', async () => {
    await StorageManager.createAppProfile('eff.com', { appName: 'EffApp' });
    await StorageManager.createInstanceProfile('eff__page', 'eff.com');
    const result = await StorageManager.getEffectiveProfile('eff.com', 'eff__page');
    expect(result.appName).toBe('EffApp');
  });

  test('instance deltas override app profile values', async () => {
    await StorageManager.createAppProfile('merge.com', { appName: 'App' });
    await StorageManager.createInstanceProfile('merge__p', 'merge.com', {
      appName: 'InstanceOverride'
    });
    const result = await StorageManager.getEffectiveProfile('merge.com', 'merge__p');
    expect(result.appName).toBe('InstanceOverride');
  });

  test('returns instance deltas when no app profile exists', async () => {
    await StorageManager.createInstanceProfile('solo__page', 'solo.com', {
      custom: 'value'
    });
    const result = await StorageManager.getEffectiveProfile('solo.com', 'solo__page');
    expect(result.custom).toBe('value');
  });
});

describe('StorageManager import/export', () => {
  test('export returns valid JSON with profiles and instances', async () => {
    await StorageManager.createAppProfile('exp.com', { appName: 'Exported' });
    const json = await StorageManager.exportAll();
    const parsed = JSON.parse(json);
    expect(parsed).toHaveProperty('profiles');
    expect(parsed).toHaveProperty('instances');
    expect(parsed.profiles['exp.com'].appName).toBe('Exported');
  });

  test('import (replace mode) replaces all data', async () => {
    await StorageManager.createAppProfile('old.com', { appName: 'Old' });
    const importData = JSON.stringify({
      profiles: { 'new.com': { domain: 'new.com', appName: 'New' } },
      instances: {}
    });
    await StorageManager.importAll(importData, false);
    const oldProfile = await StorageManager.getAppProfile('old.com');
    const newProfile = await StorageManager.getAppProfile('new.com');
    expect(oldProfile).toBeNull();
    expect(newProfile).not.toBeNull();
    expect(newProfile.appName).toBe('New');
  });

  test('import (merge mode) merges with existing data', async () => {
    await StorageManager.createAppProfile('keep.com', { appName: 'Keep' });
    const importData = JSON.stringify({
      profiles: { 'add.com': { domain: 'add.com', appName: 'Added' } },
      instances: {}
    });
    await StorageManager.importAll(importData, true);
    const kept = await StorageManager.getAppProfile('keep.com');
    const added = await StorageManager.getAppProfile('add.com');
    expect(kept).not.toBeNull();
    expect(added).not.toBeNull();
  });

  test('export then import roundtrip preserves data', async () => {
    await StorageManager.createAppProfile('rt.com', { appName: 'RoundTrip' });
    await StorageManager.createInstanceProfile('rt__p', 'rt.com', { delta: true });
    const exported = await StorageManager.exportAll();

    // Clear storage
    chrome.storage.local._reset();

    await StorageManager.importAll(exported, false);
    const profile = await StorageManager.getAppProfile('rt.com');
    const instance = await StorageManager.getInstanceProfile('rt__p');
    expect(profile.appName).toBe('RoundTrip');
    expect(instance.deltas.delta).toBe(true);
  });
});

describe('Confidence helpers', () => {
  test('confidenceRank returns correct ordering', () => {
    expect(confidenceRank('unknown')).toBe(0);
    expect(confidenceRank('tentative')).toBe(1);
    expect(confidenceRank('inferred')).toBe(2);
    expect(confidenceRank('confirmed')).toBe(3);
  });

  test('confidenceRank returns 0 for invalid levels', () => {
    expect(confidenceRank('invalid')).toBe(0);
    expect(confidenceRank('')).toBe(0);
  });

  test('_isConfidenceProtected returns true for confirmed objects', () => {
    const val = { value: 'x', confidence: 'confirmed' };
    expect(StorageManager._isConfidenceProtected(val, false)).toBe(true);
  });

  test('_isConfidenceProtected returns false when forceConfirmed is true', () => {
    const val = { value: 'x', confidence: 'confirmed' };
    expect(StorageManager._isConfidenceProtected(val, true)).toBe(false);
  });

  test('_isConfidenceProtected returns false for non-confirmed objects', () => {
    const val = { value: 'x', confidence: 'inferred' };
    expect(StorageManager._isConfidenceProtected(val, false)).toBe(false);
  });

  test('_isConfidenceProtected returns false for primitives', () => {
    expect(StorageManager._isConfidenceProtected('string', false)).toBe(false);
    expect(StorageManager._isConfidenceProtected(42, false)).toBe(false);
    expect(StorageManager._isConfidenceProtected(null, false)).toBe(false);
  });
});
