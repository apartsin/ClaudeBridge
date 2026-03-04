/**
 * E2E tests for Claude Bridge Chrome extension using Playwright.
 *
 * Tests extension loading, bridge injection, and basic content reading
 * on a local test page with editable content.
 */

const { test, expect, chromium } = require('@playwright/test');
const path = require('path');

const EXTENSION_PATH = path.resolve(__dirname, '../../dist');
const TEST_PAGE_PATH = path.resolve(__dirname, '../helpers/test-page.html');

let browserContext;

test.beforeAll(async () => {
  browserContext = await chromium.launchPersistentContext('', {
    headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-first-run',
      '--no-default-browser-check'
    ]
  });
});

test.afterAll(async () => {
  if (browserContext) {
    await browserContext.close();
  }
});

/**
 * Wait for the Claude Bridge to be ready on a page.
 */
async function waitForBridge(page, timeout = 10000) {
  await page.waitForFunction(
    () => document.body?.getAttribute('data-claude-bridge') === 'ready',
    { timeout }
  );
}

test.describe('Extension loading', () => {
  test('bridge injects on a local HTML page', async () => {
    const page = await browserContext.newPage();
    await page.goto(`file://${TEST_PAGE_PATH}`);
    await waitForBridge(page);

    const bridgeStatus = await page.evaluate(
      () => document.body.getAttribute('data-claude-bridge')
    );
    expect(bridgeStatus).toBe('ready');
    await page.close();
  });

  test('data-claude-app attribute is set', async () => {
    const page = await browserContext.newPage();
    await page.goto(`file://${TEST_PAGE_PATH}`);
    await waitForBridge(page);

    const app = await page.evaluate(
      () => document.body.getAttribute('data-claude-app')
    );
    expect(app).toBeTruthy();
    expect(typeof app).toBe('string');
    await page.close();
  });

  test('data-claude-version attribute is set', async () => {
    const page = await browserContext.newPage();
    await page.goto(`file://${TEST_PAGE_PATH}`);
    await waitForBridge(page);

    const version = await page.evaluate(
      () => document.body.getAttribute('data-claude-version')
    );
    expect(version).toBeTruthy();
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    await page.close();
  });

  test('status panel is visible', async () => {
    const page = await browserContext.newPage();
    await page.goto(`file://${TEST_PAGE_PATH}`);
    await waitForBridge(page);

    const panel = await page.$('#claude-bridge-panel');
    expect(panel).not.toBeNull();
    await page.close();
  });
});

test.describe('Bridge API', () => {
  test('window.__claudeBridge exists and has expected methods', async () => {
    const page = await browserContext.newPage();
    await page.goto(`file://${TEST_PAGE_PATH}`);
    await waitForBridge(page);

    const apiCheck = await page.evaluate(() => {
      const bridge = window.__claudeBridge;
      return {
        exists: !!bridge,
        hasGetContent: typeof bridge.getContent === 'function',
        hasGetBlock: typeof bridge.getBlock === 'function',
        hasExecute: typeof bridge.execute === 'function',
        hasExplore: typeof bridge.explore === 'function',
        hasPing: typeof bridge.ping === 'function',
        hasGetCapabilities: typeof bridge.getCapabilities === 'function',
        hasStartDemonstration: typeof bridge.startDemonstration === 'function',
        hasStopDemonstration: typeof bridge.stopDemonstration === 'function'
      };
    });

    expect(apiCheck.exists).toBe(true);
    expect(apiCheck.hasGetContent).toBe(true);
    expect(apiCheck.hasGetBlock).toBe(true);
    expect(apiCheck.hasExecute).toBe(true);
    expect(apiCheck.hasExplore).toBe(true);
    expect(apiCheck.hasPing).toBe(true);
    expect(apiCheck.hasGetCapabilities).toBe(true);
    expect(apiCheck.hasStartDemonstration).toBe(true);
    expect(apiCheck.hasStopDemonstration).toBe(true);
    await page.close();
  });

  test('ping returns ready status', async () => {
    const page = await browserContext.newPage();
    await page.goto(`file://${TEST_PAGE_PATH}`);
    await waitForBridge(page);

    const ping = await page.evaluate(() => window.__claudeBridge.ping());
    expect(ping.status).toBe('ready');
    expect(ping.timestamp).toBeDefined();
    await page.close();
  });

  test('getCapabilities returns action list', async () => {
    const page = await browserContext.newPage();
    await page.goto(`file://${TEST_PAGE_PATH}`);
    await waitForBridge(page);

    const caps = await page.evaluate(() => window.__claudeBridge.getCapabilities());
    expect(Array.isArray(caps)).toBe(true);
    expect(caps).toContain('replace_text');
    expect(caps).toContain('save');
    expect(caps).toContain('get_snapshot');
    await page.close();
  });

  test('getContent returns blocks from test page', async () => {
    const page = await browserContext.newPage();
    await page.goto(`file://${TEST_PAGE_PATH}`);
    await waitForBridge(page);

    const content = await page.evaluate(() => window.__claudeBridge.getContent());
    expect(content).not.toBeNull();
    expect(content.blocks).toBeDefined();
    expect(Array.isArray(content.blocks)).toBe(true);
    expect(content.blocks.length).toBeGreaterThan(0);
    await page.close();
  });
});
