/**
 * Executor — Executes commands against the DOM.
 *
 * Receives structured Command objects and delegates the actual DOM mutations
 * to the adapter. Uses the Extractor to resolve block targets and optionally
 * return updated snapshots after edits.
 */

const LOG_PREFIX = '[ClaudeBridge:Executor]';

/**
 * Complete set of supported action types.
 * @type {Set<string>}
 */
const SUPPORTED_ACTIONS = new Set([
  'replace_text',
  'append_text',
  'insert_block',
  'delete_block',
  'move_block',
  'set_format',
  'find_and_replace',
  'clear_block',
  'duplicate_block',
  'set_attribute',
  'save',
  'get_snapshot'
]);

export class Executor {
  /**
   * @param {object} adapter - An adapter instance that implements DOM mutation methods.
   * @param {import('./extractor.js').Extractor} extractor - The Extractor instance for reading DOM state.
   */
  constructor(adapter, extractor) {
    if (!adapter) {
      throw new Error('Executor requires an adapter instance');
    }
    if (!extractor) {
      throw new Error('Executor requires an extractor instance');
    }
    this._adapter = adapter;
    this._extractor = extractor;
  }

  /**
   * Execute a command against the DOM.
   *
   * @param {Command} command - The command to execute.
   * @returns {ExecuteResult} The result of the execution.
   *
   * Command shape:
   *   {
   *     action: string,
   *     target?: BlockTarget,
   *     value?: string,
   *     format?: FormatOptions,
   *     position?: number,
   *     blockType?: string,
   *     findText?: string,
   *     replaceText?: string,
   *     options?: CommandOptions
   *   }
   *
   * BlockTarget shape:
   *   { blockId?, position?, type?, text?, nth? }
   *
   * CommandOptions shape:
   *   { saveAfter?, validateBefore? (default true), dryRun? }
   */
  execute(command) {
    if (!command || !command.action) {
      return this._error('No action specified in command');
    }

    const { action } = command;

    if (!SUPPORTED_ACTIONS.has(action)) {
      return this._error(`Unsupported action: "${action}"`);
    }

    console.log(LOG_PREFIX, 'execute:', action, command);

    const options = command.options || {};
    const validateBefore = options.validateBefore !== false; // default true

    // For actions that don't need a target block
    if (action === 'save') {
      return this._executeSave(command, options);
    }
    if (action === 'get_snapshot') {
      return this._executeGetSnapshot();
    }
    if (action === 'find_and_replace') {
      return this._executeFindAndReplace(command, options);
    }

    // For actions that need a target block, resolve it
    let targetBlock = null;
    let targetElement = null;

    if (action === 'insert_block') {
      // insert_block may not have a target, it uses position
      // but if target is provided, resolve it for context
      if (command.target) {
        targetBlock = this._resolveTarget(command.target);
      }
    } else {
      // All other actions require a target
      if (!command.target) {
        return this._error(`Action "${action}" requires a target`);
      }

      targetBlock = this._resolveTarget(command.target);
      if (!targetBlock) {
        return this._error(`Could not resolve target block`, action);
      }

      // Validate the block still exists in DOM if requested
      if (validateBefore) {
        const freshBlock = this._extractor.getBlock(targetBlock.id);
        if (!freshBlock) {
          return this._error(`Target block "${targetBlock.id}" no longer exists in DOM`, action);
        }
        targetBlock = freshBlock;
      }
    }

    // Dry run: return what would happen without doing it
    if (options.dryRun) {
      return this._result(true, action, targetBlock ? targetBlock.id : null, {
        warning: 'Dry run - no changes applied'
      });
    }

    // Dispatch to action handler
    let result;
    try {
      switch (action) {
        case 'replace_text':
          result = this._executeReplaceText(targetBlock, command, options);
          break;
        case 'append_text':
          result = this._executeAppendText(targetBlock, command, options);
          break;
        case 'insert_block':
          result = this._executeInsertBlock(command, options);
          break;
        case 'delete_block':
          result = this._executeDeleteBlock(targetBlock, command, options);
          break;
        case 'move_block':
          result = this._executeMoveBlock(targetBlock, command, options);
          break;
        case 'set_format':
          result = this._executeSetFormat(targetBlock, command, options);
          break;
        case 'clear_block':
          result = this._executeClearBlock(targetBlock, command, options);
          break;
        case 'duplicate_block':
          result = this._executeDuplicateBlock(targetBlock, command, options);
          break;
        case 'set_attribute':
          result = this._executeSetAttribute(targetBlock, command, options);
          break;
        default:
          result = this._error(`No handler for action: "${action}"`);
      }
    } catch (err) {
      console.error(LOG_PREFIX, `Action "${action}" threw:`, err);
      result = this._error(`Action "${action}" failed: ${err.message}`, action);
    }

    // Optionally trigger save after successful edit
    if (result.success && options.saveAfter) {
      try {
        this._adapterSave();
      } catch (err) {
        result.warning = (result.warning || '') + ` Save after edit failed: ${err.message}`;
      }
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // Action handlers
  // ---------------------------------------------------------------------------

  /**
   * Replace the text content of a target block.
   */
  _executeReplaceText(block, command, options) {
    if (command.value == null) {
      return this._error('replace_text requires a "value" field', 'replace_text');
    }

    if (typeof this._adapter._applyEdit === 'function') {
      const element = this._getBlockElement(block.id);
      if (!element) {
        return this._error(`DOM element not found for block "${block.id}"`, 'replace_text');
      }

      const success = this._adapter._applyEdit(element, command.value);
      if (success) {
        this._dispatchNativeEvents(element);
        return this._result(true, 'replace_text', block.id);
      }
      return this._error(`Adapter _applyEdit returned false for block "${block.id}"`, 'replace_text');
    }

    // Fallback: direct text manipulation
    return this._fallbackReplaceText(block, command.value);
  }

  /**
   * Append text to the end of a target block.
   */
  _executeAppendText(block, command, options) {
    if (command.value == null) {
      return this._error('append_text requires a "value" field', 'append_text');
    }

    const element = this._getBlockElement(block.id);
    if (!element) {
      return this._error(`DOM element not found for block "${block.id}"`, 'append_text');
    }

    if (typeof this._adapter._applyEdit === 'function') {
      const currentText = element.textContent || '';
      const newText = currentText + command.value;
      const success = this._adapter._applyEdit(element, newText);
      if (success) {
        this._dispatchNativeEvents(element);
        return this._result(true, 'append_text', block.id);
      }
    }

    // Fallback
    const currentText = element.textContent || '';
    element.textContent = currentText + command.value;
    this._dispatchNativeEvents(element);
    return this._result(true, 'append_text', block.id);
  }

  /**
   * Insert a new block at a given position.
   */
  _executeInsertBlock(command, options) {
    if (command.blockType == null) {
      return this._error('insert_block requires a "blockType" field', 'insert_block');
    }

    if (typeof this._adapter.insertBlock === 'function') {
      const result = this._adapter.insertBlock(
        command.blockType,
        command.value || '',
        command.position,
        command.target
      );
      if (result && result.success !== false) {
        const affectedId = (result && result.blockId) || null;
        return this._result(true, 'insert_block', affectedId);
      }
      return this._error(
        (result && result.error) || 'Adapter insertBlock failed',
        'insert_block'
      );
    }

    return this._error('Adapter does not support insert_block', 'insert_block');
  }

  /**
   * Delete a target block.
   */
  _executeDeleteBlock(block, command, options) {
    if (typeof this._adapter.deleteBlock === 'function') {
      const element = this._getBlockElement(block.id);
      if (!element) {
        return this._error(`DOM element not found for block "${block.id}"`, 'delete_block');
      }

      const success = this._adapter.deleteBlock(element, block.id);
      if (success !== false) {
        return this._result(true, 'delete_block', block.id);
      }
      return this._error(`Adapter deleteBlock failed for "${block.id}"`, 'delete_block');
    }

    // Fallback: remove from DOM
    const element = this._getBlockElement(block.id);
    if (element && element.parentElement) {
      element.parentElement.removeChild(element);
      return this._result(true, 'delete_block', block.id);
    }

    return this._error(`Cannot delete block "${block.id}": element not found or has no parent`, 'delete_block');
  }

  /**
   * Move a block to a new position.
   */
  _executeMoveBlock(block, command, options) {
    if (command.position == null) {
      return this._error('move_block requires a "position" field', 'move_block');
    }

    if (typeof this._adapter.moveBlock === 'function') {
      const element = this._getBlockElement(block.id);
      if (!element) {
        return this._error(`DOM element not found for block "${block.id}"`, 'move_block');
      }

      const success = this._adapter.moveBlock(element, block.id, command.position);
      if (success !== false) {
        return this._result(true, 'move_block', block.id);
      }
      return this._error(`Adapter moveBlock failed for "${block.id}"`, 'move_block');
    }

    return this._error('Adapter does not support move_block', 'move_block');
  }

  /**
   * Apply formatting to a target block.
   */
  _executeSetFormat(block, command, options) {
    if (!command.format) {
      return this._error('set_format requires a "format" field', 'set_format');
    }

    const element = this._getBlockElement(block.id);
    if (!element) {
      return this._error(`DOM element not found for block "${block.id}"`, 'set_format');
    }

    if (typeof this._adapter.setFormat === 'function') {
      const success = this._adapter.setFormat(element, block.id, command.format);
      if (success !== false) {
        return this._result(true, 'set_format', block.id);
      }
      return this._error(`Adapter setFormat failed for "${block.id}"`, 'set_format');
    }

    // Fallback: use execCommand for basic formatting
    return this._fallbackSetFormat(element, command.format, block.id);
  }

  /**
   * Find text globally and replace it.
   */
  _executeFindAndReplace(command, options) {
    if (!command.findText) {
      return this._error('find_and_replace requires "findText"', 'find_and_replace');
    }
    if (command.replaceText == null) {
      return this._error('find_and_replace requires "replaceText"', 'find_and_replace');
    }

    if (typeof this._adapter.findAndReplace === 'function') {
      const result = this._adapter.findAndReplace(command.findText, command.replaceText);
      if (result && result.success !== false) {
        return this._result(true, 'find_and_replace', (result && result.affectedBlockId) || null, {
          warning: result.warning
        });
      }
      return this._error(
        (result && result.error) || 'Adapter findAndReplace failed',
        'find_and_replace'
      );
    }

    // Fallback: iterate through all blocks and replace text
    return this._fallbackFindAndReplace(command.findText, command.replaceText);
  }

  /**
   * Clear all content from a block.
   */
  _executeClearBlock(block, command, options) {
    const element = this._getBlockElement(block.id);
    if (!element) {
      return this._error(`DOM element not found for block "${block.id}"`, 'clear_block');
    }

    if (typeof this._adapter._applyEdit === 'function') {
      const success = this._adapter._applyEdit(element, '');
      if (success) {
        this._dispatchNativeEvents(element);
        return this._result(true, 'clear_block', block.id);
      }
    }

    // Fallback
    element.textContent = '';
    this._dispatchNativeEvents(element);
    return this._result(true, 'clear_block', block.id);
  }

  /**
   * Duplicate a block, optionally at a specific position.
   */
  _executeDuplicateBlock(block, command, options) {
    if (typeof this._adapter.duplicateBlock === 'function') {
      const element = this._getBlockElement(block.id);
      if (!element) {
        return this._error(`DOM element not found for block "${block.id}"`, 'duplicate_block');
      }

      const result = this._adapter.duplicateBlock(element, block.id, command.position);
      if (result && result.success !== false) {
        return this._result(true, 'duplicate_block', (result && result.blockId) || block.id);
      }
      return this._error(
        (result && result.error) || `Adapter duplicateBlock failed for "${block.id}"`,
        'duplicate_block'
      );
    }

    // Fallback: clone the DOM element
    const element = this._getBlockElement(block.id);
    if (!element || !element.parentElement) {
      return this._error(`Cannot duplicate block "${block.id}": element not found`, 'duplicate_block');
    }

    const clone = element.cloneNode(true);
    // Insert after the original by default, or at the specified position
    if (element.nextSibling) {
      element.parentElement.insertBefore(clone, element.nextSibling);
    } else {
      element.parentElement.appendChild(clone);
    }

    return this._result(true, 'duplicate_block', block.id);
  }

  /**
   * Set an attribute on a target block.
   */
  _executeSetAttribute(block, command, options) {
    if (!command.value && typeof command.value !== 'string') {
      return this._error('set_attribute requires a "value" field', 'set_attribute');
    }

    // The attribute key can be in command.format.key, command.key, or we look in the target
    const attrKey = (command.format && command.format.key) || command.key;
    if (!attrKey) {
      return this._error('set_attribute requires an attribute key (command.key or command.format.key)', 'set_attribute');
    }

    const element = this._getBlockElement(block.id);
    if (!element) {
      return this._error(`DOM element not found for block "${block.id}"`, 'set_attribute');
    }

    if (typeof this._adapter.setAttribute === 'function') {
      const success = this._adapter.setAttribute(element, block.id, attrKey, command.value);
      if (success !== false) {
        return this._result(true, 'set_attribute', block.id);
      }
      return this._error(`Adapter setAttribute failed for "${block.id}"`, 'set_attribute');
    }

    // Fallback
    try {
      element.setAttribute(attrKey, command.value);
      return this._result(true, 'set_attribute', block.id);
    } catch (err) {
      return this._error(`Failed to set attribute "${attrKey}": ${err.message}`, 'set_attribute');
    }
  }

  /**
   * Trigger save/publish.
   */
  _executeSave(command, options) {
    try {
      this._adapterSave();
      return this._result(true, 'save');
    } catch (err) {
      return this._error(`Save failed: ${err.message}`, 'save');
    }
  }

  /**
   * Return the current content snapshot.
   */
  _executeGetSnapshot() {
    try {
      const snapshot = this._extractor.getContent();
      return this._result(true, 'get_snapshot', null, { snapshot });
    } catch (err) {
      return this._error(`get_snapshot failed: ${err.message}`, 'get_snapshot');
    }
  }

  // ---------------------------------------------------------------------------
  // Target resolution
  // ---------------------------------------------------------------------------

  /**
   * Resolve a BlockTarget to a Block object.
   *
   * @param {BlockTarget} target - The target descriptor.
   * @returns {Block|null} The resolved block, or null if not found.
   */
  _resolveTarget(target) {
    if (!target) return null;

    // Direct ID lookup (fastest)
    if (target.blockId) {
      return this._extractor.getBlock(target.blockId);
    }

    // Need the full block list for other resolution methods
    const snapshot = this._extractor.getContent();
    const blocks = snapshot.blocks;

    if (!blocks || blocks.length === 0) {
      return null;
    }

    // By position index
    if (target.position != null) {
      const block = blocks.find(b => b.position === target.position);
      if (block) return block;
      // Fall back to array index
      if (target.position >= 0 && target.position < blocks.length) {
        return blocks[target.position];
      }
      return null;
    }

    // By type (optionally with nth)
    if (target.type) {
      const matches = blocks.filter(b => b.type === target.type);
      const nth = target.nth || 0;
      return matches[nth] || null;
    }

    // By text content (substring match)
    if (target.text) {
      const matches = blocks.filter(b =>
        b.text && b.text.includes(target.text)
      );
      const nth = target.nth || 0;
      return matches[nth] || null;
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // Fallback implementations
  // ---------------------------------------------------------------------------

  /**
   * Fallback text replacement using direct DOM manipulation.
   */
  _fallbackReplaceText(block, newValue) {
    const element = this._getBlockElement(block.id);
    if (!element) {
      return this._error(`DOM element not found for block "${block.id}"`, 'replace_text');
    }

    // Try execCommand first
    try {
      element.focus();
      const selected = document.execCommand('selectAll', false, null);
      if (selected) {
        const inserted = document.execCommand('insertText', false, newValue);
        if (inserted) {
          this._dispatchNativeEvents(element);
          return this._result(true, 'replace_text', block.id);
        }
      }
    } catch (_) {
      // execCommand not supported, fall through
    }

    // Direct mutation
    element.textContent = newValue;
    this._dispatchNativeEvents(element);
    return this._result(true, 'replace_text', block.id, {
      warning: 'Used direct textContent mutation (execCommand failed)'
    });
  }

  /**
   * Fallback formatting using execCommand.
   */
  _fallbackSetFormat(element, format, blockId) {
    try {
      element.focus();

      if (format.bold != null) {
        document.execCommand('bold', false, null);
      }
      if (format.italic != null) {
        document.execCommand('italic', false, null);
      }
      if (format.underline != null) {
        document.execCommand('underline', false, null);
      }
      if (format.textAlign) {
        const alignCmd = {
          left: 'justifyLeft',
          center: 'justifyCenter',
          right: 'justifyRight'
        }[format.textAlign];
        if (alignCmd) {
          document.execCommand(alignCmd, false, null);
        }
      }
      if (format.fontSize) {
        document.execCommand('fontSize', false, String(format.fontSize));
      }
      if (format.color) {
        document.execCommand('foreColor', false, format.color);
      }

      this._dispatchNativeEvents(element);
      return this._result(true, 'set_format', blockId, {
        warning: 'Used execCommand fallback for formatting'
      });
    } catch (err) {
      return this._error(`Fallback set_format failed: ${err.message}`, 'set_format');
    }
  }

  /**
   * Fallback find-and-replace by iterating all blocks.
   */
  _fallbackFindAndReplace(findText, replaceText) {
    const snapshot = this._extractor.getContent();
    let replacedCount = 0;
    let lastAffectedId = null;

    for (const block of snapshot.blocks) {
      if (block.text && block.text.includes(findText)) {
        const element = this._getBlockElement(block.id);
        if (element) {
          const newText = block.text.split(findText).join(replaceText);

          if (typeof this._adapter._applyEdit === 'function') {
            this._adapter._applyEdit(element, newText);
          } else {
            element.textContent = newText;
          }

          this._dispatchNativeEvents(element);
          replacedCount++;
          lastAffectedId = block.id;
        }
      }
    }

    if (replacedCount > 0) {
      return this._result(true, 'find_and_replace', lastAffectedId, {
        warning: `Replaced in ${replacedCount} block(s) using fallback method`
      });
    }

    return this._error(`Text "${findText}" not found in any block`, 'find_and_replace');
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Get the DOM element for a block ID from the extractor's internal map.
   *
   * @param {string} blockId
   * @returns {Element|null}
   */
  _getBlockElement(blockId) {
    // Access the extractor's block map (internal but necessary for execution)
    if (this._extractor._blockMap) {
      return this._extractor._blockMap.get(blockId) || null;
    }
    return null;
  }

  /**
   * Dispatch native events on an element to trigger editor change detection.
   *
   * @param {Element} element
   */
  _dispatchNativeEvents(element) {
    if (typeof this._adapter._dispatchNativeEvents === 'function') {
      this._adapter._dispatchNativeEvents(element);
      return;
    }

    // Fallback: dispatch standard input event
    try {
      element.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText'
      }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (_) {
      // Event dispatch failed silently
    }
  }

  /**
   * Trigger save via the adapter.
   */
  _adapterSave() {
    if (typeof this._adapter.save === 'function') {
      this._adapter.save();
      return;
    }

    // Fallback: try common save button selectors
    const saveSelectors = [
      'button[aria-label*="Publish"]',
      'button[aria-label*="Save"]',
      'button:has-text("Publish")',
      'button:has-text("Save")',
      '[data-action="save"]',
      '.save-button'
    ];

    for (const selector of saveSelectors) {
      try {
        const btn = document.querySelector(selector);
        if (btn) {
          btn.click();
          console.log(LOG_PREFIX, 'Save triggered via:', selector);
          return;
        }
      } catch (_) {
        // Selector may be invalid (e.g. :has-text), continue
      }
    }

    console.warn(LOG_PREFIX, 'No save mechanism found');
  }

  /**
   * Build a success result object.
   *
   * @param {boolean} success
   * @param {string} action
   * @param {string|null} [affectedBlockId]
   * @param {object} [extras] - Additional fields like warning, snapshot.
   * @returns {ExecuteResult}
   */
  _result(success, action, affectedBlockId = null, extras = {}) {
    /** @type {ExecuteResult} */
    const result = {
      success,
      action
    };

    if (affectedBlockId != null) {
      result.affectedBlockId = affectedBlockId;
    }
    if (extras.warning) {
      result.warning = extras.warning;
    }
    if (extras.snapshot) {
      result.snapshot = extras.snapshot;
    }
    if (extras.error) {
      result.error = extras.error;
    }

    return result;
  }

  /**
   * Build an error result object.
   *
   * @param {string} message - The error message.
   * @param {string} [action] - The action that failed.
   * @returns {ExecuteResult}
   */
  _error(message, action = 'unknown') {
    console.error(LOG_PREFIX, `Error [${action}]:`, message);
    return {
      success: false,
      action,
      error: message
    };
  }
}

export default Executor;
