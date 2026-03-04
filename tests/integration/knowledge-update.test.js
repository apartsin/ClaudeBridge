/**
 * Integration tests for the knowledge/profile system.
 *
 * Tests the full lifecycle of creating, reading, updating, and merging
 * profiles using the StorageManager logic against the chrome.storage mock.
 */

require('../helpers/setup');

// ─── Re-implement StorageManager for integration testing ─────────────────────
// (Same as unit test, but tests focus on multi-step workflows)

const AppProfileSchema = {
  domain: '',
  appName: '',
  version: '1.0',
  meta: { learnedAt: 0, lastUpdated: 0, updateCount: 0, confidence: 'unknown', changelog: [] },
  selectors: {
    editModeDetection: null,
    pageContainer: null,
    blocks: { heading: null, paragraph: null, image: null, list: null, table: null, button: null, divider: null, embed: null },
    toolbar: null,
    saveButton: null
  },
  actions: { replace_text: null, insert_block: null, delete_block: null, move_block: null, set_format: null, find_and_replace: null },
  quirks: [],
  editMethod: { primary: null, requiresNativeEvents: false, saveRequired: false, saveMethod: null }
};

const InstanceProfileSchema = {
  instanceId: '', domain: '', version: '1.0',
  meta: { learnedAt: 0, lastUpdated: 0, updateCount: 0, confidence: 'unknown', changelog: [] },
  deltas: {}
};

function makeChangelogEntry(type, field, oldValue, newValue, source, confidence, note) {
  return { timestamp: Date.now(), type, field, oldValue, newValue, source: source || 'auto', confidence: confidence || 'unknown', note: note || '' };
}

const StorageManager = {
  async getAll() {
    const result = await chrome.storage.local.get(['profiles', 'instances']);
    return { profiles: result.profiles || {}, instances: result.instances || {} };
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
    return this.deepMerge(JSON.parse(JSON.stringify(appProfile)), instanceProfile.deltas);
  },
  async createAppProfile(domain, initialData = {}) {
    const { profiles, instances } = await this.getAll();
    const now = Date.now();
    const profile = this.deepMerge(JSON.parse(JSON.stringify(AppProfileSchema)), initialData);
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
    if (!profile) throw new Error(`AppProfile for domain "${domain}" does not exist.`);
    const changelogEntries = [];
    profile = this._applyPatchWithConfidence(profile, patch, forceConfirmed, source, note, changelogEntries, '');
    profile.meta.lastUpdated = Date.now();
    profile.meta.updateCount = (profile.meta.updateCount || 0) + 1;
    if (!Array.isArray(profile.meta.changelog)) profile.meta.changelog = [];
    profile.meta.changelog.push(...changelogEntries);
    if (profile.meta.changelog.length > 50) {
      profile.meta.changelog = profile.meta.changelog.slice(profile.meta.changelog.length - 50);
    }
    if (patch.meta && patch.meta.confidence) profile.meta.confidence = patch.meta.confidence;
    profiles[domain] = profile;
    await chrome.storage.local.set({ profiles, instances });
  },
  async updateInstanceProfile(instanceId, patch, options = {}) {
    const { forceConfirmed = false, source = 'auto', note = '' } = options;
    const { profiles, instances } = await this.getAll();
    let instance = instances[instanceId];
    if (!instance) throw new Error(`InstanceProfile "${instanceId}" does not exist.`);
    const changelogEntries = [];
    instance.deltas = this._applyPatchWithConfidence(instance.deltas || {}, patch, forceConfirmed, source, note, changelogEntries, '');
    instance.meta.lastUpdated = Date.now();
    instance.meta.updateCount = (instance.meta.updateCount || 0) + 1;
    if (!Array.isArray(instance.meta.changelog)) instance.meta.changelog = [];
    instance.meta.changelog.push(...changelogEntries);
    if (instance.meta.changelog.length > 50) {
      instance.meta.changelog = instance.meta.changelog.slice(instance.meta.changelog.length - 50);
    }
    instances[instanceId] = instance;
    await chrome.storage.local.set({ profiles, instances });
  },
  deepMerge(target, source) {
    if (!source || typeof source !== 'object') return target;
    if (!target || typeof target !== 'object') return JSON.parse(JSON.stringify(source));
    for (const key of Object.keys(source)) {
      const srcVal = source[key];
      const tgtVal = target[key];
      if (srcVal === null || srcVal === undefined) { target[key] = srcVal; }
      else if (Array.isArray(srcVal)) { target[key] = JSON.parse(JSON.stringify(srcVal)); }
      else if (typeof srcVal === 'object' && !Array.isArray(srcVal)) {
        if (typeof tgtVal === 'object' && tgtVal !== null && !Array.isArray(tgtVal)) {
          target[key] = this.deepMerge(tgtVal, srcVal);
        } else { target[key] = JSON.parse(JSON.stringify(srcVal)); }
      } else { target[key] = srcVal; }
    }
    return target;
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
        if (tgtVal !== srcVal) changelogEntries.push(makeChangelogEntry('update', fieldPath, tgtVal, srcVal, source, 'unknown', note));
        target[key] = srcVal;
      } else if (Array.isArray(srcVal)) {
        const oldVal = Array.isArray(tgtVal) ? JSON.parse(JSON.stringify(tgtVal)) : tgtVal;
        target[key] = JSON.parse(JSON.stringify(srcVal));
        changelogEntries.push(makeChangelogEntry('update', fieldPath, oldVal, target[key], source, 'unknown', note));
      } else if (typeof srcVal === 'object') {
        if (typeof tgtVal === 'object' && tgtVal !== null && !Array.isArray(tgtVal)) {
          target[key] = this._applyPatchWithConfidence(tgtVal, srcVal, forceConfirmed, source, note, changelogEntries, fieldPath);
        } else {
          changelogEntries.push(makeChangelogEntry('update', fieldPath, tgtVal, srcVal, source, 'unknown', note));
          target[key] = JSON.parse(JSON.stringify(srcVal));
        }
      } else {
        if (tgtVal !== srcVal) changelogEntries.push(makeChangelogEntry('update', fieldPath, tgtVal, srcVal, source, 'unknown', note));
        target[key] = srcVal;
      }
    }
    return target;
  },
  _isConfidenceProtected(value, forceConfirmed) {
    if (forceConfirmed) return false;
    if (value && typeof value === 'object' && !Array.isArray(value)) return value.confidence === 'confirmed';
    return false;
  }
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Knowledge system - profile creation and retrieval', () => {
  test('creates app profile and retrieves it', async () => {
    await StorageManager.createAppProfile('example.com', {
      appName: 'Example App',
      selectors: { blocks: { heading: { value: 'h1', confidence: 'inferred', seenCount: 5 } } }
    });
    const profile = await StorageManager.getAppProfile('example.com');
    expect(profile).not.toBeNull();
    expect(profile.domain).toBe('example.com');
    expect(profile.appName).toBe('Example App');
    expect(profile.selectors.blocks.heading.value).toBe('h1');
  });

  test('creates instance profile and retrieves it', async () => {
    await StorageManager.createInstanceProfile('example.com__page1', 'example.com', {
      specialSelector: '.custom-block'
    });
    const instance = await StorageManager.getInstanceProfile('example.com__page1');
    expect(instance).not.toBeNull();
    expect(instance.instanceId).toBe('example.com__page1');
    expect(instance.deltas.specialSelector).toBe('.custom-block');
  });

  test('retrieves null for non-existent profile', async () => {
    const profile = await StorageManager.getAppProfile('doesnotexist.com');
    expect(profile).toBeNull();
  });

  test('retrieves null for non-existent instance', async () => {
    const instance = await StorageManager.getInstanceProfile('doesnotexist__page');
    expect(instance).toBeNull();
  });
});

describe('Knowledge system - profile updates with patches', () => {
  test('updates app profile with new selectors', async () => {
    await StorageManager.createAppProfile('update.com', { appName: 'Update Test' });
    await StorageManager.updateAppProfile('update.com', {
      selectors: {
        blocks: {
          paragraph: { value: '.custom-p', confidence: 'inferred', seenCount: 10 }
        }
      }
    });
    const profile = await StorageManager.getAppProfile('update.com');
    expect(profile.selectors.blocks.paragraph.value).toBe('.custom-p');
  });

  test('updates app profile with new actions', async () => {
    await StorageManager.createAppProfile('actions.com');
    await StorageManager.updateAppProfile('actions.com', {
      actions: {
        replace_text: { method: 'execCommand', details: {}, confidence: 'inferred' }
      }
    });
    const profile = await StorageManager.getAppProfile('actions.com');
    expect(profile.actions.replace_text.method).toBe('execCommand');
  });

  test('updates app profile with quirks', async () => {
    await StorageManager.createAppProfile('quirks.com');
    await StorageManager.updateAppProfile('quirks.com', {
      quirks: [{ description: 'Requires double-click to edit', confidence: 'inferred', source: 'claude' }]
    });
    const profile = await StorageManager.getAppProfile('quirks.com');
    expect(profile.quirks.length).toBe(1);
    expect(profile.quirks[0].description).toContain('double-click');
  });

  test('multiple updates increment updateCount', async () => {
    await StorageManager.createAppProfile('count.com');
    await StorageManager.updateAppProfile('count.com', { appName: 'V1' });
    await StorageManager.updateAppProfile('count.com', { appName: 'V2' });
    await StorageManager.updateAppProfile('count.com', { appName: 'V3' });
    const profile = await StorageManager.getAppProfile('count.com');
    expect(profile.meta.updateCount).toBe(3);
  });
});

describe('Knowledge system - confidence protection', () => {
  test('confirmed selectors are preserved on auto update', async () => {
    await StorageManager.createAppProfile('conf.com', {
      selectors: {
        blocks: {
          heading: { value: '.confirmed-heading', confidence: 'confirmed', seenCount: 100 }
        }
      }
    });

    // Try to overwrite with tentative selector
    await StorageManager.updateAppProfile('conf.com', {
      selectors: {
        blocks: {
          heading: { value: '.tentative-heading', confidence: 'tentative', seenCount: 1 }
        }
      }
    }, { source: 'auto' });

    const profile = await StorageManager.getAppProfile('conf.com');
    expect(profile.selectors.blocks.heading.value).toBe('.confirmed-heading');
    expect(profile.selectors.blocks.heading.confidence).toBe('confirmed');
  });

  test('confirmed selectors are overwritten with forceConfirmed', async () => {
    await StorageManager.createAppProfile('force.com', {
      selectors: {
        blocks: {
          heading: { value: '.old-confirmed', confidence: 'confirmed', seenCount: 50 }
        }
      }
    });

    await StorageManager.updateAppProfile('force.com', {
      selectors: {
        blocks: {
          heading: { value: '.new-forced', confidence: 'confirmed', seenCount: 1 }
        }
      }
    }, { forceConfirmed: true, source: 'claude' });

    const profile = await StorageManager.getAppProfile('force.com');
    expect(profile.selectors.blocks.heading.value).toBe('.new-forced');
  });

  test('non-confirmed fields are freely updated', async () => {
    await StorageManager.createAppProfile('free.com', {
      selectors: {
        blocks: {
          paragraph: { value: '.old-p', confidence: 'tentative', seenCount: 2 }
        }
      }
    });

    await StorageManager.updateAppProfile('free.com', {
      selectors: {
        blocks: {
          paragraph: { value: '.new-p', confidence: 'inferred', seenCount: 10 }
        }
      }
    });

    const profile = await StorageManager.getAppProfile('free.com');
    expect(profile.selectors.blocks.paragraph.value).toBe('.new-p');
  });
});

describe('Knowledge system - instance deltas override app profile', () => {
  test('effective profile merges instance deltas over app profile', async () => {
    await StorageManager.createAppProfile('merge.com', {
      appName: 'MergeApp',
      selectors: {
        blocks: {
          heading: { value: 'h1', confidence: 'inferred', seenCount: 5 },
          paragraph: { value: 'p', confidence: 'inferred', seenCount: 10 }
        }
      }
    });

    await StorageManager.createInstanceProfile('merge.com__special', 'merge.com', {
      selectors: {
        blocks: {
          heading: { value: '.special-heading', confidence: 'inferred', seenCount: 3 }
        }
      }
    });

    const effective = await StorageManager.getEffectiveProfile('merge.com', 'merge.com__special');
    // Instance delta should override heading
    expect(effective.selectors.blocks.heading.value).toBe('.special-heading');
    // App profile paragraph should remain
    expect(effective.selectors.blocks.paragraph.value).toBe('p');
  });

  test('effective profile preserves app data where no instance delta exists', async () => {
    await StorageManager.createAppProfile('base.com', {
      appName: 'BaseApp',
      editMethod: { primary: 'execCommand', requiresNativeEvents: false }
    });
    await StorageManager.createInstanceProfile('base.com__p1', 'base.com', {
      customField: 'instance-specific'
    });

    const effective = await StorageManager.getEffectiveProfile('base.com', 'base.com__p1');
    expect(effective.appName).toBe('BaseApp');
    expect(effective.editMethod.primary).toBe('execCommand');
    expect(effective.customField).toBe('instance-specific');
  });
});

describe('Knowledge system - changelog tracking', () => {
  test('changelog records field changes', async () => {
    await StorageManager.createAppProfile('log.com', { appName: 'Original' });
    await StorageManager.updateAppProfile('log.com', { appName: 'Updated' }, { source: 'claude', note: 'AI update' });

    const profile = await StorageManager.getAppProfile('log.com');
    expect(profile.meta.changelog.length).toBeGreaterThan(0);

    const entry = profile.meta.changelog[0];
    expect(entry.field).toBe('appName');
    expect(entry.oldValue).toBe('Original');
    expect(entry.newValue).toBe('Updated');
    expect(entry.type).toBe('update');
    expect(entry.source).toBe('claude');
    expect(entry.note).toBe('AI update');
  });

  test('changelog tracks nested field changes', async () => {
    await StorageManager.createAppProfile('nested.com');
    await StorageManager.updateAppProfile('nested.com', {
      editMethod: { primary: 'execCommand' }
    });

    const profile = await StorageManager.getAppProfile('nested.com');
    const entry = profile.meta.changelog.find((e) => e.field === 'editMethod.primary');
    expect(entry).toBeDefined();
    expect(entry.newValue).toBe('execCommand');
  });

  test('changelog is capped at 50 entries', async () => {
    await StorageManager.createAppProfile('capped.com');
    for (let i = 0; i < 60; i++) {
      await StorageManager.updateAppProfile('capped.com', { appName: `Name-${i}` });
    }
    const profile = await StorageManager.getAppProfile('capped.com');
    expect(profile.meta.changelog.length).toBeLessThanOrEqual(50);
  });

  test('changelog preserves most recent entries when capped', async () => {
    await StorageManager.createAppProfile('recent.com');
    for (let i = 0; i < 55; i++) {
      await StorageManager.updateAppProfile('recent.com', { appName: `Name-${i}` });
    }
    const profile = await StorageManager.getAppProfile('recent.com');
    // The last entry should be for the most recent update (Name-54)
    const lastEntry = profile.meta.changelog[profile.meta.changelog.length - 1];
    expect(lastEntry.newValue).toBe('Name-54');
  });
});

describe('Knowledge system - full auto-learning workflow', () => {
  test('simulates first-visit auto-learning cycle', async () => {
    const domain = 'newsite.com';
    const instanceId = 'newsite.com__page__home';

    // Step 1: Verify no existing profiles
    let appProfile = await StorageManager.getAppProfile(domain);
    expect(appProfile).toBeNull();

    // Step 2: Create app profile from exploration results
    const explorationData = {
      appName: 'New Site CMS',
      selectors: {
        blocks: {
          heading: { value: 'h1.title', confidence: 'inferred', seenCount: 1 },
          paragraph: { value: '.content p', confidence: 'inferred', seenCount: 5 }
        }
      },
      editMethod: { primary: 'contenteditable', requiresNativeEvents: false },
      quirks: [{ description: 'Auto-saves every 30 seconds', confidence: 'tentative', source: 'auto' }]
    };
    await StorageManager.createAppProfile(domain, explorationData);

    // Step 3: Create instance profile
    await StorageManager.createInstanceProfile(instanceId, domain, {
      structure: { totalBlocks: 15, blockTypes: { heading: 2, paragraph: 10, list: 3 } }
    });

    // Step 4: Verify profiles are stored
    appProfile = await StorageManager.getAppProfile(domain);
    expect(appProfile).not.toBeNull();
    expect(appProfile.appName).toBe('New Site CMS');

    const instanceProfile = await StorageManager.getInstanceProfile(instanceId);
    expect(instanceProfile).not.toBeNull();
    expect(instanceProfile.deltas.structure.totalBlocks).toBe(15);

    // Step 5: Get effective profile
    const effective = await StorageManager.getEffectiveProfile(domain, instanceId);
    expect(effective.appName).toBe('New Site CMS');
    expect(effective.structure.totalBlocks).toBe(15);

    // Step 6: Update with refined knowledge
    await StorageManager.updateAppProfile(domain, {
      selectors: {
        blocks: {
          heading: { value: 'h1.page-title', confidence: 'inferred', seenCount: 5 }
        }
      }
    }, { source: 'claude', note: 'Refined after editing session' });

    const updatedProfile = await StorageManager.getAppProfile(domain);
    expect(updatedProfile.selectors.blocks.heading.value).toBe('h1.page-title');
    expect(updatedProfile.meta.updateCount).toBe(1);
    expect(updatedProfile.meta.changelog.length).toBeGreaterThan(0);
  });
});

describe('Knowledge system - multiple domains isolation', () => {
  test('profiles for different domains do not interfere', async () => {
    await StorageManager.createAppProfile('alpha.com', { appName: 'Alpha' });
    await StorageManager.createAppProfile('beta.com', { appName: 'Beta' });
    await StorageManager.createAppProfile('gamma.com', { appName: 'Gamma' });

    const alpha = await StorageManager.getAppProfile('alpha.com');
    const beta = await StorageManager.getAppProfile('beta.com');
    const gamma = await StorageManager.getAppProfile('gamma.com');

    expect(alpha.appName).toBe('Alpha');
    expect(beta.appName).toBe('Beta');
    expect(gamma.appName).toBe('Gamma');

    // Update one, others unchanged
    await StorageManager.updateAppProfile('beta.com', { appName: 'Beta Updated' });

    const alphaAfter = await StorageManager.getAppProfile('alpha.com');
    const betaAfter = await StorageManager.getAppProfile('beta.com');
    expect(alphaAfter.appName).toBe('Alpha');
    expect(betaAfter.appName).toBe('Beta Updated');
  });
});
