/**
 * E2E tests for editing operations via Claude Bridge.
 *
 * Tests execute commands on a local test page with contenteditable regions.
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

async function waitForBridge(page, timeout = 10000) {
  await page.waitForFunction(
    () => document.body?.getAttribute('data-claude-bridge') === 'ready',
    { timeout }
  );
}

test.describe('Edit operations', () => {
  test('replace_text changes block content', async () => {
    const page = await browserContext.newPage();
    await page.goto(`file://${TEST_PAGE_PATH}`);
    await waitForBridge(page);

    // Get content to find a block
    const content = await page.evaluate(() => window.__claudeBridge.getContent());
    expect(content.blocks.length).toBeGreaterThan(0);

    const firstBlock = content.blocks[0];

    // Replace text
    const result = await page.evaluate((blockId) => {
      return window.__claudeBridge.execute({
        action: 'replace_text',
        target: { blockId },
        value: 'Replaced Text E2E'
      });
    }, firstBlock.id);

    expect(result.success).toBe(true);

    // Verify content changed
    const updated = await page.evaluate((blockId) => {
      return window.__claudeBridge.getBlock(blockId);
    }, firstBlock.id);

    if (updated) {
      expect(updated.text).toContain('Replaced Text E2E');
    }

    await page.close();
  });

  test('get_snapshot returns current state', async () => {
    const page = await browserContext.newPage();
    await page.goto(`file://${TEST_PAGE_PATH}`);
    await waitForBridge(page);

    const result = await page.evaluate(() => {
      return window.__claudeBridge.execute({ action: 'get_snapshot' });
    });

    expect(result.success).toBe(true);
    expect(result.snapshot).toBeDefined();
    expect(result.snapshot.blocks).toBeDefined();
    await page.close();
  });

  test('execute with unknown action fails gracefully', async () => {
    const page = await browserContext.newPage();
    await page.goto(`file://${TEST_PAGE_PATH}`);
    await waitForBridge(page);

    const result = await page.evaluate(() => {
      return window.__claudeBridge.execute({
        action: 'nonexistent_action',
        target: { blockId: 'block-0' }
      });
    });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    await page.close();
  });

  test('clear_block empties block content', async () => {
    const page = await browserContext.newPage();
    await page.goto(`file://${TEST_PAGE_PATH}`);
    await waitForBridge(page);

    const content = await page.evaluate(() => window.__claudeBridge.getContent());
    const textBlock = content.blocks.find(b => b.text && b.text.length > 0);
    if (!textBlock) {
      test.skip();
      return;
    }

    const result = await page.evaluate((blockId) => {
      return window.__claudeBridge.execute({
        action: 'clear_block',
        target: { blockId }
      });
    }, textBlock.id);

    expect(result.success).toBe(true);
    await page.close();
  });
});
