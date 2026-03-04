/**
 * Extractor — Extracts content from the DOM and returns ContentSnapshot objects.
 *
 * Delegates to the adapter for the actual DOM traversal and block-to-JSON
 * conversion. The Extractor adds structure, ordering, and selection info
 * on top of the adapter's raw capabilities.
 */

const LOG_PREFIX = '[ClaudeBridge:Extractor]';

/**
 * All recognized block types.
 * @type {Set<string>}
 */
const BLOCK_TYPES = new Set([
  'heading1', 'heading2', 'heading3',
  'paragraph', 'list-item', 'list',
  'image', 'video', 'embed',
  'button', 'divider', 'table',
  'table-row', 'table-cell',
  'column-layout', 'column',
  'unknown'
]);

export class Extractor {
  /**
   * @param {object} adapter - An adapter instance (GoogleSitesAdapter, GoogleDocsAdapter, GenericAdapter).
   *                           Must implement _getEditableRegions() and _blockToJson().
   */
  constructor(adapter) {
    if (!adapter) {
      throw new Error('Extractor requires an adapter instance');
    }
    this._adapter = adapter;
    /** @type {Map<string, Element>} Maps block IDs to their DOM elements for this session. */
    this._blockMap = new Map();
  }

  /**
   * Extract a full content snapshot from the current page state.
   *
   * @returns {ContentSnapshot} The complete snapshot of page content.
   */
  getContent() {
    console.log(LOG_PREFIX, 'getContent: building snapshot');

    const blocks = this._extractBlocks();
    const selection = this.getSelection();

    /** @type {ContentSnapshot} */
    const snapshot = {
      app: this._adapter.appName || 'Unknown',
      url: window.location.href,
      title: document.title || '',
      isEditMode: this._detectEditMode(),
      blocks,
      selection,
      timestamp: Date.now()
    };

    console.log(LOG_PREFIX, `getContent: ${blocks.length} blocks extracted`);
    return snapshot;
  }

  /**
   * Get a single block by its ID.
   *
   * @param {string} blockId - The block ID to look up.
   * @returns {Block|null} The block object, or null if not found.
   */
  getBlock(blockId) {
    if (!blockId) {
      return null;
    }

    const element = this._blockMap.get(blockId);
    if (!element) {
      // The block map might be stale; try a fresh extraction
      console.log(LOG_PREFIX, `getBlock: "${blockId}" not in cache, re-extracting`);
      this._extractBlocks();
      const retryElement = this._blockMap.get(blockId);
      if (!retryElement) {
        console.warn(LOG_PREFIX, `getBlock: "${blockId}" not found after re-extraction`);
        return null;
      }
      return this._elementToBlock(retryElement, blockId);
    }

    return this._elementToBlock(element, blockId);
  }

  /**
   * Get the current browser selection mapped to block context.
   *
   * @returns {SelectionInfo} Object describing the current selection.
   */
  getSelection() {
    const sel = window.getSelection();

    /** @type {SelectionInfo} */
    const info = {
      blockId: null,
      text: null,
      startOffset: null,
      endOffset: null
    };

    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      // Even with a collapsed selection (cursor only), try to identify the block
      if (sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        info.blockId = this._findBlockIdForNode(range.startContainer);
        info.startOffset = range.startOffset;
        info.endOffset = range.endOffset;
      }
      return info;
    }

    const range = sel.getRangeAt(0);
    info.text = sel.toString();
    info.startOffset = range.startOffset;
    info.endOffset = range.endOffset;
    info.blockId = this._findBlockIdForNode(range.startContainer);

    return info;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Detect whether the editor is in edit mode.
   * Delegates to adapter if it has isEditMode(), otherwise uses heuristics.
   *
   * @returns {boolean}
   */
  _detectEditMode() {
    if (typeof this._adapter.isEditMode === 'function') {
      return this._adapter.isEditMode();
    }
    // Fallback: check for any contenteditable region
    return !!document.querySelector('[contenteditable="true"]');
  }

  /**
   * Extract all blocks from the DOM using the adapter.
   * Rebuilds the internal block map.
   *
   * @returns {Block[]} Ordered array of blocks.
   */
  _extractBlocks() {
    this._blockMap.clear();

    let regions;
    try {
      regions = this._adapter._getEditableRegions();
    } catch (err) {
      console.error(LOG_PREFIX, '_getEditableRegions failed:', err.message);
      regions = [];
    }

    if (!regions || !Array.isArray(regions)) {
      regions = [];
    }

    const blocks = [];
    const parentStack = []; // Track nesting for parent/children relationships

    for (let i = 0; i < regions.length; i++) {
      const element = regions[i];
      let block;

      try {
        block = this._adapter._blockToJson(element);
      } catch (err) {
        console.warn(LOG_PREFIX, `_blockToJson failed for element ${i}:`, err.message);
        block = this._fallbackBlockToJson(element, i);
      }

      // Ensure the block has all required fields
      block = this._normalizeBlock(block, element, i);

      // Store the element reference for later lookups
      this._blockMap.set(block.id, element);

      // Determine parent-child relationships
      block.parent = this._findParentBlockId(element, blocks);
      block.children = []; // Will be populated below

      blocks.push(block);
    }

    // Second pass: populate children arrays based on parent references
    for (const block of blocks) {
      if (block.parent) {
        const parentBlock = blocks.find(b => b.id === block.parent);
        if (parentBlock && !parentBlock.children.includes(block.id)) {
          parentBlock.children.push(block.id);
        }
      }
    }

    return blocks;
  }

  /**
   * Normalize a block object to ensure it has all required fields.
   *
   * @param {object} raw - The raw block from the adapter.
   * @param {Element} element - The DOM element.
   * @param {number} index - The block's position index.
   * @returns {Block} A complete Block object.
   */
  _normalizeBlock(raw, element, index) {
    const id = raw.id || `block-${index}`;
    const type = (raw.type && BLOCK_TYPES.has(raw.type)) ? raw.type : 'unknown';

    let bounds = null;
    try {
      const rect = element.getBoundingClientRect();
      bounds = {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        left: rect.left
      };
    } catch (_) {
      bounds = { x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0 };
    }

    return {
      id,
      type,
      text: raw.text != null ? String(raw.text) : (element.textContent || ''),
      html: raw.html != null ? String(raw.html) : (element.innerHTML || ''),
      editable: raw.editable != null ? Boolean(raw.editable) : this._isEditable(element),
      visible: raw.visible != null ? Boolean(raw.visible) : this._isVisible(element),
      position: raw.position != null ? raw.position : index,
      parent: raw.parent || null,
      children: raw.children || [],
      attributes: raw.attributes || this._extractAttributes(element),
      bounds
    };
  }

  /**
   * Fallback block-to-JSON conversion when the adapter's method fails.
   *
   * @param {Element} element - The DOM element.
   * @param {number} index - Position index.
   * @returns {object} A basic block object.
   */
  _fallbackBlockToJson(element, index) {
    const tagName = (element.tagName || '').toLowerCase();
    let type = 'unknown';

    if (tagName === 'h1') type = 'heading1';
    else if (tagName === 'h2') type = 'heading2';
    else if (tagName === 'h3') type = 'heading3';
    else if (tagName === 'p') type = 'paragraph';
    else if (tagName === 'li') type = 'list-item';
    else if (tagName === 'ul' || tagName === 'ol') type = 'list';
    else if (tagName === 'img') type = 'image';
    else if (tagName === 'video') type = 'video';
    else if (tagName === 'iframe') type = 'embed';
    else if (tagName === 'button' || tagName === 'a') type = 'button';
    else if (tagName === 'hr') type = 'divider';
    else if (tagName === 'table') type = 'table';
    else if (tagName === 'tr') type = 'table-row';
    else if (tagName === 'td' || tagName === 'th') type = 'table-cell';
    else if (tagName === 'div' || tagName === 'span') type = 'paragraph';

    return {
      id: `block-${index}`,
      type,
      text: element.textContent || '',
      html: element.innerHTML || ''
    };
  }

  /**
   * Check if an element is editable.
   *
   * @param {Element} element
   * @returns {boolean}
   */
  _isEditable(element) {
    if (!element) return false;
    if (element.isContentEditable) return true;
    if (element.contentEditable === 'true') return true;
    const tagName = (element.tagName || '').toLowerCase();
    if (tagName === 'textarea' || tagName === 'input') return !element.readOnly && !element.disabled;
    // Check if any ancestor is contenteditable
    let parent = element.parentElement;
    while (parent) {
      if (parent.contentEditable === 'true') return true;
      parent = parent.parentElement;
    }
    return false;
  }

  /**
   * Check if an element is currently visible in the viewport.
   *
   * @param {Element} element
   * @returns {boolean}
   */
  _isVisible(element) {
    if (!element) return false;
    try {
      const style = window.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        return false;
      }
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return false;
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Extract relevant DOM attributes from an element.
   *
   * @param {Element} element
   * @returns {Record<string, string>}
   */
  _extractAttributes(element) {
    const attrs = {};
    if (!element || !element.attributes) return attrs;

    const interesting = [
      'id', 'class', 'data-block-id', 'data-block-type', 'data-page-id',
      'data-paragraph-id', 'data-view-id', 'contenteditable', 'role',
      'aria-label', 'href', 'src', 'alt', 'title', 'type', 'name',
      'placeholder', 'data-testid'
    ];

    for (const attrName of interesting) {
      if (element.hasAttribute(attrName)) {
        attrs[attrName] = element.getAttribute(attrName);
      }
    }

    return attrs;
  }

  /**
   * Find the block ID of the block that contains a given DOM node.
   * Walks up from the node through ancestors looking for a mapped block element.
   *
   * @param {Node} node - A DOM node (possibly a text node).
   * @returns {string|null} The block ID, or null if not found.
   */
  _findBlockIdForNode(node) {
    if (!node) return null;

    let current = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;

    while (current && current !== document.body) {
      for (const [blockId, blockElement] of this._blockMap) {
        if (blockElement === current || blockElement.contains(current)) {
          return blockId;
        }
      }
      current = current.parentElement;
    }

    return null;
  }

  /**
   * Find the parent block ID for an element by checking if any previously
   * seen block element is an ancestor of this element.
   *
   * @param {Element} element - The element to find a parent block for.
   * @param {Block[]} existingBlocks - Blocks already processed.
   * @returns {string|null} The parent block ID, or null.
   */
  _findParentBlockId(element, existingBlocks) {
    if (!element || !element.parentElement) return null;

    let current = element.parentElement;
    while (current && current !== document.body) {
      for (const block of existingBlocks) {
        const blockElement = this._blockMap.get(block.id);
        if (blockElement === current) {
          return block.id;
        }
      }
      current = current.parentElement;
    }

    return null;
  }
}

export default Extractor;
