// ClaudeBridge Background Service Worker
// Handles message passing between content scripts and the storage layer.

import { StorageManager } from "../storage/schema.js";

const LOG_PREFIX = "[ClaudeBridge:SW]";

// ─── Initialization ────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async (details) => {
  console.log(`${LOG_PREFIX} Extension installed (reason: ${details.reason})`);

  // Initialize storage with empty profiles and instances if not already present
  const existing = await chrome.storage.local.get(["profiles", "instances"]);

  if (!existing.profiles) {
    await chrome.storage.local.set({ profiles: {} });
    console.log(`${LOG_PREFIX} Initialized empty profiles store`);
  }

  if (!existing.instances) {
    await chrome.storage.local.set({ instances: {} });
    console.log(`${LOG_PREFIX} Initialized empty instances store`);
  }

  console.log(`${LOG_PREFIX} Storage initialization complete`);
});

// ─── Message Handler ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // All message handling is async, so we return true to indicate
  // we will call sendResponse asynchronously.
  handleMessage(message, sender)
    .then((response) => {
      sendResponse(response);
    })
    .catch((error) => {
      console.error(`${LOG_PREFIX} Error handling message:`, message.type, error);
      sendResponse({ error: error.message || "Unknown error" });
    });

  return true; // Keep the message channel open for async response
});

/**
 * Route a message to the appropriate handler.
 *
 * @param {object} message - The message from the content script
 * @param {object} sender  - chrome.runtime.MessageSender
 * @returns {Promise<object>}
 */
async function handleMessage(message, sender) {
  const { type } = message;
  const tabInfo = sender.tab ? `tab=${sender.tab.id}` : "no-tab";
  console.log(`${LOG_PREFIX} Received message: ${type} (${tabInfo})`);

  switch (type) {
    case "STORAGE_GET":
      return handleStorageGet(message);

    case "STORAGE_SET":
      return handleStorageSet(message);

    case "STORAGE_GET_PROFILE":
      return handleGetProfile(message);

    case "STORAGE_UPDATE_APP":
      return handleUpdateApp(message);

    case "STORAGE_UPDATE_INSTANCE":
      return handleUpdateInstance(message);

    case "STORAGE_GET_INSTANCE":
      return handleGetInstance(message);

    case "STORAGE_EXPORT":
      return handleExport();

    case "STORAGE_IMPORT":
      return handleImport(message);

    case "GET_STATUS":
      return handleGetStatus();

    default:
      console.warn(`${LOG_PREFIX} Unknown message type: ${type}`);
      return { error: `Unknown message type: ${type}` };
  }
}

// ─── Individual Handlers ───────────────────────────────────────────────────────

/**
 * STORAGE_GET: Read a value from chrome.storage.local by key.
 * Message shape: { type: "STORAGE_GET", key: string }
 * Response: { data: { [key]: value } }
 */
async function handleStorageGet(message) {
  const { key } = message;
  console.log(`${LOG_PREFIX} STORAGE_GET key="${key}"`);

  const result = await chrome.storage.local.get([key]);
  return { data: result };
}

/**
 * STORAGE_SET: Write a value to chrome.storage.local.
 * Message shape: { type: "STORAGE_SET", key: string, value: any }
 * Response: { success: true }
 */
async function handleStorageSet(message) {
  const { key, value } = message;
  console.log(`${LOG_PREFIX} STORAGE_SET key="${key}"`);

  await chrome.storage.local.set({ [key]: value });
  return { success: true };
}

/**
 * STORAGE_GET_PROFILE: Retrieve an AppProfile by domain.
 * Message shape: { type: "STORAGE_GET_PROFILE", domain: string }
 * Response: { profile: AppProfile | null }
 */
async function handleGetProfile(message) {
  const { domain } = message;
  console.log(`${LOG_PREFIX} STORAGE_GET_PROFILE domain="${domain}"`);

  const profile = await StorageManager.getAppProfile(domain);
  return { profile };
}

/**
 * STORAGE_UPDATE_APP: Update an AppProfile with a patch.
 * Message shape: { type: "STORAGE_UPDATE_APP", domain: string, patch: object, forceConfirmed?: boolean }
 * Response: { success: true }
 */
async function handleUpdateApp(message) {
  const { domain, patch, forceConfirmed = false } = message;
  console.log(`${LOG_PREFIX} STORAGE_UPDATE_APP domain="${domain}" forceConfirmed=${forceConfirmed}`);

  await StorageManager.updateAppProfile(domain, patch, { forceConfirmed });
  return { success: true };
}

/**
 * STORAGE_UPDATE_INSTANCE: Update an InstanceProfile with a patch.
 * Message shape: { type: "STORAGE_UPDATE_INSTANCE", instanceId: string, patch: object }
 * Response: { success: true }
 */
async function handleUpdateInstance(message) {
  const { instanceId, patch } = message;
  console.log(`${LOG_PREFIX} STORAGE_UPDATE_INSTANCE instanceId="${instanceId}"`);

  await StorageManager.updateInstanceProfile(instanceId, patch);
  return { success: true };
}

/**
 * STORAGE_GET_INSTANCE: Retrieve an InstanceProfile by instanceId.
 * Message shape: { type: "STORAGE_GET_INSTANCE", instanceId: string }
 * Response: { instance: InstanceProfile | null }
 */
async function handleGetInstance(message) {
  const { instanceId } = message;
  console.log(`${LOG_PREFIX} STORAGE_GET_INSTANCE instanceId="${instanceId}"`);

  const instance = await StorageManager.getInstanceProfile(instanceId);
  return { instance };
}

/**
 * STORAGE_EXPORT: Export all stored data as a JSON string.
 * Message shape: { type: "STORAGE_EXPORT" }
 * Response: JSON string of full storage
 */
async function handleExport() {
  console.log(`${LOG_PREFIX} STORAGE_EXPORT`);

  const jsonString = await StorageManager.exportAll();
  return jsonString;
}

/**
 * STORAGE_IMPORT: Import data from a JSON string (merge mode).
 * Message shape: { type: "STORAGE_IMPORT", data: string }
 * Response: { success: true }
 */
async function handleImport(message) {
  const { data } = message;
  console.log(`${LOG_PREFIX} STORAGE_IMPORT`);

  await StorageManager.importAll(data, true);
  return { success: true };
}

/**
 * GET_STATUS: Return extension status information.
 * Message shape: { type: "GET_STATUS" }
 * Response: { version: string, profileCount: number, instanceCount: number }
 */
async function handleGetStatus() {
  console.log(`${LOG_PREFIX} GET_STATUS`);

  const manifest = chrome.runtime.getManifest();
  const { profiles, instances } = await StorageManager.getAll();

  const profileCount = Object.keys(profiles).length;
  const instanceCount = Object.keys(instances).length;

  console.log(`${LOG_PREFIX} Status: v${manifest.version}, ${profileCount} profiles, ${instanceCount} instances`);

  return {
    version: manifest.version,
    profileCount,
    instanceCount
  };
}
