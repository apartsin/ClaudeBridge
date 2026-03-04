// Chrome API mock for Jest testing
// Provides a complete mock of chrome.storage.local, chrome.runtime,
// chrome.tabs, and chrome.scripting APIs used by ClaudeBridge.

const storage = {};

const chrome = {
  storage: {
    local: {
      get: jest.fn((keys) => {
        return new Promise((resolve) => {
          if (typeof keys === 'undefined' || keys === null) {
            resolve({ ...storage });
          } else if (Array.isArray(keys)) {
            const result = {};
            keys.forEach((k) => {
              if (storage[k] !== undefined) result[k] = storage[k];
            });
            resolve(result);
          } else if (typeof keys === 'string') {
            const result = {};
            if (storage[keys] !== undefined) {
              result[keys] = storage[keys];
            }
            resolve(result);
          } else if (typeof keys === 'object') {
            // Keys with defaults
            const result = {};
            for (const [k, defaultVal] of Object.entries(keys)) {
              result[k] = storage[k] !== undefined ? storage[k] : defaultVal;
            }
            resolve(result);
          } else {
            resolve({});
          }
        });
      }),
      set: jest.fn((items) => {
        return new Promise((resolve) => {
          Object.assign(storage, items);
          resolve();
        });
      }),
      remove: jest.fn((keys) => {
        return new Promise((resolve) => {
          const keyArr = Array.isArray(keys) ? keys : [keys];
          keyArr.forEach((k) => delete storage[k]);
          resolve();
        });
      }),
      clear: jest.fn(() => {
        return new Promise((resolve) => {
          Object.keys(storage).forEach((k) => delete storage[k]);
          resolve();
        });
      }),
      // Internal helper: reset storage state for test isolation
      _reset: () => {
        Object.keys(storage).forEach((k) => delete storage[k]);
      },
      // Internal helper: read raw storage for assertions
      _getStore: () => ({ ...storage })
    }
  },
  runtime: {
    sendMessage: jest.fn((message, callback) => {
      // Default: invoke callback with empty response if provided
      if (typeof callback === 'function') {
        callback({});
      }
    }),
    onMessage: {
      addListener: jest.fn(),
      removeListener: jest.fn(),
      hasListener: jest.fn(() => false)
    },
    onInstalled: {
      addListener: jest.fn()
    },
    lastError: null,
    getManifest: jest.fn(() => ({
      version: '1.0.0',
      name: 'Claude Bridge',
      manifest_version: 3
    })),
    getURL: jest.fn((path) => `chrome-extension://mock-extension-id/${path}`)
  },
  tabs: {
    query: jest.fn(() => Promise.resolve([])),
    sendMessage: jest.fn((tabId, message, callback) => {
      if (typeof callback === 'function') {
        callback({});
      }
    }),
    onUpdated: {
      addListener: jest.fn(),
      removeListener: jest.fn()
    },
    onActivated: {
      addListener: jest.fn(),
      removeListener: jest.fn()
    },
    get: jest.fn((tabId) =>
      Promise.resolve({ id: tabId, url: 'https://example.com', title: 'Test' })
    )
  },
  scripting: {
    executeScript: jest.fn(() => Promise.resolve([{ result: null }]))
  },
  action: {
    setBadgeText: jest.fn(),
    setBadgeBackgroundColor: jest.fn(),
    setIcon: jest.fn()
  }
};

// Make globally available
global.chrome = chrome;
module.exports = chrome;
