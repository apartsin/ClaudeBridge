/**
 * Google Sites adapter for Claude Bridge.
 *
 * Translates the Google Sites editor DOM into the uniform Block model
 * and performs edits through execCommand + InputEvent fallback.
 */

import { AdapterBase, sanitize } from './adapter-base.js';

// ---------------------------------------------------------------------------
// Default selectors (can be overridden via profile.selectors)
// ---------------------------------------------------------------------------

const DEFAULT_SELECTORS = {
  pageContainer:  'div[data-page-id], div.sites-canvas-main',
  toolbar:        '[data-view-id]',
  publishButton:  'button[aria-label*="Publish"]',

  // Block selectors keyed by block type
  blocks: {
    heading:  '[data-block-type="heading"], .sites-block h1, .sites-block h2, .sites-block h3',
    text:     '[data-block-type="text"], .sites-block div[contenteditable="true"]',
    image:    '[data-block-type="image"], .sites-block img',
    button:   '[data-block-type="button"], .sites-block button, .sites-block a[role="button"]',
    divider:  '[data-block-type="divider"], .sites-block hr',
    embed:    '[data-block-type="embed"], .sites-block iframe',
    list:     '[data-block-type="list"], .sites-block ul, .sites-block ol',
    columns:  '[data-block-type="columns"], .sites-block [data-column-layout]',
  },
};

const DEFAULT_QUIRKS = [
  'Heading blocks require clicking once to select, twice to edit text',
  'Publishing is required for changes to go live; drafts auto-save',
  'Images cannot have their src changed via DOM; use replace block action',
  'Block order cannot be changed by DOM manipulation; use drag simulation',
];

// ---------------------------------------------------------------------------
// Type prefix map for block IDs
// ---------------------------------------------------------------------------

const TYPE_PREFIX = {
  heading:  'gs-heading',
  text:     'gs-paragraph',
  image:    'gs-image',
  button:   'gs-button',
  divider:  'gs-divider',
  embed:    'gs-embed',
  list:     'gs-list',
  columns:  'gs-columns',
  unknown:  'gs-block',
};

// ---------------------------------------------------------------------------
// GoogleSitesAdapter
// ---------------------------------------------------------------------------

export class GoogleSitesAdapter extends AdapterBase {
  /**
   * @param {Object} profile - Merged effective profile
   */
  constructor(profile) {
    const merged = Object.assign({}, profile);
    merged.quirks    = merged.quirks    || DEFAULT_QUIRKS;
    merged.selectors = Object.assign({}, DEFAULT_SELECTORS, merged.selectors || {});

    super(merged);

    /** @type {Object} Resolved selectors */
    this.sel = this.profile.selectors;
  }

  // -----------------------------------------------------------------------
  // Overrides
  // -----------------------------------------------------------------------

  /** @override */
  _isEditMode() {
    // URL contains /edit
    if (window.location.pathname.includes('/edit')) return true;

    // Toolbar with data-view-id
    if (document.querySelector(this.sel.toolbar)) return true;

    // Publish button visible
    if (document.querySelector(this.sel.publishButton)) return true;

    return false;
  }

  /** @override */
  _getPageTitle() {
    // Try common Google Sites title locations
    const titleEl =
      document.querySelector('[data-site-title]') ||
      document.querySelector('header h1') ||
      document.querySelector('.sites-header-title');

    if (titleEl) return titleEl.textContent.trim();

    return document.title || '';
  }

  /** @override */
  _getEditableRegions() {
    const elements  = [];
    const seen      = new Set();
    const blockSels = this.sel.blocks;

    // Iterate block types in a stable order
    const typeOrder = ['heading', 'text', 'image', 'button', 'divider', 'embed', 'list', 'columns'];

    for (const type of typeOrder) {
      const selector = blockSels[type];
      if (!selector) continue;

      const nodes = document.querySelectorAll(selector);
      nodes.forEach(node => {
        if (!seen.has(node)) {
          seen.add(node);
          // Tag the node so _blockToJson can read its type
          node.__cbType = type;
          elements.push(node);
        }
      });
    }

    // Sort elements by document order
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
    const type = element.__cbType || this._inferType(element);
    const prefix = TYPE_PREFIX[type] || TYPE_PREFIX.unknown;
    const id = `${prefix}-${index}`;

    const block = {
      id,
      type,
      content: this._extractContent(element, type),
      index,
    };

    // Attach extra attributes depending on type
    const attrs = {};

    if (type === 'heading') {
      attrs.level = this._headingLevel(element);
    }
    if (type === 'image') {
      const img = element.tagName === 'IMG' ? element : element.querySelector('img');
      if (img) {
        attrs.src = img.getAttribute('src') || '';
        attrs.alt = img.getAttribute('alt') || '';
      }
    }
    if (type === 'embed') {
      const iframe = element.tagName === 'IFRAME' ? element : element.querySelector('iframe');
      if (iframe) {
        attrs.src = iframe.getAttribute('src') || '';
      }
    }
    if (type === 'button') {
      attrs.label = element.textContent.trim();
      const link = element.closest('a') || element.querySelector('a');
      if (link) attrs.href = link.getAttribute('href') || '';
    }

    if (Object.keys(attrs).length) block.attrs = attrs;

    return block;
  }

  /** @override */
  _applyEdit(element, value) {
    // Primary: focus + execCommand
    try {
      element.focus();

      // Select all existing content
      document.execCommand('selectAll', false, null);

      // Replace with new text — execCommand('insertText') works in
      // contenteditable regions and integrates with undo history.
      const success = document.execCommand('insertText', false, value);
      if (success) return true;
    } catch (_) {
      // fall through to fallback
    }

    // Fallback: direct mutation + synthetic InputEvent
    try {
      element.textContent = value;
      element.dispatchEvent(new InputEvent('input', {
        bubbles:    true,
        cancelable: true,
        inputType:  'insertText',
        data:       value,
      }));
      return true;
    } catch (_) {
      return false;
    }
  }

  /** @override */
  _dispatchNativeEvents(element) {
    const eventInit = { bubbles: true, cancelable: true };

    element.dispatchEvent(new Event('input',  eventInit));
    element.dispatchEvent(new Event('change', eventInit));

    // Google Sites may also listen for blur to persist changes
    element.dispatchEvent(new Event('blur', eventInit));
  }

  /** @override */
  async _waitForEditorReady() {
    // Wait for the page container to appear in the DOM
    const containerSel = this.sel.pageContainer;

    const existing = document.querySelector(containerSel);
    if (existing) return;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        observer.disconnect();
        reject(new Error('Timed out waiting for Google Sites editor to load'));
      }, 15000);

      const observer = new MutationObserver(() => {
        if (document.querySelector(containerSel)) {
          observer.disconnect();
          clearTimeout(timeout);
          resolve();
        }
      });

      observer.observe(document.body, { childList: true, subtree: true });
    });
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  /**
   * Infer block type from a DOM element when __cbType is not set.
   * @param {Element} element
   * @returns {string}
   */
  _inferType(element) {
    const tag = element.tagName.toLowerCase();

    if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tag)) return 'heading';
    if (tag === 'img')    return 'image';
    if (tag === 'hr')     return 'divider';
    if (tag === 'iframe') return 'embed';
    if (tag === 'ul' || tag === 'ol') return 'list';
    if (tag === 'button') return 'button';
    if (element.querySelector('img'))    return 'image';
    if (element.querySelector('iframe')) return 'embed';

    return 'text';
  }

  /**
   * Extract display content from a block element.
   * @param {Element} element
   * @param {string}  type
   * @returns {string}
   */
  _extractContent(element, type) {
    switch (type) {
      case 'image': {
        const img = element.tagName === 'IMG' ? element : element.querySelector('img');
        return img ? (img.getAttribute('alt') || '') : '';
      }
      case 'divider':
        return '---';
      case 'embed': {
        const iframe = element.tagName === 'IFRAME' ? element : element.querySelector('iframe');
        return iframe ? (iframe.getAttribute('src') || '') : '';
      }
      default:
        return element.innerHTML || element.textContent || '';
    }
  }

  /**
   * Determine the heading level (1-6).
   * @param {Element} element
   * @returns {number}
   */
  _headingLevel(element) {
    const tag = element.tagName.toLowerCase();
    const match = tag.match(/^h(\d)$/);
    if (match) return parseInt(match[1], 10);

    // Look for a heading child
    for (let lvl = 1; lvl <= 6; lvl++) {
      if (element.querySelector(`h${lvl}`)) return lvl;
    }

    // data-block-type may carry a level attribute
    const levelAttr = element.getAttribute('data-heading-level');
    if (levelAttr) return parseInt(levelAttr, 10) || 2;

    return 2; // default
  }
}
