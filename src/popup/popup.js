// ClaudeBridge Popup
// Displays status for the active tab and provides quick actions.

// ─── DOM references ──────────────────────────────────────────────────────────

const $statusIndicator = document.getElementById("status-indicator");
const $appName         = document.getElementById("app-name");
const $profileStatus   = document.getElementById("profile-status");
const $blockCount      = document.getElementById("block-count");
const $btnViewProfile  = document.getElementById("btn-view-profile");
const $btnEditProfile  = document.getElementById("btn-edit-profile");
const $btnExport       = document.getElementById("btn-export");
const $btnImport       = document.getElementById("btn-import");
const $importFile      = document.getElementById("import-file");
const $knownApps       = document.getElementById("known-apps");
const $knownInstances  = document.getElementById("known-instances");
const $linkOptions     = document.getElementById("link-options");

// ─── State ───────────────────────────────────────────────────────────────────

let currentDomain = null;

// ─── Initialization ──────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", async () => {
  await refreshStatus();
  bindEvents();
});

// ─── Refresh status from active tab & background ─────────────────────────────

async function refreshStatus() {
  try {
    // 1. Get active tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url) {
      setInactive("No active tab");
      return;
    }

    // 2. Check for data-claude-bridge attribute on the page
    let bridgeDetected = false;
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const el = document.querySelector("[data-claude-bridge]");
          if (!el) return null;
          return {
            active: true,
            blockCount: document.querySelectorAll("[data-block-id]").length
          };
        }
      });

      if (results && results[0] && results[0].result) {
        bridgeDetected = true;
        const info = results[0].result;
        $blockCount.textContent = String(info.blockCount);
      }
    } catch {
      // Scripting may fail on restricted pages — that is fine
    }

    // 3. Query background service worker for profile data
    const statusResponse = await chrome.runtime.sendMessage({ type: "GET_STATUS", url: tab.url });

    if (statusResponse && statusResponse.ok) {
      const { domain, appName, profileExists, instanceExists } = statusResponse;
      currentDomain = domain;

      $appName.textContent = appName || domain || "Unknown";

      if (profileExists) {
        $profileStatus.textContent = instanceExists ? "App + Instance" : "App Only";
        $btnViewProfile.disabled = false;
        $btnEditProfile.disabled = false;
      } else {
        $profileStatus.textContent = "None";
        $btnViewProfile.disabled = true;
        $btnEditProfile.disabled = true;
      }

      if (bridgeDetected) {
        setActive();
      } else {
        setInactive("Bridge not detected");
      }
    } else {
      setInactive("No profile");
    }

    // 4. Update footer counts
    const countsResponse = await chrome.runtime.sendMessage({ type: "GET_COUNTS" });
    if (countsResponse && countsResponse.ok) {
      $knownApps.textContent = String(countsResponse.apps);
      $knownInstances.textContent = String(countsResponse.instances);
    }
  } catch (err) {
    console.error("ClaudeBridge popup: refreshStatus failed", err);
    setInactive("Error");
  }
}

// ─── Status helpers ──────────────────────────────────────────────────────────

function setActive() {
  $statusIndicator.textContent = "Active";
  $statusIndicator.classList.remove("inactive");
  $statusIndicator.classList.add("active");
}

function setInactive(reason) {
  $statusIndicator.textContent = reason || "Inactive";
  $statusIndicator.classList.remove("active");
  $statusIndicator.classList.add("inactive");
}

// ─── Event bindings ──────────────────────────────────────────────────────────

function bindEvents() {
  // View Profile — opens options page filtered to current domain
  $btnViewProfile.addEventListener("click", () => {
    if (currentDomain) {
      chrome.runtime.openOptionsPage();
    }
  });

  // Edit Profile — same destination
  $btnEditProfile.addEventListener("click", () => {
    if (currentDomain) {
      chrome.runtime.openOptionsPage();
    }
  });

  // Export — request JSON blob from background and download it
  $btnExport.addEventListener("click", async () => {
    try {
      const response = await chrome.runtime.sendMessage({ type: "STORAGE_EXPORT" });
      if (response && response.ok) {
        downloadJSON(response.data, "claude-bridge-profiles.json");
      } else {
        console.error("Export failed", response);
      }
    } catch (err) {
      console.error("Export error", err);
    }
  });

  // Import — open file picker
  $btnImport.addEventListener("click", () => {
    $importFile.click();
  });

  // Handle selected import file
  $importFile.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    try {
      const text = await file.text();
      // Validate JSON before sending
      JSON.parse(text);

      const response = await chrome.runtime.sendMessage({
        type: "STORAGE_IMPORT",
        data: text,
        merge: true
      });

      if (response && response.ok) {
        await refreshStatus();
      } else {
        console.error("Import failed", response);
      }
    } catch (err) {
      console.error("Import error — invalid JSON or messaging failure", err);
    }

    // Reset the input so the same file can be re-imported
    $importFile.value = "";
  });

  // Open Options page
  $linkOptions.addEventListener("click", (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
}

// ─── Utility ─────────────────────────────────────────────────────────────────

/**
 * Trigger a JSON file download in the browser.
 * @param {string} jsonString
 * @param {string} filename
 */
function downloadJSON(jsonString, filename) {
  const blob = new Blob([jsonString], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
