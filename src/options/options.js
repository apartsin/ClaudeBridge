// ClaudeBridge Options Page
// Two-panel profile manager for App Profiles and Instance Profiles.

// ─── DOM references ──────────────────────────────────────────────────────────

const $listApps         = document.getElementById("list-apps");
const $listInstances    = document.getElementById("list-instances");
const $btnAddApp        = document.getElementById("btn-add-app");
const $btnAddInstance    = document.getElementById("btn-add-instance");
const $detailEmpty      = document.getElementById("detail-empty");
const $detailContent    = document.getElementById("detail-content");
const $detailTitle      = document.getElementById("detail-title");
const $detailType       = document.getElementById("detail-type");
const $detailDomain     = document.getElementById("detail-domain");
const $detailConfidence = document.getElementById("detail-confidence");
const $detailUpdated    = document.getElementById("detail-updated");
const $detailUpdateCount = document.getElementById("detail-update-count");
const $fieldSelectors   = document.getElementById("field-selectors");
const $fieldActions     = document.getElementById("field-actions");
const $fieldQuirks      = document.getElementById("field-quirks");
const $fieldChangelog   = document.getElementById("field-changelog");
const $btnSave          = document.getElementById("btn-save");
const $btnDelete        = document.getElementById("btn-delete");
const $btnExportSingle  = document.getElementById("btn-export-single");

// ─── State ───────────────────────────────────────────────────────────────────

let allProfiles  = {};   // domain -> AppProfile
let allInstances = {};   // instanceId -> InstanceProfile
let selectedKey  = null; // the domain or instanceId currently shown
let selectedType = null; // "app" | "instance"

// ─── Initialization ──────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", async () => {
  await loadAllProfiles();
  renderSidebar();
  bindEvents();
});

// ─── Data loading ────────────────────────────────────────────────────────────

async function loadAllProfiles() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "GET_ALL_PROFILES" });
    if (response && response.ok) {
      allProfiles  = response.profiles  || {};
      allInstances = response.instances || {};
    }
  } catch (err) {
    console.error("ClaudeBridge options: failed to load profiles", err);
  }
}

// ─── Sidebar rendering ──────────────────────────────────────────────────────

function renderSidebar() {
  // App profiles
  $listApps.innerHTML = "";
  const appKeys = Object.keys(allProfiles).sort();
  if (appKeys.length === 0) {
    const li = document.createElement("li");
    li.className = "profile-list-empty";
    li.textContent = "No app profiles yet";
    $listApps.appendChild(li);
  } else {
    for (const domain of appKeys) {
      const profile = allProfiles[domain];
      const li = document.createElement("li");
      li.textContent = profile.appName || domain;
      li.title = domain;
      li.dataset.key = domain;
      li.dataset.type = "app";
      if (selectedType === "app" && selectedKey === domain) {
        li.classList.add("selected");
      }
      $listApps.appendChild(li);
    }
  }

  // Instance profiles
  $listInstances.innerHTML = "";
  const instKeys = Object.keys(allInstances).sort();
  if (instKeys.length === 0) {
    const li = document.createElement("li");
    li.className = "profile-list-empty";
    li.textContent = "No instance profiles yet";
    $listInstances.appendChild(li);
  } else {
    for (const id of instKeys) {
      const inst = allInstances[id];
      const li = document.createElement("li");
      li.textContent = id;
      li.title = `Domain: ${inst.domain || "unknown"}`;
      li.dataset.key = id;
      li.dataset.type = "instance";
      if (selectedType === "instance" && selectedKey === id) {
        li.classList.add("selected");
      }
      $listInstances.appendChild(li);
    }
  }
}

// ─── Detail panel rendering ─────────────────────────────────────────────────

function showProfile(key, type) {
  selectedKey = key;
  selectedType = type;

  $detailEmpty.hidden = true;
  $detailContent.hidden = false;

  if (type === "app") {
    const profile = allProfiles[key];
    if (!profile) return;

    $detailTitle.textContent = profile.appName || key;
    $detailType.textContent = "App";
    $detailType.className = "type-badge app";
    $detailDomain.textContent = profile.domain || key;
    $detailConfidence.textContent = profile.meta?.confidence || "unknown";
    $detailUpdated.textContent = formatTimestamp(profile.meta?.lastUpdated);
    $detailUpdateCount.textContent = String(profile.meta?.updateCount || 0);

    // Populate editable fields
    $fieldSelectors.value = prettyJSON(profile.selectors || {});
    $fieldActions.value = prettyJSON(profile.actions || {});
    $fieldQuirks.value = prettyJSON(profile.quirks || []);

    // Changelog (read-only)
    renderChangelog(profile.meta?.changelog || []);

  } else if (type === "instance") {
    const inst = allInstances[key];
    if (!inst) return;

    $detailTitle.textContent = key;
    $detailType.textContent = "Instance";
    $detailType.className = "type-badge instance";
    $detailDomain.textContent = inst.domain || "unknown";
    $detailConfidence.textContent = inst.meta?.confidence || "unknown";
    $detailUpdated.textContent = formatTimestamp(inst.meta?.lastUpdated);
    $detailUpdateCount.textContent = String(inst.meta?.updateCount || 0);

    // For instances, selectors field holds deltas
    $fieldSelectors.value = prettyJSON(inst.deltas || {});
    $fieldActions.value = "{}";
    $fieldQuirks.value = "[]";

    renderChangelog(inst.meta?.changelog || []);
  }

  // Refresh sidebar selection highlight
  renderSidebar();
}

function renderChangelog(changelog) {
  $fieldChangelog.innerHTML = "";

  if (!changelog || changelog.length === 0) {
    $fieldChangelog.innerHTML = '<div class="changelog-empty">No changelog entries.</div>';
    return;
  }

  // Show newest first
  const sorted = [...changelog].reverse();

  for (const entry of sorted) {
    const div = document.createElement("div");
    div.className = "changelog-entry";

    const time = document.createElement("span");
    time.className = "cl-time";
    time.textContent = formatTimestamp(entry.timestamp);

    const type = document.createElement("span");
    type.className = "cl-type";
    type.textContent = entry.type || "change";

    const field = document.createElement("span");
    field.className = "cl-field";
    field.textContent = entry.field || "";

    div.appendChild(time);
    div.appendChild(type);
    div.appendChild(field);

    if (entry.note) {
      const note = document.createElement("span");
      note.textContent = ` — ${entry.note}`;
      note.style.color = "#999";
      div.appendChild(note);
    }

    $fieldChangelog.appendChild(div);
  }
}

function clearDetailPanel() {
  selectedKey = null;
  selectedType = null;
  $detailEmpty.hidden = false;
  $detailContent.hidden = true;
  renderSidebar();
}

// ─── Event bindings ──────────────────────────────────────────────────────────

function bindEvents() {
  // Sidebar click delegation
  $listApps.addEventListener("click", (e) => {
    const li = e.target.closest("li[data-key]");
    if (li) showProfile(li.dataset.key, "app");
  });

  $listInstances.addEventListener("click", (e) => {
    const li = e.target.closest("li[data-key]");
    if (li) showProfile(li.dataset.key, "instance");
  });

  // Add new App Profile
  $btnAddApp.addEventListener("click", () => {
    showAddDialog("app");
  });

  // Add new Instance Profile
  $btnAddInstance.addEventListener("click", () => {
    showAddDialog("instance");
  });

  // Save current profile
  $btnSave.addEventListener("click", async () => {
    await saveCurrentProfile();
  });

  // Delete current profile
  $btnDelete.addEventListener("click", async () => {
    if (!selectedKey || !selectedType) return;

    const confirmed = confirm(
      `Delete ${selectedType} profile "${selectedKey}"? This cannot be undone.`
    );
    if (!confirmed) return;

    try {
      const response = await chrome.runtime.sendMessage({
        type: selectedType === "app" ? "STORAGE_DELETE_APP" : "STORAGE_DELETE_INSTANCE",
        key: selectedKey
      });

      if (response && response.ok) {
        await loadAllProfiles();
        clearDetailPanel();
      } else {
        alert("Delete failed: " + (response?.error || "Unknown error"));
      }
    } catch (err) {
      console.error("Delete error", err);
      alert("Delete failed: " + err.message);
    }
  });

  // Export single profile
  $btnExportSingle.addEventListener("click", () => {
    if (!selectedKey || !selectedType) return;

    let data;
    if (selectedType === "app") {
      data = { profiles: { [selectedKey]: allProfiles[selectedKey] }, instances: {} };
    } else {
      data = { profiles: {}, instances: { [selectedKey]: allInstances[selectedKey] } };
    }

    downloadJSON(JSON.stringify(data, null, 2), `claude-bridge-${selectedType}-${sanitizeFilename(selectedKey)}.json`);
  });
}

// ─── Save logic ──────────────────────────────────────────────────────────────

async function saveCurrentProfile() {
  if (!selectedKey || !selectedType) return;

  // Parse the JSON editor fields
  let selectors, actions, quirks;
  try {
    selectors = JSON.parse($fieldSelectors.value);
  } catch {
    alert("Invalid JSON in Selectors / Deltas field.");
    return;
  }
  try {
    actions = JSON.parse($fieldActions.value);
  } catch {
    alert("Invalid JSON in Actions field.");
    return;
  }
  try {
    quirks = JSON.parse($fieldQuirks.value);
  } catch {
    alert("Invalid JSON in Quirks field.");
    return;
  }

  try {
    if (selectedType === "app") {
      const patch = { selectors, actions, quirks };
      const response = await chrome.runtime.sendMessage({
        type: "STORAGE_UPDATE_APP",
        domain: selectedKey,
        patch,
        options: { source: "human", note: "Edited via Options page" }
      });

      if (response && response.ok) {
        await loadAllProfiles();
        showProfile(selectedKey, "app");
      } else {
        alert("Save failed: " + (response?.error || "Unknown error"));
      }
    } else {
      // Instance: the selectors field holds the full deltas object
      const patch = selectors; // deltas is what the user edited
      const response = await chrome.runtime.sendMessage({
        type: "STORAGE_UPDATE_INSTANCE",
        instanceId: selectedKey,
        patch,
        options: { source: "human", note: "Edited via Options page" }
      });

      if (response && response.ok) {
        await loadAllProfiles();
        showProfile(selectedKey, "instance");
      } else {
        alert("Save failed: " + (response?.error || "Unknown error"));
      }
    }
  } catch (err) {
    console.error("Save error", err);
    alert("Save failed: " + err.message);
  }
}

// ─── Add Profile Dialog ──────────────────────────────────────────────────────

function showAddDialog(type) {
  // Create a modal overlay
  const overlay = document.createElement("div");
  overlay.className = "dialog-overlay";

  const dialog = document.createElement("div");
  dialog.className = "dialog";

  const title = type === "app" ? "New App Profile" : "New Instance Profile";
  const placeholder = type === "app" ? "e.g. sites.google.com" : "e.g. sites.google.com__s__abc123";
  const idLabel = type === "app" ? "Domain" : "Instance ID";

  dialog.innerHTML = `
    <h3>${title}</h3>
    <label style="font-size:12px;color:#666;display:block;margin-bottom:4px">${idLabel}</label>
    <input type="text" id="dialog-key" placeholder="${placeholder}">
    ${type === "instance" ? `
      <label style="font-size:12px;color:#666;display:block;margin-bottom:4px">Parent Domain</label>
      <input type="text" id="dialog-domain" placeholder="e.g. sites.google.com">
    ` : ""}
    ${type === "app" ? `
      <label style="font-size:12px;color:#666;display:block;margin-bottom:4px">App Name</label>
      <input type="text" id="dialog-app-name" placeholder="e.g. Google Sites">
    ` : ""}
    <div class="dialog-actions">
      <button id="dialog-cancel" class="btn btn-secondary">Cancel</button>
      <button id="dialog-create" class="btn btn-primary">Create</button>
    </div>
  `;

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  const $key = dialog.querySelector("#dialog-key");
  $key.focus();

  const close = () => overlay.remove();

  dialog.querySelector("#dialog-cancel").addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  dialog.querySelector("#dialog-create").addEventListener("click", async () => {
    const key = $key.value.trim();
    if (!key) {
      $key.style.borderColor = "#d32f2f";
      return;
    }

    try {
      if (type === "app") {
        const appName = dialog.querySelector("#dialog-app-name")?.value.trim() || key;
        const response = await chrome.runtime.sendMessage({
          type: "STORAGE_CREATE_APP",
          domain: key,
          initialData: { appName }
        });

        if (response && response.ok) {
          close();
          await loadAllProfiles();
          showProfile(key, "app");
        } else {
          alert("Create failed: " + (response?.error || "Unknown error"));
        }
      } else {
        const domain = dialog.querySelector("#dialog-domain")?.value.trim() || "";
        const response = await chrome.runtime.sendMessage({
          type: "STORAGE_CREATE_INSTANCE",
          instanceId: key,
          domain,
          initialData: {}
        });

        if (response && response.ok) {
          close();
          await loadAllProfiles();
          showProfile(key, "instance");
        } else {
          alert("Create failed: " + (response?.error || "Unknown error"));
        }
      }
    } catch (err) {
      console.error("Create error", err);
      alert("Create failed: " + err.message);
    }
  });
}

// ─── Utility ─────────────────────────────────────────────────────────────────

function prettyJSON(obj) {
  try {
    return JSON.stringify(obj, null, 2);
  } catch {
    return "{}";
  }
}

function formatTimestamp(ts) {
  if (!ts) return "--";
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function sanitizeFilename(str) {
  return str.replace(/[^a-zA-Z0-9._-]/g, "_").substring(0, 60);
}

/**
 * Trigger a JSON file download.
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
