/**
 * AdapterBase - Abstract base class for all site adapters.
 *
 * Each adapter translates a specific editor's DOM into a uniform
 * Block/ContentSnapshot model and provides an execute() dispatcher
 * that maps command actions to editor-specific mutations.
 */

// ---------------------------------------------------------------------------
// Data-shape JSDoc typedefs (no runtime cost)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} Block
 * @property {string}  id       - Adapter-assigned block id (e.g. "gs-heading-0")
 * @property {string}  type     - Block type: heading, paragraph, image, list, ...
 * @property {string}  content  - Text / HTML content of the block
 * @property {number}  index    - Zero-based position in the document
 * @property {Object}  [attrs]  - Optional key/value attributes (level, src, href, ...)
 */

/**
 * @typedef {Object} ContentSnapshot
 * @property {string}   title   - Page / document title
 * @property {Block[]}  blocks  - Ordered list of blocks
 * @property {boolean}  editMode - Whether the page is currently in edit mode
 * @property {string[]} quirks   - Adapter-specific caveats the AI should know
 */

/**
 * @typedef {Object} SelectionInfo
 * @property {string|null}  blockId  - Block that contains the caret / selection
 * @property {number}       start    - Character offset of the selection start
 * @property {number}       end      - Character offset of the selection end
 * @property {string}       text     - Selected text
 */

/**
 * @typedef {Object} ExecuteResult
 * @property {boolean} success
 * @property {string}  [error]
 * @property {*}       [data]   - Optional payload (e.g. snapshot for get_snapshot)
 */

/**
 * @typedef {Object} ExplorationResult
 * @property {string[]}  editableSelectors - CSS selectors that matched editable regions
 * @property {string[]}  detectedFrameworks - e.g. ["Quill", "ProseMirror"]
 * @property {boolean}   editMode
 * @property {number}    blockCount
 */

// ---------------------------------------------------------------------------
// Sanitiser helpers
// ---------------------------------------------------------------------------

const DANGEROUS_ATTR_RE = /^on[a-z]+$/i;
const DATA_URI_RE       = /^\s*data\s*:/i;

/**
 * Strip dangerous HTML content: <script>, event-handler attributes,
 * data-URIs in src/href attributes.
 *
 * @param {string} html - Raw HTML string
 * @returns {string} Sanitised HTML string
 */
function sanitize(html) {
  if (typeof html !== 'string') return '';

  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  // Remove all <script> and <noscript> elements
  const dangerous = doc.querySelectorAll('script, noscript');
  dangerous.forEach(el => el.remove());

  // Walk every element
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT);
  let node;
  while ((node = walker.nextNode())) {
    const attrs = Array.from(node.attributes);
    for (const attr of attrs) {
      // Remove event handlers (onclick, onload, onerror, ...)
      if (DANGEROUS_ATTR_RE.test(attr.name)) {
        node.removeAttribute(attr.name);
        continue;
      }
      // Remove data-URIs in src / href / action / formaction
      if (['src', 'href', 'action', 'formaction'].includes(attr.name.toLowerCase())) {
        if (DATA_URI_RE.test(attr.value)) {
          node.removeAttribute(attr.name);
        }
      }
    }
  }

  return doc.body.innerHTML;
}

// ---------------------------------------------------------------------------
// AdapterBase
// ---------------------------------------------------------------------------

export class AdapterBase {
  /**
   * @param {Object} profile - Merged effective profile with selectors, quirks, etc.
   */
  constructor(profile) {
    if (new.target === AdapterBase) {
      throw new Error('AdapterBase is abstract and cannot be instantiated directly.');
    }
    /** @type {Object} */
    this.profile = profile || {};

    /** @type {Map<string, {element: Element, block: Block}>} */
    this.blocks = new Map();
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Build a full content snapshot of the current page / document.
   * @returns {ContentSnapshot}
   */
  getContent() {
    this.blocks.clear();

    const regions = this._getEditableRegions();
    const blocks  = regions.map((el, i) => {
      const block = this._blockToJson(el, i);
      this.blocks.set(block.id, { element: el, block });
      return block;
    });

    return {
      title:    this._getPageTitle(),
      blocks,
      editMode: this._isEditMode(),
      quirks:   this.profile.quirks || [],
    };
  }

  /**
   * Return a single tracked block by its id.
   * @param {string} blockId
   * @returns {Block|null}
   */
  getBlock(blockId) {
    const entry = this.blocks.get(blockId);
    return entry ? entry.block : null;
  }

  /**
   * Describe the current selection / caret position.
   * @returns {SelectionInfo}
   */
  getSelection() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) {
      return { blockId: null, start: 0, end: 0, text: '' };
    }

    const range = sel.getRangeAt(0);
    const text  = sel.toString();

    // Try to find which tracked block contains the anchor node
    let blockId = null;
    for (const [id, { element }] of this.blocks) {
      if (element.contains(range.startContainer)) {
        blockId = id;
        break;
      }
    }

    return {
      blockId,
      start: range.startOffset,
      end:   range.endOffset,
      text,
    };
  }

  /**
   * Execute a command against the editor.
   *
   * @param {Object} command
   * @param {string} command.action - One of the supported action types
   * @returns {ExecuteResult}
   */
  execute(command) {
    if (!command || !command.action) {
      return { success: false, error: 'Missing command.action' };
    }

    try {
      switch (command.action) {
        case 'replace_text':
          return this._handleReplaceText(command);
        case 'append_text':
          return this._handleAppendText(command);
        case 'insert_block':
          return this._handleInsertBlock(command);
        case 'delete_block':
          return this._handleDeleteBlock(command);
        case 'move_block':
          return this._handleMoveBlock(command);
        case 'set_format':
          return this._handleSetFormat(command);
        case 'find_and_replace':
          return this._handleFindAndReplace(command);
        case 'clear_block':
          return this._handleClearBlock(command);
        case 'duplicate_block':
          return this._handleDuplicateBlock(command);
        case 'set_attribute':
          return this._handleSetAttribute(command);
        case 'save':
          return this._handleSave(command);
        case 'get_snapshot':
          return this._handleGetSnapshot();
        default:
          return { success: false, error: `Unknown action: ${command.action}` };
      }
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Explore the page to discover editable regions, frameworks, etc.
   * @returns {ExplorationResult}
   */
  explore() {
    const editableSelectors = [];
    const detectedFrameworks = [];

    // contenteditable
    const ceElements = document.querySelectorAll('[contenteditable="true"]');
    if (ceElements.length) editableSelectors.push('[contenteditable="true"]');

    // textarea / input[type=text]
    const textareas = document.querySelectorAll('textarea');
    if (textareas.length) editableSelectors.push('textarea');
    const textInputs = document.querySelectorAll('input[type="text"], input:not([type])');
    if (textInputs.length) editableSelectors.push('input[type="text"]');

    // Known frameworks
    if (window.Quill || document.querySelector('.ql-editor'))     detectedFrameworks.push('Quill');
    if (document.querySelector('.ProseMirror'))                    detectedFrameworks.push('ProseMirror');
    if (window.CKEDITOR)                                          detectedFrameworks.push('CKEditor');
    if (window.tinymce)                                           detectedFrameworks.push('TinyMCE');

    const regions = this._getEditableRegions();

    return {
      editableSelectors,
      detectedFrameworks,
      editMode:   this._isEditMode(),
      blockCount: regions.length,
    };
  }

  // -----------------------------------------------------------------------
  // Sanitise utility (static-like, exposed on prototype for subclasses)
  // -----------------------------------------------------------------------

  /**
   * Strip dangerous HTML.
   * @param {string} html
   * @returns {string}
   */
  sanitize(html) {
    return sanitize(html);
  }

  // -----------------------------------------------------------------------
  // Command handlers  (default implementations, override in subclasses)
  // -----------------------------------------------------------------------

  /** @private */
  _handleReplaceText(command) {
    const { blockId, value } = command;
    const entry = this.blocks.get(blockId);
    if (!entry) return { success: false, error: `Block not found: ${blockId}` };

    const clean   = sanitize(value);
    const applied = this._applyEdit(entry.element, clean);
    if (applied) {
      this._dispatchNativeEvents(entry.element);
      entry.block.content = clean;
    }
    return { success: applied };
  }

  /** @private */
  _handleAppendText(command) {
    const { blockId, value } = command;
    const entry = this.blocks.get(blockId);
    if (!entry) return { success: false, error: `Block not found: ${blockId}` };

    const clean      = sanitize(value);
    const newContent  = entry.element.innerHTML + clean;
    const applied     = this._applyEdit(entry.element, newContent);
    if (applied) {
      this._dispatchNativeEvents(entry.element);
      entry.block.content = newContent;
    }
    return { success: applied };
  }

  /** @private */
  _handleInsertBlock(command) {
    const { afterBlockId, type, content } = command;
    const clean = sanitize(content || '');

    // Create a new element
    const newEl = document.createElement('div');
    newEl.setAttribute('contenteditable', 'true');
    newEl.innerHTML = clean;

    if (afterBlockId) {
      const entry = this.blocks.get(afterBlockId);
      if (!entry) return { success: false, error: `Block not found: ${afterBlockId}` };
      entry.element.parentNode.insertBefore(newEl, entry.element.nextSibling);
    } else {
      // Insert at the beginning of the first editable region
      const regions = this._getEditableRegions();
      if (regions.length) {
        regions[0].parentNode.insertBefore(newEl, regions[0]);
      } else {
        return { success: false, error: 'No editable region found for insertion' };
      }
    }

    this._dispatchNativeEvents(newEl);
    // Refresh block map
    this.getContent();
    return { success: true };
  }

  /** @private */
  _handleDeleteBlock(command) {
    const { blockId } = command;
    const entry = this.blocks.get(blockId);
    if (!entry) return { success: false, error: `Block not found: ${blockId}` };

    const parent = entry.element.parentNode;
    if (!parent) return { success: false, error: 'Block has no parent node' };

    parent.removeChild(entry.element);
    this.blocks.delete(blockId);
    return { success: true };
  }

  /** @private */
  _handleMoveBlock(command) {
    const { blockId, targetIndex } = command;
    const entry = this.blocks.get(blockId);
    if (!entry) return { success: false, error: `Block not found: ${blockId}` };

    const regions = this._getEditableRegions();
    if (targetIndex < 0 || targetIndex > regions.length) {
      return { success: false, error: `Target index ${targetIndex} out of range` };
    }

    const parent = entry.element.parentNode;
    parent.removeChild(entry.element);

    // Re-query after removal
    const updatedRegions = this._getEditableRegions();
    if (targetIndex >= updatedRegions.length) {
      const lastEl = updatedRegions[updatedRegions.length - 1];
      lastEl.parentNode.insertBefore(entry.element, lastEl.nextSibling);
    } else {
      const refEl = updatedRegions[targetIndex];
      refEl.parentNode.insertBefore(entry.element, refEl);
    }

    this.getContent(); // refresh block map
    return { success: true };
  }

  /** @private */
  _handleSetFormat(command) {
    const { blockId, format, value } = command;
    const entry = this.blocks.get(blockId);
    if (!entry) return { success: false, error: `Block not found: ${blockId}` };

    // Focus the element so execCommand targets it
    entry.element.focus();

    // Select all text within the block
    const range = document.createRange();
    range.selectNodeContents(entry.element);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    let applied = false;
    try {
      applied = document.execCommand(format, false, value || null);
    } catch (_) {
      applied = false;
    }

    return { success: applied };
  }

  /** @private */
  _handleFindAndReplace(command) {
    const { find, replace, blockId, all } = command;
    if (!find) return { success: false, error: 'Missing "find" parameter' };

    const targets = blockId
      ? [this.blocks.get(blockId)].filter(Boolean)
      : Array.from(this.blocks.values());

    let totalReplaced = 0;

    for (const { element, block } of targets) {
      const original = element.innerHTML;
      const regex    = all ? new RegExp(this._escapeRegex(find), 'g') : new RegExp(this._escapeRegex(find));
      const updated  = original.replace(regex, sanitize(replace || ''));

      if (updated !== original) {
        this._applyEdit(element, updated);
        this._dispatchNativeEvents(element);
        block.content = updated;
        totalReplaced++;
      }
    }

    return { success: true, data: { blocksModified: totalReplaced } };
  }

  /** @private */
  _handleClearBlock(command) {
    const { blockId } = command;
    const entry = this.blocks.get(blockId);
    if (!entry) return { success: false, error: `Block not found: ${blockId}` };

    const applied = this._applyEdit(entry.element, '');
    if (applied) {
      this._dispatchNativeEvents(entry.element);
      entry.block.content = '';
    }
    return { success: applied };
  }

  /** @private */
  _handleDuplicateBlock(command) {
    const { blockId } = command;
    const entry = this.blocks.get(blockId);
    if (!entry) return { success: false, error: `Block not found: ${blockId}` };

    const clone = entry.element.cloneNode(true);
    entry.element.parentNode.insertBefore(clone, entry.element.nextSibling);
    this._dispatchNativeEvents(clone);
    this.getContent(); // refresh
    return { success: true };
  }

  /** @private */
  _handleSetAttribute(command) {
    const { blockId, attribute, value } = command;
    const entry = this.blocks.get(blockId);
    if (!entry) return { success: false, error: `Block not found: ${blockId}` };

    if (!attribute) return { success: false, error: 'Missing "attribute" parameter' };

    entry.element.setAttribute(attribute, value);
    if (!entry.block.attrs) entry.block.attrs = {};
    entry.block.attrs[attribute] = value;
    return { success: true };
  }

  /** @private */
  _handleSave(_command) {
    // Default: trigger Ctrl+S
    const event = new KeyboardEvent('keydown', {
      key:     's',
      code:    'KeyS',
      ctrlKey: true,
      bubbles: true,
    });
    document.dispatchEvent(event);
    return { success: true };
  }

  /** @private */
  _handleGetSnapshot() {
    const snapshot = this.getContent();
    return { success: true, data: snapshot };
  }

  // -----------------------------------------------------------------------
  // Abstract methods (subclasses MUST override)
  // -----------------------------------------------------------------------

  /**
   * Return an ordered list of DOM elements that represent editable blocks.
   * @returns {Element[]}
   */
  _getEditableRegions() {
    throw new Error('Subclass must implement _getEditableRegions()');
  }

  /**
   * Convert a DOM element to a Block JSON object.
   * @param {Element} element
   * @param {number}  index
   * @returns {Block}
   */
  _blockToJson(element, index) {
    throw new Error('Subclass must implement _blockToJson()');
  }

  /**
   * Apply a new HTML value to a block element. Return true on success.
   * @param {Element} element
   * @param {string}  value - Sanitised HTML
   * @returns {boolean}
   */
  _applyEdit(element, value) {
    throw new Error('Subclass must implement _applyEdit()');
  }

  /**
   * Dispatch synthetic events so the host editor recognises the mutation.
   * @param {Element} element
   */
  _dispatchNativeEvents(element) {
    throw new Error('Subclass must implement _dispatchNativeEvents()');
  }

  /**
   * Wait until the editor is fully loaded / ready.
   * @returns {Promise<void>}
   */
  async _waitForEditorReady() {
    throw new Error('Subclass must implement _waitForEditorReady()');
  }

  /**
   * Determine if the page is in an edit / authoring mode.
   * @returns {boolean}
   */
  _isEditMode() {
    throw new Error('Subclass must implement _isEditMode()');
  }

  /**
   * Return the page / document title.
   * @returns {string}
   */
  _getPageTitle() {
    throw new Error('Subclass must implement _getPageTitle()');
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  /**
   * Escape a string for use inside a RegExp.
   * @param {string} str
   * @returns {string}
   */
  _escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}

export { sanitize };
