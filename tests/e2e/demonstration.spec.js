/**
 * E2E tests for Learn by Demonstration feature.
 *
 * Tests the full demonstration workflow: start recording, perform edits,
 * stop recording, analyze, and save.
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

test.describe('Demonstration workflow', () => {
  test('startDemonstration returns recording status', async () => {
    const page = await browserContext.newPage();
    await page.goto(`file://${TEST_PAGE_PATH}`);
    await waitForBridge(page);

    const result = await page.evaluate(() => {
      return window.__claudeBridge.startDemonstration({ maxDuration: 5000 });
    });

    expect(result.status).toBe('recording');
    expect(result.startTime).toBeDefined();

    // Clean up
    await page.evaluate(() => window.__claudeBridge.stopDemonstration());
    await page.close();
  });

  test('getDemonstrationStatus reports recording state', async () => {
    const page = await browserContext.newPage();
    await page.goto(`file://${TEST_PAGE_PATH}`);
    await waitForBridge(page);

    // Before recording
    const beforeStatus = await page.evaluate(() => {
      return window.__claudeBridge.getDemonstrationStatus();
    });
    expect(beforeStatus.recording).toBe(false);

    // Start recording
    await page.evaluate(() => {
      window.__claudeBridge.startDemonstration({ maxDuration: 10000 });
    });

    const duringStatus = await page.evaluate(() => {
      return window.__claudeBridge.getDemonstrationStatus();
    });
    expect(duringStatus.recording).toBe(true);

    // Stop
    await page.evaluate(() => window.__claudeBridge.stopDemonstration());

    const afterStatus = await page.evaluate(() => {
      return window.__claudeBridge.getDemonstrationStatus();
    });
    expect(afterStatus.recording).toBe(false);

    await page.close();
  });

  test('stopDemonstration returns recording with events', async () => {
    const page = await browserContext.newPage();
    await page.goto(`file://${TEST_PAGE_PATH}`);
    await waitForBridge(page);

    // Start recording
    await page.evaluate(() => {
      window.__claudeBridge.startDemonstration({ maxDuration: 10000 });
    });

    // Simulate user typing in the editor
    const editor = await page.$('#editor');
    if (editor) {
      await editor.click();
      await page.keyboard.type('Hello demonstration');
      await page.waitForTimeout(200);
    }

    // Stop recording
    const recording = await page.evaluate(() => {
      return window.__claudeBridge.stopDemonstration();
    });

    expect(recording.status).toBe('stopped');
    expect(recording.events).toBeDefined();
    expect(Array.isArray(recording.events)).toBe(true);
    expect(recording.duration).toBeDefined();
    expect(recording.metadata).toBeDefined();

    await page.close();
  });

  test('analyzeDemonstration returns structured analysis', async () => {
    const page = await browserContext.newPage();
    await page.goto(`file://${TEST_PAGE_PATH}`);
    await waitForBridge(page);

    // Start recording
    await page.evaluate(() => {
      window.__claudeBridge.startDemonstration({ maxDuration: 10000 });
    });

    // Simulate typing
    const editor = await page.$('#editor');
    if (editor) {
      await editor.click();
      await page.keyboard.type('Test text');
      await page.waitForTimeout(200);
    }

    // Stop and analyze
    const recording = await page.evaluate(() => {
      return window.__claudeBridge.stopDemonstration();
    });

    const analysis = await page.evaluate((rec) => {
      return window.__claudeBridge.analyzeDemonstration(rec);
    }, recording);

    expect(analysis).toBeDefined();
    if (!analysis.error) {
      expect(analysis.actions).toBeDefined();
      expect(analysis.editMethod).toBeDefined();
      expect(analysis.confidence).toBeDefined();
      expect(analysis.summary).toBeDefined();
    }

    await page.close();
  });
});
