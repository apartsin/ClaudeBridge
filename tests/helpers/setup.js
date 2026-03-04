// Common test setup for ClaudeBridge Jest tests.
// Requires the chrome mock to make it globally available,
// and resets state between tests for isolation.

require('../mocks/chrome.mock');

// Reset chrome storage and all mocks between tests
beforeEach(() => {
  chrome.storage.local._reset();
  jest.clearAllMocks();
  // Reset runtime.lastError to null
  chrome.runtime.lastError = null;
});

// Suppress console.log noise from source code during tests.
// Comment out these lines if you need to debug test output.
beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterAll(() => {
  console.log.mockRestore();
  console.warn.mockRestore();
});
