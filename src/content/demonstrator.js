/**
 * Demonstrator — Records and analyzes user interactions to teach Claude
 * how to edit in unfamiliar editors.
 *
 * DemonstrationRecorder observes DOM mutations and user events on editable
 * regions, producing a raw recording. DemonstrationAnalyzer then classifies
 * the recording into structured knowledge (actions, edit methods, selectors,
 * quirks) that can be saved to a profile.
 */

const LOG_PREFIX = '[ClaudeBridge:Demonstrator]';

/**
 * Event types to listen for during recording.
 * @type {string[]}
 */
const TRACKED_EVENTS = [
  'input',
  'keydown',
  'keyup',
  'click',
  'mousedown',
  'mouseup',
  'paste',
  'cut',
  'copy',
  'focus',
  'blur',
  'compositionstart',
  'compositionend',
  'beforeinput'
];

/**
 * MutationObserver configuration for editable regions.
 * @type {MutationObserverInit}
 */
const MUTATION_CONFIG = {
  childList: true,
  subtree: true,
  characterData: true,
  attributes: true,
  attributeOldValue: true,
  characterDataOldValue: true
};

/**
 * Formatting keyboard shortcuts mapped to their format names.
 * @type {Map<string, string>}
 */
const FORMAT_SHORTCUTS = new Map([
  ['b', 'bold'],
  ['i', 'italic'],
  ['u', 'underline'],
  ['e', 'code'],
  ['k', 'link'],
  ['z', 'undo'],
  ['y', 'redo']
]);

/**
 * Maximum length for content previews stored in recordings.
 * @type {number}
 */
const CONTENT_PREVIEW_LENGTH = 200;

// ---------------------------------------------------------------------------
// DemonstrationRecorder
// ---------------------------------------------------------------------------

export class DemonstrationRecorder {
  constructor() {
    /** @type {boolean} */
    this._recording = false;
    /** @type {Array<object>} Recorded user events. */
    this._events = [];
    /** @type {Array<object>} Recorded DOM mutations. */
    this._mutations = [];
    /** @type {MutationObserver|null} */
    this._observer = null;
    /** @type {Array<{element: EventTarget, type: string, handler: Function}>} */
    this._listeners = [];
    /** @type {number|null} */
    this._startTime = null;
    /** @type {object} User-supplied options. */
    this._options = {};
    /** @type {number} Maximum events before auto-stop. */
    this._maxEvents = 500;
    /** @type {number} Maximum duration in ms before auto-stop. */
    this._maxDuration = 60000;
    /** @type {number|null} Auto-stop timer id. */
    this._timer = null;
    /** @type {object|null} Snapshot of editable regions at recording start. */
    this._initialSnapshot = null;
    /** @type {Element[]} Editable regions being observed. */
    this._editableRegions = [];
  }

  /**
   * Start recording on all editable regions of the page.
   *
   * @param {object} [options]
   * @param {string} [options.targetSelector] - Restrict to regions matching this CSS selector.
   * @param {number} [options.maxEvents] - Override max event limit.
   * @param {number} [options.maxDuration] - Override max duration in ms.
   * @returns {{ status: string, startTime: number, editableRegions: number }}
   */
  start(options = {}) {
    if (this._recording) {
      console.warn(LOG_PREFIX, 'Already recording — call stop() first');
      return { status: 'already_recording', startTime: this._startTime, editableRegions: this._editableRegions.length };
    }

    this._options = options;
    this._events = [];
    this._mutations = [];
    this._startTime = Date.now();
    this._recording = true;

    if (typeof options.maxEvents === 'number' && options.maxEvents > 0) {
      this._maxEvents = options.maxEvents;
    }
    if (typeof options.maxDuration === 'number' && options.maxDuration > 0) {
      this._maxDuration = options.maxDuration;
    }

    // Discover editable regions
    this._editableRegions = this._findEditableRegions(options.targetSelector);
    console.log(LOG_PREFIX, `Found ${this._editableRegions.length} editable region(s)`);

    // Capture initial snapshot before any interaction
    this._initialSnapshot = this._captureSnapshot();

    // Set up MutationObserver
    this._observer = new MutationObserver((mutationsList) => {
      this._handleMutations(mutationsList);
    });
    for (const region of this._editableRegions) {
      this._observer.observe(region, MUTATION_CONFIG);
    }

    // Attach event listeners on document (events bubble)
    for (const eventType of TRACKED_EVENTS) {
      const handler = (event) => this._handleEvent(event);
      document.addEventListener(eventType, handler, true);
      this._listeners.push({ element: document, type: eventType, handler });
    }

    // Auto-stop timer
    this._timer = setTimeout(() => {
      console.log(LOG_PREFIX, 'Auto-stopping: max duration reached');
      this.stop();
    }, this._maxDuration);

    console.log(LOG_PREFIX, 'Recording started');
    return { status: 'recording', startTime: this._startTime, editableRegions: this._editableRegions.length };
  }

  /**
   * Stop recording and return the full recording payload.
   *
   * @returns {{
   *   events: Array<object>,
   *   mutations: Array<object>,
   *   duration: number,
   *   metadata: object,
   *   status: string
   * }}
   */
  stop() {
    if (!this._recording) {
      console.warn(LOG_PREFIX, 'Not currently recording');
      return { events: [], mutations: [], duration: 0, metadata: {}, status: 'not_recording' };
    }

    // Disconnect observer
    if (this._observer) {
      this._observer.disconnect();
      this._observer = null;
    }

    // Remove event listeners
    for (const { element, type, handler } of this._listeners) {
      element.removeEventListener(type, handler, true);
    }
    this._listeners = [];

    // Clear auto-stop timer
    if (this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
    }

    const endTime = Date.now();
    const finalSnapshot = this._captureSnapshot();

    this._recording = false;

    const result = {
      events: this._events.slice(),
      mutations: this._mutations.slice(),
      duration: endTime - this._startTime,
      metadata: {
        startTime: this._startTime,
        endTime,
        url: window.location.href,
        editableRegions: this._editableRegions.length,
        initialSnapshot: this._initialSnapshot,
        finalSnapshot
      },
      status: 'stopped'
    };

    console.log(
      LOG_PREFIX,
      `Recording stopped: ${this._events.length} events, ${this._mutations.length} mutations, ${result.duration}ms`
    );

    return result;
  }

  /**
   * Whether recording is currently active.
   * @returns {boolean}
   */
  isRecording() {
    return this._recording;
  }

  /**
   * Current recording status with counts and timing.
   *
   * @returns {{
   *   recording: boolean,
   *   eventCount: number,
   *   mutationCount: number,
   *   elapsed: number,
   *   remaining: number
   * }}
   */
  getStatus() {
    const elapsed = this._recording ? Date.now() - this._startTime : 0;
    const remaining = this._recording ? Math.max(0, this._maxDuration - elapsed) : 0;
    return {
      recording: this._recording,
      eventCount: this._events.length,
      mutationCount: this._mutations.length,
      elapsed,
      remaining
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Find all editable regions on the page.
   *
   * @param {string} [targetSelector] - Optional CSS selector to restrict scope.
   * @returns {Element[]}
   */
  _findEditableRegions(targetSelector) {
    if (targetSelector) {
      const targets = Array.from(document.querySelectorAll(targetSelector));
      if (targets.length > 0) {
        return targets;
      }
      console.warn(LOG_PREFIX, `No elements matched targetSelector "${targetSelector}", falling back to auto-detect`);
    }

    const regions = new Set();

    // contenteditable elements
    const editables = document.querySelectorAll('[contenteditable="true"], [contenteditable=""]');
    for (const el of editables) {
      regions.add(el);
    }

    // textareas
    const textareas = document.querySelectorAll('textarea');
    for (const el of textareas) {
      regions.add(el);
    }

    // text/number/url/email inputs
    const inputs = document.querySelectorAll(
      'input[type="text"], input[type="url"], input[type="email"], input[type="number"], input[type="search"], input:not([type])'
    );
    for (const el of inputs) {
      regions.add(el);
    }

    return Array.from(regions);
  }

  /**
   * Capture a snapshot of all editable regions' content.
   *
   * @returns {Array<{ selector: string, tagName: string, html: string, text: string }>}
   */
  _captureSnapshot() {
    return this._editableRegions.map((region) => {
      const isInput = region.tagName === 'INPUT' || region.tagName === 'TEXTAREA';
      return {
        selector: this._computeSelector(region),
        tagName: region.tagName.toLowerCase(),
        html: isInput ? '' : region.innerHTML.slice(0, 5000),
        text: isInput ? region.value.slice(0, 5000) : region.textContent.slice(0, 5000)
      };
    });
  }

  /**
   * Handle a batch of DOM mutations from the MutationObserver.
   *
   * @param {MutationRecord[]} mutationsList
   */
  _handleMutations(mutationsList) {
    if (!this._recording) return;

    const timestamp = Date.now() - this._startTime;

    for (const mutation of mutationsList) {
      const record = {
        timestamp,
        type: mutation.type,
        target: {
          tagName: mutation.target.tagName ? mutation.target.tagName.toLowerCase() : '#text',
          selector: this._computeSelector(
            mutation.target.nodeType === Node.ELEMENT_NODE ? mutation.target : mutation.target.parentElement
          )
        },
        details: {}
      };

      switch (mutation.type) {
        case 'childList': {
          const addedTexts = [];
          const removedTexts = [];
          for (const node of mutation.addedNodes) {
            const text = (node.textContent || '').trim();
            if (text) addedTexts.push(text.slice(0, CONTENT_PREVIEW_LENGTH));
          }
          for (const node of mutation.removedNodes) {
            const text = (node.textContent || '').trim();
            if (text) removedTexts.push(text.slice(0, CONTENT_PREVIEW_LENGTH));
          }
          record.details = {
            addedNodesCount: mutation.addedNodes.length,
            removedNodesCount: mutation.removedNodes.length,
            addedTextPreview: addedTexts.join(' | ').slice(0, CONTENT_PREVIEW_LENGTH),
            removedTextPreview: removedTexts.join(' | ').slice(0, CONTENT_PREVIEW_LENGTH)
          };
          break;
        }
        case 'characterData': {
          const oldVal = mutation.oldValue || '';
          const newVal = mutation.target.textContent || '';
          record.details = {
            oldValue: oldVal.slice(0, CONTENT_PREVIEW_LENGTH),
            newValue: newVal.slice(0, CONTENT_PREVIEW_LENGTH)
          };
          break;
        }
        case 'attributes': {
          record.details = {
            attributeName: mutation.attributeName,
            oldValue: mutation.oldValue != null ? String(mutation.oldValue).slice(0, CONTENT_PREVIEW_LENGTH) : null,
            newValue: mutation.target.getAttribute
              ? (mutation.target.getAttribute(mutation.attributeName) || '').slice(0, CONTENT_PREVIEW_LENGTH)
              : null
          };
          break;
        }
      }

      this._mutations.push(record);
    }
  }

  /**
   * Handle a user event and push a structured record.
   *
   * @param {Event} event
   */
  _handleEvent(event) {
    if (!this._recording) return;

    // Check if we hit the max events limit
    if (this._events.length >= this._maxEvents) {
      console.log(LOG_PREFIX, 'Auto-stopping: max events reached');
      this.stop();
      return;
    }

    const timestamp = Date.now() - this._startTime;
    const target = event.target;

    const record = {
      type: event.type,
      timestamp,
      target: this._describeTarget(target),
      data: this._extractEventData(event)
    };

    this._events.push(record);
  }

  /**
   * Build a descriptor object for an event target element.
   *
   * @param {EventTarget} target
   * @returns {{
   *   tagName: string,
   *   id: string,
   *   className: string,
   *   selector: string,
   *   isEditable: boolean,
   *   contentBefore: string
   * }}
   */
  _describeTarget(target) {
    if (!(target instanceof Element)) {
      return {
        tagName: '#document',
        id: '',
        className: '',
        selector: 'document',
        isEditable: false,
        contentBefore: ''
      };
    }

    const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';
    const isEditable = isInput || target.isContentEditable;

    let contentBefore = '';
    if (isInput) {
      contentBefore = target.value.slice(0, CONTENT_PREVIEW_LENGTH);
    } else if (isEditable) {
      contentBefore = target.textContent.slice(0, CONTENT_PREVIEW_LENGTH);
    }

    return {
      tagName: target.tagName.toLowerCase(),
      id: target.id || '',
      className: typeof target.className === 'string' ? target.className : '',
      selector: this._computeSelector(target),
      isEditable,
      contentBefore
    };
  }

  /**
   * Extract event-type-specific data from an event.
   *
   * @param {Event} event
   * @returns {object}
   */
  _extractEventData(event) {
    const data = {};

    // Keyboard events
    if (event instanceof KeyboardEvent) {
      data.key = event.key;
      data.code = event.code;
      data.ctrlKey = event.ctrlKey;
      data.shiftKey = event.shiftKey;
      data.altKey = event.altKey;
      data.metaKey = event.metaKey;
      return data;
    }

    // InputEvent (beforeinput, input)
    if (event instanceof InputEvent) {
      data.inputType = event.inputType || '';
      data.data = event.data != null ? event.data.slice(0, CONTENT_PREVIEW_LENGTH) : null;
      data.isComposing = event.isComposing || false;
      return data;
    }

    // Mouse events
    if (event instanceof MouseEvent) {
      data.x = event.clientX;
      data.y = event.clientY;
      data.button = event.button;
      return data;
    }

    // Clipboard events
    if (event instanceof ClipboardEvent) {
      if (event.clipboardData) {
        data.clipboardText = (event.clipboardData.getData('text/plain') || '').slice(0, CONTENT_PREVIEW_LENGTH);
      }
      return data;
    }

    // Focus / blur
    if (event instanceof FocusEvent) {
      data.relatedTargetSelector = event.relatedTarget instanceof Element
        ? this._computeSelector(event.relatedTarget)
        : null;
      return data;
    }

    // Composition events
    if (event.type === 'compositionstart' || event.type === 'compositionend') {
      data.data = event.data || '';
      return data;
    }

    return data;
  }

  /**
   * Build a unique CSS selector path for an element.
   *
   * Stops at body, at an element with an id, or at a contenteditable boundary.
   *
   * @param {Element|null} element
   * @returns {string}
   */
  _computeSelector(element) {
    if (!element || !(element instanceof Element)) {
      return 'unknown';
    }

    const parts = [];
    let current = element;

    while (current && current !== document.body && current !== document.documentElement) {
      // If the element has an id, use it and stop
      if (current.id) {
        parts.unshift(`#${CSS.escape(current.id)}`);
        break;
      }

      let part = current.tagName.toLowerCase();

      // Add distinguishing class names (skip very long or dynamic-looking ones)
      if (typeof current.className === 'string' && current.className.trim()) {
        const classes = current.className
          .trim()
          .split(/\s+/)
          .filter((c) => c.length < 40 && !/^[a-z]{1,3}-[a-f0-9]{4,}$/i.test(c))
          .slice(0, 3);
        if (classes.length > 0) {
          part += '.' + classes.map((c) => CSS.escape(c)).join('.');
        }
      }

      // Add nth-child if needed for disambiguation
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(
          (s) => s.tagName === current.tagName
        );
        if (siblings.length > 1) {
          const index = siblings.indexOf(current) + 1;
          part += `:nth-child(${index})`;
        }
      }

      parts.unshift(part);

      // Stop at contenteditable boundary
      if (
        current.getAttribute('contenteditable') === 'true' ||
        current.getAttribute('contenteditable') === ''
      ) {
        break;
      }

      current = current.parentElement;
    }

    // Prepend 'body' if we walked all the way up
    if (current === document.body && parts.length > 0 && !parts[0].startsWith('#')) {
      parts.unshift('body');
    }

    return parts.join(' > ') || 'body';
  }
}

// ---------------------------------------------------------------------------
// DemonstrationAnalyzer
// ---------------------------------------------------------------------------

export class DemonstrationAnalyzer {
  /**
   * Analyze a raw recording into structured knowledge.
   *
   * @param {{
   *   events: Array<object>,
   *   mutations: Array<object>,
   *   duration: number,
   *   metadata: object
   * }} recording - Output from DemonstrationRecorder.stop()
   *
   * @returns {{
   *   actions: Array<{ type: string, description: string, confidence: string }>,
   *   editMethod: { primary: string, details: object, confidence: string },
   *   selectors: { [blockType: string]: { value: string, confidence: string } },
   *   quirks: Array<{ description: string, confidence: string, source: string }>,
   *   confidence: string,
   *   summary: string
   * }}
   */
  analyze(recording) {
    if (!recording || !recording.events) {
      console.warn(LOG_PREFIX, 'analyze: invalid recording');
      return {
        actions: [],
        editMethod: { primary: 'unknown', details: {}, confidence: 'low' },
        selectors: {},
        quirks: [],
        confidence: 'low',
        summary: 'No valid recording data provided.'
      };
    }

    console.log(
      LOG_PREFIX,
      `Analyzing recording: ${recording.events.length} events, ${recording.mutations.length} mutations, ${recording.duration}ms`
    );

    const actions = this._detectActions(recording);
    const editMethod = this._detectEditMethod(recording);
    const selectors = this._detectSelectors(recording);
    const quirks = this._detectQuirks(recording);

    const confidence = this._overallConfidence(actions, editMethod, quirks);
    const summary = this._generateSummary(actions, editMethod, quirks);

    return {
      actions,
      editMethod,
      selectors,
      quirks,
      confidence,
      summary
    };
  }

  // -------------------------------------------------------------------------
  // Action detection
  // -------------------------------------------------------------------------

  /**
   * Classify event sequences into high-level action types.
   *
   * @param {object} recording
   * @returns {Array<{ type: string, description: string, confidence: string }>}
   */
  _detectActions(recording) {
    const { events } = recording;
    const actions = [];

    let i = 0;
    while (i < events.length) {
      const evt = events[i];

      // --- Text typing: consecutive keydown + input pairs ---
      if (evt.type === 'keydown' && this._isPrintableKey(evt.data)) {
        const run = this._consumeTypingRun(events, i);
        if (run.length > 0) {
          // Check if preceded by a selectAll (text replacement)
          const isReplacement = this._hasSelectAllBefore(events, i);
          if (isReplacement) {
            actions.push({
              type: 'text_replace',
              description: `Replaced text by selecting all then typing ${run.length} character(s)`,
              confidence: 'observed'
            });
          } else {
            actions.push({
              type: 'text_edit',
              description: `Typed ${run.length} character(s)`,
              confidence: 'observed'
            });
          }
          i += run.consumedEvents;
          continue;
        }
      }

      // --- Formatting shortcuts: Ctrl/Cmd + B/I/U/etc ---
      if (evt.type === 'keydown' && (evt.data.ctrlKey || evt.data.metaKey) && !evt.data.altKey) {
        const lower = (evt.data.key || '').toLowerCase();
        if (FORMAT_SHORTCUTS.has(lower)) {
          const formatName = FORMAT_SHORTCUTS.get(lower);
          actions.push({
            type: 'format_change',
            description: `Applied formatting: ${formatName} (${this._shortcutLabel(evt.data)})`,
            confidence: 'observed'
          });
          i++;
          continue;
        }

        // --- Save: Ctrl+S ---
        if (lower === 's') {
          actions.push({
            type: 'save',
            description: 'Triggered save via keyboard shortcut (Ctrl+S)',
            confidence: 'observed'
          });
          i++;
          continue;
        }
      }

      // --- Block insert: Enter key ---
      if (evt.type === 'keydown' && evt.data.key === 'Enter' && !evt.data.ctrlKey && !evt.data.metaKey) {
        // Check if a new element appeared in mutations nearby
        const hasMutationNear = this._hasMutationInWindow(recording.mutations, evt.timestamp, 500, 'childList');
        actions.push({
          type: 'block_insert',
          description: hasMutationNear
            ? 'Pressed Enter, new block element created'
            : 'Pressed Enter (line break or new block)',
          confidence: hasMutationNear ? 'observed' : 'inferred'
        });
        i++;
        continue;
      }

      // --- Block delete: Backspace/Delete removing nodes ---
      if (
        evt.type === 'keydown' &&
        (evt.data.key === 'Backspace' || evt.data.key === 'Delete')
      ) {
        const hasMutationNear = this._hasMutationInWindow(recording.mutations, evt.timestamp, 500, 'childList');
        if (hasMutationNear) {
          actions.push({
            type: 'block_delete',
            description: `Pressed ${evt.data.key}, block element removed`,
            confidence: 'observed'
          });
        }
        // Single character deletes are normal typing, skip unless block-level
        i++;
        continue;
      }

      // --- Paste ---
      if (evt.type === 'paste') {
        const preview = evt.data.clipboardText
          ? evt.data.clipboardText.slice(0, 50)
          : '(no text)';
        actions.push({
          type: 'paste',
          description: `Pasted content: "${preview}${evt.data.clipboardText && evt.data.clipboardText.length > 50 ? '...' : ''}"`,
          confidence: 'observed'
        });
        i++;
        continue;
      }

      // --- Cut ---
      if (evt.type === 'cut') {
        actions.push({
          type: 'cut',
          description: 'Cut selected content',
          confidence: 'observed'
        });
        i++;
        continue;
      }

      // --- Save button click ---
      if (evt.type === 'click' && this._isSaveButton(evt.target)) {
        actions.push({
          type: 'save',
          description: `Clicked save button (${evt.target.selector})`,
          confidence: 'observed'
        });
        i++;
        continue;
      }

      i++;
    }

    return actions;
  }

  /**
   * Check whether a key event represents a printable character.
   *
   * @param {object} keyData
   * @returns {boolean}
   */
  _isPrintableKey(keyData) {
    if (!keyData || !keyData.key) return false;
    if (keyData.ctrlKey || keyData.metaKey || keyData.altKey) return false;
    // Single character keys are printable (letters, digits, punctuation, space)
    return keyData.key.length === 1 || keyData.key === 'Space';
  }

  /**
   * Consume a run of consecutive typing events (keydown of printable characters
   * with optional input events interleaved).
   *
   * @param {Array<object>} events
   * @param {number} startIndex
   * @returns {{ length: number, consumedEvents: number }}
   */
  _consumeTypingRun(events, startIndex) {
    let length = 0;
    let consumed = 0;
    let j = startIndex;
    let lastTimestamp = events[startIndex].timestamp;

    while (j < events.length) {
      const evt = events[j];

      // Allow up to 2 seconds gap between typing events
      if (evt.timestamp - lastTimestamp > 2000) break;

      if (evt.type === 'keydown' && this._isPrintableKey(evt.data)) {
        length++;
        lastTimestamp = evt.timestamp;
        consumed++;
        j++;
      } else if (evt.type === 'keyup' || evt.type === 'input' || evt.type === 'beforeinput') {
        // These naturally interleave with keydown during typing
        consumed++;
        j++;
      } else {
        break;
      }
    }

    return { length, consumedEvents: consumed };
  }

  /**
   * Check if there was a selectAll action (Ctrl+A) shortly before the given index.
   *
   * @param {Array<object>} events
   * @param {number} index
   * @returns {boolean}
   */
  _hasSelectAllBefore(events, index) {
    // Look back up to 10 events for a Ctrl+A or Cmd+A
    const lookback = Math.max(0, index - 10);
    for (let i = index - 1; i >= lookback; i--) {
      const evt = events[i];
      if (
        evt.type === 'keydown' &&
        evt.data &&
        (evt.data.ctrlKey || evt.data.metaKey) &&
        (evt.data.key === 'a' || evt.data.key === 'A')
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Check if any mutation of the given type occurred near a timestamp.
   *
   * @param {Array<object>} mutations
   * @param {number} timestamp
   * @param {number} windowMs
   * @param {string} [mutationType]
   * @returns {boolean}
   */
  _hasMutationInWindow(mutations, timestamp, windowMs, mutationType) {
    for (const mut of mutations) {
      if (Math.abs(mut.timestamp - timestamp) <= windowMs) {
        if (!mutationType || mut.type === mutationType) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Build a human-readable label for a keyboard shortcut.
   *
   * @param {object} keyData
   * @returns {string}
   */
  _shortcutLabel(keyData) {
    const parts = [];
    if (keyData.ctrlKey) parts.push('Ctrl');
    if (keyData.metaKey) parts.push('Cmd');
    if (keyData.shiftKey) parts.push('Shift');
    if (keyData.altKey) parts.push('Alt');
    parts.push(keyData.key.toUpperCase());
    return parts.join('+');
  }

  /**
   * Check if a click target looks like a save button.
   *
   * @param {object} target
   * @returns {boolean}
   */
  _isSaveButton(target) {
    if (!target) return false;
    const hints = ['save', 'publish', 'submit', 'update'];
    const text = `${target.id} ${target.className} ${target.tagName}`.toLowerCase();
    return hints.some((h) => text.includes(h));
  }

  // -------------------------------------------------------------------------
  // Edit method detection
  // -------------------------------------------------------------------------

  /**
   * Determine how edits were applied to the DOM.
   *
   * @param {object} recording
   * @returns {{ primary: string, details: object, confidence: string }}
   */
  _detectEditMethod(recording) {
    const { events, mutations } = recording;

    const charDataMutations = mutations.filter((m) => m.type === 'characterData').length;
    const childListMutations = mutations.filter((m) => m.type === 'childList').length;
    const attributeMutations = mutations.filter((m) => m.type === 'attributes').length;
    const inputEvents = events.filter((e) => e.type === 'input').length;
    const beforeInputEvents = events.filter((e) => e.type === 'beforeinput').length;
    const keydownEvents = events.filter((e) => e.type === 'keydown').length;

    const details = {
      charDataMutations,
      childListMutations,
      attributeMutations,
      inputEvents,
      beforeInputEvents,
      keydownEvents,
      totalMutations: mutations.length,
      totalEvents: events.length
    };

    // If beforeinput events are present with specific inputTypes, likely a framework
    const hasFrameworkInputTypes = events.some(
      (e) =>
        e.type === 'beforeinput' &&
        e.data &&
        e.data.inputType &&
        /^(insertFrom|deleteBy|format)/.test(e.data.inputType)
    );

    // Heuristic: characterData mutations dominate → direct DOM editing
    if (charDataMutations > 0 && charDataMutations >= childListMutations * 2) {
      return {
        primary: 'directDOM',
        details,
        confidence: charDataMutations > 5 ? 'observed' : 'inferred'
      };
    }

    // Heuristic: childList mutations dominate → innerHTML replacement or framework
    if (childListMutations > charDataMutations * 2) {
      // If framework-style input events present, it is probably a framework
      if (hasFrameworkInputTypes || beforeInputEvents > inputEvents * 0.5) {
        return {
          primary: 'frameworkAPI',
          details,
          confidence: 'inferred'
        };
      }
      return {
        primary: 'directDOM',
        details,
        confidence: 'inferred'
      };
    }

    // Heuristic: many keyboard events but few mutations → possibly execCommand or keyboard-driven
    if (keydownEvents > 0 && mutations.length < keydownEvents * 0.3) {
      return {
        primary: 'keyboard',
        details,
        confidence: 'inferred'
      };
    }

    // Heuristic: execCommand patterns — attribute mutations on formatting tags, or
    // input events with formatBold/formatItalic inputTypes
    const hasExecCommandHints = events.some(
      (e) =>
        e.type === 'input' &&
        e.data &&
        e.data.inputType &&
        /^format/.test(e.data.inputType)
    );
    if (hasExecCommandHints) {
      return {
        primary: 'execCommand',
        details,
        confidence: 'inferred'
      };
    }

    // Default: balanced mix, assume directDOM
    if (mutations.length > 0) {
      return {
        primary: 'directDOM',
        details,
        confidence: 'inferred'
      };
    }

    // No mutations at all — keyboard simulation might be needed
    return {
      primary: 'keyboard',
      details,
      confidence: 'inferred'
    };
  }

  // -------------------------------------------------------------------------
  // Selector detection
  // -------------------------------------------------------------------------

  /**
   * Extract useful CSS selectors from the elements that were edited.
   *
   * @param {object} recording
   * @returns {{ [blockType: string]: { value: string, confidence: string } }}
   */
  _detectSelectors(recording) {
    const { events, mutations } = recording;
    const selectorsByType = {};

    // Collect selectors from editable event targets
    for (const evt of events) {
      if (!evt.target || !evt.target.isEditable) continue;
      const blockType = this._inferBlockType(evt.target.tagName);
      const selector = evt.target.selector;
      if (selector && selector !== 'unknown' && selector !== 'body') {
        if (!selectorsByType[blockType]) {
          selectorsByType[blockType] = new Set();
        }
        selectorsByType[blockType].add(selector);
      }
    }

    // Collect selectors from mutation targets
    for (const mut of mutations) {
      if (!mut.target || !mut.target.selector) continue;
      const blockType = this._inferBlockType(mut.target.tagName);
      const selector = mut.target.selector;
      if (selector && selector !== 'unknown' && selector !== 'body') {
        if (!selectorsByType[blockType]) {
          selectorsByType[blockType] = new Set();
        }
        selectorsByType[blockType].add(selector);
      }
    }

    // Convert sets to single best selector per type
    const result = {};
    for (const [blockType, selectors] of Object.entries(selectorsByType)) {
      const selectorArray = Array.from(selectors);
      // Pick the most specific selector (longest path is usually most specific)
      selectorArray.sort((a, b) => b.length - a.length);
      result[blockType] = {
        value: selectorArray[0],
        confidence: 'tentative'
      };
    }

    return result;
  }

  /**
   * Infer a block type from a tag name.
   *
   * @param {string} tagName
   * @returns {string}
   */
  _inferBlockType(tagName) {
    if (!tagName) return 'unknown';
    const tag = tagName.toLowerCase();

    const tagMap = {
      h1: 'heading1',
      h2: 'heading2',
      h3: 'heading3',
      h4: 'heading4',
      h5: 'heading5',
      h6: 'heading6',
      p: 'paragraph',
      div: 'container',
      span: 'inline',
      li: 'list-item',
      ul: 'list',
      ol: 'list',
      table: 'table',
      tr: 'table-row',
      td: 'table-cell',
      th: 'table-cell',
      img: 'image',
      video: 'video',
      iframe: 'embed',
      input: 'input',
      textarea: 'textarea',
      button: 'button',
      a: 'link',
      hr: 'divider',
      blockquote: 'blockquote',
      pre: 'code-block',
      code: 'code'
    };

    return tagMap[tag] || 'unknown';
  }

  // -------------------------------------------------------------------------
  // Quirk detection
  // -------------------------------------------------------------------------

  /**
   * Identify behavioral quirks in the editor.
   *
   * @param {object} recording
   * @returns {Array<{ description: string, confidence: string, source: string }>}
   */
  _detectQuirks(recording) {
    const { events, mutations } = recording;
    const quirks = [];

    // --- Slow editor: large delay between keydown and corresponding mutation ---
    const keydowns = events.filter((e) => e.type === 'keydown');
    const slowDelays = [];
    for (const kd of keydowns) {
      // Find the nearest mutation after this keydown
      let nearestMutDelta = Infinity;
      for (const mut of mutations) {
        const delta = mut.timestamp - kd.timestamp;
        if (delta >= 0 && delta < nearestMutDelta) {
          nearestMutDelta = delta;
        }
      }
      if (nearestMutDelta > 500 && nearestMutDelta < Infinity) {
        slowDelays.push(nearestMutDelta);
      }
    }
    if (slowDelays.length > 0) {
      const avgDelay = Math.round(slowDelays.reduce((a, b) => a + b, 0) / slowDelays.length);
      quirks.push({
        description: `Slow editor detected: average ${avgDelay}ms delay between keypress and DOM mutation (${slowDelays.length} slow event(s))`,
        confidence: 'tentative',
        source: 'demonstration'
      });
    }

    // --- Ignored events: keydown events with no mutation nearby ---
    let ignoredCount = 0;
    for (const kd of keydowns) {
      if (this._isPrintableKey(kd.data)) {
        const hasMutation = this._hasMutationInWindow(mutations, kd.timestamp, 1000, null);
        if (!hasMutation) {
          ignoredCount++;
        }
      }
    }
    if (ignoredCount > 0) {
      quirks.push({
        description: `${ignoredCount} keypress event(s) produced no DOM mutation — editor may be intercepting or ignoring keyboard input`,
        confidence: 'tentative',
        source: 'demonstration'
      });
    }

    // --- IME composition events present ---
    const hasComposition = events.some(
      (e) => e.type === 'compositionstart' || e.type === 'compositionend'
    );
    if (hasComposition) {
      quirks.push({
        description: 'IME composition events detected — editor handles multi-step input (CJK, accented characters)',
        confidence: 'tentative',
        source: 'demonstration'
      });
    }

    // --- Mutation bursts: single input producing many mutations ---
    const inputEvts = events.filter((e) => e.type === 'input');
    let burstCount = 0;
    for (const inp of inputEvts) {
      const mutationsInWindow = mutations.filter(
        (m) => Math.abs(m.timestamp - inp.timestamp) <= 100
      );
      if (mutationsInWindow.length >= 5) {
        burstCount++;
      }
    }
    if (burstCount > 0) {
      quirks.push({
        description: `${burstCount} input event(s) triggered 5+ DOM mutations each — editor performs complex transforms on input`,
        confidence: 'tentative',
        source: 'demonstration'
      });
    }

    // --- High attribute churn: many attribute mutations relative to content mutations ---
    const attrMutCount = mutations.filter((m) => m.type === 'attributes').length;
    const contentMutCount = mutations.filter(
      (m) => m.type === 'characterData' || m.type === 'childList'
    ).length;
    if (attrMutCount > 10 && attrMutCount > contentMutCount * 2) {
      quirks.push({
        description: `High attribute mutation count (${attrMutCount}) relative to content mutations (${contentMutCount}) — editor may use attributes for state tracking`,
        confidence: 'tentative',
        source: 'demonstration'
      });
    }

    // --- Clipboard events without matching mutations (editor might handle paste specially) ---
    const pasteEvents = events.filter((e) => e.type === 'paste');
    for (const pe of pasteEvents) {
      const hasMutation = this._hasMutationInWindow(mutations, pe.timestamp, 2000, null);
      if (!hasMutation) {
        quirks.push({
          description: 'Paste event did not produce DOM mutations within 2 seconds — editor may handle paste asynchronously or via API',
          confidence: 'tentative',
          source: 'demonstration'
        });
        break; // Only report once
      }
    }

    return quirks;
  }

  // -------------------------------------------------------------------------
  // Summary generation
  // -------------------------------------------------------------------------

  /**
   * Compute overall confidence level for the analysis.
   *
   * @param {Array<object>} actions
   * @param {object} editMethod
   * @param {Array<object>} quirks
   * @returns {'tentative'|'inferred'}
   */
  _overallConfidence(actions, editMethod, quirks) {
    const observedActions = actions.filter((a) => a.confidence === 'observed').length;
    if (observedActions >= 3 && editMethod.confidence === 'observed') {
      return 'inferred'; // Even best single demonstration is only 'inferred' until confirmed
    }
    return 'tentative';
  }

  /**
   * Generate a human-readable summary of the analysis.
   *
   * @param {Array<object>} actions
   * @param {object} editMethod
   * @param {Array<object>} quirks
   * @returns {string}
   */
  _generateSummary(actions, editMethod, quirks) {
    const lines = [];

    // Summarize actions
    if (actions.length === 0) {
      lines.push('No recognizable editing actions were detected in the recording.');
    } else {
      const typeCounts = {};
      for (const action of actions) {
        typeCounts[action.type] = (typeCounts[action.type] || 0) + 1;
      }
      const parts = Object.entries(typeCounts)
        .map(([type, count]) => `${count} ${type.replace(/_/g, ' ')}`)
        .join(', ');
      lines.push(`Detected ${actions.length} action(s): ${parts}.`);
    }

    // Summarize edit method
    const methodLabels = {
      execCommand: 'document.execCommand',
      directDOM: 'direct DOM manipulation',
      keyboard: 'keyboard event simulation',
      frameworkAPI: 'framework-specific API',
      unknown: 'unknown method'
    };
    const methodLabel = methodLabels[editMethod.primary] || editMethod.primary;
    lines.push(
      `Primary edit method: ${methodLabel} (confidence: ${editMethod.confidence}).`
    );

    // Summarize quirks
    if (quirks.length > 0) {
      lines.push(`Detected ${quirks.length} quirk(s):`);
      for (const quirk of quirks) {
        lines.push(`  - ${quirk.description}`);
      }
    } else {
      lines.push('No unusual editor behaviors detected.');
    }

    return lines.join('\n');
  }
}
