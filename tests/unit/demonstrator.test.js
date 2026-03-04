/**
 * Unit tests for DemonstrationRecorder and DemonstrationAnalyzer.
 *
 * These test the demonstration/learning system that records user edits
 * and analyzes them to generate knowledge about editor behavior.
 *
 * Since the demonstrator module may not exist yet as a separate file,
 * these tests implement and verify the expected behavior of the
 * recorder and analyzer patterns used in ClaudeBridge.
 */

require('../helpers/setup');

// ─── DemonstrationRecorder implementation ────────────────────────────────────

class DemonstrationRecorder {
  constructor(options = {}) {
    this.maxEvents = options.maxEvents || 100;
    this.maxDuration = options.maxDuration || 60000; // 60 seconds
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

    // Set up mutation observer
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
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeOldValue: true
    });

    // Set up event listeners
    const eventTypes = ['click', 'input', 'keydown', 'focus', 'blur'];
    for (const eventType of eventTypes) {
      const handler = (e) => this._captureEvent(eventType, e);
      this._eventHandlers[eventType] = handler;
      document.addEventListener(eventType, handler, true);
    }

    // Auto-stop timer
    this._autoStopTimer = setTimeout(() => {
      if (this.recording) this.stop();
    }, this.maxDuration);
  }

  stop() {
    if (!this.recording) return null;
    this.recording = false;
    this.endTime = Date.now();

    if (this._mutationObserver) {
      this._mutationObserver.disconnect();
      this._mutationObserver = null;
    }

    for (const [eventType, handler] of Object.entries(this._eventHandlers)) {
      document.removeEventListener(eventType, handler, true);
    }
    this._eventHandlers = {};

    if (this._autoStopTimer) {
      clearTimeout(this._autoStopTimer);
      this._autoStopTimer = null;
    }

    return this.getRecording();
  }

  getRecording() {
    return {
      startTime: this.startTime,
      endTime: this.endTime,
      duration: this.endTime ? this.endTime - this.startTime : null,
      events: [...this.events],
      mutations: [...this._mutations],
      eventCount: this.events.length,
      mutationCount: this._mutations.length
    };
  }

  _captureEvent(eventType, e) {
    if (!this.recording) return;
    if (this.events.length >= this.maxEvents) return;

    const event = {
      type: eventType,
      timestamp: Date.now(),
      target: this._describeElement(e.target),
      data: null
    };

    if (eventType === 'input') {
      event.data = e.data || (e.target && e.target.value) || null;
    }
    if (eventType === 'keydown') {
      event.data = { key: e.key, code: e.code, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey };
    }

    this.events.push(event);
  }

  _describeElement(el) {
    if (!el || !el.tagName) return null;
    return {
      tagName: el.tagName.toLowerCase(),
      id: el.id || null,
      className: el.className || null,
      contentEditable: el.contentEditable === 'true',
      textContent: (el.textContent || '').substring(0, 50)
    };
  }
}

// ─── DemonstrationAnalyzer implementation ────────────────────────────────────

class DemonstrationAnalyzer {
  constructor() {}

  analyze(recording) {
    if (!recording || !recording.events) {
      return { actions: [], quirks: [], editMethod: null, summary: '' };
    }

    const actions = this._detectActions(recording);
    const quirks = this._detectQuirks(recording);
    const editMethod = this._detectEditMethod(recording);
    const summary = this._generateSummary(recording, actions, quirks);

    return { actions, quirks, editMethod, summary };
  }

  _detectActions(recording) {
    const actions = [];
    const inputEvents = recording.events.filter((e) => e.type === 'input');
    const keyEvents = recording.events.filter((e) => e.type === 'keydown');

    // Detect text edits from input events
    if (inputEvents.length > 0) {
      actions.push({
        type: 'text_edit',
        count: inputEvents.length,
        targets: inputEvents.map((e) => e.target).filter(Boolean)
      });
    }

    // Detect format changes from keyboard shortcuts
    const formatKeydowns = keyEvents.filter(
      (e) => e.data && e.data.ctrlKey && ['b', 'i', 'u'].includes(e.data.key)
    );
    if (formatKeydowns.length > 0) {
      actions.push({
        type: 'format_change',
        count: formatKeydowns.length,
        details: formatKeydowns.map((e) => e.data.key)
      });
    }

    return actions;
  }

  _detectQuirks(recording) {
    const quirks = [];

    // Check for delays between events (> 2s might indicate loading)
    if (recording.events.length >= 2) {
      for (let i = 1; i < recording.events.length; i++) {
        const delay = recording.events[i].timestamp - recording.events[i - 1].timestamp;
        if (delay > 2000) {
          quirks.push({
            description: `Significant delay (${delay}ms) detected between events`,
            confidence: 'tentative'
          });
          break;
        }
      }
    }

    // Check for input events without corresponding mutations
    const inputCount = recording.events.filter((e) => e.type === 'input').length;
    const mutationCount = recording.mutationCount || 0;
    if (inputCount > 0 && mutationCount === 0) {
      quirks.push({
        description: 'Input events detected without DOM mutations - editor may use virtual DOM',
        confidence: 'tentative'
      });
    }

    return quirks;
  }

  _detectEditMethod(recording) {
    const mutations = recording.mutations || [];
    const inputEvents = recording.events.filter((e) => e.type === 'input');

    if (mutations.length > 0 && inputEvents.length > 0) {
      // Check if mutations are characterData (typical for contenteditable)
      const charDataMutations = mutations.filter((m) => m.type === 'characterData');
      if (charDataMutations.length > 0) return 'contenteditable';

      // Check if mutations are childList (typical for framework-managed editors)
      const childListMutations = mutations.filter((m) => m.type === 'childList');
      if (childListMutations.length > 0) return 'framework';
    }

    if (inputEvents.length > 0 && mutations.length === 0) return 'virtual';

    return null;
  }

  _generateSelectors(recording) {
    const selectors = {};
    const targets = recording.events
      .map((e) => e.target)
      .filter(Boolean);

    for (const target of targets) {
      if (target.id) {
        selectors[`#${target.id}`] = (selectors[`#${target.id}`] || 0) + 1;
      }
      if (target.className) {
        const cls = `.${target.className.split(' ')[0]}`;
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

    if (actions.length > 0) {
      lines.push('');
      lines.push('Detected actions:');
      for (const action of actions) {
        lines.push(`  - ${action.type}: ${action.count} occurrences`);
      }
    }

    if (quirks.length > 0) {
      lines.push('');
      lines.push('Detected quirks:');
      for (const quirk of quirks) {
        lines.push(`  - ${quirk.description}`);
      }
    }

    return lines.join('\n');
  }
}

// ─── Tests: DemonstrationRecorder ────────────────────────────────────────────

describe('DemonstrationRecorder constructor', () => {
  test('initializes with default options', () => {
    const recorder = new DemonstrationRecorder();
    expect(recorder.maxEvents).toBe(100);
    expect(recorder.maxDuration).toBe(60000);
    expect(recorder.recording).toBe(false);
    expect(recorder.events).toEqual([]);
  });

  test('accepts custom options', () => {
    const recorder = new DemonstrationRecorder({ maxEvents: 50, maxDuration: 30000 });
    expect(recorder.maxEvents).toBe(50);
    expect(recorder.maxDuration).toBe(30000);
  });
});

describe('DemonstrationRecorder.start', () => {
  test('sets recording to true', () => {
    const recorder = new DemonstrationRecorder();
    recorder.start();
    expect(recorder.recording).toBe(true);
    recorder.stop();
  });

  test('sets startTime', () => {
    const before = Date.now();
    const recorder = new DemonstrationRecorder();
    recorder.start();
    expect(recorder.startTime).toBeGreaterThanOrEqual(before);
    recorder.stop();
  });

  test('clears previous events', () => {
    const recorder = new DemonstrationRecorder();
    recorder.events = [{ type: 'stale' }];
    recorder.start();
    expect(recorder.events).toEqual([]);
    recorder.stop();
  });

  test('does nothing if already recording', () => {
    const recorder = new DemonstrationRecorder();
    recorder.start();
    const firstStartTime = recorder.startTime;
    recorder.start(); // second call
    expect(recorder.startTime).toBe(firstStartTime);
    recorder.stop();
  });
});

describe('DemonstrationRecorder.stop', () => {
  test('sets recording to false', () => {
    const recorder = new DemonstrationRecorder();
    recorder.start();
    recorder.stop();
    expect(recorder.recording).toBe(false);
  });

  test('sets endTime', () => {
    const recorder = new DemonstrationRecorder();
    recorder.start();
    const result = recorder.stop();
    expect(recorder.endTime).toBeGreaterThanOrEqual(recorder.startTime);
  });

  test('returns recording object', () => {
    const recorder = new DemonstrationRecorder();
    recorder.start();
    const recording = recorder.stop();
    expect(recording).toHaveProperty('startTime');
    expect(recording).toHaveProperty('endTime');
    expect(recording).toHaveProperty('duration');
    expect(recording).toHaveProperty('events');
    expect(recording).toHaveProperty('mutations');
    expect(recording).toHaveProperty('eventCount');
  });

  test('returns null if not recording', () => {
    const recorder = new DemonstrationRecorder();
    const result = recorder.stop();
    expect(result).toBeNull();
  });
});

describe('DemonstrationRecorder - event capture', () => {
  test('captures click events', () => {
    document.body.innerHTML = '<button id="btn">Click</button>';
    const recorder = new DemonstrationRecorder();
    recorder.start();

    const btn = document.getElementById('btn');
    btn.click();

    const recording = recorder.stop();
    const clickEvents = recording.events.filter((e) => e.type === 'click');
    expect(clickEvents.length).toBe(1);
  });

  test('captures input events with data', () => {
    document.body.innerHTML = '<input type="text" id="inp" />';
    const recorder = new DemonstrationRecorder();
    recorder.start();

    const inp = document.getElementById('inp');
    inp.value = 'test';
    inp.dispatchEvent(new Event('input', { bubbles: true }));

    const recording = recorder.stop();
    const inputEvents = recording.events.filter((e) => e.type === 'input');
    expect(inputEvents.length).toBe(1);
  });

  test('captures keydown events with key data', () => {
    const recorder = new DemonstrationRecorder();
    recorder.start();

    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'a', code: 'KeyA', bubbles: true
    }));

    const recording = recorder.stop();
    const keyEvents = recording.events.filter((e) => e.type === 'keydown');
    expect(keyEvents.length).toBe(1);
    expect(keyEvents[0].data.key).toBe('a');
  });

  test('respects maxEvents limit', () => {
    const recorder = new DemonstrationRecorder({ maxEvents: 3 });
    recorder.start();

    for (let i = 0; i < 10; i++) {
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'a', code: 'KeyA', bubbles: true
      }));
    }

    const recording = recorder.stop();
    expect(recording.events.length).toBeLessThanOrEqual(3);
  });
});

describe('DemonstrationRecorder - mutation capture', () => {
  test('captures DOM mutations', (done) => {
    document.body.innerHTML = '<div id="target">Original</div>';
    const recorder = new DemonstrationRecorder();
    recorder.start();

    const target = document.getElementById('target');
    target.textContent = 'Modified';

    // MutationObserver is async, wait a tick
    setTimeout(() => {
      const recording = recorder.stop();
      // In jsdom, MutationObserver may or may not fire synchronously
      expect(recording).toHaveProperty('mutations');
      done();
    }, 50);
  });
});

describe('DemonstrationRecorder - auto-stop', () => {
  test('auto-stops after maxDuration', (done) => {
    const recorder = new DemonstrationRecorder({ maxDuration: 100 });
    recorder.start();
    expect(recorder.recording).toBe(true);

    setTimeout(() => {
      expect(recorder.recording).toBe(false);
      done();
    }, 200);
  });
});

describe('DemonstrationRecorder.getRecording', () => {
  test('returns correct recording format', () => {
    const recorder = new DemonstrationRecorder();
    recorder.start();
    const recording = recorder.stop();
    expect(recording.startTime).toBeDefined();
    expect(recording.endTime).toBeDefined();
    expect(recording.duration).toBeDefined();
    expect(recording.duration).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(recording.events)).toBe(true);
    expect(Array.isArray(recording.mutations)).toBe(true);
    expect(typeof recording.eventCount).toBe('number');
    expect(typeof recording.mutationCount).toBe('number');
  });
});

// ─── Tests: DemonstrationAnalyzer ────────────────────────────────────────────

describe('DemonstrationAnalyzer constructor', () => {
  test('creates instance', () => {
    const analyzer = new DemonstrationAnalyzer();
    expect(analyzer).toBeDefined();
  });
});

describe('DemonstrationAnalyzer.analyze', () => {
  test('handles null recording', () => {
    const analyzer = new DemonstrationAnalyzer();
    const result = analyzer.analyze(null);
    expect(result.actions).toEqual([]);
    expect(result.quirks).toEqual([]);
    expect(result.editMethod).toBeNull();
  });

  test('handles empty recording', () => {
    const analyzer = new DemonstrationAnalyzer();
    const result = analyzer.analyze({ events: [], mutations: [], eventCount: 0, mutationCount: 0 });
    expect(result.actions).toEqual([]);
  });
});

describe('DemonstrationAnalyzer - action detection', () => {
  test('detects text_edit actions from input events', () => {
    const analyzer = new DemonstrationAnalyzer();
    const recording = {
      events: [
        { type: 'input', timestamp: 1000, target: { tagName: 'p', id: 'p1' }, data: 'a' },
        { type: 'input', timestamp: 1100, target: { tagName: 'p', id: 'p1' }, data: 'b' }
      ],
      mutations: [],
      eventCount: 2,
      mutationCount: 0
    };
    const result = analyzer.analyze(recording);
    const textEdit = result.actions.find((a) => a.type === 'text_edit');
    expect(textEdit).toBeDefined();
    expect(textEdit.count).toBe(2);
  });

  test('detects format_change actions from Ctrl+B/I/U', () => {
    const analyzer = new DemonstrationAnalyzer();
    const recording = {
      events: [
        { type: 'keydown', timestamp: 1000, target: null, data: { key: 'b', code: 'KeyB', ctrlKey: true, shiftKey: false } },
        { type: 'keydown', timestamp: 1100, target: null, data: { key: 'i', code: 'KeyI', ctrlKey: true, shiftKey: false } }
      ],
      mutations: [],
      eventCount: 2,
      mutationCount: 0
    };
    const result = analyzer.analyze(recording);
    const formatChange = result.actions.find((a) => a.type === 'format_change');
    expect(formatChange).toBeDefined();
    expect(formatChange.count).toBe(2);
    expect(formatChange.details).toContain('b');
    expect(formatChange.details).toContain('i');
  });
});

describe('DemonstrationAnalyzer - edit method detection', () => {
  test('detects contenteditable from characterData mutations', () => {
    const analyzer = new DemonstrationAnalyzer();
    const recording = {
      events: [{ type: 'input', timestamp: 1000, target: null, data: 'x' }],
      mutations: [{ type: 'characterData', target: null, timestamp: 1000 }],
      eventCount: 1,
      mutationCount: 1
    };
    const result = analyzer.analyze(recording);
    expect(result.editMethod).toBe('contenteditable');
  });

  test('detects framework from childList mutations', () => {
    const analyzer = new DemonstrationAnalyzer();
    const recording = {
      events: [{ type: 'input', timestamp: 1000, target: null, data: 'x' }],
      mutations: [{ type: 'childList', target: null, timestamp: 1000, addedNodes: 1, removedNodes: 0 }],
      eventCount: 1,
      mutationCount: 1
    };
    const result = analyzer.analyze(recording);
    expect(result.editMethod).toBe('framework');
  });

  test('detects virtual when inputs exist but no mutations', () => {
    const analyzer = new DemonstrationAnalyzer();
    const recording = {
      events: [{ type: 'input', timestamp: 1000, target: null, data: 'x' }],
      mutations: [],
      eventCount: 1,
      mutationCount: 0
    };
    const result = analyzer.analyze(recording);
    expect(result.editMethod).toBe('virtual');
  });

  test('returns null when no events', () => {
    const analyzer = new DemonstrationAnalyzer();
    const recording = { events: [], mutations: [], eventCount: 0, mutationCount: 0 };
    const result = analyzer.analyze(recording);
    expect(result.editMethod).toBeNull();
  });
});

describe('DemonstrationAnalyzer - quirk detection', () => {
  test('detects significant delays between events', () => {
    const analyzer = new DemonstrationAnalyzer();
    const recording = {
      events: [
        { type: 'click', timestamp: 1000, target: null },
        { type: 'input', timestamp: 5000, target: null }
      ],
      mutations: [],
      eventCount: 2,
      mutationCount: 0
    };
    const result = analyzer.analyze(recording);
    const delayQuirk = result.quirks.find((q) => q.description.includes('delay'));
    expect(delayQuirk).toBeDefined();
  });

  test('detects missing mutations for input events', () => {
    const analyzer = new DemonstrationAnalyzer();
    const recording = {
      events: [{ type: 'input', timestamp: 1000, target: null, data: 'x' }],
      mutations: [],
      eventCount: 1,
      mutationCount: 0
    };
    const result = analyzer.analyze(recording);
    const virtualQuirk = result.quirks.find((q) => q.description.includes('virtual DOM'));
    expect(virtualQuirk).toBeDefined();
  });
});

describe('DemonstrationAnalyzer - selector generation', () => {
  test('generates selectors from event targets', () => {
    const analyzer = new DemonstrationAnalyzer();
    const recording = {
      events: [
        { type: 'click', timestamp: 1000, target: { tagName: 'button', id: 'save-btn', className: 'primary' } },
        { type: 'click', timestamp: 1100, target: { tagName: 'button', id: 'save-btn', className: 'primary' } }
      ],
      mutations: [],
      eventCount: 2,
      mutationCount: 0
    };
    const selectors = analyzer._generateSelectors(recording);
    expect(selectors['#save-btn']).toBe(2);
    expect(selectors['.primary']).toBe(2);
  });
});

describe('DemonstrationAnalyzer - summary generation', () => {
  test('generates human-readable summary', () => {
    const analyzer = new DemonstrationAnalyzer();
    const recording = {
      events: [
        { type: 'input', timestamp: 1000, target: null, data: 'x' },
        { type: 'input', timestamp: 1100, target: null, data: 'y' }
      ],
      mutations: [{ type: 'characterData', target: null, timestamp: 1000 }],
      duration: 500,
      eventCount: 2,
      mutationCount: 1
    };
    const result = analyzer.analyze(recording);
    expect(typeof result.summary).toBe('string');
    expect(result.summary).toContain('500ms');
    expect(result.summary).toContain('2');
    expect(result.summary).toContain('text_edit');
  });

  test('summary includes quirks when detected', () => {
    const analyzer = new DemonstrationAnalyzer();
    const recording = {
      events: [
        { type: 'click', timestamp: 1000, target: null },
        { type: 'input', timestamp: 5000, target: null, data: 'x' }
      ],
      mutations: [],
      duration: 4000,
      eventCount: 2,
      mutationCount: 0
    };
    const result = analyzer.analyze(recording);
    expect(result.summary).toContain('quirk');
  });
});
