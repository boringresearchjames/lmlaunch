const settings = {
  apiBase: window.location.origin,
  token: localStorage.getItem("apiToken") || ""
};

function saveToken(token) {
  settings.token = String(token || "").trim();
  if (settings.token) {
    localStorage.setItem("apiToken", settings.token);
  } else {
    localStorage.removeItem("apiToken");
  }
}

function syncGlobalApiTokenInput() {
  const input = $("globalApiToken");
  if (input) {
    input.value = settings.token || "";
  }
}

let instancesCache = [];
let gpuTelemetryCache = [];
let runtimeBackendsCache = [];
let operationPending = null;
let operationStatusTimer = null;

const $ = (id) => document.getElementById(id);

function toast(msg) {
  $("toast").textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
}

function setOperationPending(info) {
  operationPending = info;
  const statusEl = $("launchStatus");
  const startBtn = $("launchInstance");
  const loadConfigBtn = $("loadSelectedConfig");
  const closeBtn = $("closeAll");

  if (!operationPending) {
    statusEl.textContent = "Idle";
    startBtn.disabled = false;
    startBtn.textContent = "Start";
    loadConfigBtn.disabled = false;
    loadConfigBtn.textContent = "Load Selected";
    if (closeBtn) {
      closeBtn.disabled = false;
      closeBtn.textContent = "X";
    }
    if (operationStatusTimer) {
      clearInterval(operationStatusTimer);
      operationStatusTimer = null;
    }
    return;
  }

  startBtn.disabled = true;
  loadConfigBtn.disabled = true;
  if (closeBtn) {
    closeBtn.disabled = true;
  }

  if (operationPending.type === "config-load") {
    startBtn.textContent = "Start";
    loadConfigBtn.textContent = "Loading...";
    if (closeBtn) {
      closeBtn.textContent = "X";
    }
  } else if (operationPending.type === "system-close") {
    startBtn.textContent = "Start";
    loadConfigBtn.textContent = "Load Selected";
    if (closeBtn) {
      closeBtn.textContent = "...";
    }
  } else {
    startBtn.textContent = "Starting...";
    loadConfigBtn.textContent = "Load Selected";
    if (closeBtn) {
      closeBtn.textContent = "X";
    }
  }

  const render = () => {
    const elapsedMs = Date.now() - operationPending.startedAt;
    const elapsedSec = Math.max(1, Math.round(elapsedMs / 1000));

    if (operationPending.type === "config-load") {
      statusEl.textContent = `Loading config ${operationPending.name} (${elapsedSec}s)`;
      return;
    }

    if (operationPending.type === "system-close") {
      statusEl.textContent = `Closing instances and unloading models (${elapsedSec}s)`;
      return;
    }

    statusEl.textContent = `Starting ${operationPending.name} on ${operationPending.host}:${operationPending.port} (${elapsedSec}s)`;
  };

  render();
  if (operationStatusTimer) {
    clearInterval(operationStatusTimer);
  }
  operationStatusTimer = setInterval(render, 500);
}

function stateChipHtml(state) {
  const normalized = String(state || "unknown").toLowerCase();
  const safeText = escapeHtml(state || "unknown");
  return `<span class="state-chip state-${normalized}"><span class="state-dot"></span>${safeText}</span>`;
}

function formatCompactCount(value) {
  const num = Math.max(0, Number(value || 0));
  if (!Number.isFinite(num)) return "0";
  return Math.round(num).toLocaleString();
}

function activityChipHtml(inst) {
  const inflight = Math.max(0, Number(inst?.inflightRequests || 0));
  const maxInflight = Math.max(1, Number(inst?.maxInflightRequests || 1));
  const queueDepth = Math.max(0, Number(inst?.queueDepth || 0));
  const totalCompletionTokens = Math.max(0, Number(inst?.totalCompletionTokens || 0));
  const totalTokens = Math.max(0, Number(inst?.totalTokens || 0));
  const lastActivityMs = Date.parse(inst?.lastActivityAt || "");
  const isProcessing = inflight > 0;
  const recentlyActive = !isProcessing
    && Number.isFinite(lastActivityMs)
    && (Date.now() - lastActivityMs) <= 45000;
  const statusText = isProcessing ? "Processing" : (recentlyActive ? "Active" : "Idle");
  const statusClass = isProcessing ? "processing" : (recentlyActive ? "active" : "idle");
  const tokenCount = totalCompletionTokens > 0 ? totalCompletionTokens : totalTokens;
  const tokenText = tokenCount > 0 ? `tok:${formatCompactCount(tokenCount)}` : "";
  const activityAgoSec = recentlyActive
    ? Math.max(1, Math.round((Date.now() - lastActivityMs) / 1000))
    : null;

  return `
    <div class="activity-chip ${statusClass}">
      <span class="activity-dot"></span>
      <span>${statusText}</span>
      <span class="activity-count">${inflight}/${maxInflight}</span>
      ${queueDepth > 0 ? `<span class="activity-queue">q:${queueDepth}</span>` : ""}
      ${tokenText ? `<span class="activity-token">${tokenText}</span>` : ""}
      ${activityAgoSec !== null ? `<span class="activity-fresh">${activityAgoSec}s</span>` : ""}
    </div>
  `;
}

async function api(path, options = {}) {
  const headers = {
    "content-type": "application/json",
    ...(options.headers || {})
  };

  if (settings.token) {
    headers.authorization = `Bearer ${settings.token}`;
  }

  const response = await fetch(`${settings.apiBase}${path}`, {
    ...options,
    headers
  });

  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    throw new Error(data.error || text || `HTTP ${response.status}`);
  }

  return data;
}

function setGlobalApiStatusLabel(text) {
  const chip = $("globalApiStatus");
  if (chip) {
    chip.textContent = text;
  }
}

async function refreshGlobalApiAccess() {
  const select = $("globalApiMode");
  if (!select) return;

  try {
    const security = await api("/v1/settings/security");
    const requireApiKey = security?.api?.requireApiKey !== false;
    select.value = requireApiKey ? "require" : "open";
    setGlobalApiStatusLabel(`API access: ${requireApiKey ? "Require Key" : "Open"}`);
  } catch (error) {
    setGlobalApiStatusLabel("API access: unknown");
  }
}

function copy(value) {
  navigator.clipboard.writeText(value)
    .then(() => toast(`Copied: ${value}`))
    .catch(() => toast("Copy failed — clipboard not available"));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function parseContextLengthInput() {
  const preset = $("launchContextPreset").value;
  if (preset === "auto") {
    return "auto";
  }
  if (preset === "custom") {
    const custom = Number($("launchContextCustom").value);
    if (!Number.isInteger(custom) || custom < 256) {
      throw new Error("Custom context must be an integer >= 256");
    }
    return custom;
  }

  const presetValue = Number(preset);
  if (!Number.isInteger(presetValue) || presetValue < 256) {
    throw new Error("Invalid context preset selected");
  }
  return presetValue;
}

function parseOptionalPositiveIntegerInput(id) {
  const raw = String($(id).value || "").trim();
  if (!raw) return null;
  const num = Number(raw);
  if (!Number.isInteger(num) || num < 1) {
    throw new Error(`${id} must be a positive integer`);
  }
  return num;
}

function normalizeRuntimeBackend(value) {
  const raw = String(value || "auto").trim().toLowerCase();
  if (raw === "valkun") return "vulkan";
  if (["auto", "cuda", "cpu", "vulkan"].includes(raw)) return raw;
  return "auto";
}

function runtimeBackendUsesGpu(value) {
  return normalizeRuntimeBackend(value) !== "cpu";
}

function applyRuntimeBackendUi() {
  const backend = normalizeRuntimeBackend($("launchRuntimeBackend").value);
  const gpuSelect = $("launchGpus");
  const usesGpu = runtimeBackendUsesGpu(backend);
  gpuSelect.disabled = !usesGpu;
  if (!usesGpu) {
    Array.from(gpuSelect.options).forEach((opt) => {
      opt.selected = false;
      opt.disabled = true;
    });
    return;
  }

  Array.from(gpuSelect.options).forEach((opt) => {
    opt.disabled = false;
  });
  applyGpuAvailability();
}

async function loadRuntimeBackends({ silent = true } = {}) {
  const select = $("launchRuntimeBackend");
  const detail = $("launchRuntimeDetail");
  const current = normalizeRuntimeBackend(select.value || "auto");

  try {
    const payload = await api("/v1/system/runtime-backends");
    const options = Array.isArray(payload?.gguf_runtimes) && payload.gguf_runtimes.length > 0
      ? payload.gguf_runtimes
      : (Array.isArray(payload?.data) ? payload.data : []);
    runtimeBackendsCache = options;

    select.innerHTML = "";
    options.forEach((item) => {
      const value = normalizeRuntimeBackend(item.id);
      const option = document.createElement("option");
      option.value = value;
      const versionText = item.version ? ` v${item.version}` : "";
      option.textContent = `${item.label || value}${versionText}`;
      option.disabled = item.available === false;
      option.dataset.selectionId = item.id || value;
      option.dataset.runtimeLabel = item.label || value;
      option.dataset.detail = item.detail || "";
      select.appendChild(option);
    });

    if (select.options.length === 0) {
      ["auto", "cuda", "vulkan", "cpu"].forEach((backend) => {
        const option = document.createElement("option");
        option.value = backend;
        option.textContent = backend.toUpperCase();
        select.appendChild(option);
      });
    }

    select.value = Array.from(select.options).some((opt) => opt.value === current && !opt.disabled)
      ? current
      : "auto";
    if (detail) {
      const selectedOption = select.options[select.selectedIndex];
      detail.textContent = selectedOption?.dataset?.detail || "";
    }
    applyRuntimeBackendUi();
    if (!silent) {
      toast("Runtime backends updated");
    }
  } catch (error) {
    if (detail) {
      detail.textContent = "Runtime detection unavailable";
    }
    if (!silent) {
      toast(`Runtime backend load failed: ${error.message}`);
    }
  }
}

function formatGpuStats(inst) {
  const stats = Array.isArray(inst.gpuStats) ? inst.gpuStats : [];
  if (stats.length === 0) {
    const ids = Array.isArray(inst.gpus) ? inst.gpus : [];
    return ids.length > 0 ? `GPU ${ids.join(", ")} (telemetry pending)` : "-";
  }

  return stats.map((gpu) => {
    const used = Number(gpu.memory_used_mib ?? 0);
    const total = Number(gpu.memory_total_mib ?? 0);
    const memPct = total > 0 ? Math.round((used / total) * 100) : null;
    const temp = gpu.temperature_c ?? "n/a";
    const gClock = gpu.graphics_clock_mhz ?? "n/a";
    const mClock = gpu.memory_clock_mhz ?? "n/a";
    const util = gpu.utilization_percent ?? "n/a";
    return `GPU ${escapeHtml(gpu.id)}<br><span class="gpu-line">${escapeHtml(gpu.name || "Unknown")}</span><br><span class="gpu-line">mem ${used}/${total} MiB${memPct !== null ? ` (${memPct}%)` : ""} • util ${util}%</span><br><span class="gpu-line">temp ${temp}C • gfx ${gClock} MHz • mem ${mClock} MHz</span>`;
  }).join("<hr class=\"gpu-divider\" />");
}

function downloadTextFile(filename, content) {
  const blob = new Blob([content], { type: "application/yaml" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function activeInstances(data = instancesCache) {
  return (data || []).filter((inst) => inst.state !== "stopped");
}

function occupiedPortsSet() {
  const set = new Set();
  activeInstances().forEach((inst) => {
    if (Number.isInteger(Number(inst.port))) {
      set.add(Number(inst.port));
    }
  });
  return set;
}

function occupiedGpuSet() {
  const set = new Set();
  activeInstances().forEach((inst) => {
    (inst.gpus || []).forEach((gpu) => set.add(String(gpu)));
  });
  return set;
}

function suggestNextFreePort(start = 1234) {
  const occupied = occupiedPortsSet();
  for (let p = start; p <= 65535; p += 1) {
    if (!occupied.has(p)) {
      return p;
    }
  }
  return start;
}

function applyGpuAvailability() {
  const select = $("launchGpus");
  if (!select) return;
  const occupied = occupiedGpuSet();
  const currentlySelected = new Set(Array.from(select.selectedOptions).map((opt) => opt.value));

  Array.from(select.options).forEach((opt) => {
    const inUse = occupied.has(opt.value);
    if (inUse && currentlySelected.has(opt.value)) {
      opt.selected = false;
    }
    opt.disabled = inUse;
    if (inUse) {
      if (!opt.textContent.includes("(in use)")) {
        opt.dataset.cleanLabel = opt.dataset.cleanLabel || opt.textContent;
        opt.textContent = `${opt.dataset.cleanLabel} (in use)`;
      }
    } else if (opt.dataset.cleanLabel) {
      opt.textContent = opt.dataset.cleanLabel;
    }
  });
}

$("openHelp").onclick = () => {
  const base = (settings.apiBase || "").trim().replace(/\/$/, "");
  if (!base) {
    toast("Set API Base URL first");
    return;
  }
  window.open(`${base}/help`, "_blank", "noopener,noreferrer");
};

$("saveGlobalApi").onclick = async () => {
  try {
    saveToken($("globalApiToken").value);
    const requireApiKey = $("globalApiMode").value === "require";
    await api("/v1/settings/security", {
      method: "PUT",
      body: JSON.stringify({
        api: {
          requireApiKey
        }
      })
    });
    await refreshGlobalApiAccess();
    toast(`API access updated: ${requireApiKey ? "Require Key" : "Open"}`);
  } catch (error) {
    toast(`API access update failed: ${error.message}`);
  }
};

$("globalApiToken").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void $("saveGlobalApi").click();
  }
});

$("closeAll").onclick = async () => {
  const confirmed = window.confirm("Unload all instances and stop LM Studio server now?");
  if (!confirmed) {
    return;
  }

  const closePoll = setInterval(() => {
    void refreshInstances();
  }, 1000);
  setOperationPending({
    type: "system-close",
    startedAt: Date.now()
  });

  try {
    const payload = await api("/v1/system/close", {
      method: "POST",
      body: JSON.stringify({ unloadModels: true, stopDaemon: true })
    });
    toast("All instances closed and models unloaded");
    $("configLibraryResult").textContent = JSON.stringify(payload, null, 2);
    await refreshInstances();
    window.close();
  } catch (error) {
    toast(`Close failed: ${error.message}`);
  } finally {
    clearInterval(closePoll);
    setOperationPending(null);
  }
};

async function loadLMStudioModels(selectElementId) {
  const select = $(selectElementId);
  const currentValue = select.value;

  function applyModels(models, sourceLabel) {
    select.innerHTML = '<option value="">-- Select model --</option>';
    models.forEach((model) => {
      const option = document.createElement("option");
      option.value = model.id;
      option.textContent = model.name || model.id;
      select.appendChild(option);
    });

    if (currentValue) {
      select.value = currentValue;
    }

    toast(`Loaded ${models.length} models (${sourceLabel})`);
  }

  try {
    const { models = [] } = await api("/v1/lmstudio/models");
    if (models.length > 0) {
      applyModels(models, "LM Studio");
      return;
    }
  } catch {
    // Fall through to instances-based model discovery.
  }

  try {
    const { data = [] } = await api("/v1/instances");
    const unique = new Set();
    for (const item of data) {
      const model = String(item?.effectiveModel || "").trim();
      if (model) {
        unique.add(model);
      }
    }

    const fallbackModels = [...unique].map((id) => ({ id, name: id }));
    if (fallbackModels.length > 0) {
      applyModels(fallbackModels, "running instances");
      return;
    }

    select.innerHTML = '<option value="">-- No models discovered --</option>';
    toast("No models discovered. Start LM Studio server or run an instance first.");
  } catch (error) {
    toast(`Models load failed: ${error.message}`);
  }
}

async function loadSystemGpus(selectElementId = "launchGpus") {
  try {
    const { data = [], warning, diagnostics } = await api("/v1/system/gpus");
    gpuTelemetryCache = data;
    const gpusSelect = $(selectElementId);
    const currentSelected = Array.from(gpusSelect.selectedOptions).map((opt) => opt.value);

    gpusSelect.innerHTML = "";
    data.forEach((gpu) => {
      const option = document.createElement("option");
      option.value = gpu.id;
      const temp = gpu.temperature_c ?? "n/a";
      const util = gpu.utilization_percent ?? "n/a";
      option.textContent = `GPU ${gpu.id}: ${gpu.name} (${gpu.memory_total_mib} MiB, util ${util}%, ${temp}C)`;
      if (currentSelected.includes(gpu.id)) {
        option.selected = true;
      }
      gpusSelect.appendChild(option);
    });

    applyRuntimeBackendUi();

    if (warning) {
      const diagDetail = diagnostics?.detail ? ` (${diagnostics.detail})` : "";
      toast(`GPU runtime warning: ${warning}${diagDetail}`);
      return;
    }

    toast(`Loaded ${data.length} GPUs`);
  } catch (error) {
    toast(`GPU load failed: ${error.message}`);
  }
}

// Auto-load on page load
window.addEventListener("load", () => {
  setTimeout(() => loadSystemGpus("launchGpus"), 300);
  setTimeout(() => loadLMStudioModels("launchInstanceModel"), 450);
  setTimeout(() => loadRuntimeBackends({ silent: false }), 520);
});

$("launchInstance").onclick = async () => {
  try {
    const name = $("launchName").value.trim();
    const port = Number($("launchPort").value);
    const model = $("launchInstanceModel").value.trim();
    const runtimeSelect = $("launchRuntimeBackend");
    const runtimeBackend = normalizeRuntimeBackend(runtimeSelect.value);
    const runtimeOption = runtimeSelect.options[runtimeSelect.selectedIndex];
    const runtimeSelection = runtimeOption?.dataset?.selectionId || runtimeBackend;
    const runtimeLabel = runtimeOption?.dataset?.runtimeLabel || runtimeBackend;
    let selectedGpus = Array.from($("launchGpus").selectedOptions).map((opt) => opt.value);

    if (!name) {
      toast("Instance name is required");
      return;
    }

    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      toast("Valid port is required");
      return;
    }

    const occupiedPorts = occupiedPortsSet();
    if (occupiedPorts.has(port)) {
      toast(`Port ${port} is already in use by a running instance`);
      return;
    }

    if (runtimeBackendUsesGpu(runtimeBackend)) {
      const occupiedGpus = occupiedGpuSet();
      const gpuConflict = selectedGpus.find((g) => occupiedGpus.has(String(g)));
      if (gpuConflict) {
        toast(`GPU ${gpuConflict} is already assigned to a running instance`);
        return;
      }
    } else {
      selectedGpus = [];
    }

    if (!model) {
      toast("Model selection is required");
      return;
    }

    const contextLength = parseContextLengthInput();

    const payload = {
      name,
      port,
      model,
      bindHost: "127.0.0.1",
      gpus: selectedGpus,
      maxInflightRequests: Number($("launchInflight").value || 4),
      queueLimit: Number($("launchQueueLimit").value || 64),
      modelParallel: Number($("launchModelParallel").value || 1),
      modelTtlSeconds: parseOptionalPositiveIntegerInput("launchModelTtl"),
      restartPolicy: {
        mode: String($("launchRestartMode").value || "never"),
        maxRetries: Number($("launchRestartRetries").value || 2),
        backoffMs: Number($("launchRestartBackoffMs").value || 3000)
      },
      runtimeBackend,
      runtimeSelection,
      runtimeLabel,
      contextLength
    };

    const launchPoll = setInterval(() => {
      void refreshInstances();
    }, 1000);
    setOperationPending({
      type: "launch",
      name,
      host: "127.0.0.1",
      port,
      startedAt: Date.now()
    });

    try {
      await api("/v1/instances/start", {
        method: "POST",
        body: JSON.stringify(payload)
      });
    } finally {
      clearInterval(launchPoll);
      setOperationPending(null);
    }
    toast("Instance started");
    await refreshInstances();
  } catch (error) {
    toast(`Start failed: ${error.message}`);
  }
};

async function refreshInstances() {
  try {
    const { data, gpus } = await api("/v1/instances");
    if (Array.isArray(gpus)) {
      gpuTelemetryCache = gpus;
    }
    instancesCache = data || [];
    const tbody = $("instanceRows");
    const openOptionsByInstance = new Set(
      Array.from(tbody.querySelectorAll("details.action-more[open]"))
        .map((el) => el.getAttribute("data-instance-id"))
        .filter(Boolean)
    );
    tbody.innerHTML = "";
    const logsSelect = $("logsInstanceSelect");
    const selectedLogInstance = logsSelect.value;

    logsSelect.innerHTML = '<option value="">-- Select instance --</option>';

    for (const inst of data || []) {
      const opt = document.createElement("option");
      opt.value = inst.id;
      opt.textContent = `${inst.id} (${inst.state})`;
      logsSelect.appendChild(opt);

      const tr = document.createElement("tr");
      const normalizedState = String(inst.state || "unknown").toLowerCase();
      tr.setAttribute("data-state", normalizedState);
      const baseUrl = String(inst.baseUrl || `http://${inst.host || "127.0.0.1"}:${inst.port}`);
      const proxyBaseUrl = String(inst.proxyBaseUrl || `${settings.apiBase}/v1/instances/${encodeURIComponent(inst.id)}/proxy/v1`);
      const runtimeBackend = normalizeRuntimeBackend(inst.runtime?.hardware || "auto");
      const runtimeLabel = inst.runtime?.label || runtimeBackend;
      const isStopped = String(inst.state || "").toLowerCase() === "stopped";
      const primaryAction = isStopped
        ? `<button class="delete" data-action="delete" data-id="${inst.id}">Remove</button>`
        : `<button data-action="stop" data-id="${inst.id}">Stop</button>`;
      const drainAction = isStopped
        ? ""
        : `<button data-action="drain" data-id="${inst.id}" data-enabled="${inst.drain ? "false" : "true"}">${inst.drain ? "\u25b6 Resume Intake" : "\u23f8 Pause Intake"}</button>`;
      const forceStopAction = isStopped
        ? ""
        : `<button class="kill" data-action="kill" data-id="${inst.id}">Force Stop</button>`;
      const removeSecondaryAction = isStopped
        ? ""
        : `<button class="delete" data-action="delete" data-id="${inst.id}">Remove</button>`;

      tr.innerHTML = `
        <td>${inst.id}</td>
        <td>
          ${stateChipHtml(inst.state)}
          ${activityChipHtml(inst)}
        </td>
        <td>
          <div>${escapeHtml(inst.effectiveModel || "-")}</div>
          <div class="runtime-meta">ctx: ${inst.contextLength || "auto"}</div>
          <div class="runtime-meta">runtime: ${escapeHtml(runtimeLabel)}</div>
        </td>
        <td>${inst.port}</td>
        <td class="gpu-cell">${formatGpuStats(inst)}</td>
        <td class="actions-cell">
          <div class="action-primary">
            ${primaryAction}
          </div>
          <details class="action-more" data-instance-id="${inst.id}" ${openOptionsByInstance.has(String(inst.id)) ? "open" : ""}>
            <summary>Options</summary>
            <div class="action-secondary">
              ${drainAction}
              ${forceStopAction}
              <div class="action-copy-grid">
                <button class="copy" data-action="copy-base" data-id="${inst.id}" data-copy="${proxyBaseUrl}">Proxy Base URL</button>
                <button class="copy" data-action="copy-chat" data-id="${inst.id}" data-copy="${proxyBaseUrl}/chat/completions">Proxy Chat URL</button>
              </div>
              <button class="copy" data-action="copy-model" data-id="${inst.id}" data-copy="${inst.effectiveModel}">Copy Model ID</button>
              ${removeSecondaryAction}
            </div>
          </details>
        </td>
      `;

      tbody.appendChild(tr);
    }

    if (selectedLogInstance) {
      logsSelect.value = selectedLogInstance;
    }

    if (!logsSelect.value && logsSelect.options.length > 1) {
      logsSelect.selectedIndex = 1;
    }

    const launchPort = $("launchPort");
    if (launchPort && occupiedPortsSet().has(Number(launchPort.value))) {
      launchPort.value = String(suggestNextFreePort(1234));
    }

    applyGpuAvailability();

    tbody.querySelectorAll("button[data-action]").forEach((btn) => {
      btn.onclick = async () => {
        const id = btn.getAttribute("data-id");
        const action = btn.getAttribute("data-action");
        try {
          if (action === "stop") {
            const confirmed = window.confirm(`Stop instance ${id}?`);
            if (!confirmed) return;
            await api(`/v1/instances/${id}/stop`, { method: "POST", body: "{}" });
          } else if (action === "kill") {
            const confirmed = window.confirm(`Force stop instance ${id}?`);
            if (!confirmed) return;
            await api(`/v1/instances/${id}/kill`, {
              method: "POST",
              body: JSON.stringify({ reason: "operator" })
            });
          } else if (action === "drain") {
            const enable = btn.getAttribute("data-enabled") === "true";
            await api(`/v1/instances/${id}/drain`, {
              method: "POST",
              body: JSON.stringify({ enabled: enable })
            });
          } else if (action === "delete") {
            const confirmed = window.confirm(`Remove instance ${id} from LM Launch?`);
            if (!confirmed) return;
            await api(`/v1/instances/${id}`, {
              method: "DELETE"
            });
          } else if (action === "copy-base" || action === "copy-chat" || action === "copy-model") {
            copy(btn.getAttribute("data-copy") || "");
            return;
          }

          toast(`Action ${action} applied on ${id}`);
          await refreshInstances();
        } catch (error) {
          toast(`Action failed: ${error.message}`);
        }
      };
    });
  } catch (error) {
    toast(`Instances refresh failed: ${error.message}`);
  }
}

$("refreshInstances").onclick = refreshInstances;

$("refreshLogs").onclick = async () => {
  try {
    const instanceId = $("logsInstanceSelect").value.trim();
    if (!instanceId) {
      toast("Select an instance first");
      return;
    }
    const lines = Number($("logsLines").value || 200);
    const data = await api(`/v1/instances/${instanceId}/logs?lines=${lines}`);
    $("logsView").textContent = data.data || "";
  } catch (error) {
    toast(`Logs refresh failed: ${error.message}`);
  }
};

$("clearLogs").onclick = () => {
  $("logsView").textContent = "";
};

$("copyLogs").onclick = () => {
  copy($("logsView").textContent || "");
};

async function refreshConfigLibrary() {
  try {
    const { data = [] } = await api("/v1/instance-configs");
    const select = $("savedConfigSelect");
    const previous = select.value;
    select.innerHTML = data.length === 0
      ? '<option value="">-- No saved configs --</option>'
      : '<option value="">-- Select saved config --</option>';

    for (const cfg of data) {
      const option = document.createElement("option");
      option.value = cfg.id;
      option.textContent = `${cfg.name} (${cfg.instanceCount} instances)`;
      select.appendChild(option);
    }

    if (previous && Array.from(select.options).some((opt) => opt.value === previous)) {
      select.value = previous;
    }

    $("configLibraryResult").textContent = data.length === 0
      ? "No saved configs yet. Save current instances to create one."
      : `Saved configs: ${data.length}`;
  } catch (error) {
    $("configLibraryResult").textContent = `Config list unavailable: ${error.message}`;
  }
}

$("saveCurrentConfig").onclick = async () => {
  try {
    const name = $("configName").value.trim() || `Config ${new Date().toLocaleString()}`;
    const payload = await api("/v1/instance-configs/save-current", {
      method: "POST",
      body: JSON.stringify({ name })
    });
    $("configLibraryResult").textContent = JSON.stringify(payload, null, 2);
    toast("Current config saved");
    await refreshConfigLibrary();
    $("savedConfigSelect").value = payload.id;
  } catch (error) {
    toast(`Save config failed: ${error.message}`);
  }
};

$("loadSelectedConfig").onclick = async () => {
  try {
    const id = $("savedConfigSelect").value;
    if (!id) {
      toast("Select a saved config first");
      return;
    }

    const cfgSelect = $("savedConfigSelect");
    const cfgName = cfgSelect.options[cfgSelect.selectedIndex]?.textContent || id;
    const loadPoll = setInterval(() => {
      void refreshInstances();
    }, 1000);
    setOperationPending({
      type: "config-load",
      name: cfgName,
      startedAt: Date.now()
    });

    let payload;
    try {
      payload = await api(`/v1/instance-configs/${id}/load`, {
        method: "POST",
        body: JSON.stringify({ replaceExisting: true })
      });
    } finally {
      clearInterval(loadPoll);
      setOperationPending(null);
    }

    $("configLibraryResult").textContent = JSON.stringify(payload, null, 2);
    toast(`Loaded config: started ${payload.started?.length || 0}, failed ${payload.failed?.length || 0}`);
    await refreshInstances();
  } catch (error) {
    toast(`Load config failed: ${error.message}`);
  }
};

$("deleteSelectedConfig").onclick = async () => {
  try {
    const id = $("savedConfigSelect").value;
    if (!id) {
      toast("Select a saved config first");
      return;
    }

    await api(`/v1/instance-configs/${id}`, { method: "DELETE" });
    toast("Config deleted");
    await refreshConfigLibrary();
  } catch (error) {
    toast(`Delete config failed: ${error.message}`);
  }
};

$("exportCurrentConfig").onclick = async () => {
  try {
    const response = await fetch(`${settings.apiBase}/v1/instance-configs/current/export.yaml`, {
      headers: {
        authorization: `Bearer ${settings.token}`
      }
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(text || `HTTP ${response.status}`);
    }
    downloadTextFile("instance-config-current.yaml", text);
    toast("Exported current config YAML");
  } catch (error) {
    toast(`Export current failed: ${error.message}`);
  }
};

$("exportSelectedConfig").onclick = async () => {
  try {
    const id = $("savedConfigSelect").value;
    if (!id) {
      toast("Select a saved config first");
      return;
    }

    const response = await fetch(`${settings.apiBase}/v1/instance-configs/${id}/export.yaml`, {
      headers: {
        authorization: `Bearer ${settings.token}`
      }
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(text || `HTTP ${response.status}`);
    }
    downloadTextFile(`instance-config-${id}.yaml`, text);
    toast("Exported selected config YAML");
  } catch (error) {
    toast(`Export selected failed: ${error.message}`);
  }
};

$("launchContextPreset").onchange = () => {
  const customInput = $("launchContextCustom");
  const isCustom = $("launchContextPreset").value === "custom";
  customInput.disabled = !isCustom;
  if (!isCustom) {
    customInput.value = "";
  }
};

$("launchRuntimeBackend").onchange = () => {
  applyRuntimeBackendUi();
  const select = $("launchRuntimeBackend");
  const detail = $("launchRuntimeDetail");
  if (detail) {
    const selectedOption = select.options[select.selectedIndex];
    detail.textContent = selectedOption?.dataset?.detail || "";
  }
};

function applyRestartPolicyUi() {
  const mode = String($("launchRestartMode").value || "never");
  const disabled = mode !== "on-failure";
  $("launchRestartRetries").disabled = disabled;
  $("launchRestartBackoffMs").disabled = disabled;
}

$("launchRestartMode").onchange = () => {
  applyRestartPolicyUi();
};

$("launchInstanceModel").onchange = () => {
  const nameInput = $("launchName");
  if (String(nameInput.value || "").trim()) {
    return;
  }

  const rawModel = String($("launchInstanceModel").value || "").trim();
  if (!rawModel) {
    return;
  }

  const base = rawModel
    .split("/")
    .pop()
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();

  if (base) {
    nameInput.value = base;
  }
};

syncGlobalApiTokenInput();
void refreshGlobalApiAccess();
refreshInstances();
refreshConfigLibrary();
loadRuntimeBackends({ silent: true });
applyRestartPolicyUi();
setInterval(refreshInstances, 2000);
setInterval(() => loadSystemGpus("launchGpus"), 15000);
setInterval(() => loadRuntimeBackends({ silent: true }), 60000);
