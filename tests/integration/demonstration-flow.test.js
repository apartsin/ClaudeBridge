/**
 * Integration tests for the full demonstration workflow.
 *
 * Tests the end-to-end flow: start recording -> perform edits ->
 * stop recording -> analyze recording -> save knowledge to profile.
 */

require('../helpers/setup');

// ─── Re-use DemonstrationRecorder and Analyzer from unit tests ───────────────

class DemonstrationRecorder {
  constructor(options = {}) {
    this.maxEvents = options.maxEvents || 100;
    this.maxDuration = options.maxDuration || 60000;
    this.recording = false;
    this.events = [];
    this.startTime = null;
    this.endTime = null;
    this._mutationObserver = null;
    this._mutations = [];
    this._autoStopTimer = null;
    this._eventHandlers = {};
  }

  start() {
    if (this.recording) return;
    this.recording = true;
    this.events = [];
    this._mutations = [];
    this.startTime = Date.now();
    this.endTime = null;
    this._mutationObserver = new MutationObserver((mutations) => {
      if (!this.recording) return;
      for (const mutation of mutations) {
        this._mutations.push({
          type: mutation.type,
          target: this._describeElement(mutation.target),
          timestamp: Date.now(),
          addedNodes: mutation.addedNodes ? mutation.addedNodes.length : 0,
          removedNodes: mutation.removedNodes ? mutation.removedNodes.length : 0,
          attributeName: mutation.attributeName || null,
          oldValue: mutation.oldValue || null
        });
      }
    });
    this._mutationObserver.observe(document.body, {
      childList: true, subtree: true, characterData: true, attributes: true, attributeOldValue: true
    });
    const eventTypes = ['click', 'input', 'keydown', 'focus', 'blur'];
    for (const eventType of eventTypes) {
      const handler = (e) => this._captureEvent(eventType, e);
      this._eventHandlers[eventType] = handler;
      document.addEventListener(eventType, handler, true);
    }
    this._autoStopTimer = setTimeout(() => { if (this.recording) this.stop(); }, this.maxDuration);
  }

  stop() {
    if (!this.recording) return null;
    this.recording = false;
    this.endTime = Date.now();
    if (this._mutationObserver) { this._mutationObserver.disconnect(); this._mutationObserver = null; }
    for (const [eventType, handler] of Object.entries(this._eventHandlers)) {
      document.removeEventListener(eventType, handler, true);
    }
    this._eventHandlers = {};
    if (this._autoStopTimer) { clearTimeout(this._autoStopTimer); this._autoStopTimer = null; }
    return this.getRecording();
  }

  getRecording() {
    return {
      startTime: this.startTime, endTime: this.endTime,
      duration: this.endTime ? this.endTime - this.startTime : null,
      events: [...this.events], mutations: [...this._mutations],
      eventCount: this.events.length, mutationCount: this._mutations.length
    };
  }

  _captureEvent(eventType, e) {
    if (!this.recording || this.events.length >= this.maxEvents) return;
    const event = { type: eventType, timestamp: Date.now(), target: this._describeElement(e.target), data: null };
    if (eventType === 'input') event.data = e.data || (e.target && e.target.value) || null;
    if (eventType === 'keydown') event.data = { key: e.key, code: e.code, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey };
    this.events.push(event);
  }

  _describeElement(el) {
    if (!el || !el.tagName) return null;
    return {
      tagName: el.tagName.toLowerCase(), id: el.id || null, className: el.className || null,
      contentEditable: el.contentEditable === 'true', textContent: (el.textContent || '').substring(0, 50)
    };
  }
}

class DemonstrationAnalyzer {
  analyze(recording) {
    if (!recording || !recording.events) return { actions: [], quirks: [], editMethod: null, summary: '', selectors: {} };
    const actions = this._detectActions(recording);
    const quirks = this._detectQuirks(recording);
    const editMethod = this._detectEditMethod(recording);
    const selectors = this._generateSelectors(recording);
    const summary = this._generateSummary(recording, actions, quirks);
    return { actions, quirks, editMethod, selectors, summary };
  }

  _detectActions(recording) {
    const actions = [];
    const inputEvents = recording.events.filter((e) => e.type === 'input');
    const keyEvents = recording.events.filter((e) => e.type === 'keydown');
    if (inputEvents.length > 0) {
      actions.push({ type: 'text_edit', count: inputEvents.length, targets: inputEvents.map((e) => e.target).filter(Boolean) });
    }
    const formatKeydowns = keyEvents.filter((e) => e.data && e.data.ctrlKey && ['b', 'i', 'u'].includes(e.data.key));
    if (formatKeydowns.length > 0) {
      actions.push({ type: 'format_change', count: formatKeydowns.length, details: formatKeydowns.map((e) => e.data.key) });
    }
    return actions;
  }

  _detectQuirks(recording) {
    const quirks = [];
    if (recording.events.length >= 2) {
      for (let i = 1; i < recording.events.length; i++) {
        const delay = recording.events[i].timestamp - recording.events[i - 1].timestamp;
        if (delay > 2000) { quirks.push({ description: `Significant delay (${delay}ms)`, confidence: 'tentative' }); break; }
      }
    }
    const inputCount = recording.events.filter((e) => e.type === 'input').length;
    if (inputCount > 0 && (recording.mutationCount || 0) === 0) {
      quirks.push({ description: 'Input events without DOM mutations', confidence: 'tentative' });
    }
    return quirks;
  }

  _detectEditMethod(recording) {
    const mutations = recording.mutations || [];
    const inputEvents = recording.events.filter((e) => e.type === 'input');
    if (mutations.length > 0 && inputEvents.length > 0) {
      if (mutations.some((m) => m.type === 'characterData')) return 'contenteditable';
      if (mutations.some((m) => m.type === 'childList')) return 'framework';
    }
    if (inputEvents.length > 0 && mutations.length === 0) return 'virtual';
    return null;
  }

  _generateSelectors(recording) {
    const selectors = {};
    const targets = recording.events.map((e) => e.target).filter(Boolean);
    for (const target of targets) {
      if (target.id) selectors[`#${target.id}`] = (selectors[`#${target.id}`] || 0) + 1;
      if (target.className) {
        const cls = `.${String(target.className).split(' ')[0]}`;
        selectors[cls] = (selectors[cls] || 0) + 1;
      }
    }
    return selectors;
  }

  _generateSummary(recording, actions, quirks) {
    const lines = [];
    lines.push(`Recording duration: ${recording.duration || 0}ms`);
    lines.push(`Total events: ${recording.eventCount || 0}`);
    lines.push(`Total mutations: ${recording.mutationCount || 0}`);
    if (actions.length > 0) { lines.push(''); lines.push('Detected actions:'); actions.forEach((a) => lines.push(`  - ${a.type}: ${a.count}`)); }
    if (quirks.length > 0) { lines.push(''); lines.push('Detected quirks:'); quirks.forEach((q) => lines.push(`  - ${q.description}`)); }
    return lines.join('\n');
  }
}

// ─── StorageManager (minimal for integration) ────────────────────────────────

const StorageManager = {
  async getAll() {
    const result = await chrome.storage.local.get(['profiles', 'instances']);
    return { profiles: result.profiles || {}, instances: result.instances || {} };
  },
  async getAppProfile(domain) {
    const { profiles } = await this.getAll();
    return profiles[domain] || null;
  },
  async createAppProfile(domain, initialData = {}) {
    const { profiles, instances } = await this.getAll();
    const now = Date.now();
    const profile = Object.assign({
      domain: '', appName: '', version: '1.0',
      meta: { learnedAt: 0, lastUpdated: 0, updateCount: 0, confidence: 'unknown', changelog: [] },
      selectors: { blocks: {} }, actions: {}, quirks: [], editMethod: { primary: null }
    }, initialData);
    profile.domain = domain;
    profile.meta.learnedAt = now;
    profile.meta.lastUpdated = now;
    profiles[domain] = profile;
    await chrome.storage.local.set({ profiles, instances });
    return profile;
  },
  async updateAppProfile(domain, patch) {
    const { profiles, instances } = await this.getAll();
    let profile = profiles[domain];
    if (!profile) throw new Error(`Profile "${domain}" does not exist.`);
    // Simple merge for integration tests
    for (const key of Object.keys(patch)) {
      if (key === 'meta') continue;
      if (typeof patch[key] === 'object' && patch[key] !== null && !Array.isArray(patch[key]) &&
          typeof profile[key] === 'object' && profile[key] !== null && !Array.isArray(profile[key])) {
        profile[key] = Object.assign({}, profile[key], patch[key]);
      } else {
        profile[key] = patch[key];
      }
    }
    profile.meta.lastUpdated = Date.now();
    profile.meta.updateCount = (profile.meta.updateCount || 0) + 1;
    profiles[domain] = profile;
    await chrome.storage.local.set({ profiles, instances });
  }
};

// ─── Test setup ──────────────────────────────────────────────────────────────

function setupDemoDOM() {
  document.body.innerHTML = `
    <div contenteditable="true" id="editor">
      <h1 id="title">Demo Title</h1>
      <p id="content">Demo content paragraph.</p>
      <p id="content2">Another paragraph for editing.</p>
    </div>
    <textarea id="notes">Notes here</textarea>
    <button id="save-btn">Save</button>
  `;
  document.title = 'Demo Page';
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Demonstration workflow - recording and stopping', () => {
  beforeEach(() => setupDemoDOM());

  test('full record -> stop cycle produces valid recording', () => {
    const recorder = new DemonstrationRecorder();
    recorder.start();
    expect(recorder.recording).toBe(true);

    // Simulate some user actions
    const content = document.getElementById('content');
    content.click();
    content.dispatchEvent(new Event('focus', { bubbles: true }));
    content.textContent = 'Edited content';
    content.dispatchEvent(new Event('input', { bubbles: true }));

    const recording = recorder.stop();
    expect(recorder.recording).toBe(false);
    expect(recording).not.toBeNull();
    expect(recording.eventCount).toBeGreaterThan(0);
    expect(recording.startTime).toBeDefined();
    expect(recording.endTime).toBeDefined();
    expect(recording.duration).toBeGreaterThanOrEqual(0);
  });

  test('captures click events during recording', () => {
    const recorder = new DemonstrationRecorder();
    recorder.start();

    document.getElementById('save-btn').click();

    const recording = recorder.stop();
    const clicks = recording.events.filter((e) => e.type === 'click');
    expect(clicks.length).toBeGreaterThan(0);
  });

  test('captures input events during editing', () => {
    const recorder = new DemonstrationRecorder();
    recorder.start();

    const ta = document.getElementById('notes');
    ta.value = 'Updated notes';
    ta.dispatchEvent(new Event('input', { bubbles: true }));

    const recording = recorder.stop();
    const inputs = recording.events.filter((e) => e.type === 'input');
    expect(inputs.length).toBeGreaterThan(0);
  });
});

describe('Demonstration workflow - analysis after recording', () => {
  test('analyze recording detects text_edit actions', () => {
    const recorder = new DemonstrationRecorder();
    const analyzer = new DemonstrationAnalyzer();

    setupDemoDOM();
    recorder.start();

    // Simulate text editing
    const p = document.getElementById('content');
    p.textContent = 'New text';
    p.dispatchEvent(new Event('input', { bubbles: true }));
    p.dispatchEvent(new Event('input', { bubbles: true }));

    const recording = recorder.stop();
    const analysis = analyzer.analyze(recording);

    const textEdit = analysis.actions.find((a) => a.type === 'text_edit');
    expect(textEdit).toBeDefined();
    expect(textEdit.count).toBe(2);
  });

  test('analyze recording detects format keyboard shortcuts', () => {
    const analyzer = new DemonstrationAnalyzer();

    const recording = {
      events: [
        { type: 'keydown', timestamp: 1000, target: { tagName: 'p', id: 'content' }, data: { key: 'b', code: 'KeyB', ctrlKey: true, shiftKey: false } },
        { type: 'keydown', timestamp: 1100, target: { tagName: 'p', id: 'content' }, data: { key: 'i', code: 'KeyI', ctrlKey: true, shiftKey: false } }
      ],
      mutations: [],
      eventCount: 2,
      mutationCount: 0,
      duration: 100,
      startTime: 1000,
      endTime: 1100
    };

    const analysis = analyzer.analyze(recording);
    const formatAction = analysis.actions.find((a) => a.type === 'format_change');
    expect(formatAction).toBeDefined();
    expect(formatAction.count).toBe(2);
  });

  test('analyze recording generates selectors from targets', () => {
    const analyzer = new DemonstrationAnalyzer();

    const recording = {
      events: [
        { type: 'click', timestamp: 1000, target: { tagName: 'p', id: 'content', className: 'editable' } },
        { type: 'click', timestamp: 1100, target: { tagName: 'p', id: 'content', className: 'editable' } },
        { type: 'click', timestamp: 1200, target: { tagName: 'button', id: 'save-btn', className: 'primary' } }
      ],
      mutations: [],
      eventCount: 3,
      mutationCount: 0,
      duration: 200,
      startTime: 1000,
      endTime: 1200
    };

    const analysis = analyzer.analyze(recording);
    expect(analysis.selectors['#content']).toBe(2);
    expect(analysis.selectors['#save-btn']).toBe(1);
  });

  test('analyze recording generates human-readable summary', () => {
    const analyzer = new DemonstrationAnalyzer();

    const recording = {
      events: [
        { type: 'input', timestamp: 1000, target: null, data: 'x' },
        { type: 'input', timestamp: 1100, target: null, data: 'y' }
      ],
      mutations: [],
      eventCount: 2,
      mutationCount: 0,
      duration: 500,
      startTime: 1000,
      endTime: 1500
    };

    const analysis = analyzer.analyze(recording);
    expect(typeof analysis.summary).toBe('string');
    expect(analysis.summary.length).toBeGreaterThan(0);
    expect(analysis.summary).toContain('500ms');
    expect(analysis.summary).toContain('2');
  });
});

describe('Demonstration workflow - save analysis to profile', () => {
  test('records edits, analyzes, and saves to profile', async () => {
    setupDemoDOM();
    const domain = 'demo-test.com';

    // Step 1: Create initial profile
    await StorageManager.createAppProfile(domain, { appName: 'Demo App' });

    // Step 2: Record a demonstration
    const recorder = new DemonstrationRecorder();
    recorder.start();

    const p = document.getElementById('content');
    p.textContent = 'Edited text';
    p.dispatchEvent(new Event('input', { bubbles: true }));
    p.dispatchEvent(new Event('input', { bubbles: true }));

    const recording = recorder.stop();

    // Step 3: Analyze the recording
    const analyzer = new DemonstrationAnalyzer();
    const analysis = analyzer.analyze(recording);

    // Step 4: Convert analysis into profile patch
    const profilePatch = {
      editMethod: { primary: analysis.editMethod || 'unknown' },
      quirks: analysis.quirks.map((q) => ({
        description: q.description,
        confidence: q.confidence,
        source: 'demonstration'
      }))
    };

    // If selectors were detected, add them
    if (Object.keys(analysis.selectors).length > 0) {
      profilePatch.learnedSelectors = analysis.selectors;
    }

    // Step 5: Save to profile
    await StorageManager.updateAppProfile(domain, profilePatch);

    // Step 6: Verify profile was updated
    const updatedProfile = await StorageManager.getAppProfile(domain);
    expect(updatedProfile).not.toBeNull();
    expect(updatedProfile.meta.updateCount).toBe(1);
    expect(updatedProfile.editMethod.primary).toBeDefined();
  });

  test('multiple demonstration sessions accumulate knowledge', async () => {
    const domain = 'multi-session.com';

    // Create initial profile
    await StorageManager.createAppProfile(domain, { appName: 'Multi Session App' });

    // First session: basic text editing
    const analyzer = new DemonstrationAnalyzer();
    const session1Recording = {
      events: [
        { type: 'input', timestamp: 1000, target: { tagName: 'p', id: 'p1' }, data: 'hello' }
      ],
      mutations: [{ type: 'characterData', target: null, timestamp: 1000 }],
      eventCount: 1, mutationCount: 1, duration: 500, startTime: 1000, endTime: 1500
    };
    const analysis1 = analyzer.analyze(session1Recording);
    await StorageManager.updateAppProfile(domain, {
      editMethod: { primary: analysis1.editMethod }
    });

    // Second session: formatting
    const session2Recording = {
      events: [
        { type: 'keydown', timestamp: 2000, target: null, data: { key: 'b', code: 'KeyB', ctrlKey: true, shiftKey: false } }
      ],
      mutations: [], eventCount: 1, mutationCount: 0, duration: 300, startTime: 2000, endTime: 2300
    };
    const analysis2 = analyzer.analyze(session2Recording);
    const hasFormatting = analysis2.actions.some((a) => a.type === 'format_change');
    await StorageManager.updateAppProfile(domain, {
      actions: { set_format: { method: 'keyboard-shortcut', confirmed: hasFormatting } }
    });

    // Verify accumulated knowledge
    const profile = await StorageManager.getAppProfile(domain);
    expect(profile.meta.updateCount).toBe(2);
    expect(profile.editMethod.primary).toBe('contenteditable');
    expect(profile.actions.set_format.method).toBe('keyboard-shortcut');
  });
});

describe('Demonstration workflow - error resilience', () => {
  test('analyzer handles recording with no events gracefully', () => {
    const analyzer = new DemonstrationAnalyzer();
    const result = analyzer.analyze({
      events: [], mutations: [], eventCount: 0, mutationCount: 0, duration: 0
    });
    expect(result.actions).toEqual([]);
    expect(result.quirks).toEqual([]);
    expect(result.editMethod).toBeNull();
    expect(typeof result.summary).toBe('string');
  });

  test('recorder handles rapid start/stop', () => {
    const recorder = new DemonstrationRecorder();
    recorder.start();
    const recording = recorder.stop();
    expect(recording).not.toBeNull();
    expect(recording.duration).toBeGreaterThanOrEqual(0);
    expect(recording.events).toEqual([]);
  });

  test('analyzer handles null recording', () => {
    const analyzer = new DemonstrationAnalyzer();
    const result = analyzer.analyze(null);
    expect(result.actions).toEqual([]);
    expect(result.editMethod).toBeNull();
  });

  test('profile update after failed recording does not corrupt data', async () => {
    const domain = 'resilient.com';
    await StorageManager.createAppProfile(domain, { appName: 'Resilient App' });

    // Simulate a "no-op" demonstration (nothing recorded)
    const analyzer = new DemonstrationAnalyzer();
    const emptyAnalysis = analyzer.analyze({
      events: [], mutations: [], eventCount: 0, mutationCount: 0, duration: 0
    });

    // Only update if there's actual data
    if (emptyAnalysis.actions.length > 0) {
      await StorageManager.updateAppProfile(domain, { editMethod: { primary: emptyAnalysis.editMethod } });
    }

    // Profile should remain unchanged
    const profile = await StorageManager.getAppProfile(domain);
    expect(profile.appName).toBe('Resilient App');
    expect(profile.meta.updateCount).toBe(0);
  });
});
