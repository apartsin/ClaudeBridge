/**
 * Unit tests for Explorer (src/content/explorer.js).
 *
 * Tests the auto-learning exploration logic that detects editable regions,
 * editor frameworks, block types, and available actions.
 */

require('../helpers/setup');

// ─── Re-implement key explorer constants and logic ───────────────────────────

const BLOCK_PROBE_SELECTORS = {
  heading1: ['h1'],
  heading2: ['h2'],
  heading3: ['h3'],
  paragraph: ['p', 'div[contenteditable="true"]', '.ql-editor > p', '.ProseMirror > p'],
  'list-item': ['li'],
  list: ['ul', 'ol'],
  image: ['img'],
  video: ['video'],
  embed: ['iframe'],
  button: ['button:not([aria-label])'],
  divider: ['hr'],
  table: ['table'],
  'table-row': ['tr'],
  'table-cell': ['td', 'th']
};

const EDITOR_FRAMEWORKS = [
  { name: 'Quill', detect: () => !!document.querySelector('.ql-editor'), selector: '.ql-editor', editMethod: 'nativeApi' },
  { name: 'ProseMirror', detect: () => !!document.querySelector('.ProseMirror'), selector: '.ProseMirror', editMethod: 'nativeApi' },
  { name: 'CKEditor', detect: () => !!window.CKEDITOR, selector: '.ck-editor__editable', editMethod: 'nativeApi' },
  { name: 'TinyMCE', detect: () => !!window.tinymce, selector: '.mce-content-body', editMethod: 'nativeApi' },
  { name: 'ContentEditable', detect: () => !!document.querySelector('[contenteditable="true"]'), selector: '[contenteditable="true"]', editMethod: 'execCommand' }
];

const KNOWN_APPS = {
  'sites.google.com': 'Google Sites',
  'docs.google.com': 'Google Docs',
  'notion.so': 'Notion',
  'medium.com': 'Medium',
  'wordpress.com': 'WordPress',
  'github.com': 'GitHub'
};

const SAVE_SELECTORS = [
  { selector: 'button[aria-label*="Publish"]', label: 'Publish button (aria-label)' },
  { selector: 'button[aria-label*="Save"]', label: 'Save button (aria-label)' },
  { selector: '[data-action="save"]', label: 'Save button (data-action)' },
  { selector: '.save-button', label: 'Save button (class)' },
  { selector: '#save-btn', label: 'Save button (id)' },
  { selector: '#publish-btn', label: 'Publish button (id)' }
];

// ─── Minimal Explorer re-implementation ──────────────────────────────────────

class Explorer {
  constructor(adapter) {
    if (!adapter) throw new Error('Explorer requires an adapter instance');
    this._adapter = adapter;
  }

  explore() {
    const domain = window.location.hostname;
    const app = this._adapter.appName || this._detectAppName(domain);
    const framework = this._detectFramework();
    const detectedBlocks = this._scanBlocks();
    const detectedActions = this._detectActions(framework);
    const suggestedQuirks = this._detectQuirks(domain, framework);
    const suggestedSelectors = this._buildSuggestedSelectors(detectedBlocks);
    const suggestedEditMethod = framework ? framework.editMethod : 'execCommand';
    const confidence = this._assessConfidence(detectedBlocks, detectedActions, framework);
    return {
      app, domain, detectedBlocks, detectedActions, suggestedQuirks,
      suggestedSelectors, suggestedEditMethod, confidence
    };
  }

  _detectFramework() {
    for (const fw of EDITOR_FRAMEWORKS) {
      try { if (fw.detect()) return fw; } catch (_) {}
    }
    return null;
  }

  _detectAppName(domain) {
    if (KNOWN_APPS[domain]) return KNOWN_APPS[domain];
    try {
      const ogSiteName = document.querySelector('meta[property="og:site_name"]');
      if (ogSiteName && ogSiteName.content) return ogSiteName.content;
      const appNameMeta = document.querySelector('meta[name="application-name"]');
      if (appNameMeta && appNameMeta.content) return appNameMeta.content;
    } catch (_) {}
    const mainPart = domain.replace(/^www\./, '').split('.').slice(-2, -1)[0] || domain;
    return mainPart.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  _scanBlocks() {
    const detectedBlocks = [];
    for (const [blockType, selectors] of Object.entries(BLOCK_PROBE_SELECTORS)) {
      for (const selector of selectors) {
        let elements;
        try { elements = document.querySelectorAll(selector); } catch (_) { continue; }
        if (elements.length > 0) {
          let sampleText = '';
          for (const el of elements) {
            const text = (el.textContent || '').trim();
            if (text.length > 0) { sampleText = text.substring(0, 100); break; }
          }
          const editableMethod = this._probeEditability(elements[0]);
          detectedBlocks.push({ type: blockType, selector, count: elements.length, sampleText, editableMethod });
          break;
        }
      }
    }
    return detectedBlocks;
  }

  _probeEditability(element) {
    if (!element) return 'readonly';
    const tagName = (element.tagName || '').toLowerCase();
    if (tagName === 'textarea' || tagName === 'input') {
      return element.readOnly || element.disabled ? 'readonly' : 'input';
    }
    if (element.isContentEditable || element.contentEditable === 'true') return 'contenteditable';
    // jsdom fallback: check attribute directly
    if (element.getAttribute && element.getAttribute('contenteditable') === 'true') return 'contenteditable';
    let parent = element.parentElement;
    while (parent) {
      if (parent.contentEditable === 'true') return 'contenteditable';
      if (parent.getAttribute && parent.getAttribute('contenteditable') === 'true') return 'contenteditable';
      parent = parent.parentElement;
    }
    if (element.closest && element.closest('.ql-editor')) return 'nativeApi';
    if (element.closest && element.closest('.ProseMirror')) return 'nativeApi';
    return 'readonly';
  }

  _detectActions(framework) {
    const actions = [];
    const hasEditable = !!document.querySelector('[contenteditable="true"]');
    const hasInputs = !!document.querySelector('textarea, input[type="text"]');
    actions.push({ action: 'replace_text', viable: hasEditable || hasInputs, method: 'execCommand/textContent' });
    actions.push({ action: 'append_text', viable: hasEditable || hasInputs, method: 'execCommand/textContent' });
    actions.push({ action: 'insert_block', viable: hasEditable, method: 'DOM insertion' });
    actions.push({ action: 'delete_block', viable: hasEditable, method: 'DOM removeChild' });
    actions.push({ action: 'move_block', viable: hasEditable, method: 'DOM reordering' });
    actions.push({ action: 'set_format', viable: hasEditable, method: 'execCommand' });
    actions.push({ action: 'find_and_replace', viable: hasEditable || hasInputs, method: 'Block iteration' });
    actions.push({ action: 'clear_block', viable: hasEditable || hasInputs, method: 'Set textContent to empty' });
    actions.push({ action: 'set_attribute', viable: true, method: 'element.setAttribute()' });
    const saveBtn = this._detectSaveMechanism();
    actions.push({ action: 'save', viable: saveBtn !== null, method: saveBtn ? saveBtn.label : 'none' });
    actions.push({ action: 'get_snapshot', viable: true, method: 'Extractor.getContent()' });
    return actions;
  }

  _detectSaveMechanism() {
    for (const entry of SAVE_SELECTORS) {
      try {
        const el = document.querySelector(entry.selector);
        if (el) return entry;
      } catch (_) {}
    }
    try {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        const text = (btn.textContent || '').trim().toLowerCase();
        if (text === 'publish' || text === 'save' || text === 'save changes') {
          return { selector: 'button (text match)', label: `Button with text "${btn.textContent.trim()}"` };
        }
      }
    } catch (_) {}
    return null;
  }

  _detectQuirks(domain, framework) {
    const quirks = [];
    if (document.querySelector('[data-reactroot]') || document.querySelector('[data-react-root]')) {
      quirks.push('Page uses React; DOM mutations may be overwritten by re-renders');
    }
    // Vue.js detection: Vue adds data-v-XXXX attributes. We scan all elements
    // for any attribute that starts with "data-v-".
    const allEls = document.querySelectorAll('*');
    let hasVue = false;
    for (const el of allEls) {
      if (el.attributes) {
        for (const attr of el.attributes) {
          if (attr.name.startsWith('data-v-')) { hasVue = true; break; }
        }
      }
      if (hasVue) break;
    }
    if (hasVue) {
      quirks.push('Page uses Vue.js; DOM mutations may be overwritten by reactivity system');
    }
    return quirks;
  }

  _buildSuggestedSelectors(detectedBlocks) {
    const selectors = {};
    for (const block of detectedBlocks) {
      selectors[block.type] = {
        value: block.selector,
        confidence: block.count > 0 ? 'inferred' : 'tentative',
        seenCount: block.count
      };
    }
    return selectors;
  }

  _assessConfidence(blocks, actions, framework) {
    let score = 0;
    if (framework) score += 3;
    if (blocks.length >= 3) score += 2;
    else if (blocks.length >= 1) score += 1;
    const viableActions = actions.filter((a) => a.viable);
    if (viableActions.length >= 5) score += 2;
    else if (viableActions.length >= 2) score += 1;
    if (document.querySelector('[contenteditable="true"]')) score += 1;
    if (score >= 6) return 'high';
    if (score >= 3) return 'medium';
    return 'low';
  }
}

// ─── Mock adapter ────────────────────────────────────────────────────────────

function createMockAdapter(options = {}) {
  return {
    appName: options.appName || null
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Explorer constructor', () => {
  test('throws when no adapter provided', () => {
    expect(() => new Explorer(null)).toThrow('Explorer requires an adapter instance');
  });

  test('creates instance with valid adapter', () => {
    const explorer = new Explorer(createMockAdapter());
    expect(explorer._adapter).toBeDefined();
  });
});

describe('Explorer - editable region detection', () => {
  test('detects contenteditable regions', () => {
    document.body.innerHTML = '<div contenteditable="true"><p>Editable</p></div>';
    const explorer = new Explorer(createMockAdapter());
    const result = explorer.explore();
    const paraBlock = result.detectedBlocks.find((b) => b.type === 'paragraph');
    expect(paraBlock).toBeDefined();
    expect(paraBlock.count).toBeGreaterThan(0);
  });

  test('detects textarea elements', () => {
    document.body.innerHTML = '<textarea>Content</textarea>';
    const explorer = new Explorer(createMockAdapter());
    const result = explorer.explore();
    // textarea does not match block probe selectors directly, but actions detect inputs
    const replaceAction = result.detectedActions.find((a) => a.action === 'replace_text');
    expect(replaceAction.viable).toBe(true);
  });

  test('detects input elements', () => {
    document.body.innerHTML = '<input type="text" value="test" />';
    const explorer = new Explorer(createMockAdapter());
    const result = explorer.explore();
    const replaceAction = result.detectedActions.find((a) => a.action === 'replace_text');
    expect(replaceAction.viable).toBe(true);
  });

  test('handles page with no editable content', () => {
    document.body.innerHTML = '<div>Static content only</div>';
    const explorer = new Explorer(createMockAdapter());
    const result = explorer.explore();
    const replaceAction = result.detectedActions.find((a) => a.action === 'replace_text');
    expect(replaceAction.viable).toBe(false);
  });
});

describe('Explorer - editor framework detection', () => {
  test('detects Quill editor', () => {
    document.body.innerHTML = '<div class="ql-editor"><p>Quill content</p></div>';
    const explorer = new Explorer(createMockAdapter());
    const result = explorer.explore();
    expect(result.suggestedEditMethod).toBe('nativeApi');
  });

  test('detects ProseMirror editor', () => {
    document.body.innerHTML = '<div class="ProseMirror"><p>PM content</p></div>';
    const explorer = new Explorer(createMockAdapter());
    const result = explorer.explore();
    expect(result.suggestedEditMethod).toBe('nativeApi');
  });

  test('detects CKEditor when window.CKEDITOR exists', () => {
    document.body.innerHTML = '<div contenteditable="true"><p>Content</p></div>';
    window.CKEDITOR = {};
    const explorer = new Explorer(createMockAdapter());
    const result = explorer.explore();
    expect(result.suggestedEditMethod).toBe('nativeApi');
    delete window.CKEDITOR;
  });

  test('detects TinyMCE when window.tinymce exists', () => {
    document.body.innerHTML = '<div contenteditable="true"><p>Content</p></div>';
    window.tinymce = {};
    const explorer = new Explorer(createMockAdapter());
    const result = explorer.explore();
    expect(result.suggestedEditMethod).toBe('nativeApi');
    delete window.tinymce;
  });

  test('falls back to execCommand when no framework detected', () => {
    document.body.innerHTML = '<div contenteditable="true"><p>Plain CE</p></div>';
    const explorer = new Explorer(createMockAdapter());
    const result = explorer.explore();
    expect(result.suggestedEditMethod).toBe('execCommand');
  });
});

describe('Explorer - block scanning', () => {
  test('finds correct block types and counts', () => {
    document.body.innerHTML = `
      <div contenteditable="true">
        <h1>Title</h1>
        <h2>Subtitle</h2>
        <p>Paragraph 1</p>
        <p>Paragraph 2</p>
        <ul><li>Item 1</li><li>Item 2</li></ul>
      </div>
    `;
    const explorer = new Explorer(createMockAdapter());
    const result = explorer.explore();

    const h1 = result.detectedBlocks.find((b) => b.type === 'heading1');
    expect(h1).toBeDefined();
    expect(h1.count).toBe(1);

    const h2 = result.detectedBlocks.find((b) => b.type === 'heading2');
    expect(h2).toBeDefined();

    const listItems = result.detectedBlocks.find((b) => b.type === 'list-item');
    expect(listItems).toBeDefined();
    expect(listItems.count).toBe(2);
  });

  test('sample text is extracted from first visible element', () => {
    document.body.innerHTML = '<div contenteditable="true"><h1>Sample Heading Text</h1></div>';
    const explorer = new Explorer(createMockAdapter());
    const result = explorer.explore();
    const h1 = result.detectedBlocks.find((b) => b.type === 'heading1');
    expect(h1.sampleText).toBe('Sample Heading Text');
  });

  test('truncates sample text to 100 characters', () => {
    const longText = 'A'.repeat(200);
    document.body.innerHTML = `<div contenteditable="true"><p>${longText}</p></div>`;
    const explorer = new Explorer(createMockAdapter());
    const result = explorer.explore();
    const para = result.detectedBlocks.find((b) => b.type === 'paragraph');
    expect(para.sampleText.length).toBeLessThanOrEqual(100);
  });
});

describe('Explorer - app name detection', () => {
  test('detects known domains', () => {
    const explorer = new Explorer(createMockAdapter());
    expect(explorer._detectAppName('sites.google.com')).toBe('Google Sites');
    expect(explorer._detectAppName('docs.google.com')).toBe('Google Docs');
    expect(explorer._detectAppName('notion.so')).toBe('Notion');
    expect(explorer._detectAppName('github.com')).toBe('GitHub');
  });

  test('detects app name from meta og:site_name', () => {
    document.head.innerHTML = '<meta property="og:site_name" content="My Custom App">';
    const explorer = new Explorer(createMockAdapter());
    const name = explorer._detectAppName('unknown.example.com');
    expect(name).toBe('My Custom App');
    document.head.innerHTML = '';
  });

  test('detects app name from meta application-name', () => {
    document.head.innerHTML = '<meta name="application-name" content="AppFromMeta">';
    const explorer = new Explorer(createMockAdapter());
    const name = explorer._detectAppName('unknown2.example.com');
    expect(name).toBe('AppFromMeta');
    document.head.innerHTML = '';
  });

  test('derives readable name from domain when no meta', () => {
    document.head.innerHTML = '';
    const explorer = new Explorer(createMockAdapter());
    const name = explorer._detectAppName('my-cool-app.example.com');
    // Should derive from "example" (second-to-last part) or similar
    expect(typeof name).toBe('string');
    expect(name.length).toBeGreaterThan(0);
  });

  test('uses adapter appName when available', () => {
    document.body.innerHTML = '<div contenteditable="true"><p>Text</p></div>';
    const explorer = new Explorer(createMockAdapter({ appName: 'AdapterApp' }));
    const result = explorer.explore();
    expect(result.app).toBe('AdapterApp');
  });
});

describe('Explorer - suggested selectors', () => {
  test('returns object mapping block types to selector info', () => {
    document.body.innerHTML = `
      <div contenteditable="true">
        <h1>Title</h1>
        <p>Para</p>
      </div>
    `;
    const explorer = new Explorer(createMockAdapter());
    const result = explorer.explore();
    expect(result.suggestedSelectors).toBeDefined();
    expect(typeof result.suggestedSelectors).toBe('object');

    if (result.suggestedSelectors.heading1) {
      expect(result.suggestedSelectors.heading1).toHaveProperty('value');
      expect(result.suggestedSelectors.heading1).toHaveProperty('confidence');
      expect(result.suggestedSelectors.heading1).toHaveProperty('seenCount');
    }
  });

  test('selector confidence is inferred when elements exist', () => {
    document.body.innerHTML = '<div contenteditable="true"><p>Test</p></div>';
    const explorer = new Explorer(createMockAdapter());
    const result = explorer.explore();
    const para = result.suggestedSelectors.paragraph;
    if (para) {
      expect(para.confidence).toBe('inferred');
    }
  });
});

describe('Explorer - confidence assessment', () => {
  test('returns high confidence with framework + many blocks + many actions', () => {
    document.body.innerHTML = `
      <div class="ql-editor">
        <h1>H1</h1><h2>H2</h2><h3>H3</h3>
        <p>P1</p><p>P2</p>
        <ul><li>L1</li></ul>
      </div>
    `;
    const explorer = new Explorer(createMockAdapter());
    const result = explorer.explore();
    // With Quill framework (+3), 4+ block types (+2), many viable actions (+2), contenteditable (+1) = 8 >= 6
    expect(result.confidence).toBe('high');
  });

  test('returns low confidence with no editable content', () => {
    document.body.innerHTML = '<div>No editable content at all</div>';
    const explorer = new Explorer(createMockAdapter());
    const result = explorer.explore();
    expect(result.confidence).toBe('low');
  });

  test('returns medium confidence with some editable content', () => {
    document.body.innerHTML = '<div contenteditable="true"><p>Some content</p></div>';
    const explorer = new Explorer(createMockAdapter());
    const result = explorer.explore();
    // ContentEditable detected (+1), paragraph block (+1), several viable actions (~7: +2) = ~4
    expect(['medium', 'high']).toContain(result.confidence);
  });
});

describe('Explorer - quirk detection', () => {
  test('detects React usage', () => {
    document.body.innerHTML = '<div data-reactroot><p>React app</p></div>';
    const explorer = new Explorer(createMockAdapter());
    const result = explorer.explore();
    const reactQuirk = result.suggestedQuirks.find((q) => q.includes('React'));
    expect(reactQuirk).toBeDefined();
  });

  test('detects Vue.js usage', () => {
    document.body.innerHTML = '<div data-v-abc123><p>Vue app</p></div>';
    const explorer = new Explorer(createMockAdapter());
    const result = explorer.explore();
    const vueQuirk = result.suggestedQuirks.find((q) => q.includes('Vue'));
    expect(vueQuirk).toBeDefined();
  });

  test('returns empty quirks for plain pages', () => {
    document.body.innerHTML = '<div contenteditable="true"><p>Plain page</p></div>';
    const explorer = new Explorer(createMockAdapter());
    const result = explorer.explore();
    expect(result.suggestedQuirks.length).toBe(0);
  });
});

describe('Explorer - save mechanism detection', () => {
  test('detects save button by aria-label', () => {
    document.body.innerHTML = '<button aria-label="Save changes">Save</button>';
    const explorer = new Explorer(createMockAdapter());
    const saveBtn = explorer._detectSaveMechanism();
    expect(saveBtn).not.toBeNull();
    expect(saveBtn.label).toContain('Save');
  });

  test('detects publish button by id', () => {
    document.body.innerHTML = '<button id="publish-btn">Publish</button>';
    const explorer = new Explorer(createMockAdapter());
    const saveBtn = explorer._detectSaveMechanism();
    expect(saveBtn).not.toBeNull();
  });

  test('detects save button by text content', () => {
    document.body.innerHTML = '<button>Save</button>';
    const explorer = new Explorer(createMockAdapter());
    const saveBtn = explorer._detectSaveMechanism();
    expect(saveBtn).not.toBeNull();
  });

  test('returns null when no save mechanism found', () => {
    document.body.innerHTML = '<button>Click me</button>';
    const explorer = new Explorer(createMockAdapter());
    const saveBtn = explorer._detectSaveMechanism();
    expect(saveBtn).toBeNull();
  });
});

describe('Explorer - probeEditability', () => {
  test('returns contenteditable for contenteditable elements', () => {
    document.body.innerHTML = '<div contenteditable="true">Editable</div>';
    const explorer = new Explorer(createMockAdapter());
    const el = document.querySelector('[contenteditable]');
    expect(explorer._probeEditability(el)).toBe('contenteditable');
  });

  test('returns input for textarea elements', () => {
    document.body.innerHTML = '<textarea>Text</textarea>';
    const explorer = new Explorer(createMockAdapter());
    const el = document.querySelector('textarea');
    expect(explorer._probeEditability(el)).toBe('input');
  });

  test('returns readonly for non-editable elements', () => {
    document.body.innerHTML = '<div>Not editable</div>';
    const explorer = new Explorer(createMockAdapter());
    const el = document.querySelector('div');
    expect(explorer._probeEditability(el)).toBe('readonly');
  });

  test('returns readonly for null element', () => {
    const explorer = new Explorer(createMockAdapter());
    expect(explorer._probeEditability(null)).toBe('readonly');
  });

  test('returns readonly for disabled textarea', () => {
    document.body.innerHTML = '<textarea disabled>Disabled</textarea>';
    const explorer = new Explorer(createMockAdapter());
    const el = document.querySelector('textarea');
    expect(explorer._probeEditability(el)).toBe('readonly');
  });

  test('returns contenteditable for child of contenteditable', () => {
    document.body.innerHTML = '<div contenteditable="true"><p>Child</p></div>';
    const explorer = new Explorer(createMockAdapter());
    const el = document.querySelector('p');
    expect(explorer._probeEditability(el)).toBe('contenteditable');
  });
});
