/**
 * app.js — top-level orchestrator (reduced after Phase 5 refactor).
 * All domain logic lives in components/*.js.
 */
import { settings, saveToken, api } from './api.js';
import { store } from './store.js';
import './components/lf-state-chip.js';
import './components/lf-activity-chip.js';
import './components/lf-toast.js';
import './components/lf-host-stats.js';
import './components/lf-routing-map.js';
import './components/lf-launch-form.js';
import './components/lf-instances-panel.js';
import './components/lf-config-library.js';
import './components/lf-hub-page.js';
import { setOperationPending, loadModelList } from './components/lf-launch-form.js';
import { initTestDialog } from './components/lf-test-dialog.js';

const $ = (id) => document.getElementById(id);

function toast(msg) {
  $("toast")?.notify(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

function syncGlobalApiTokenInput() {
  const input = $("globalApiToken");
  if (input) input.value = settings.token || "";
}

function setGlobalApiStatusLabel(text) {
  const chip = $("globalApiStatus");
  if (chip) chip.textContent = text;
}

async function refreshGlobalApiAccess() {
  const select = $("globalApiMode");
  if (!select) return;
  try {
    const security = await api("/v1/settings/security");
    const requireApiKey = security?.api?.requireApiKey !== false;
    select.value = requireApiKey ? "require" : "open";
    setGlobalApiStatusLabel(`API access: ${requireApiKey ? "Require Key" : "Open"}`);
  } catch (_) {
    setGlobalApiStatusLabel("API access: unknown");
  }
}

$("openHelp").onclick = () => {
  const base = (settings.apiBase || "").trim().replace(/\/$/, "");
  if (!base) { toast("Set API Base URL first"); return; }
  window.open(`${base}/help`, "_blank", "noopener,noreferrer");
};

$("saveGlobalApi").onclick = async () => {
  try {
    saveToken($("globalApiToken").value);
    const requireApiKey = $("globalApiMode").value === "require";
    await api("/v1/settings/security", {
      method: "PUT",
      body: JSON.stringify({ api: { requireApiKey } })
    });
    await refreshGlobalApiAccess();
    toast(`API access updated: ${requireApiKey ? "Require Key" : "Open"}`);
    void store.refresh('gpuHardware').catch(() => {});
    void loadModelList("launchInstanceModel");
  } catch (error) {
    toast(`API access update failed: ${error.message}`);
  }
};

$("globalApiToken").addEventListener("keydown", (event) => {
  if (event.key === "Enter") { event.preventDefault(); void $("saveGlobalApi").click(); }
});

$("unloadAll").onclick = async () => {
  const confirmed = window.confirm("Stop all running instances? The service stays up and config is preserved.");
  if (!confirmed) return;
  const closePoll = setInterval(() => { void store.refresh('instances').catch(() => {}); }, 1000);
  setOperationPending({ type: "system-unload", startedAt: Date.now() });
  try {
    await api("/v1/system/close", {
      method: "POST",
      body: JSON.stringify({ unloadModels: true, stopDaemon: false })
    });
    toast("All instances unloaded — service still running");
    await store.refresh('instances');
  } catch (error) {
    toast(`Unload failed: ${error.message}`);
  } finally {
    clearInterval(closePoll);
    setOperationPending(null);
  }
};

$("closeAll").onclick = async () => {
  const confirmed = window.confirm("Stop all running instances now?");
  if (!confirmed) return;
  const closePoll = setInterval(() => { void store.refresh('instances').catch(() => {}); }, 1000);
  setOperationPending({ type: "system-close", startedAt: Date.now() });
  try {
    const payload = await api("/v1/system/close", {
      method: "POST",
      body: JSON.stringify({ unloadModels: true, stopDaemon: true })
    });
    toast("All instances closed and models unloaded");
    const result = document.getElementById("configLibraryResult");
    if (result) result.textContent = JSON.stringify(payload, null, 2);
    await store.refresh('instances');
    window.close();
  } catch (error) {
    toast(`Close failed: ${error.message}`);
  } finally {
    clearInterval(closePoll);
    setOperationPending(null);
  }
};

function initTabs() {
  const tabInstances = document.getElementById("tabInstances");
  const tabModels = document.getElementById("tabModels");
  const tabAbout = document.getElementById("tabAbout");
  const pageInstances = document.getElementById("pageInstances");
  const pageModels = document.getElementById("pageModels");
  const pageAbout = document.getElementById("pageAbout");
  if (!tabInstances || !tabModels) return;

  function activate(activeTab, activePage) {
    [tabInstances, tabModels, tabAbout].forEach(t => t?.classList.remove("tab-btn-active"));
    [pageInstances, pageModels, pageAbout].forEach(p => { if (p) p.hidden = true; });
    activeTab.classList.add("tab-btn-active");
    activePage.hidden = false;
  }

  tabInstances.addEventListener("click", () => activate(tabInstances, pageInstances));
  tabModels.addEventListener("click", () => activate(tabModels, pageModels));
  tabAbout?.addEventListener("click", () => {
    activate(tabAbout, pageAbout);
    void loadAboutInfo();
  });
}

async function loadAboutInfo() {
  // Only load once — if version is already populated, skip
  const verEl = document.getElementById("aboutVerDep");
  if (!verEl || verEl.textContent !== "—") return;

  const base = (settings.apiBase || "").replace(/\/$/, "");
  const authHeaders = settings.token ? { Authorization: `Bearer ${settings.token}` } : {};

  try {
    const health = await fetch(`${base}/health`);
    const data = await health.json();
    const ver = data.version || "unknown";
    const node = data.node || "unknown";

    verEl.textContent = `v${ver}`;
    const nodeEl = document.getElementById("aboutNodeVer");
    if (nodeEl) nodeEl.textContent = node;

    // Populate topbar version badge
    const topbarVer = document.getElementById("topbarVersion");
    if (topbarVer) topbarVer.textContent = `v${ver}`;
  } catch { /* leave as — */ }

  // llama-server version + platform via bridge
  try {
    const sysRes = await fetch(`${base}/v1/system/info`, { headers: authHeaders });
    if (sysRes.ok) {
      const sys = await sysRes.json();
      const llamaEl = document.getElementById("aboutLlamaVer");
      if (llamaEl) llamaEl.textContent = sys.llamaServerVersion || "—";
      const platEl = document.getElementById("aboutPlatform");
      if (platEl) platEl.textContent = sys.platform || "—";
      const archEl = document.getElementById("aboutArch");
      if (archEl) archEl.textContent = sys.arch || "—";
    }
  } catch { /* optional */ }

  // Set the API help link
  const helpLink = document.getElementById("aboutHelpLink");
  if (helpLink) helpLink.href = `${base}/help`;
}

// ── Init ─────────────────────────────────────────────────────────────────

syncGlobalApiTokenInput();
void refreshGlobalApiAccess();
store.startPolling();
initTabs();
initTestDialog();
void loadTopbarVersion();

async function loadTopbarVersion() {
  try {
    const base = (settings.apiBase || "").replace(/\/$/, "");
    const res = await fetch(`${base}/health`);
    if (!res.ok) return;
    const data = await res.json();
    const ver = data.version;
    if (!ver) return;
    const el = document.getElementById("topbarVersion");
    if (el) el.textContent = `v${ver}`;
  } catch { /* not critical */ }
}

