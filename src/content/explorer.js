/**
 * Explorer — Auto-learns editor structure on first visit.
 *
 * Scans the live DOM for editable regions, block types, available actions,
 * and editor frameworks. Returns an ExplorationResult describing what was
 * found without modifying any DOM content.
 */

const LOG_PREFIX = '[ClaudeBridge:Explorer]';

/**
 * Known block-type selectors to probe across various editors.
 * Each entry maps a block type to an array of CSS selectors to try.
 */
const BLOCK_PROBE_SELECTORS = {
  heading1: ['h1', '[data-block-type="heading"] h1', '.kix-paragraphrenderer h1'],
  heading2: ['h2', '[data-block-type="heading"] h2', '.kix-paragraphrenderer h2'],
  heading3: ['h3', '[data-block-type="heading"] h3', '.kix-paragraphrenderer h3'],
  paragraph: [
    'p',
    'div[contenteditable="true"]',
    '[data-block-type="text"]',
    '.kix-paragraphrenderer',
    '.ql-editor > p',
    '.ProseMirror > p',
    '.ck-editor__editable p'
  ],
  'list-item': ['li', '.kix-listrenderer li'],
  list: ['ul', 'ol', '.kix-listrenderer'],
  image: [
    'img',
    '[data-block-type="image"]',
    '.kix-imagerenderer',
    'figure img'
  ],
  video: ['video', '[data-block-type="video"]'],
  embed: [
    'iframe',
    '[data-block-type="embed"]',
    'embed',
    'object'
  ],
  button: [
    'button:not([aria-label])',
    '[data-block-type="button"]',
    'a.button',
    'a[role="button"]'
  ],
  divider: ['hr', '[data-block-type="divider"]'],
  table: ['table', '.kix-tablerenderer', '[data-block-type="table"]'],
  'table-row': ['tr'],
  'table-cell': ['td', 'th'],
  'column-layout': [
    '.sites-layout-row',
    '[data-block-type="column-layout"]',
    '.row',
    '.columns'
  ],
  column: [
    '.sites-layout-tile',
    '[data-block-type="column"]',
    '.column',
    '.col'
  ]
};

/**
 * Known editor framework signatures for auto-detection.
 */
const EDITOR_FRAMEWORKS = [
  {
    name: 'Quill',
    detect: () => !!window.Quill || !!document.querySelector('.ql-editor'),
    selector: '.ql-editor',
    editMethod: 'nativeApi'
  },
  {
    name: 'ProseMirror',
    detect: () => !!document.querySelector('.ProseMirror'),
    selector: '.ProseMirror',
    editMethod: 'nativeApi'
  },
  {
    name: 'CKEditor',
    detect: () => !!window.CKEDITOR,
    selector: '.ck-editor__editable',
    editMethod: 'nativeApi'
  },
  {
    name: 'TinyMCE',
    detect: () => !!window.tinymce,
    selector: '.mce-content-body',
    editMethod: 'nativeApi'
  },
  {
    name: 'Google Sites',
    detect: () => window.location.hostname === 'sites.google.com',
    selector: '[data-block-type]',
    editMethod: 'execCommand'
  },
  {
    name: 'Google Docs',
    detect: () => window.location.hostname === 'docs.google.com',
    selector: '.kix-paragraphrenderer',
    editMethod: 'keyboardSim'
  },
  {
    name: 'ContentEditable',
    detect: () => !!document.querySelector('[contenteditable="true"]'),
    selector: '[contenteditable="true"]',
    editMethod: 'execCommand'
  }
];

/**
 * Common save mechanism selectors to probe.
 */
const SAVE_SELECTORS = [
  { selector: 'button[aria-label*="Publish"]', label: 'Publish button (aria-label)' },
  { selector: 'button[aria-label*="Save"]', label: 'Save button (aria-label)' },
  { selector: '[data-action="save"]', label: 'Save button (data-action)' },
  { selector: '.save-button', label: 'Save button (class)' },
  { selector: 'button.publish', label: 'Publish button (class)' },
  { selector: '#save-btn', label: 'Save button (id)' },
  { selector: '#publish-btn', label: 'Publish button (id)' }
];

export class Explorer {
  /**
   * @param {object} adapter - An adapter instance. Used to know the app name
   *                           and to access adapter-specific exploration if available.
   */
  constructor(adapter) {
    if (!adapter) {
      throw new Error('Explorer requires an adapter instance');
    }
    this._adapter = adapter;
  }

  /**
   * Explore the current page's editor structure.
   * This method is read-only -- it does NOT modify any DOM content.
   *
   * @returns {ExplorationResult}
   */
  explore() {
    console.log(LOG_PREFIX, 'Starting exploration...');

    const domain = window.location.hostname;
    const app = this._adapter.appName || this._detectAppName(domain);

    // Step 1: Detect editor framework
    const framework = this._detectFramework();
    console.log(LOG_PREFIX, 'Detected framework:', framework ? framework.name : 'none');

    // Step 2: Scan for block types
    const detectedBlocks = this._scanBlocks();
    console.log(LOG_PREFIX, `Detected ${detectedBlocks.length} block types`);

    // Step 3: Detect available actions
    const detectedActions = this._detectActions(framework);
    console.log(LOG_PREFIX, `Detected ${detectedActions.length} actions`);

    // Step 4: Detect quirks
    const suggestedQuirks = this._detectQuirks(domain, framework);

    // Step 5: Build suggested selectors from detected blocks
    const suggestedSelectors = this._buildSuggestedSelectors(detectedBlocks);

    // Step 6: Determine edit method
    const suggestedEditMethod = framework ? framework.editMethod : 'execCommand';

    // Step 7: Assess confidence
    const confidence = this._assessConfidence(detectedBlocks, detectedActions, framework);

    // Step 8: Build raw DOM summary
    const rawDomSummary = this._buildDomSummary(detectedBlocks, framework, detectedActions);

    /** @type {ExplorationResult} */
    const result = {
      app,
      domain,
      detectedBlocks,
      detectedActions,
      suggestedQuirks,
      suggestedSelectors,
      suggestedEditMethod,
      confidence,
      rawDomSummary
    };

    console.log(LOG_PREFIX, 'Exploration complete:', result);
    return result;
  }

  // ---------------------------------------------------------------------------
  // Private methods
  // ---------------------------------------------------------------------------

  /**
   * Detect which editor framework is being used, if any.
   *
   * @returns {object|null} The matched framework descriptor or null.
   */
  _detectFramework() {
    for (const fw of EDITOR_FRAMEWORKS) {
      try {
        if (fw.detect()) {
          return fw;
        }
      } catch (_) {
        // Detection function threw, skip
      }
    }
    return null;
  }

  /**
   * Detect the app name from the domain when no adapter info is available.
   *
   * @param {string} domain
   * @returns {string}
   */
  _detectAppName(domain) {
    if (domain === 'sites.google.com') return 'Google Sites';
    if (domain === 'docs.google.com') return 'Google Docs';
    if (domain.includes('notion.so')) return 'Notion';
    if (domain.includes('confluence')) return 'Confluence';
    return 'Unknown Editor';
  }

  /**
   * Scan the DOM for known block types and record which selectors match.
   *
   * @returns {DetectedBlock[]}
   */
  _scanBlocks() {
    const detectedBlocks = [];

    for (const [blockType, selectors] of Object.entries(BLOCK_PROBE_SELECTORS)) {
      for (const selector of selectors) {
        let elements;
        try {
          elements = document.querySelectorAll(selector);
        } catch (_) {
          // Invalid selector, skip
          continue;
        }

        if (elements.length > 0) {
          // Get sample text from the first visible element
          let sampleText = '';
          for (const el of elements) {
            const text = (el.textContent || '').trim();
            if (text.length > 0) {
              sampleText = text.substring(0, 100);
              break;
            }
          }

          // Determine if elements are editable
          const editableMethod = this._probeEditability(elements[0]);

          detectedBlocks.push({
            type: blockType,
            selector,
            count: elements.length,
            sampleText,
            editableMethod
          });

          // Use the first matching selector for each block type
          break;
        }
      }
    }

    return detectedBlocks;
  }

  /**
   * Probe editability of an element without modifying it.
   * Only performs non-destructive checks (focus test, attribute inspection).
   *
   * @param {Element} element
   * @returns {string} One of: "contenteditable", "input", "execCommand", "nativeApi", "readonly"
   */
  _probeEditability(element) {
    if (!element) return 'readonly';

    const tagName = (element.tagName || '').toLowerCase();

    // Input/textarea elements
    if (tagName === 'textarea' || tagName === 'input') {
      return element.readOnly || element.disabled ? 'readonly' : 'input';
    }

    // Contenteditable
    if (element.isContentEditable || element.contentEditable === 'true') {
      return 'contenteditable';
    }

    // Check if any parent is contenteditable
    let parent = element.parentElement;
    while (parent) {
      if (parent.contentEditable === 'true') {
        return 'contenteditable';
      }
      parent = parent.parentElement;
    }

    // Check for known editor wrapper classes
    if (element.closest('.ql-editor')) return 'nativeApi';
    if (element.closest('.ProseMirror')) return 'nativeApi';
    if (element.closest('.ck-editor__editable')) return 'nativeApi';
    if (element.closest('.mce-content-body')) return 'nativeApi';

    return 'readonly';
  }

  /**
   * Detect which actions are viable on this page.
   *
   * @param {object|null} framework - The detected framework.
   * @returns {DetectedAction[]}
   */
  _detectActions(framework) {
    const actions = [];
    const hasEditable = !!document.querySelector('[contenteditable="true"]');
    const hasInputs = !!document.querySelector('textarea, input[type="text"]');
    const isGoogleSites = window.location.hostname === 'sites.google.com';
    const isGoogleDocs = window.location.hostname === 'docs.google.com';

    // replace_text
    actions.push({
      action: 'replace_text',
      viable: hasEditable || hasInputs,
      method: hasEditable ? 'execCommand/textContent' : 'value property',
      notes: hasEditable
        ? 'ContentEditable regions found; execCommand preferred'
        : hasInputs
          ? 'Input/textarea elements found; use .value'
          : 'No editable regions found'
    });

    // append_text
    actions.push({
      action: 'append_text',
      viable: hasEditable || hasInputs,
      method: hasEditable ? 'execCommand/textContent' : 'value property',
      notes: 'Same mechanism as replace_text, appends to existing'
    });

    // insert_block
    actions.push({
      action: 'insert_block',
      viable: hasEditable,
      method: isGoogleSites ? 'DOM insertion after block container'
        : isGoogleDocs ? 'Keyboard simulation (Enter key)'
          : 'DOM appendChild/insertBefore',
      notes: isGoogleDocs
        ? 'Google Docs requires keyboard simulation for block insertion'
        : 'Direct DOM manipulation may work for most editors'
    });

    // delete_block
    actions.push({
      action: 'delete_block',
      viable: hasEditable,
      method: isGoogleDocs ? 'Select + Delete key simulation' : 'DOM removeChild',
      notes: isGoogleDocs
        ? 'Must select block content and simulate delete'
        : 'Remove element from parent'
    });

    // move_block
    actions.push({
      action: 'move_block',
      viable: hasEditable && !isGoogleDocs,
      method: 'DOM reordering',
      notes: isGoogleDocs
        ? 'Block reordering not supported in Google Docs via DOM'
        : 'Remove and re-insert element at new position'
    });

    // set_format
    actions.push({
      action: 'set_format',
      viable: hasEditable,
      method: 'execCommand',
      notes: 'execCommand supports bold/italic/underline and basic formatting'
    });

    // find_and_replace
    actions.push({
      action: 'find_and_replace',
      viable: hasEditable || hasInputs,
      method: isGoogleDocs ? 'Ctrl+H keyboard shortcut' : 'Block iteration with text replacement',
      notes: isGoogleDocs
        ? 'Use native Find & Replace dialog via Ctrl+H'
        : 'Iterate blocks and replace matching text'
    });

    // clear_block
    actions.push({
      action: 'clear_block',
      viable: hasEditable || hasInputs,
      method: hasEditable ? 'Set textContent to empty' : 'Set value to empty',
      notes: 'Clear all content from the target block'
    });

    // duplicate_block
    actions.push({
      action: 'duplicate_block',
      viable: hasEditable && !isGoogleDocs,
      method: 'cloneNode(true) + insertBefore',
      notes: isGoogleDocs
        ? 'Block duplication not reliably supported in Google Docs'
        : 'Clone DOM node and insert after original'
    });

    // set_attribute
    actions.push({
      action: 'set_attribute',
      viable: true,
      method: 'element.setAttribute()',
      notes: 'Standard DOM attribute setting'
    });

    // save
    const saveBtn = this._detectSaveMechanism();
    actions.push({
      action: 'save',
      viable: saveBtn !== null,
      method: saveBtn ? saveBtn.label : 'none found',
      notes: saveBtn
        ? `Save mechanism detected: ${saveBtn.label}`
        : 'No save/publish button detected; editor may auto-save'
    });

    // get_snapshot
    actions.push({
      action: 'get_snapshot',
      viable: true,
      method: 'Extractor.getContent()',
      notes: 'Always available; returns current DOM state as JSON'
    });

    return actions;
  }

  /**
   * Detect the save mechanism by looking for known save/publish buttons.
   *
   * @returns {object|null} The matched save selector descriptor or null.
   */
  _detectSaveMechanism() {
    for (const entry of SAVE_SELECTORS) {
      try {
        const el = document.querySelector(entry.selector);
        if (el) {
          return entry;
        }
      } catch (_) {
        // Invalid selector, skip
      }
    }

    // Also check for buttons containing save/publish text
    try {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        const text = (btn.textContent || '').trim().toLowerCase();
        if (text === 'publish' || text === 'save' || text === 'save changes') {
          return { selector: 'button (text match)', label: `Button with text "${btn.textContent.trim()}"` };
        }
      }
    } catch (_) {
      // Skip
    }

    return null;
  }

  /**
   * Detect potential quirks based on the domain and framework.
   *
   * @param {string} domain
   * @param {object|null} framework
   * @returns {string[]}
   */
  _detectQuirks(domain, framework) {
    const quirks = [];

    if (domain === 'sites.google.com') {
      quirks.push('Heading blocks require clicking once to select, twice to edit text');
      quirks.push('Publishing is required for changes to go live; drafts auto-save');
      quirks.push('Images cannot have their src changed via DOM; use replace block action');
      quirks.push('Block order cannot be changed by DOM manipulation; use drag simulation');
    }

    if (domain === 'docs.google.com') {
      quirks.push('Direct DOM text mutation does not work; use execCommand or keyboard sim');
      quirks.push('Undo history is maintained by Docs -- use sparingly for bulk edits');
      quirks.push('Images and drawings cannot be edited via DOM');
      quirks.push('execCommand("insertText") works when editor iframe is focused');
    }

    // Check if page uses iframes for editing (common quirk)
    const editableIframes = document.querySelectorAll('iframe[contenteditable], iframe.docs-texteventtarget-iframe');
    if (editableIframes.length > 0) {
      quirks.push('Editor uses iframe for text input; must focus iframe contentDocument before editing');
    }

    // Check for shadow DOM usage
    const allElements = document.querySelectorAll('*');
    let hasShadowDom = false;
    for (const el of allElements) {
      if (el.shadowRoot) {
        hasShadowDom = true;
        break;
      }
    }
    if (hasShadowDom) {
      quirks.push('Page uses Shadow DOM; some elements may not be accessible via standard selectors');
    }

    // Check for MutationObserver-heavy pages (heuristic: presence of data-reactroot or similar)
    if (document.querySelector('[data-reactroot]') || document.querySelector('[data-react-root]')) {
      quirks.push('Page uses React; DOM mutations may be overwritten by re-renders');
    }

    if (document.querySelector('[data-v-]')) {
      quirks.push('Page uses Vue.js; DOM mutations may be overwritten by reactivity system');
    }

    return quirks;
  }

  /**
   * Build suggested selectors from the detected blocks.
   *
   * @param {DetectedBlock[]} detectedBlocks
   * @returns {object} Map of block type to selector info.
   */
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

  /**
   * Assess overall confidence of the exploration results.
   *
   * @param {DetectedBlock[]} blocks
   * @param {DetectedAction[]} actions
   * @param {object|null} framework
   * @returns {"high"|"medium"|"low"}
   */
  _assessConfidence(blocks, actions, framework) {
    let score = 0;

    // Framework detected
    if (framework) score += 3;

    // Multiple block types detected
    if (blocks.length >= 3) score += 2;
    else if (blocks.length >= 1) score += 1;

    // Editable actions detected
    const viableActions = actions.filter(a => a.viable);
    if (viableActions.length >= 5) score += 2;
    else if (viableActions.length >= 2) score += 1;

    // Editable regions exist
    if (document.querySelector('[contenteditable="true"]')) score += 1;

    if (score >= 6) return 'high';
    if (score >= 3) return 'medium';
    return 'low';
  }

  /**
   * Build a human-readable DOM summary for the exploration result.
   *
   * @param {DetectedBlock[]} blocks
   * @param {object|null} framework
   * @param {DetectedAction[]} actions
   * @returns {string}
   */
  _buildDomSummary(blocks, framework, actions) {
    const lines = [];

    lines.push(`Domain: ${window.location.hostname}`);
    lines.push(`URL: ${window.location.href}`);
    lines.push(`Title: ${document.title}`);
    lines.push('');

    if (framework) {
      lines.push(`Editor Framework: ${framework.name}`);
      lines.push(`Primary Selector: ${framework.selector}`);
      lines.push(`Edit Method: ${framework.editMethod}`);
    } else {
      lines.push('Editor Framework: None detected (generic)');
    }
    lines.push('');

    lines.push('Detected Block Types:');
    if (blocks.length === 0) {
      lines.push('  (none)');
    } else {
      for (const b of blocks) {
        const sample = b.sampleText ? ` | Sample: "${b.sampleText.substring(0, 50)}"` : '';
        lines.push(`  ${b.type}: ${b.count} found via "${b.selector}" [${b.editableMethod}]${sample}`);
      }
    }
    lines.push('');

    lines.push('Viable Actions:');
    const viableActions = actions.filter(a => a.viable);
    const nonViableActions = actions.filter(a => !a.viable);
    for (const a of viableActions) {
      lines.push(`  [OK] ${a.action}: ${a.method}`);
    }
    for (const a of nonViableActions) {
      lines.push(`  [--] ${a.action}: ${a.notes}`);
    }

    // DOM statistics
    lines.push('');
    lines.push('DOM Statistics:');
    lines.push(`  Total elements: ${document.querySelectorAll('*').length}`);
    lines.push(`  ContentEditable regions: ${document.querySelectorAll('[contenteditable="true"]').length}`);
    lines.push(`  Input/Textarea fields: ${document.querySelectorAll('input, textarea').length}`);
    lines.push(`  Iframes: ${document.querySelectorAll('iframe').length}`);

    return lines.join('\n');
  }
}

export default Explorer;
