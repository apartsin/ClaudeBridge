/**
 * StorageClient — Content script side storage client.
 *
 * Communicates with the background service worker via chrome.runtime.sendMessage
 * because content scripts cannot always access chrome.storage directly.
 *
 * All methods are async and return Promises that resolve with the response data
 * from the background service worker.
 */

const LOG_PREFIX = '[ClaudeBridge:StorageClient]';

/**
 * Send a message to the background service worker and return the response.
 * Wraps chrome.runtime.sendMessage in a Promise and handles errors.
 *
 * @param {object} message - The message payload to send.
 * @returns {Promise<any>} - The response from the service worker.
 */
function sendMessage(message) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          const errorMsg = chrome.runtime.lastError.message || 'Unknown runtime error';
          console.error(LOG_PREFIX, 'Message failed:', errorMsg, message);
          reject(new Error(errorMsg));
          return;
        }
        if (response && response.error) {
          console.error(LOG_PREFIX, 'Service worker error:', response.error, message);
          reject(new Error(response.error));
          return;
        }
        resolve(response);
      });
    } catch (err) {
      console.error(LOG_PREFIX, 'Failed to send message:', err.message);
      reject(err);
    }
  });
}

const StorageClient = {
  /**
   * Get the app profile for a given domain.
   *
   * @param {string} domain - The domain to look up (e.g. "sites.google.com").
   * @returns {Promise<object|null>} - The app profile object, or null if not found.
   */
  async getProfile(domain) {
    console.log(LOG_PREFIX, 'getProfile:', domain);
    const response = await sendMessage({
      type: 'STORAGE_GET_PROFILE',
      domain
    });
    return (response && response.profile) || null;
  },

  /**
   * Get the instance profile for a given instance ID.
   *
   * @param {string} instanceId - The instance ID (e.g. "sites.google.com__s__abc123").
   * @returns {Promise<object|null>} - The instance profile object, or null if not found.
   */
  async getInstance(instanceId) {
    console.log(LOG_PREFIX, 'getInstance:', instanceId);
    const response = await sendMessage({
      type: 'STORAGE_GET_INSTANCE',
      instanceId
    });
    return (response && response.instance) || null;
  },

  /**
   * Update (deep-merge a patch into) the app profile for a domain.
   *
   * @param {string} domain - The domain whose profile to update.
   * @param {object} patch - The partial object to deep-merge into the profile.
   * @param {object} [options] - Optional settings.
   * @param {boolean} [options.forceConfirmed] - If true, allow overwriting confirmed items.
   * @param {string} [options.source] - Source of the update: "claude"|"human"|"auto".
   * @returns {Promise<object>} - The service worker response ({ success: true } on success).
   */
  async updateApp(domain, patch, options = {}) {
    console.log(LOG_PREFIX, 'updateApp:', domain, patch, options);
    const response = await sendMessage({
      type: 'STORAGE_UPDATE_APP',
      domain,
      patch,
      forceConfirmed: options.forceConfirmed || false,
      source: options.source || 'auto'
    });
    return response;
  },

  /**
   * Update (deep-merge a patch into) the instance profile.
   *
   * @param {string} instanceId - The instance ID to update.
   * @param {object} patch - The partial object to deep-merge.
   * @returns {Promise<object>} - The service worker response ({ success: true } on success).
   */
  async updateInstance(instanceId, patch) {
    console.log(LOG_PREFIX, 'updateInstance:', instanceId, patch);
    const response = await sendMessage({
      type: 'STORAGE_UPDATE_INSTANCE',
      instanceId,
      patch
    });
    return response;
  },

  /**
   * Get the current extension status from the service worker.
   *
   * @returns {Promise<object>} - Status object { version, profileCount, instanceCount }.
   */
  async getStatus() {
    console.log(LOG_PREFIX, 'getStatus');
    const response = await sendMessage({
      type: 'GET_STATUS'
    });
    return response;
  }
};

export default StorageClient;
