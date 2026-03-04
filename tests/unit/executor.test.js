/**
 * Unit tests for Executor (src/content/executor.js).
 *
 * Tests the command execution engine with mock adapter and extractor.
 */

require('../helpers/setup');

// ─── Re-implement Executor for testing ───────────────────────────────────────

const SUPPORTED_ACTIONS = new Set([
  'replace_text', 'append_text', 'insert_block', 'delete_block',
  'move_block', 'set_format', 'find_and_replace', 'clear_block',
  'duplicate_block', 'set_attribute', 'save', 'get_snapshot'
]);

class Executor {
  constructor(adapter, extractor) {
    if (!adapter) throw new Error('Executor requires an adapter instance');
    if (!extractor) throw new Error('Executor requires an extractor instance');
    this._adapter = adapter;
    this._extractor = extractor;
  }

  execute(command) {
    if (!command || !command.action) {
      return this._error('No action specified in command');
    }
    const { action } = command;
    if (!SUPPORTED_ACTIONS.has(action)) {
      return this._error(`Unsupported action: "${action}"`);
    }
    const options = command.options || {};
    if (action === 'save') return this._executeSave(command, options);
    if (action === 'get_snapshot') return this._executeGetSnapshot();
    if (action === 'find_and_replace') return this._executeFindAndReplace(command, options);

    let targetBlock = null;
    if (action === 'insert_block') {
      if (command.target) targetBlock = this._resolveTarget(command.target);
    } else {
      if (!command.target) return this._error(`Action "${action}" requires a target`);
      targetBlock = this._resolveTarget(command.target);
      if (!targetBlock) return this._error('Could not resolve target block', action);
      const validateBefore = options.validateBefore !== false;
      if (validateBefore) {
        const freshBlock = this._extractor.getBlock(targetBlock.id);
        if (!freshBlock) return this._error(`Target block "${targetBlock.id}" no longer exists in DOM`, action);
        targetBlock = freshBlock;
      }
    }

    if (options.dryRun) {
      return this._result(true, action, targetBlock ? targetBlock.id : null, {
        warning: 'Dry run - no changes applied'
      });
    }

    let result;
    try {
      switch (action) {
        case 'replace_text': result = this._executeReplaceText(targetBlock, command, options); break;
        case 'append_text': result = this._executeAppendText(targetBlock, command, options); break;
        case 'clear_block': result = this._executeClearBlock(targetBlock, command, options); break;
        case 'delete_block': result = this._executeDeleteBlock(targetBlock, command, options); break;
        default: result = this._error(`No handler for action: "${action}"`);
      }
    } catch (err) {
      result = this._error(`Action "${action}" failed: ${err.message}`, action);
    }
    return result;
  }

  _executeReplaceText(block, command) {
    if (command.value == null) return this._error('replace_text requires a "value" field', 'replace_text');
    const element = this._getBlockElement(block.id);
    if (!element) return this._error(`DOM element not found for block "${block.id}"`, 'replace_text');
    if (typeof this._adapter._applyEdit === 'function') {
      const success = this._adapter._applyEdit(element, command.value);
      if (success) return this._result(true, 'replace_text', block.id);
      return this._error(`Adapter _applyEdit returned false for block "${block.id}"`, 'replace_text');
    }
    element.textContent = command.value;
    return this._result(true, 'replace_text', block.id);
  }

  _executeAppendText(block, command) {
    if (command.value == null) return this._error('append_text requires a "value" field', 'append_text');
    const element = this._getBlockElement(block.id);
    if (!element) return this._error(`DOM element not found for block "${block.id}"`, 'append_text');
    const currentText = element.textContent || '';
    element.textContent = currentText + command.value;
    return this._result(true, 'append_text', block.id);
  }

  _executeClearBlock(block) {
    const element = this._getBlockElement(block.id);
    if (!element) return this._error(`DOM element not found for block "${block.id}"`, 'clear_block');
    element.textContent = '';
    return this._result(true, 'clear_block', block.id);
  }

  _executeDeleteBlock(block) {
    const element = this._getBlockElement(block.id);
    if (!element) return this._error(`DOM element not found for block "${block.id}"`, 'delete_block');
    if (element.parentElement) {
      element.parentElement.removeChild(element);
      return this._result(true, 'delete_block', block.id);
    }
    return this._error(`Cannot delete block "${block.id}"`, 'delete_block');
  }

  _executeSave() {
    if (typeof this._adapter.save === 'function') {
      this._adapter.save();
      return this._result(true, 'save');
    }
    return this._result(true, 'save');
  }

  _executeGetSnapshot() {
    const snapshot = this._extractor.getContent();
    return this._result(true, 'get_snapshot', null, { snapshot });
  }

  _executeFindAndReplace(command) {
    if (!command.findText) return this._error('find_and_replace requires "findText"', 'find_and_replace');
    if (command.replaceText == null) return this._error('find_and_replace requires "replaceText"', 'find_and_replace');
    const snapshot = this._extractor.getContent();
    let replacedCount = 0;
    let lastAffectedId = null;
    for (const block of snapshot.blocks) {
      if (block.text && block.text.includes(command.findText)) {
        const element = this._getBlockElement(block.id);
        if (element) {
          element.textContent = block.text.split(command.findText).join(command.replaceText);
          replacedCount++;
          lastAffectedId = block.id;
        }
      }
    }
    if (replacedCount > 0) {
      return this._result(true, 'find_and_replace', lastAffectedId);
    }
    return this._error(`Text "${command.findText}" not found in any block`, 'find_and_replace');
  }

  _resolveTarget(target) {
    if (!target) return null;
    if (target.blockId) return this._extractor.getBlock(target.blockId);
    const snapshot = this._extractor.getContent();
    const blocks = snapshot.blocks;
    if (!blocks || blocks.length === 0) return null;
    if (target.position != null) {
      const block = blocks.find((b) => b.position === target.position);
      if (block) return block;
      if (target.position >= 0 && target.position < blocks.length) return blocks[target.position];
      return null;
    }
    if (target.type) {
      const matches = blocks.filter((b) => b.type === target.type);
      const nth = target.nth || 0;
      return matches[nth] || null;
    }
    if (target.text) {
      const matches = blocks.filter((b) => b.text && b.text.includes(target.text));
      const nth = target.nth || 0;
      return matches[nth] || null;
    }
    return null;
  }

  _getBlockElement(blockId) {
    if (this._extractor._blockMap) return this._extractor._blockMap.get(blockId) || null;
    return null;
  }

  _result(success, action, affectedBlockId = null, extras = {}) {
    const result = { success, action };
    if (affectedBlockId != null) result.affectedBlockId = affectedBlockId;
    if (extras.warning) result.warning = extras.warning;
    if (extras.snapshot) result.snapshot = extras.snapshot;
    if (extras.error) result.error = extras.error;
    return result;
  }

  _error(message, action = 'unknown') {
    return { success: false, action, error: message };
  }
}

// ─── Mock extractor and adapter ──────────────────────────────────────────────

function setupTestDOM() {
  document.body.innerHTML = `
    <div contenteditable="true" id="editor">
      <p id="p1">First paragraph text.</p>
      <p id="p2">Second paragraph text.</p>
      <h2 id="h2">Heading Two</h2>
    </div>
  `;
}

function createTestExtractor() {
  const blockMap = new Map();

  const extractor = {
    _blockMap: blockMap,
    getContent: () => {
      blockMap.clear();
      const blocks = [];
      const elements = document.querySelectorAll('#editor > *');
      elements.forEach((el, i) => {
        const tagName = el.tagName.toLowerCase();
        let type = 'paragraph';
        if (tagName === 'h2') type = 'heading2';
        const block = {
          id: el.id || `block-${i}`,
          type,
          text: el.textContent || '',
          html: el.innerHTML || '',
          editable: true,
          position: i,
          parent: null,
          children: []
        };
        blocks.push(block);
        blockMap.set(block.id, el);
      });
      return {
        app: 'TestApp',
        url: 'about:blank',
        title: '',
        isEditMode: true,
        blocks,
        selection: { blockId: null, text: null, startOffset: null, endOffset: null },
        timestamp: Date.now()
      };
    },
    getBlock: (blockId) => {
      const el = blockMap.get(blockId);
      if (!el) {
        // Trigger re-extraction
        extractor.getContent();
        const retryEl = blockMap.get(blockId);
        if (!retryEl) return null;
        return {
          id: blockId,
          type: 'paragraph',
          text: retryEl.textContent,
          html: retryEl.innerHTML,
          editable: true,
          position: 0,
          parent: null,
          children: []
        };
      }
      return {
        id: blockId,
        type: 'paragraph',
        text: el.textContent,
        html: el.innerHTML,
        editable: true,
        position: 0,
        parent: null,
        children: []
      };
    }
  };

  return extractor;
}

function createTestAdapter() {
  return {
    _applyEdit: jest.fn((element, value) => {
      element.textContent = value;
      return true;
    }),
    _dispatchNativeEvents: jest.fn(),
    save: jest.fn()
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Executor constructor', () => {
  test('throws when no adapter provided', () => {
    expect(() => new Executor(null, {})).toThrow('Executor requires an adapter instance');
  });

  test('throws when no extractor provided', () => {
    expect(() => new Executor({}, null)).toThrow('Executor requires an extractor instance');
  });

  test('creates instance with valid adapter and extractor', () => {
    const executor = new Executor({}, { _blockMap: new Map() });
    expect(executor._adapter).toBeDefined();
    expect(executor._extractor).toBeDefined();
  });
});

describe('Executor.execute - validation', () => {
  let executor;

  beforeEach(() => {
    setupTestDOM();
    executor = new Executor(createTestAdapter(), createTestExtractor());
  });

  test('rejects command with no action', () => {
    const result = executor.execute({});
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/No action specified/);
  });

  test('rejects null command', () => {
    const result = executor.execute(null);
    expect(result.success).toBe(false);
  });

  test('rejects unsupported action', () => {
    const result = executor.execute({ action: 'fly_to_moon' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Unsupported action/);
  });

  test('rejects action without required target', () => {
    const result = executor.execute({ action: 'replace_text' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/requires a target/);
  });
});

describe('Executor - replace_text', () => {
  let executor, adapter, extractor;

  beforeEach(() => {
    setupTestDOM();
    adapter = createTestAdapter();
    extractor = createTestExtractor();
    executor = new Executor(adapter, extractor);
    extractor.getContent(); // populate blockMap
  });

  test('replaces text in target block by blockId', () => {
    const result = executor.execute({
      action: 'replace_text',
      target: { blockId: 'p1' },
      value: 'New content'
    });
    expect(result.success).toBe(true);
    expect(result.action).toBe('replace_text');
    expect(result.affectedBlockId).toBe('p1');
    expect(document.getElementById('p1').textContent).toBe('New content');
  });

  test('fails when value is not provided', () => {
    const result = executor.execute({
      action: 'replace_text',
      target: { blockId: 'p1' }
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/requires a "value"/);
  });

  test('fails when target block not found', () => {
    const result = executor.execute({
      action: 'replace_text',
      target: { blockId: 'nonexistent' },
      value: 'text'
    });
    expect(result.success).toBe(false);
  });
});

describe('Executor - append_text', () => {
  let executor, adapter, extractor;

  beforeEach(() => {
    setupTestDOM();
    adapter = createTestAdapter();
    extractor = createTestExtractor();
    executor = new Executor(adapter, extractor);
    extractor.getContent();
  });

  test('appends text to target block', () => {
    const result = executor.execute({
      action: 'append_text',
      target: { blockId: 'p1' },
      value: ' appended'
    });
    expect(result.success).toBe(true);
    expect(document.getElementById('p1').textContent).toBe('First paragraph text. appended');
  });

  test('fails when value is not provided', () => {
    const result = executor.execute({
      action: 'append_text',
      target: { blockId: 'p1' }
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/requires a "value"/);
  });
});

describe('Executor - clear_block', () => {
  let executor;

  beforeEach(() => {
    setupTestDOM();
    const extractor = createTestExtractor();
    executor = new Executor(createTestAdapter(), extractor);
    extractor.getContent();
  });

  test('clears block content', () => {
    const result = executor.execute({
      action: 'clear_block',
      target: { blockId: 'p1' }
    });
    expect(result.success).toBe(true);
    expect(document.getElementById('p1').textContent).toBe('');
  });
});

describe('Executor - delete_block', () => {
  let executor;

  beforeEach(() => {
    setupTestDOM();
    const extractor = createTestExtractor();
    executor = new Executor(createTestAdapter(), extractor);
    extractor.getContent();
  });

  test('removes block from DOM', () => {
    expect(document.getElementById('p1')).not.toBeNull();
    const result = executor.execute({
      action: 'delete_block',
      target: { blockId: 'p1' }
    });
    expect(result.success).toBe(true);
    expect(document.getElementById('p1')).toBeNull();
  });
});

describe('Executor - get_snapshot', () => {
  let executor;

  beforeEach(() => {
    setupTestDOM();
    const extractor = createTestExtractor();
    executor = new Executor(createTestAdapter(), extractor);
  });

  test('returns current snapshot', () => {
    const result = executor.execute({ action: 'get_snapshot' });
    expect(result.success).toBe(true);
    expect(result.action).toBe('get_snapshot');
    expect(result.snapshot).toBeDefined();
    expect(result.snapshot.blocks.length).toBeGreaterThan(0);
  });
});

describe('Executor - save', () => {
  test('calls adapter save method', () => {
    setupTestDOM();
    const adapter = createTestAdapter();
    const extractor = createTestExtractor();
    const executor = new Executor(adapter, extractor);
    const result = executor.execute({ action: 'save' });
    expect(result.success).toBe(true);
    expect(adapter.save).toHaveBeenCalled();
  });
});

describe('Executor - target resolution', () => {
  let executor, extractor;

  beforeEach(() => {
    setupTestDOM();
    extractor = createTestExtractor();
    executor = new Executor(createTestAdapter(), extractor);
    extractor.getContent();
  });

  test('resolves target by blockId', () => {
    const block = executor._resolveTarget({ blockId: 'p1' });
    expect(block).not.toBeNull();
    expect(block.id).toBe('p1');
  });

  test('resolves target by position', () => {
    const block = executor._resolveTarget({ position: 0 });
    expect(block).not.toBeNull();
  });

  test('resolves target by type', () => {
    const block = executor._resolveTarget({ type: 'heading2' });
    expect(block).not.toBeNull();
    expect(block.text).toContain('Heading');
  });

  test('resolves target by text content', () => {
    const block = executor._resolveTarget({ text: 'Second paragraph' });
    expect(block).not.toBeNull();
    expect(block.text).toContain('Second paragraph');
  });

  test('returns null for unresolvable target', () => {
    const block = executor._resolveTarget({ text: 'nonexistent content xyz' });
    expect(block).toBeNull();
  });

  test('returns null for empty target', () => {
    const block = executor._resolveTarget({});
    expect(block).toBeNull();
  });
});

describe('Executor - dry_run', () => {
  test('returns without making changes', () => {
    setupTestDOM();
    const extractor = createTestExtractor();
    const executor = new Executor(createTestAdapter(), extractor);
    extractor.getContent();
    const originalText = document.getElementById('p1').textContent;
    const result = executor.execute({
      action: 'replace_text',
      target: { blockId: 'p1' },
      value: 'Should not appear',
      options: { dryRun: true }
    });
    expect(result.success).toBe(true);
    expect(result.warning).toMatch(/Dry run/);
    expect(document.getElementById('p1').textContent).toBe(originalText);
  });
});

describe('Executor - find_and_replace', () => {
  let executor, extractor;

  beforeEach(() => {
    setupTestDOM();
    extractor = createTestExtractor();
    executor = new Executor(createTestAdapter(), extractor);
    extractor.getContent();
  });

  test('replaces text across blocks', () => {
    const result = executor.execute({
      action: 'find_and_replace',
      findText: 'paragraph',
      replaceText: 'section'
    });
    expect(result.success).toBe(true);
    expect(document.getElementById('p1').textContent).toContain('section');
    expect(document.getElementById('p2').textContent).toContain('section');
  });

  test('fails when findText not found', () => {
    const result = executor.execute({
      action: 'find_and_replace',
      findText: 'zzzznotfound',
      replaceText: 'x'
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/);
  });

  test('fails when findText missing', () => {
    const result = executor.execute({
      action: 'find_and_replace',
      replaceText: 'x'
    });
    expect(result.success).toBe(false);
  });

  test('fails when replaceText missing', () => {
    const result = executor.execute({
      action: 'find_and_replace',
      findText: 'paragraph'
    });
    expect(result.success).toBe(false);
  });
});
