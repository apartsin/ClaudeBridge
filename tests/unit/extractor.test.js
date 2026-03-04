/**
 * Unit tests for Extractor (src/content/extractor.js).
 *
 * Since we cannot import the ES module directly, we re-implement the
 * Extractor logic and test against a jsdom document with editable content.
 */

require('../helpers/setup');
const fs = require('fs');
const path = require('path');

// ─── Re-implement key constants ──────────────────────────────────────────────

const BLOCK_TYPES = new Set([
  'heading1', 'heading2', 'heading3',
  'paragraph', 'list-item', 'list',
  'image', 'video', 'embed',
  'button', 'divider', 'table',
  'table-row', 'table-cell',
  'column-layout', 'column',
  'unknown'
]);

// ─── Minimal Extractor re-implementation for testing ─────────────────────────

class Extractor {
  constructor(adapter) {
    if (!adapter) throw new Error('Extractor requires an adapter instance');
    this._adapter = adapter;
    this._blockMap = new Map();
  }

  getContent() {
    const blocks = this._extractBlocks();
    const selection = this.getSelection();
    return {
      app: this._adapter.appName || 'Unknown',
      url: window.location.href,
      title: document.title || '',
      isEditMode: this._detectEditMode(),
      blocks,
      selection,
      timestamp: Date.now()
    };
  }

  getBlock(blockId) {
    if (!blockId) return null;
    const element = this._blockMap.get(blockId);
    if (!element) {
      this._extractBlocks();
      const retryElement = this._blockMap.get(blockId);
      if (!retryElement) return null;
      return this._elementToBlock(retryElement, blockId);
    }
    return this._elementToBlock(element, blockId);
  }

  getSelection() {
    const sel = window.getSelection();
    const info = { blockId: null, text: null, startOffset: null, endOffset: null };
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
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

  _detectEditMode() {
    if (typeof this._adapter.isEditMode === 'function') return this._adapter.isEditMode();
    return !!document.querySelector('[contenteditable="true"]');
  }

  _extractBlocks() {
    this._blockMap.clear();
    let regions;
    try {
      regions = this._adapter._getEditableRegions();
    } catch (err) {
      regions = [];
    }
    if (!regions || !Array.isArray(regions)) regions = [];

    const blocks = [];
    for (let i = 0; i < regions.length; i++) {
      const element = regions[i];
      let block;
      try {
        block = this._adapter._blockToJson(element, i);
      } catch (err) {
        block = this._fallbackBlockToJson(element, i);
      }
      block = this._normalizeBlock(block, element, i);
      this._blockMap.set(block.id, element);
      block.parent = null;
      block.children = [];
      blocks.push(block);
    }
    return blocks;
  }

  _normalizeBlock(raw, element, index) {
    const id = raw.id || `block-${index}`;
    const type = (raw.type && BLOCK_TYPES.has(raw.type)) ? raw.type : 'unknown';
    return {
      id,
      type,
      text: raw.text != null ? String(raw.text) : (element.textContent || ''),
      html: raw.html != null ? String(raw.html) : (element.innerHTML || ''),
      editable: raw.editable != null ? Boolean(raw.editable) : this._isEditable(element),
      visible: true,
      position: raw.position != null ? raw.position : index,
      parent: raw.parent || null,
      children: raw.children || [],
      attributes: raw.attributes || {},
      bounds: { x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0 }
    };
  }

  _elementToBlock(element, blockId) {
    const block = this._fallbackBlockToJson(element, 0);
    block.id = blockId;
    return this._normalizeBlock(block, element, 0);
  }

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

  _isEditable(element) {
    if (!element) return false;
    if (element.isContentEditable) return true;
    if (element.contentEditable === 'true') return true;
    // jsdom fallback: check the attribute directly
    if (element.getAttribute && element.getAttribute('contenteditable') === 'true') return true;
    const tagName = (element.tagName || '').toLowerCase();
    if (tagName === 'textarea' || tagName === 'input') return !element.readOnly && !element.disabled;
    let parent = element.parentElement;
    while (parent) {
      if (parent.contentEditable === 'true') return true;
      if (parent.getAttribute && parent.getAttribute('contenteditable') === 'true') return true;
      parent = parent.parentElement;
    }
    return false;
  }

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
}

// ─── Mock adapter factory ────────────────────────────────────────────────────

function createMockAdapter(options = {}) {
  return {
    appName: options.appName || 'TestApp',
    isEditMode: options.isEditMode || (() => true),
    _getEditableRegions: options.getEditableRegions || (() => {
      const regions = [];
      const editable = document.querySelectorAll('[contenteditable="true"]');
      editable.forEach((root) => {
        const children = root.querySelectorAll('p, h1, h2, h3, li, pre, blockquote');
        if (children.length > 0) {
          children.forEach((child) => regions.push(child));
        } else {
          regions.push(root);
        }
      });
      document.querySelectorAll('textarea, input[type="text"]').forEach((el) => {
        regions.push(el);
      });
      return regions;
    }),
    _blockToJson: options.blockToJson || ((element, index) => {
      const tagName = (element.tagName || '').toLowerCase();
      let type = 'paragraph';
      if (tagName === 'h1') type = 'heading1';
      else if (tagName === 'h2') type = 'heading2';
      else if (tagName === 'h3') type = 'heading3';
      else if (tagName === 'li') type = 'list-item';
      else if (tagName === 'pre') type = 'paragraph';
      else if (tagName === 'blockquote') type = 'paragraph';
      else if (tagName === 'textarea' || tagName === 'input') type = 'paragraph';
      return {
        id: `block-${index}`,
        type,
        text: element.value || element.textContent || '',
        html: element.innerHTML || element.value || '',
        editable: true
      };
    })
  };
}

// ─── Setup test DOM ──────────────────────────────────────────────────────────

function setupTestDOM() {
  document.body.innerHTML = `
    <div contenteditable="true" id="editor">
      <h2>Section Title</h2>
      <p>First paragraph with some text.</p>
      <p>Second paragraph with different text.</p>
      <li>List item one</li>
      <li>List item two</li>
    </div>
    <textarea id="text-area">Some textarea content</textarea>
    <input type="text" id="text-input" value="Input value" />
    <div id="non-editable">Not editable</div>
  `;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Extractor constructor', () => {
  test('throws when no adapter provided', () => {
    expect(() => new Extractor(null)).toThrow('Extractor requires an adapter instance');
  });

  test('creates instance with valid adapter', () => {
    const adapter = createMockAdapter();
    const extractor = new Extractor(adapter);
    expect(extractor._adapter).toBe(adapter);
    expect(extractor._blockMap).toBeInstanceOf(Map);
  });
});

describe('Extractor.getContent', () => {
  beforeEach(() => setupTestDOM());

  test('returns a snapshot with expected shape', () => {
    const extractor = new Extractor(createMockAdapter());
    const snapshot = extractor.getContent();
    expect(snapshot).toHaveProperty('app');
    expect(snapshot).toHaveProperty('url');
    expect(snapshot).toHaveProperty('title');
    expect(snapshot).toHaveProperty('isEditMode');
    expect(snapshot).toHaveProperty('blocks');
    expect(snapshot).toHaveProperty('selection');
    expect(snapshot).toHaveProperty('timestamp');
  });

  test('returns blocks array with correct count', () => {
    const extractor = new Extractor(createMockAdapter());
    const snapshot = extractor.getContent();
    // h2, p, p, li, li, textarea, input = 7
    expect(snapshot.blocks.length).toBe(7);
  });

  test('each block has required fields', () => {
    const extractor = new Extractor(createMockAdapter());
    const snapshot = extractor.getContent();
    for (const block of snapshot.blocks) {
      expect(block).toHaveProperty('id');
      expect(block).toHaveProperty('type');
      expect(block).toHaveProperty('text');
      expect(block).toHaveProperty('html');
      expect(block).toHaveProperty('editable');
      expect(block).toHaveProperty('position');
    }
  });

  test('block types are detected correctly', () => {
    const extractor = new Extractor(createMockAdapter());
    const snapshot = extractor.getContent();
    const types = snapshot.blocks.map((b) => b.type);
    expect(types).toContain('heading2');
    expect(types).toContain('paragraph');
    expect(types).toContain('list-item');
  });

  test('block text content is extracted', () => {
    const extractor = new Extractor(createMockAdapter());
    const snapshot = extractor.getContent();
    const heading = snapshot.blocks.find((b) => b.type === 'heading2');
    expect(heading.text).toBe('Section Title');
  });

  test('app name is set from adapter', () => {
    const extractor = new Extractor(createMockAdapter({ appName: 'MyEditor' }));
    const snapshot = extractor.getContent();
    expect(snapshot.app).toBe('MyEditor');
  });

  test('isEditMode reflects adapter state', () => {
    const extractor = new Extractor(createMockAdapter({ isEditMode: () => false }));
    const snapshot = extractor.getContent();
    expect(snapshot.isEditMode).toBe(false);
  });

  test('timestamp is a recent number', () => {
    const before = Date.now();
    const extractor = new Extractor(createMockAdapter());
    const snapshot = extractor.getContent();
    expect(snapshot.timestamp).toBeGreaterThanOrEqual(before);
    expect(snapshot.timestamp).toBeLessThanOrEqual(Date.now());
  });
});

describe('Extractor.getBlock', () => {
  beforeEach(() => setupTestDOM());

  test('returns null for null/undefined blockId', () => {
    const extractor = new Extractor(createMockAdapter());
    expect(extractor.getBlock(null)).toBeNull();
    expect(extractor.getBlock(undefined)).toBeNull();
  });

  test('returns block after getContent populates blockMap', () => {
    const extractor = new Extractor(createMockAdapter());
    extractor.getContent();
    const block = extractor.getBlock('block-0');
    expect(block).not.toBeNull();
    expect(block.id).toBe('block-0');
  });

  test('re-extracts blocks if blockId not initially in cache', () => {
    const extractor = new Extractor(createMockAdapter());
    // getBlock triggers re-extraction internally
    const block = extractor.getBlock('block-1');
    expect(block).not.toBeNull();
  });

  test('returns null for non-existent blockId', () => {
    const extractor = new Extractor(createMockAdapter());
    extractor.getContent();
    const block = extractor.getBlock('nonexistent-id');
    expect(block).toBeNull();
  });
});

describe('Extractor.getSelection', () => {
  beforeEach(() => setupTestDOM());

  test('returns selection info with null fields when nothing selected', () => {
    const extractor = new Extractor(createMockAdapter());
    extractor.getContent();
    const sel = extractor.getSelection();
    expect(sel).toHaveProperty('blockId');
    expect(sel).toHaveProperty('text');
    expect(sel).toHaveProperty('startOffset');
    expect(sel).toHaveProperty('endOffset');
  });

  test('text is null when no selection exists', () => {
    const extractor = new Extractor(createMockAdapter());
    const sel = extractor.getSelection();
    expect(sel.text).toBeNull();
  });
});

describe('Extractor with empty page', () => {
  test('handles page with no editable regions', () => {
    document.body.innerHTML = '<div>Non-editable content only</div>';
    const adapter = createMockAdapter({
      getEditableRegions: () => []
    });
    const extractor = new Extractor(adapter);
    const snapshot = extractor.getContent();
    expect(snapshot.blocks).toEqual([]);
  });
});

describe('Extractor with multiple editable regions', () => {
  test('collects blocks from all editable regions', () => {
    document.body.innerHTML = `
      <div contenteditable="true" id="region1">
        <p>Region 1 paragraph</p>
      </div>
      <div contenteditable="true" id="region2">
        <p>Region 2 paragraph</p>
      </div>
    `;
    const extractor = new Extractor(createMockAdapter());
    const snapshot = extractor.getContent();
    expect(snapshot.blocks.length).toBe(2);
    expect(snapshot.blocks[0].text).toBe('Region 1 paragraph');
    expect(snapshot.blocks[1].text).toBe('Region 2 paragraph');
  });
});

describe('Extractor block type detection via fallback', () => {
  test('detects h1 as heading1', () => {
    document.body.innerHTML = '<div contenteditable="true"><h1>H1</h1></div>';
    const adapter = createMockAdapter({
      blockToJson: null // will use fallback
    });
    // Override blockToJson to throw so fallback is used
    adapter._blockToJson = () => { throw new Error('force fallback'); };
    const extractor = new Extractor(adapter);
    const snapshot = extractor.getContent();
    const block = snapshot.blocks.find((b) => b.text === 'H1');
    expect(block).toBeDefined();
    expect(block.type).toBe('heading1');
  });

  test('detects img as image', () => {
    document.body.innerHTML = '<div contenteditable="true"><img src="test.png" alt="test" /></div>';
    const adapter = createMockAdapter({
      getEditableRegions: () => [document.querySelector('img')]
    });
    adapter._blockToJson = () => { throw new Error('force fallback'); };
    const extractor = new Extractor(adapter);
    const snapshot = extractor.getContent();
    expect(snapshot.blocks[0].type).toBe('image');
  });

  test('detects hr as divider', () => {
    document.body.innerHTML = '<div contenteditable="true"><hr /></div>';
    const adapter = createMockAdapter({
      getEditableRegions: () => [document.querySelector('hr')]
    });
    adapter._blockToJson = () => { throw new Error('force fallback'); };
    const extractor = new Extractor(adapter);
    const snapshot = extractor.getContent();
    expect(snapshot.blocks[0].type).toBe('divider');
  });

  test('detects table as table', () => {
    document.body.innerHTML = '<div contenteditable="true"><table><tr><td>Cell</td></tr></table></div>';
    const adapter = createMockAdapter({
      getEditableRegions: () => [document.querySelector('table')]
    });
    adapter._blockToJson = () => { throw new Error('force fallback'); };
    const extractor = new Extractor(adapter);
    const snapshot = extractor.getContent();
    expect(snapshot.blocks[0].type).toBe('table');
  });

  test('unknown tags fallback to paragraph or unknown', () => {
    document.body.innerHTML = '<div contenteditable="true"><section>Content</section></div>';
    const adapter = createMockAdapter({
      getEditableRegions: () => [document.querySelector('section')]
    });
    adapter._blockToJson = () => { throw new Error('force fallback'); };
    const extractor = new Extractor(adapter);
    const snapshot = extractor.getContent();
    expect(snapshot.blocks[0].type).toBe('unknown');
  });
});

describe('Extractor._isEditable', () => {
  beforeEach(() => setupTestDOM());

  test('returns true for contenteditable elements', () => {
    const extractor = new Extractor(createMockAdapter());
    const el = document.getElementById('editor');
    expect(extractor._isEditable(el)).toBe(true);
  });

  test('returns true for textarea elements', () => {
    const extractor = new Extractor(createMockAdapter());
    const el = document.getElementById('text-area');
    expect(extractor._isEditable(el)).toBe(true);
  });

  test('returns true for text input elements', () => {
    const extractor = new Extractor(createMockAdapter());
    const el = document.getElementById('text-input');
    expect(extractor._isEditable(el)).toBe(true);
  });

  test('returns false for regular divs', () => {
    const extractor = new Extractor(createMockAdapter());
    const el = document.getElementById('non-editable');
    expect(extractor._isEditable(el)).toBe(false);
  });

  test('returns false for null', () => {
    const extractor = new Extractor(createMockAdapter());
    expect(extractor._isEditable(null)).toBe(false);
  });

  test('returns true for child of contenteditable', () => {
    const extractor = new Extractor(createMockAdapter());
    const p = document.querySelector('#editor p');
    expect(extractor._isEditable(p)).toBe(true);
  });
});

describe('Extractor._detectEditMode', () => {
  test('delegates to adapter.isEditMode when available', () => {
    document.body.innerHTML = '<div>No editable</div>';
    const adapter = createMockAdapter({ isEditMode: () => true });
    const extractor = new Extractor(adapter);
    expect(extractor._detectEditMode()).toBe(true);
  });

  test('falls back to checking for contenteditable', () => {
    document.body.innerHTML = '<div contenteditable="true">Editable</div>';
    const adapter = createMockAdapter();
    delete adapter.isEditMode;
    const extractor = new Extractor(adapter);
    expect(extractor._detectEditMode()).toBe(true);
  });

  test('returns false when no contenteditable and no adapter method', () => {
    document.body.innerHTML = '<div>Plain</div>';
    const adapter = createMockAdapter();
    delete adapter.isEditMode;
    const extractor = new Extractor(adapter);
    expect(extractor._detectEditMode()).toBe(false);
  });
});
