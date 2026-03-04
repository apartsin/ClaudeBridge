/**
 * Google Docs adapter for Claude Bridge.
 *
 * Google Docs uses a custom rendering engine ("Kix") that does not rely on
 * standard contenteditable.  Text lives inside absolutely-positioned SVG/span
 * layers, and direct DOM mutation is ignored by the editor model.
 *
 * Edits must go through:
 *   1. execCommand('insertText') when the internal iframe is focused, OR
 *   2. Keyboard simulation via the .docs-texteventtarget-iframe element.
 *
 * The adapter exposes blocks by reading the Kix paragraph, list, table and
 * image renderers and mapping them to the uniform Block model.
 */

import { AdapterBase, sanitize } from './adapter-base.js';

// ---------------------------------------------------------------------------
// Default selectors
// ---------------------------------------------------------------------------

const DEFAULT_SELECTORS = {
  // Main content area
  documentContainer: '.kix-appview-editor',
  pagesContainer:    '.kix-paginateddocumentplugin',

  // Block renderers
  paragraph:  'div.kix-paragraphrenderer',
  list:       'div.kix-listrenderer',
  table:      'div.kix-tablerenderer',
  image:      'div.kix-imagerenderer',

  // Heading detection: Docs marks headings via style spans
  headingClasses: [
    'kix-paragraphrenderer-heading1',
    'kix-paragraphrenderer-heading2',
    'kix-paragraphrenderer-heading3',
    'kix-paragraphrenderer-heading4',
    'kix-paragraphrenderer-heading5',
    'kix-paragraphrenderer-heading6',
  ],

  // Input target iframe used for keyboard simulation
  textEventTarget: '.docs-texteventtarget-iframe',

  // Title element
  titleInput: 'input.docs-title-input',
};

const DEFAULT_QUIRKS = [
  'Direct DOM text mutation does not work; use execCommand or keyboard sim',
  'Undo history is maintained by Docs — use sparingly for bulk edits',
  'Images and drawings cannot be edited via DOM',
  "execCommand('insertText') works when editor iframe is focused",
];

// ---------------------------------------------------------------------------
// Type prefix map
// ---------------------------------------------------------------------------

const TYPE_PREFIX = {
  heading:   'gd-heading',
  paragraph: 'gd-paragraph',
  list:      'gd-list',
  table:     'gd-table',
  image:     'gd-image',
  unknown:   'gd-block',
};

// ---------------------------------------------------------------------------
// GoogleDocsAdapter
// ---------------------------------------------------------------------------

export class GoogleDocsAdapter extends AdapterBase {
  /**
   * @param {Object} profile
   */
  constructor(profile) {
    const merged = Object.assign({}, profile);
    merged.quirks    = merged.quirks    || DEFAULT_QUIRKS;
    merged.selectors = Object.assign({}, DEFAULT_SELECTORS, merged.selectors || {});

    super(merged);

    this.sel = this.profile.selectors;
  }

  // -----------------------------------------------------------------------
  // Overrides
  // -----------------------------------------------------------------------

  /** @override */
  _isEditMode() {
    // Google Docs is always in edit mode when the editor container is present.
    // View-only docs lack the text event target iframe.
    return !!document.querySelector(this.sel.textEventTarget);
  }

  /** @override */
  _getPageTitle() {
    const titleInput = document.querySelector(this.sel.titleInput);
    if (titleInput) return titleInput.value || titleInput.textContent || '';

    // Fallback to page title
    return document.title.replace(/ - Google Docs$/, '').trim();
  }

  /** @override */
  _getEditableRegions() {
    const elements = [];
    const seen     = new Set();

    // Collect paragraphs (includes headings)
    document.querySelectorAll(this.sel.paragraph).forEach(el => {
      if (!seen.has(el)) { seen.add(el); el.__cbType = this._classifyParagraph(el); elements.push(el); }
    });

    // Lists
    document.querySelectorAll(this.sel.list).forEach(el => {
      if (!seen.has(el)) { seen.add(el); el.__cbType = 'list'; elements.push(el); }
    });

    // Tables
    document.querySelectorAll(this.sel.table).forEach(el => {
      if (!seen.has(el)) { seen.add(el); el.__cbType = 'table'; elements.push(el); }
    });

    // Images
    document.querySelectorAll(this.sel.image).forEach(el => {
      if (!seen.has(el)) { seen.add(el); el.__cbType = 'image'; elements.push(el); }
    });

    // Sort by document order
    elements.sort((a, b) => {
      const pos = a.compareDocumentPosition(b);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });

    return elements;
  }

  /** @override */
  _blockToJson(element, index) {
    const type   = element.__cbType || 'paragraph';
    const prefix = TYPE_PREFIX[type] || TYPE_PREFIX.unknown;

    // Prefer data-paragraph-id when available
    const paraId = element.getAttribute('data-paragraph-id');
    const id     = paraId ? `${prefix}-${paraId}` : `${prefix}-${index}`;

    const block = {
      id,
      type,
      content: this._extractContent(element, type),
      index,
    };

    const attrs = {};

    if (type === 'heading') {
      attrs.level = this._headingLevel(element);
    }
    if (type === 'image') {
      const img = element.querySelector('img');
      if (img) {
        attrs.src = img.getAttribute('src') || '';
        attrs.alt = img.getAttribute('alt') || '';
      }
    }
    if (paraId) {
      attrs.paragraphId = paraId;
    }

    if (Object.keys(attrs).length) block.attrs = attrs;

    return block;
  }

  /** @override */
  _applyEdit(element, value) {
    // Strategy 1: Focus the text event target iframe and use execCommand
    const iframeEl = document.querySelector(this.sel.textEventTarget);
    if (iframeEl) {
      try {
        const iframeDoc = iframeEl.contentDocument || iframeEl.contentWindow.document;
        const target    = iframeDoc.querySelector('[contenteditable="true"]') || iframeDoc.body;

        // Click the paragraph element first so Docs places the caret there
        element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        element.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, cancelable: true }));
        element.dispatchEvent(new MouseEvent('click',     { bubbles: true, cancelable: true }));

        target.focus();

        // Select all in the caret's paragraph
        document.execCommand('selectAll', false, null);

        // Insert replacement text
        const success = document.execCommand('insertText', false, value);
        if (success) return true;
      } catch (_) {
        // fall through to keyboard simulation
      }
    }

    // Strategy 2: Keyboard simulation (type character by character)
    try {
      return this._typeViaKeyboard(element, value);
    } catch (_) {
      return false;
    }
  }

  /** @override */
  _dispatchNativeEvents(element) {
    const eventInit = { bubbles: true, cancelable: true };

    element.dispatchEvent(new Event('input',  eventInit));
    element.dispatchEvent(new Event('change', eventInit));
  }

  /** @override */
  async _waitForEditorReady() {
    const targetSel = this.sel.textEventTarget;

    if (document.querySelector(targetSel)) return;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        observer.disconnect();
        reject(new Error('Timed out waiting for Google Docs editor to load'));
      }, 20000);

      const observer = new MutationObserver(() => {
        if (document.querySelector(targetSel)) {
          observer.disconnect();
          clearTimeout(timeout);
          resolve();
        }
      });

      observer.observe(document.documentElement, { childList: true, subtree: true });
    });
  }

  // -----------------------------------------------------------------------
  // Command overrides
  // -----------------------------------------------------------------------

  /**
   * Google Docs find-and-replace is best done through the native Ctrl+H
   * dialog because direct DOM mutation is not recognised by the editor model.
   * @override
   */
  _handleFindAndReplace(command) {
    const { find, replace } = command;
    if (!find) return { success: false, error: 'Missing "find" parameter' };

    try {
      // Open Find & Replace dialog via Ctrl+H
      this._simulateShortcut('h', { ctrlKey: true });

      // The dialog is asynchronous; we queue the values via a short delay chain.
      // This is a best-effort approach; the caller may need to verify the result.
      setTimeout(() => {
        const findInput = document.querySelector('input[aria-label="Find"], input.docs-findinput-input');
        if (findInput) {
          this._setNativeValue(findInput, find);
        }
      }, 300);

      setTimeout(() => {
        const replaceInput = document.querySelector('input[aria-label="Replace with"], input.docs-replaceinput-input');
        if (replaceInput) {
          this._setNativeValue(replaceInput, replace || '');
        }
      }, 400);

      // Click "Replace all" after values are set
      setTimeout(() => {
        const replaceAllBtn = document.querySelector(
          'button[aria-label="Replace all"], button[data-action="replaceAll"]'
        );
        if (replaceAllBtn) replaceAllBtn.click();
      }, 600);

      return { success: true, data: { method: 'native-dialog' } };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Save in Google Docs is automatic, but we can force via Ctrl+S.
   * @override
   */
  _handleSave(_command) {
    this._simulateShortcut('s', { ctrlKey: true });
    return { success: true };
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  /**
   * Classify a kix-paragraphrenderer as heading or paragraph.
   * @param {Element} el
   * @returns {string}
   */
  _classifyParagraph(el) {
    const classList = el.className || '';
    for (const cls of this.sel.headingClasses) {
      if (classList.includes(cls)) return 'heading';
    }
    return 'paragraph';
  }

  /**
   * Determine heading level from CSS class name.
   * @param {Element} el
   * @returns {number}
   */
  _headingLevel(el) {
    const classList = el.className || '';
    for (let i = 0; i < this.sel.headingClasses.length; i++) {
      if (classList.includes(this.sel.headingClasses[i])) return i + 1;
    }
    return 1;
  }

  /**
   * Extract visible text content from a block element.
   * @param {Element} element
   * @param {string}  type
   * @returns {string}
   */
  _extractContent(element, type) {
    if (type === 'image') {
      const img = element.querySelector('img');
      return img ? (img.getAttribute('alt') || '[image]') : '[image]';
    }

    // Google Docs renders text inside nested spans.  Walk text nodes.
    const textParts = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const text = node.textContent;
      if (text.trim()) textParts.push(text);
    }
    return textParts.join('');
  }

  /**
   * Type text using keyboard events dispatched to the text-event-target
   * iframe.  This is the most reliable way to inject text into Google Docs
   * when execCommand fails.
   *
   * @param {Element} element - The paragraph to target (clicked first)
   * @param {string}  text
   * @returns {boolean}
   */
  _typeViaKeyboard(element, text) {
    const iframeEl = document.querySelector(this.sel.textEventTarget);
    if (!iframeEl) return false;

    const iframeDoc = iframeEl.contentDocument || iframeEl.contentWindow.document;
    const target    = iframeDoc.querySelector('[contenteditable="true"]') || iframeDoc.body;

    // Click the paragraph element to place the caret
    element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    element.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true }));
    element.dispatchEvent(new MouseEvent('click',     { bubbles: true }));

    // Select all existing text
    this._simulateShortcut('a', { ctrlKey: true }, target);

    // Type each character
    for (const char of text) {
      const eventOpts = {
        key:      char,
        code:     `Key${char.toUpperCase()}`,
        charCode: char.charCodeAt(0),
        keyCode:  char.charCodeAt(0),
        bubbles:  true,
      };
      target.dispatchEvent(new KeyboardEvent('keydown',  eventOpts));
      target.dispatchEvent(new KeyboardEvent('keypress', eventOpts));
      target.dispatchEvent(new InputEvent('input', {
        bubbles:   true,
        inputType: 'insertText',
        data:      char,
      }));
      target.dispatchEvent(new KeyboardEvent('keyup', eventOpts));
    }

    return true;
  }

  /**
   * Simulate a keyboard shortcut.
   * @param {string}   key
   * @param {Object}   modifiers - { ctrlKey, shiftKey, altKey, metaKey }
   * @param {Element}  [target=document]
   */
  _simulateShortcut(key, modifiers = {}, target = document) {
    const opts = {
      key,
      code:     `Key${key.toUpperCase()}`,
      bubbles:  true,
      cancelable: true,
      ctrlKey:  !!modifiers.ctrlKey,
      shiftKey: !!modifiers.shiftKey,
      altKey:   !!modifiers.altKey,
      metaKey:  !!modifiers.metaKey,
    };
    target.dispatchEvent(new KeyboardEvent('keydown', opts));
    target.dispatchEvent(new KeyboardEvent('keyup',   opts));
  }

  /**
   * Set an input element's value using the native setter so React/Angular
   * controlled components pick up the change.
   * @param {HTMLInputElement} input
   * @param {string} value
   */
  _setNativeValue(input, value) {
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    ).set;
    nativeSetter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
}
