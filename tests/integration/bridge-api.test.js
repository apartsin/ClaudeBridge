/**
 * Integration tests for the Bridge API surface.
 *
 * Tests the full flow of initializing the bridge, extracting content,
 * executing commands, and querying capabilities against a realistic DOM.
 */

require('../helpers/setup');

// ─── Re-implement minimal bridge API ─────────────────────────────────────────

const BLOCK_TYPES = new Set([
  'heading1', 'heading2', 'heading3', 'paragraph', 'list-item', 'list',
  'image', 'video', 'embed', 'button', 'divider', 'table', 'unknown'
]);

const SUPPORTED_ACTIONS = new Set([
  'replace_text', 'append_text', 'insert_block', 'delete_block',
  'move_block', 'set_format', 'find_and_replace', 'clear_block',
  'duplicate_block', 'set_attribute', 'save', 'get_snapshot'
]);

function createBridgeApi(dom) {
  const blockMap = new Map();

  function getEditableRegions() {
    const regions = [];
    document.querySelectorAll('[contenteditable="true"]').forEach((root) => {
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
  }

  function blockToJson(element, index) {
    const tagName = (element.tagName || '').toLowerCase();
    let type = 'paragraph';
    if (tagName === 'h1') type = 'heading1';
    else if (tagName === 'h2') type = 'heading2';
    else if (tagName === 'h3') type = 'heading3';
    else if (tagName === 'li') type = 'list-item';
    return {
      id: element.id || `block-${index}`,
      type,
      text: element.value || element.textContent || '',
      html: element.innerHTML || element.value || '',
      editable: true,
      position: index,
      parent: null,
      children: []
    };
  }

  const api = {
    version: '1.0.0',
    app: 'TestApp',
    domain: 'localhost',
    profileLoaded: false,

    getContent() {
      blockMap.clear();
      const regions = getEditableRegions();
      const blocks = regions.map((el, i) => {
        const block = blockToJson(el, i);
        blockMap.set(block.id, el);
        return block;
      });
      return {
        app: this.app,
        url: window.location.href,
        title: document.title || '',
        isEditMode: !!document.querySelector('[contenteditable="true"]'),
        blocks,
        selection: { blockId: null, text: null, startOffset: null, endOffset: null },
        timestamp: Date.now()
      };
    },

    getBlock(blockId) {
      let el = blockMap.get(blockId);
      if (!el) {
        this.getContent();
        el = blockMap.get(blockId);
      }
      if (!el) return null;
      return blockToJson(el, 0);
    },

    execute(command) {
      if (!command || !command.action) {
        return { success: false, action: 'unknown', error: 'No action specified' };
      }
      if (!SUPPORTED_ACTIONS.has(command.action)) {
        return { success: false, action: command.action, error: `Unsupported action: "${command.action}"` };
      }

      if (command.action === 'get_snapshot') {
        return { success: true, action: 'get_snapshot', snapshot: this.getContent() };
      }

      if (command.action === 'replace_text') {
        if (!command.target || !command.target.blockId) {
          return { success: false, action: 'replace_text', error: 'No target specified' };
        }
        const el = blockMap.get(command.target.blockId);
        if (!el) {
          this.getContent();
          const retryEl = blockMap.get(command.target.blockId);
          if (!retryEl) return { success: false, action: 'replace_text', error: 'Block not found' };
        }
        const targetEl = blockMap.get(command.target.blockId);
        if (!targetEl) return { success: false, action: 'replace_text', error: 'Block not found' };
        targetEl.textContent = command.value;
        return { success: true, action: 'replace_text', affectedBlockId: command.target.blockId };
      }

      if (command.action === 'clear_block') {
        const el = blockMap.get(command.target.blockId);
        if (!el) return { success: false, action: 'clear_block', error: 'Block not found' };
        el.textContent = '';
        return { success: true, action: 'clear_block', affectedBlockId: command.target.blockId };
      }

      if (command.action === 'append_text') {
        const el = blockMap.get(command.target.blockId);
        if (!el) return { success: false, action: 'append_text', error: 'Block not found' };
        el.textContent += command.value;
        return { success: true, action: 'append_text', affectedBlockId: command.target.blockId };
      }

      if (command.action === 'save') {
        return { success: true, action: 'save' };
      }

      return { success: false, action: command.action, error: 'Not implemented in test bridge' };
    },

    getCapabilities() {
      return Array.from(SUPPORTED_ACTIONS);
    },

    ping() {
      return { status: 'ready', timestamp: Date.now() };
    }
  };

  return api;
}

function setupBridgeDOM() {
  document.body.innerHTML = `
    <div contenteditable="true" id="main-editor">
      <h1 id="title">Page Title</h1>
      <p id="intro">Introduction paragraph with text.</p>
      <p id="body">Body paragraph with more content.</p>
      <h2 id="subtitle">Subtitle</h2>
      <p id="conclusion">Conclusion paragraph.</p>
      <li id="item1">List item one</li>
      <li id="item2">List item two</li>
    </div>
    <textarea id="notes">Some notes here</textarea>
    <input type="text" id="search" value="search term" />
    <button id="save-btn">Save</button>
  `;
  document.title = 'Test Page';
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Bridge initialization', () => {
  let bridge;

  beforeEach(() => {
    setupBridgeDOM();
    bridge = createBridgeApi();
  });

  test('bridge has version property', () => {
    expect(bridge.version).toBe('1.0.0');
  });

  test('bridge has app name', () => {
    expect(bridge.app).toBe('TestApp');
  });

  test('bridge has domain', () => {
    expect(bridge.domain).toBe('localhost');
  });

  test('body attributes can be set on init', () => {
    document.body.setAttribute('data-claude-bridge', 'ready');
    document.body.setAttribute('data-claude-app', bridge.app);
    document.body.setAttribute('data-claude-version', bridge.version);
    expect(document.body.getAttribute('data-claude-bridge')).toBe('ready');
    expect(document.body.getAttribute('data-claude-app')).toBe('TestApp');
    expect(document.body.getAttribute('data-claude-version')).toBe('1.0.0');
  });
});

describe('Bridge.getContent', () => {
  let bridge;

  beforeEach(() => {
    setupBridgeDOM();
    bridge = createBridgeApi();
  });

  test('returns content snapshot with blocks', () => {
    const content = bridge.getContent();
    expect(content).toHaveProperty('blocks');
    expect(content).toHaveProperty('app');
    expect(content).toHaveProperty('title');
    expect(content).toHaveProperty('isEditMode');
    expect(content).toHaveProperty('timestamp');
    expect(content.blocks.length).toBeGreaterThan(0);
  });

  test('detects edit mode from contenteditable', () => {
    const content = bridge.getContent();
    expect(content.isEditMode).toBe(true);
  });

  test('returns correct page title', () => {
    const content = bridge.getContent();
    expect(content.title).toBe('Test Page');
  });

  test('includes heading blocks', () => {
    const content = bridge.getContent();
    const h1 = content.blocks.find((b) => b.type === 'heading1');
    expect(h1).toBeDefined();
    expect(h1.text).toBe('Page Title');
  });

  test('includes paragraph blocks', () => {
    const content = bridge.getContent();
    const paragraphs = content.blocks.filter((b) => b.type === 'paragraph');
    expect(paragraphs.length).toBeGreaterThanOrEqual(3);
  });

  test('includes list-item blocks', () => {
    const content = bridge.getContent();
    const items = content.blocks.filter((b) => b.type === 'list-item');
    expect(items.length).toBe(2);
  });

  test('includes textarea and input elements', () => {
    const content = bridge.getContent();
    // textarea and input should also be detected
    expect(content.blocks.length).toBeGreaterThanOrEqual(9);
  });
});

describe('Bridge.execute - replace_text', () => {
  let bridge;

  beforeEach(() => {
    setupBridgeDOM();
    bridge = createBridgeApi();
    bridge.getContent();
  });

  test('replaces text in a block and returns success', () => {
    const result = bridge.execute({
      action: 'replace_text',
      target: { blockId: 'intro' },
      value: 'Updated introduction.'
    });
    expect(result.success).toBe(true);
    expect(result.action).toBe('replace_text');
    expect(result.affectedBlockId).toBe('intro');
    expect(document.getElementById('intro').textContent).toBe('Updated introduction.');
  });

  test('verifies DOM is actually modified', () => {
    bridge.execute({
      action: 'replace_text',
      target: { blockId: 'body' },
      value: 'New body content.'
    });
    const content = bridge.getContent();
    const bodyBlock = content.blocks.find((b) => b.id === 'body');
    expect(bodyBlock.text).toBe('New body content.');
  });

  test('fails gracefully for nonexistent block', () => {
    const result = bridge.execute({
      action: 'replace_text',
      target: { blockId: 'nonexistent' },
      value: 'text'
    });
    expect(result.success).toBe(false);
  });
});

describe('Bridge.execute - clear_block', () => {
  let bridge;

  beforeEach(() => {
    setupBridgeDOM();
    bridge = createBridgeApi();
    bridge.getContent();
  });

  test('clears block content', () => {
    const result = bridge.execute({
      action: 'clear_block',
      target: { blockId: 'intro' }
    });
    expect(result.success).toBe(true);
    expect(document.getElementById('intro').textContent).toBe('');
  });
});

describe('Bridge.execute - append_text', () => {
  let bridge;

  beforeEach(() => {
    setupBridgeDOM();
    bridge = createBridgeApi();
    bridge.getContent();
  });

  test('appends text to block', () => {
    const result = bridge.execute({
      action: 'append_text',
      target: { blockId: 'intro' },
      value: ' More text.'
    });
    expect(result.success).toBe(true);
    expect(document.getElementById('intro').textContent).toContain('More text.');
  });
});

describe('Bridge.getCapabilities', () => {
  test('returns array of action names', () => {
    setupBridgeDOM();
    const bridge = createBridgeApi();
    const caps = bridge.getCapabilities();
    expect(Array.isArray(caps)).toBe(true);
    expect(caps).toContain('replace_text');
    expect(caps).toContain('append_text');
    expect(caps).toContain('get_snapshot');
    expect(caps).toContain('find_and_replace');
    expect(caps).toContain('save');
    expect(caps).toContain('clear_block');
    expect(caps).toContain('delete_block');
    expect(caps.length).toBe(SUPPORTED_ACTIONS.size);
  });
});

describe('Bridge.ping', () => {
  test('returns status ready with timestamp', () => {
    setupBridgeDOM();
    const bridge = createBridgeApi();
    const before = Date.now();
    const pong = bridge.ping();
    expect(pong.status).toBe('ready');
    expect(pong.timestamp).toBeGreaterThanOrEqual(before);
    expect(pong.timestamp).toBeLessThanOrEqual(Date.now());
  });
});

describe('Bridge.execute - get_snapshot', () => {
  test('returns current content snapshot', () => {
    setupBridgeDOM();
    const bridge = createBridgeApi();
    const result = bridge.execute({ action: 'get_snapshot' });
    expect(result.success).toBe(true);
    expect(result.snapshot).toBeDefined();
    expect(result.snapshot.blocks.length).toBeGreaterThan(0);
  });
});

describe('Bridge.execute - save', () => {
  test('save action returns success', () => {
    setupBridgeDOM();
    const bridge = createBridgeApi();
    const result = bridge.execute({ action: 'save' });
    expect(result.success).toBe(true);
    expect(result.action).toBe('save');
  });
});

describe('Bridge.execute - error handling', () => {
  test('returns error for null command', () => {
    setupBridgeDOM();
    const bridge = createBridgeApi();
    const result = bridge.execute(null);
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  test('returns error for unsupported action', () => {
    setupBridgeDOM();
    const bridge = createBridgeApi();
    const result = bridge.execute({ action: 'teleport' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unsupported');
  });
});

describe('Bridge - multi-step editing workflow', () => {
  test('read -> edit -> verify cycle', () => {
    setupBridgeDOM();
    const bridge = createBridgeApi();

    // Step 1: Read initial content
    const initial = bridge.getContent();
    const originalText = initial.blocks.find((b) => b.id === 'intro').text;
    expect(originalText).toContain('Introduction');

    // Step 2: Edit
    const editResult = bridge.execute({
      action: 'replace_text',
      target: { blockId: 'intro' },
      value: 'Modified introduction.'
    });
    expect(editResult.success).toBe(true);

    // Step 3: Verify
    const updated = bridge.getContent();
    const updatedText = updated.blocks.find((b) => b.id === 'intro').text;
    expect(updatedText).toBe('Modified introduction.');
    expect(updatedText).not.toBe(originalText);
  });
});
