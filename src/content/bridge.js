/**
 * bridge.js — Main entry point content script for Claude Bridge.
 *
 * Initialization sequence:
 *  1. Detect app from window.location.hostname
 *  2. Load profile from storage via StorageClient
 *  3. Instantiate adapter with effective profile
 *  4. Create Extractor, Executor, Explorer
 *  5. Inject window.__claudeBridge with all API methods
 *  6. Set body attributes
 *  7. Inject status panel
 *  8. Log ready message
 */

import StorageClient from './storage-client.js';
import { Extractor } from './extractor.js';
import { Executor } from './executor.js';
import { Explorer } from './explorer.js';

// Adapter imports — these will be loaded based on detected app
import { GoogleSitesAdapter } from './adapters/google-sites.js';
import { GoogleDocsAdapter } from './adapters/google-docs.js';
import { GenericAdapter } from './adapters/generic.js';

const LOG_PREFIX = '[ClaudeBridge]';
const VERSION = '1.0.0';

/**
 * Map of hostname patterns to adapter classes.
 */
const ADAPTER_MAP = {
  'sites.google.com': {
    AdapterClass: GoogleSitesAdapter,
    appName: 'Google Sites'
  },
  'docs.google.com': {
    AdapterClass: GoogleDocsAdapter,
    appName: 'Google Docs'
  }
};

/**
 * Deep merge two objects. Arrays are replaced (not concatenated).
 * Null/undefined source values are skipped.
 *
 * @param {object} target
 * @param {object} source
 * @returns {object} The merged result (target is mutated).
 */
function deepMerge(target, source) {
  if (!source || typeof source !== 'object') return target;
  if (!target || typeof target !== 'object') return source;

  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const tgtVal = target[key];

    if (srcVal === null || srcVal === undefined) {
      continue;
    }

    if (Array.isArray(srcVal)) {
      // Arrays: source replaces target
      target[key] = srcVal;
    } else if (typeof srcVal === 'object' && typeof tgtVal === 'object' && !Array.isArray(tgtVal)) {
      // Objects: recursive merge
      target[key] = deepMerge(tgtVal, srcVal);
    } else {
      // Primitives: source wins
      target[key] = srcVal;
    }
  }

  return target;
}

/**
 * Normalize a URL to a stable instance ID.
 * Strips /edit, /view, /u/N/, query params, and trailing slashes.
 * Converts path separators to double underscores.
 *
 * @param {string} url
 * @returns {string}
 */
function normalizeInstanceId(url) {
  try {
    const parsed = new URL(url);
    let path = parsed.pathname;

    // Strip /u/0/, /u/1/, etc. (Google user selector)
    path = path.replace(/\/u\/\d+\/?/g, '/');

    // Strip /edit, /view suffixes
    path = path.replace(/\/(edit|view)\/?$/i, '');

    // Strip trailing slash
    path = path.replace(/\/+$/, '');

    // Strip leading slash
    path = path.replace(/^\/+/, '');

    // Convert slashes to double underscores
    const normalized = parsed.hostname + (path ? '__' + path.replace(/\//g, '__') : '');

    return normalized;
  } catch (_) {
    // If URL parsing fails, do a basic normalization
    return url
      .replace(/https?:\/\//, '')
      .replace(/[?#].*$/, '')
      .replace(/\/(edit|view)\/?$/i, '')
      .replace(/\/u\/\d+\/?/g, '/')
      .replace(/\/+$/, '')
      .replace(/^\/+/, '')
      .replace(/\//g, '__');
  }
}

/**
 * Merge an app profile and an instance profile into an effective profile.
 * Instance values override app values where they exist.
 *
 * @param {object|null} appProfile
 * @param {object|null} instanceProfile
 * @returns {object} The merged effective profile.
 */
function mergeProfiles(appProfile, instanceProfile) {
  const base = appProfile ? JSON.parse(JSON.stringify(appProfile)) : {};

  if (!instanceProfile) return base;

  // Merge instance overrides into the app profile
  if (instanceProfile.selectorOverrides) {
    base.selectors = deepMerge(base.selectors || {}, instanceProfile.selectorOverrides);
  }
  if (instanceProfile.actionOverrides) {
    base.actions = deepMerge(base.actions || {}, instanceProfile.actionOverrides);
  }
  if (instanceProfile.editMethodOverride) {
    base.editMethod = deepMerge(base.editMethod || {}, instanceProfile.editMethodOverride);
  }

  // Merge instance quirks (append, do not replace)
  if (instanceProfile.quirks && Array.isArray(instanceProfile.quirks)) {
    base.quirks = (base.quirks || []).concat(instanceProfile.quirks);
  }

  // Attach instance metadata
  base._instance = {
    instanceId: instanceProfile.instanceId,
    url: instanceProfile.url,
    title: instanceProfile.title,
    pages: instanceProfile.pages || {},
    structure: instanceProfile.structure || {},
    meta: instanceProfile.meta || {}
  };

  return base;
}

/**
 * Create and inject the status panel into the page DOM.
 *
 * @param {object} config - Panel configuration.
 * @param {string} config.app - The app name.
 * @param {boolean} config.profileLoaded - Whether a profile was loaded.
 * @param {number} config.blockCount - Number of detected blocks.
 * @param {string} config.instanceId - The instance ID.
 */
function injectStatusPanel(config) {
  // Remove any existing panel
  const existing = document.getElementById('claude-bridge-panel');
  if (existing) {
    existing.remove();
  }

  const panel = document.createElement('div');
  panel.id = 'claude-bridge-panel';

  // Panel styles
  Object.assign(panel.style, {
    position: 'fixed',
    bottom: '16px',
    right: '16px',
    zIndex: '999999',
    backgroundColor: 'rgba(24, 24, 27, 0.92)',
    color: '#e4e4e7',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    fontSize: '12px',
    lineHeight: '1.5',
    borderRadius: '8px',
    padding: '12px 16px',
    minWidth: '200px',
    maxWidth: '280px',
    boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)',
    border: '1px solid rgba(255, 255, 255, 0.1)',
    cursor: 'default',
    userSelect: 'none',
    transition: 'opacity 0.2s ease'
  });

  const profileStatus = config.profileLoaded ? 'loaded' : 'first visit';
  const profileIcon = config.profileLoaded ? '\u2713' : '\u26A0';
  const appStatus = config.profileLoaded ? '\u2713' : '\u26A0 Exploring...';

  panel.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
      <span style="font-weight: 600; font-size: 13px;">\uD83D\uDD0C Claude Bridge v${VERSION}</span>
      <button id="claude-bridge-minimize"
        style="background: none; border: none; color: #a1a1aa; cursor: pointer; font-size: 14px; padding: 0 2px; line-height: 1;"
        title="Minimize">\u2212</button>
    </div>
    <div id="claude-bridge-panel-body">
      <div style="margin-bottom: 4px;">App: ${config.app} ${appStatus}</div>
      <div style="margin-bottom: 4px;">Blocks: ${config.blockCount} detected</div>
      <div>Profile: ${profileStatus}</div>
    </div>
  `;

  document.body.appendChild(panel);

  // Minimize/restore functionality
  let minimized = false;
  const minimizeBtn = document.getElementById('claude-bridge-minimize');
  const panelBody = document.getElementById('claude-bridge-panel-body');

  if (minimizeBtn && panelBody) {
    minimizeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      minimized = !minimized;

      if (minimized) {
        panelBody.style.display = 'none';
        panel.style.minWidth = 'auto';
        minimizeBtn.textContent = '+';
        minimizeBtn.title = 'Expand';
      } else {
        panelBody.style.display = 'block';
        panel.style.minWidth = '200px';
        minimizeBtn.textContent = '\u2212';
        minimizeBtn.title = 'Minimize';
      }

      // Persist minimized state
      try {
        chrome.runtime.sendMessage({
          type: 'STORAGE_SET',
          key: 'panelState',
          value: { minimized, position: { bottom: panel.style.bottom, right: panel.style.right } }
        });
      } catch (_) {
        // Storage unavailable, ignore
      }
    });
  }

  // Make panel draggable
  makeDraggable(panel);

  // Restore panel state from storage
  restorePanelState(panel, panelBody, minimizeBtn);
}

/**
 * Make an element draggable by mouse.
 *
 * @param {HTMLElement} element
 */
function makeDraggable(element) {
  let isDragging = false;
  let startX, startY;
  let origRight, origBottom;

  element.addEventListener('mousedown', (e) => {
    // Don't start drag on the minimize button
    if (e.target.id === 'claude-bridge-minimize') return;

    isDragging = true;
    startX = e.clientX;
    startY = e.clientY;

    const rect = element.getBoundingClientRect();
    origRight = window.innerWidth - rect.right;
    origBottom = window.innerHeight - rect.bottom;

    element.style.opacity = '0.8';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;

    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    const newRight = Math.max(0, origRight - dx);
    const newBottom = Math.max(0, origBottom - dy);

    element.style.right = newRight + 'px';
    element.style.bottom = newBottom + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (!isDragging) return;
    isDragging = false;
    element.style.opacity = '1';

    // Persist position
    try {
      chrome.runtime.sendMessage({
        type: 'STORAGE_SET',
        key: 'panelState',
        value: {
          position: { bottom: element.style.bottom, right: element.style.right }
        }
      });
    } catch (_) {
      // Ignore
    }
  });
}

/**
 * Restore panel state (minimized, position) from storage.
 *
 * @param {HTMLElement} panel
 * @param {HTMLElement} panelBody
 * @param {HTMLElement} minimizeBtn
 */
function restorePanelState(panel, panelBody, minimizeBtn) {
  try {
    chrome.runtime.sendMessage({ type: 'STORAGE_GET', key: 'panelState' }, (response) => {
      if (chrome.runtime.lastError || !response || !response.data) return;

      const state = response.data;

      if (state.minimized && panelBody && minimizeBtn) {
        panelBody.style.display = 'none';
        panel.style.minWidth = 'auto';
        minimizeBtn.textContent = '+';
        minimizeBtn.title = 'Expand';
      }

      if (state.position) {
        if (state.position.bottom) panel.style.bottom = state.position.bottom;
        if (state.position.right) panel.style.right = state.position.right;
      }
    });
  } catch (_) {
    // Storage unavailable, ignore
  }
}

/**
 * Main initialization function.
 * Runs the full bridge setup sequence.
 */
async function initBridge() {
  console.log(LOG_PREFIX, 'Initializing...');

  // Step 1: Detect app from hostname
  const hostname = window.location.hostname;
  const adapterInfo = ADAPTER_MAP[hostname] || null;
  const appName = adapterInfo ? adapterInfo.appName : 'Generic Editor';
  const domain = hostname;
  const instanceId = normalizeInstanceId(window.location.href);

  console.log(LOG_PREFIX, `Detected app: ${appName} | Domain: ${domain} | Instance: ${instanceId}`);

  // Step 2: Load profile from storage
  let appProfile = null;
  let instanceProfile = null;
  let profileLoaded = false;

  try {
    appProfile = await StorageClient.getProfile(domain);
    instanceProfile = await StorageClient.getInstance(instanceId);
    profileLoaded = appProfile !== null;
  } catch (err) {
    console.warn(LOG_PREFIX, 'Failed to load profiles from storage:', err.message);
  }

  const effectiveProfile = mergeProfiles(appProfile, instanceProfile);
  const profileStatus = profileLoaded ? 'loaded' : 'exploring';
  const profileVersion = (appProfile && appProfile.version) || null;

  console.log(LOG_PREFIX, `Profile status: ${profileStatus} | Version: ${profileVersion}`);

  // Step 3: Instantiate adapter with effective profile
  let adapter;
  if (adapterInfo) {
    adapter = new adapterInfo.AdapterClass(effectiveProfile);
  } else {
    adapter = new GenericAdapter(effectiveProfile);
  }

  // Set appName on the adapter for downstream use
  if (!adapter.appName) {
    adapter.appName = appName;
  }

  // Wait for editor to be ready (if adapter supports it)
  if (typeof adapter._waitForEditorReady === 'function') {
    try {
      await adapter._waitForEditorReady();
      console.log(LOG_PREFIX, 'Editor ready');
    } catch (err) {
      console.warn(LOG_PREFIX, 'Editor ready wait timed out:', err.message);
    }
  }

  // Step 4: Create Extractor, Executor, Explorer
  const extractor = new Extractor(adapter);
  const executor = new Executor(adapter, extractor);
  const explorer = new Explorer(adapter);

  // Get initial block count for the status panel
  let initialBlockCount = 0;
  try {
    const snapshot = extractor.getContent();
    initialBlockCount = snapshot.blocks.length;
  } catch (err) {
    console.warn(LOG_PREFIX, 'Initial content extraction failed:', err.message);
  }

  // Build context from loaded profile
  const context = {
    knownBlocks: (effectiveProfile.selectors && effectiveProfile.selectors.blocks)
      ? Object.entries(effectiveProfile.selectors.blocks).map(([type, entry]) => ({
          type,
          selector: entry.value || entry,
          confidence: entry.confidence || 'unknown'
        }))
      : [],
    availableActions: (effectiveProfile.actions)
      ? Object.entries(effectiveProfile.actions).map(([action, entry]) => ({
          action,
          method: entry.method || 'unknown',
          confidence: entry.confidence || 'unknown'
        }))
      : [],
    quirks: (effectiveProfile.quirks || []).map(q =>
      typeof q === 'string' ? q : (q.description || String(q))
    ),
    confidence: (effectiveProfile.meta && effectiveProfile.meta.confidence) || 'unknown'
  };

  // Step 5: Inject window.__claudeBridge
  const bridgeApi = {
    // Metadata
    version: VERSION,
    app: appName,
    domain,
    instanceId,
    profileLoaded,
    profileVersion,
    context,

    // Read methods
    getContent: () => {
      try {
        return extractor.getContent();
      } catch (err) {
        console.error(LOG_PREFIX, 'getContent failed:', err);
        return null;
      }
    },

    getBlock: (blockId) => {
      try {
        return extractor.getBlock(blockId);
      } catch (err) {
        console.error(LOG_PREFIX, 'getBlock failed:', err);
        return null;
      }
    },

    getSelection: () => {
      try {
        return extractor.getSelection();
      } catch (err) {
        console.error(LOG_PREFIX, 'getSelection failed:', err);
        return { blockId: null, text: null, startOffset: null, endOffset: null };
      }
    },

    getProfile: () => {
      return effectiveProfile;
    },

    // Execute methods
    execute: (command) => {
      try {
        return executor.execute(command);
      } catch (err) {
        console.error(LOG_PREFIX, 'execute failed:', err);
        return { success: false, action: (command && command.action) || 'unknown', error: err.message };
      }
    },

    // Knowledge methods
    updateAppKnowledge: async (targetDomain, patch) => {
      console.log(LOG_PREFIX, 'updateAppKnowledge:', targetDomain, patch);
      try {
        await StorageClient.updateApp(targetDomain, patch, { source: 'claude' });
        console.log(LOG_PREFIX, 'App knowledge updated for:', targetDomain);
      } catch (err) {
        console.error(LOG_PREFIX, 'updateAppKnowledge failed:', err);
        throw err;
      }
    },

    updateInstanceKnowledge: async (targetInstanceId, patch) => {
      console.log(LOG_PREFIX, 'updateInstanceKnowledge:', targetInstanceId, patch);
      try {
        await StorageClient.updateInstance(targetInstanceId, patch);
        console.log(LOG_PREFIX, 'Instance knowledge updated for:', targetInstanceId);
      } catch (err) {
        console.error(LOG_PREFIX, 'updateInstanceKnowledge failed:', err);
        throw err;
      }
    },

    flagQuirk: async (description, level = 'app') => {
      console.log(LOG_PREFIX, 'flagQuirk:', description, level);
      const quirkEntry = {
        description,
        confidence: 'inferred',
        source: 'claude'
      };

      try {
        if (level === 'instance') {
          await StorageClient.updateInstance(instanceId, {
            quirks: [...(effectiveProfile.quirks || []), quirkEntry]
          });
        } else {
          await StorageClient.updateApp(domain, {
            quirks: [...((appProfile && appProfile.quirks) || []), quirkEntry]
          }, { source: 'claude' });
        }
        console.log(LOG_PREFIX, `Quirk flagged at ${level} level:`, description);
      } catch (err) {
        console.error(LOG_PREFIX, 'flagQuirk failed:', err);
        throw err;
      }
    },

    // Exploration
    explore: async () => {
      console.log(LOG_PREFIX, 'Running exploration...');
      try {
        const result = explorer.explore();
        console.log(LOG_PREFIX, 'Exploration complete:', result);
        return result;
      } catch (err) {
        console.error(LOG_PREFIX, 'explore failed:', err);
        throw err;
      }
    },

    // Utility
    getCapabilities: () => {
      return [
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
      ];
    },

    ping: () => {
      return {
        status: 'ready',
        timestamp: Date.now()
      };
    }
  };

  // Inject onto the window object
  // Use Object.defineProperty to make it non-writable from the page context
  try {
    Object.defineProperty(window, '__claudeBridge', {
      value: Object.freeze(bridgeApi),
      writable: false,
      configurable: false,
      enumerable: true
    });
  } catch (_) {
    // If defineProperty fails (e.g., already defined), fall back to direct assignment
    window.__claudeBridge = bridgeApi;
  }

  // Step 6: Set body attributes
  document.body.setAttribute('data-claude-bridge', 'ready');
  document.body.setAttribute('data-claude-app', appName);
  document.body.setAttribute('data-claude-profile', profileStatus);
  document.body.setAttribute('data-claude-version', VERSION);

  // Step 7: Inject status panel
  injectStatusPanel({
    app: appName,
    profileLoaded,
    blockCount: initialBlockCount,
    instanceId
  });

  // Step 8: Log ready message
  console.log(
    `${LOG_PREFIX} Ready. App: ${appName} | Profile: ${profileStatus} | Instance: ${instanceId}`
  );
}

// ---------------------------------------------------------------------------
// Entry point — run initialization
// ---------------------------------------------------------------------------

initBridge().catch((err) => {
  console.error(LOG_PREFIX, 'Initialization failed:', err);

  // Set error state on body so Claude knows something went wrong
  document.body.setAttribute('data-claude-bridge', 'error');
  document.body.setAttribute('data-claude-bridge-error', err.message);
});
