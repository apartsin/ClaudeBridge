/**
 * Generic adapter for Claude Bridge.
 *
 * Fallback adapter for any page that contains contenteditable regions,
 * textareas, or input fields.  Auto-detects known rich-text editor
 * frameworks (Quill, ProseMirror, CKEditor, TinyMCE) and routes edits
 * through their APIs when available.
 */

import { AdapterBase, sanitize } from './adapter-base.js';

// ---------------------------------------------------------------------------
// Framework detection descriptors
// ---------------------------------------------------------------------------

const FRAMEWORKS = [
  {
    name:     'Quill',
    detect:   () => !!(window.Quill || document.querySelector('.ql-editor')),
    selector: '.ql-editor',
    api:      'quill',
  },
  {
    name:     'ProseMirror',
    detect:   () => !!document.querySelector('.ProseMirror'),
    selector: '.ProseMirror',
    api:      'prosemirror',
  },
  {
    name:     'CKEditor',
    detect:   () => !!window.CKEDITOR,
    selector: '.cke_editable, .ck-editor__editable',
    api:      'ckeditor',
  },
  {
    name:     'TinyMCE',
    detect:   () => !!window.tinymce,
    selector: '.mce-content-body, #tinymce',
    api:      'tinymce',
  },
];

// ---------------------------------------------------------------------------
// Default quirks
// ---------------------------------------------------------------------------

const DEFAULT_QUIRKS = [
  'Generic adapter — behaviour depends on the detected editor framework',
  'If no framework is detected, raw contenteditable or textarea editing is used',
  'Framework API edits integrate with undo history; direct DOM edits may not',
];

// ---------------------------------------------------------------------------
// Type prefix
// ---------------------------------------------------------------------------

const TYPE_PREFIX = {
  heading:       'gen-heading',
  paragraph:     'gen-paragraph',
  text:          'gen-text',
  textarea:      'gen-textarea',
  input:         'gen-input',
  list:          'gen-list',
  image:         'gen-image',
  code:          'gen-code',
  blockquote:    'gen-blockquote',
  unknown:       'gen-block',
};

// ---------------------------------------------------------------------------
// GenericAdapter
// ---------------------------------------------------------------------------

export class GenericAdapter extends AdapterBase {
  /**
   * @param {Object} profile
   */
  constructor(profile) {
    const merged = Object.assign({}, profile);
    merged.quirks = merged.quirks || DEFAULT_QUIRKS;

    super(merged);

    /** @type {{name: string, selector: string, api: string}|null} */
    this.detectedFramework = null;

    this._detectFramework();
  }

  // -----------------------------------------------------------------------
  // Framework detection
  // -----------------------------------------------------------------------

  /** @private */
  _detectFramework() {
    for (const fw of FRAMEWORKS) {
      if (fw.detect()) {
        this.detectedFramework = fw;
        return;
      }
    }
    this.detectedFramework = null;
  }

  // -----------------------------------------------------------------------
  // Overrides
  // -----------------------------------------------------------------------

  /** @override */
  _isEditMode() {
    // Any editable region present means the page has something we can work with
    return this._getEditableRegions().length > 0;
  }

  /** @override */
  _getPageTitle() {
    // Look for common heading elements
    const h1 = document.querySelector('h1');
    if (h1) return h1.textContent.trim();

    return document.title || '';
  }

  /** @override */
  _getEditableRegions() {
    const elements = [];
    const seen     = new Set();

    const addUnique = (el, type) => {
      if (!seen.has(el)) {
        seen.add(el);
        el.__cbType = type;
        elements.push(el);
      }
    };

    // If a known framework is detected, prefer its root element and children
    if (this.detectedFramework) {
      const roots = document.querySelectorAll(this.detectedFramework.selector);
      roots.forEach(root => {
        // Extract semantic children from the framework root
        this._extractBlocksFromContainer(root, addUnique);
      });
    }

    // Contenteditable regions (may overlap with framework)
    document.querySelectorAll('[contenteditable="true"]').forEach(el => {
      // If this is a framework root we already processed, extract children
      if (seen.has(el)) return;

      // Check if it is a single-block editable or a multi-block container
      const children = el.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, pre, blockquote, div');
      if (children.length > 1) {
        this._extractBlocksFromContainer(el, addUnique);
      } else {
        addUnique(el, 'text');
      }
    });

    // Textareas
    document.querySelectorAll('textarea').forEach(el => {
      addUnique(el, 'textarea');
    });

    // Text inputs (excluding hidden, password, email, etc. — we want plain text)
    document.querySelectorAll('input[type="text"], input:not([type])').forEach(el => {
      // Skip hidden inputs or inputs inside invisible containers
      if (el.offsetParent === null) return;
      addUnique(el, 'input');
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
    const rawType = element.__cbType || 'text';
    const prefix  = TYPE_PREFIX[rawType] || TYPE_PREFIX.unknown;
    const id      = `${prefix}-${index}`;

    // Normalize type to match the standard BlockType enum used by Extractor
    let type = rawType;
    if (rawType === 'heading') {
      const level = this._headingLevel(element);
      type = level <= 3 ? `heading${level}` : 'heading3';
    } else if (rawType === 'text' || rawType === 'textarea' || rawType === 'input') {
      type = 'paragraph';
    } else if (rawType === 'code') {
      type = 'paragraph';
    } else if (rawType === 'blockquote') {
      type = 'paragraph';
    }

    // Extract text and html separately (Extractor expects both)
    const contentValue = this._extractContent(element, rawType);
    const text = (rawType === 'textarea' || rawType === 'input')
      ? (element.value || '')
      : (element.textContent || '');
    const html = (rawType === 'textarea' || rawType === 'input')
      ? (element.value || '')
      : (element.innerHTML || '');

    const block = {
      id,
      type,
      text,
      html,
      content: contentValue,
      index,
    };

    const attrs = {};

    if (rawType === 'heading') {
      attrs.level = this._headingLevel(element);
    }
    if (rawType === 'image') {
      const img = element.tagName === 'IMG' ? element : element.querySelector('img');
      if (img) {
        attrs.src = img.getAttribute('src') || '';
        attrs.alt = img.getAttribute('alt') || '';
      }
    }
    if (rawType === 'textarea' || rawType === 'input') {
      attrs.name        = element.getAttribute('name') || '';
      attrs.placeholder = element.getAttribute('placeholder') || '';
    }
    if (this.detectedFramework) {
      attrs.framework = this.detectedFramework.name;
    }

    if (Object.keys(attrs).length) block.attrs = attrs;

    return block;
  }

  /** @override */
  _applyEdit(element, value) {
    const type = element.__cbType;

    // --- Textarea / Input ---
    if (type === 'textarea' || type === 'input') {
      return this._applyToFormField(element, value);
    }

    // --- Framework-specific API ---
    if (this.detectedFramework) {
      const apiResult = this._applyViaFrameworkApi(element, value);
      if (apiResult) return true;
    }

    // --- Contenteditable: execCommand ---
    try {
      element.focus();
      document.execCommand('selectAll', false, null);
      const success = document.execCommand('insertText', false, value);
      if (success) return true;
    } catch (_) {
      // fall through
    }

    // --- Contenteditable: direct mutation ---
    try {
      if (element.getAttribute('contenteditable') === 'true') {
        element.innerHTML = value;
        element.dispatchEvent(new InputEvent('input', {
          bubbles:   true,
          inputType: 'insertText',
          data:      value,
        }));
        return true;
      }
    } catch (_) {
      // fall through
    }

    // --- Fallback: textContent ---
    try {
      element.textContent = value;
      return true;
    } catch (_) {
      return false;
    }
  }

  /** @override */
  _dispatchNativeEvents(element) {
    const opts = { bubbles: true, cancelable: true };

    element.dispatchEvent(new Event('input',  opts));
    element.dispatchEvent(new Event('change', opts));
    element.dispatchEvent(new Event('blur',   opts));
  }

  /** @override */
  async _waitForEditorReady() {
    // For generic pages we simply wait for DOMContentLoaded + a short delay
    if (document.readyState === 'loading') {
      await new Promise(resolve => {
        document.addEventListener('DOMContentLoaded', resolve, { once: true });
      });
    }

    // Extra settle time for SPAs that hydrate after load
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  /** @override */
  explore() {
    // Re-detect framework in case it loaded after construction
    this._detectFramework();

    const base = super.explore();

    if (this.detectedFramework) {
      base.detectedFrameworks = [this.detectedFramework.name];
    }

    return base;
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  /**
   * Walk a container element and invoke addFn for each semantic child block.
   * @param {Element}  container
   * @param {Function} addFn - (element, type) => void
   */
  _extractBlocksFromContainer(container, addFn) {
    const childBlocks = container.querySelectorAll(
      'p, h1, h2, h3, h4, h5, h6, li, pre, blockquote, img, hr, table'
    );

    if (childBlocks.length === 0) {
      // Treat the container itself as a single text block
      addFn(container, 'text');
      return;
    }

    childBlocks.forEach(child => {
      const tag = child.tagName.toLowerCase();
      let type;

      if (/^h[1-6]$/.test(tag))        type = 'heading';
      else if (tag === 'p')             type = 'paragraph';
      else if (tag === 'li')            type = 'list';
      else if (tag === 'pre')           type = 'code';
      else if (tag === 'blockquote')    type = 'blockquote';
      else if (tag === 'img')           type = 'image';
      else if (tag === 'table')         type = 'text'; // simplified
      else                              type = 'text';

      addFn(child, type);
    });
  }

  /**
   * Extract displayable content from a block element.
   * @param {Element} element
   * @param {string}  type
   * @returns {string}
   */
  _extractContent(element, type) {
    switch (type) {
      case 'textarea':
      case 'input':
        return element.value || '';
      case 'image': {
        const img = element.tagName === 'IMG' ? element : element.querySelector('img');
        return img ? (img.getAttribute('alt') || '[image]') : '[image]';
      }
      default:
        return element.innerHTML || element.textContent || '';
    }
  }

  /**
   * Determine heading level from tag name.
   * @param {Element} element
   * @returns {number}
   */
  _headingLevel(element) {
    const match = element.tagName.toLowerCase().match(/^h(\d)$/);
    return match ? parseInt(match[1], 10) : 1;
  }

  /**
   * Set value on a textarea or input field and fire synthetic events.
   * Uses the native value setter so framework bindings (React, Vue) detect
   * the change.
   *
   * @param {HTMLInputElement|HTMLTextAreaElement} element
   * @param {string} value
   * @returns {boolean}
   */
  _applyToFormField(element, value) {
    try {
      // Use native setter to bypass React/Vue proxied setters
      const proto = element.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;

      const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
      if (descriptor && descriptor.set) {
        descriptor.set.call(element, value);
      } else {
        element.value = value;
      }

      // Dispatch events that frameworks listen for
      element.dispatchEvent(new Event('input',  { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    } catch (_) {
      element.value = value;
      return true;
    }
  }

  /**
   * Attempt to apply an edit through the detected framework's API.
   *
   * @param {Element} element
   * @param {string}  value
   * @returns {boolean} true if the framework API handled the edit
   */
  _applyViaFrameworkApi(element, value) {
    if (!this.detectedFramework) return false;

    switch (this.detectedFramework.api) {
      case 'quill':
        return this._applyQuill(element, value);
      case 'prosemirror':
        return this._applyProseMirror(element, value);
      case 'ckeditor':
        return this._applyCKEditor(element, value);
      case 'tinymce':
        return this._applyTinyMCE(element, value);
      default:
        return false;
    }
  }

  /**
   * Edit via Quill API.
   * @param {Element} element
   * @param {string}  value
   * @returns {boolean}
   */
  _applyQuill(element, value) {
    try {
      // Find the Quill instance.  Quill stores a reference on the container.
      const container = element.closest('.ql-container') || element.parentElement;
      const quill     = container && container.__quill;

      if (quill && typeof quill.setText === 'function') {
        quill.setText(''); // clear
        quill.clipboard.dangerouslyPasteHTML(0, value);
        return true;
      }

      // Fallback: try global Quill.find
      if (window.Quill && typeof window.Quill.find === 'function') {
        const instance = window.Quill.find(element);
        if (instance) {
          instance.setText('');
          instance.clipboard.dangerouslyPasteHTML(0, value);
          return true;
        }
      }
    } catch (_) { /* fall through */ }
    return false;
  }

  /**
   * Edit via ProseMirror API.
   * @param {Element} element
   * @param {string}  value
   * @returns {boolean}
   */
  _applyProseMirror(element, value) {
    try {
      // ProseMirror stores its view on the DOM node
      const view = element.pmViewDesc && element.pmViewDesc.view;
      if (!view) return false;

      const { state } = view;
      const tr = state.tr;

      // Replace the entire document content with a paragraph containing the new text
      tr.replaceWith(0, state.doc.content.size, state.schema.text(value));
      view.dispatch(tr);
      return true;
    } catch (_) { /* fall through */ }
    return false;
  }

  /**
   * Edit via CKEditor API.
   * @param {Element} element
   * @param {string}  value
   * @returns {boolean}
   */
  _applyCKEditor(element, value) {
    try {
      // CKEditor 4
      if (window.CKEDITOR && window.CKEDITOR.instances) {
        const instances = Object.values(window.CKEDITOR.instances);
        for (const editor of instances) {
          if (editor.editable && editor.editable().$ === element) {
            editor.setData(value);
            return true;
          }
        }
        // If only one instance, use it
        if (instances.length === 1) {
          instances[0].setData(value);
          return true;
        }
      }

      // CKEditor 5 — look for the editor on the source element
      const ck5Element = element.closest('.ck-editor__editable');
      if (ck5Element && ck5Element.ckeditorInstance) {
        ck5Element.ckeditorInstance.setData(value);
        return true;
      }
    } catch (_) { /* fall through */ }
    return false;
  }

  /**
   * Edit via TinyMCE API.
   * @param {Element} element
   * @param {string}  value
   * @returns {boolean}
   */
  _applyTinyMCE(element, value) {
    try {
      if (!window.tinymce) return false;

      // Find the editor instance that matches this element
      const editors = window.tinymce.editors || [];
      for (const editor of editors) {
        const body = editor.getBody && editor.getBody();
        if (body === element || (editor.getContainer && editor.getContainer().contains(element))) {
          editor.setContent(value);
          return true;
        }
      }

      // Fallback: use the active editor
      const active = window.tinymce.activeEditor;
      if (active) {
        active.setContent(value);
        return true;
      }
    } catch (_) { /* fall through */ }
    return false;
  }
}
