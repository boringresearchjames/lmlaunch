const DEFAULT_LOCAL_API_BASE = "http://localhost:8081";

function normalizeApiBase(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw.replace(/\/$/, "");
}

function resolveInitialApiBase() {
  const params = new URLSearchParams(window.location.search || "");
  const queryBase = normalizeApiBase(params.get("apiBase"));
  const storedBase = normalizeApiBase(localStorage.getItem("apiBase") || "");

  if (queryBase) {
    localStorage.setItem("apiBase", queryBase);
    return queryBase;
  }

  if (storedBase) {
    return storedBase;
  }

  const origin = normalizeApiBase(window.location.origin);
  if (window.location.protocol !== "file:" && origin && origin !== "null") {
    return origin;
  }

  return DEFAULT_LOCAL_API_BASE;
}

const settings = {
  apiBase: resolveInitialApiBase(),
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
let operationPending = null;
let operationStatusTimer = null;
let instanceTestTargetId = null;

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
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(value)
      .then(() => toast(`Copied: ${value.slice(0, 80)}`))
      .catch(() => copyFallback(value));
  } else {
    copyFallback(value);
  }
}
function copyFallback(value) {
  const ta = document.createElement('textarea');
  ta.value = value;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try {
    document.execCommand('copy');
    toast(`Copied: ${value.slice(0, 80)}`);
  } catch (e) {
    toast('Copy failed');
  }
  document.body.removeChild(ta);
}

function closeInstanceTestDialog() {
  const dialog = $("instanceTestDialog");
  if (!dialog) return;
  if (typeof dialog.close === "function") {
    dialog.close();
  } else {
    dialog.removeAttribute("open");
  }
}

function openInstanceTestDialog(instanceId) {
  const dialog = $("instanceTestDialog");
  const meta = $("instanceTestMeta");
  const result = $("instanceTestResult");
  if (!dialog || !meta || !result) {
    toast("Diagnostic dialog unavailable");
    return;
  }

  const inst = instancesCache.find((x) => String(x.id) === String(instanceId));
  if (!inst) {
    toast("Instance not found for diagnostic test");
    return;
  }

  instanceTestTargetId = String(instanceId);
  const serverArgs = Array.isArray(inst.runtime?.serverArgs) && inst.runtime.serverArgs.length > 0
    ? inst.runtime.serverArgs.join(' ')
    : '(none)';
  const ctxLen = inst.contextLength != null ? String(inst.contextLength) : 'auto';
  const gpuList = Array.isArray(inst.gpus) && inst.gpus.length > 0 ? inst.gpus.join(', ') : 'none';
  const backend = inst.runtime?.hardware || 'auto';
  meta.textContent = [
    `id: ${inst.id}  •  model: ${inst.effectiveModel || 'unknown'}  •  port: ${inst.port}`,
    `server args: ${serverArgs}`,
    `context: ${ctxLen}  •  backend: ${backend}  •  gpus: ${gpuList}`
  ].join('\n');
  result.textContent = "Ready. Click Send Test Prompt.";

  if (typeof dialog.showModal === "function") {
    dialog.showModal();
  } else {
    dialog.setAttribute("open", "open");
  }
}

async function sendInstanceDiagnosticPrompt() {
  const result = $("instanceTestResult");
  const sendBtn = $("instanceTestSend");
  const promptInput = $("instanceTestPrompt");
  const targetId = String(instanceTestTargetId || "").trim();

  if (!targetId) {
    toast("Select an instance first");
    return;
  }

  const inst = instancesCache.find((x) => String(x.id) === targetId);
  if (!inst) {
    toast("Selected instance is no longer available");
    return;
  }

  const prompt = String(promptInput?.value || "").trim();
  if (!prompt) {
    toast("Prompt cannot be empty");
    return;
  }

  const modelId = String(inst.effectiveModel || inst.pendingModel || "").trim();
  if (!modelId) {
    toast("Instance model is unknown; cannot send diagnostic prompt");
    return;
  }

  const payload = {
    model: modelId,
    messages: [
      { role: "system", content: "You are a concise diagnostics assistant." },
      { role: "user", content: prompt }
    ],
    temperature: 0,
    max_tokens: 64,
    stream: false
  };

  sendBtn.disabled = true;
  const startedAt = Date.now();
  result.textContent = "Running diagnostic request...";

  try {
    const response = await api(`/v1/instances/${encodeURIComponent(targetId)}/proxy/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify(payload)
    });
    const latencyMs = Date.now() - startedAt;
    const contentParts = [];
    const choice = response?.choices?.[0] || null;
    const msgContent = choice?.message?.content;

    const pushText = (value) => {
      if (typeof value === "string") {
        const cleaned = value.trim();
        if (cleaned) {
          contentParts.push(cleaned);
        }
      }
    };

    if (typeof msgContent === "string") {
      pushText(msgContent);
    } else if (Array.isArray(msgContent)) {
      for (const part of msgContent) {
        if (typeof part === "string") {
          pushText(part);
          continue;
        }
        const textCandidates = [
          part?.text,
          part?.content,
          part?.value,
          part?.output_text,
          part?.reasoning,
          part?.reasoning_content
        ];
        for (const candidate of textCandidates) {
          pushText(candidate);
        }
      }
    } else if (msgContent && typeof msgContent === "object") {
      const textCandidates = [
        msgContent?.text,
        msgContent?.content,
        msgContent?.value,
        msgContent?.output_text,
        msgContent?.reasoning,
        msgContent?.reasoning_content
      ];
      for (const candidate of textCandidates) {
        pushText(candidate);
      }
      if (Array.isArray(msgContent?.parts)) {
        for (const part of msgContent.parts) {
          pushText(part?.text ?? part?.content ?? part?.value);
        }
      }
    }

    if (contentParts.length === 0) {
      pushText(choice?.text);
      pushText(choice?.message?.reasoning_content);
      pushText(choice?.message?.reasoning);
      pushText(choice?.delta?.content);
      pushText(response?.content);
      pushText(response?.text);
      pushText(response?.output_text);
      pushText(response?.completion_message?.content);
      pushText(response?.completion_message?.text);
    }

    if (contentParts.length === 0 && Array.isArray(response?.output)) {
      for (const item of response.output) {
        const segments = Array.isArray(item?.content) ? item.content : [];
        for (const seg of segments) {
          pushText(seg?.text ?? seg?.content ?? seg?.value ?? seg?.output_text);
        }
      }
    }

    const content = contentParts.join("\n").trim();
    const usage = response?.usage || null;
    const hasVisibleText = content.length > 0;
    const rawPayload = JSON.stringify(response, null, 2);
    const responsePreview = hasVisibleText ? content : "(empty response text)";

    result.textContent = [
      `status: ok`,
      `instance: ${targetId}`,
      `model: ${modelId}`,
      `latency_ms: ${latencyMs}`,
      `finish_reason: ${choice?.finish_reason || "n/a"}`,
      usage ? `usage: prompt=${usage.prompt_tokens || 0} completion=${usage.completion_tokens || 0} total=${usage.total_tokens || 0}` : "usage: n/a",
      "",
      "response:",
      responsePreview || "(empty response)",
      "",
      "raw_payload:",
      rawPayload ? rawPayload.slice(0, 6000) : "(none)"
    ].join("\n");
    toast(`Diagnostic test succeeded for ${targetId}`);
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    result.textContent = [
      `status: failed`,
      `instance: ${targetId}`,
      `latency_ms: ${latencyMs}`,
      "",
      `error: ${error.message}`
    ].join("\n");
    toast(`Diagnostic test failed: ${error.message}`);
  } finally {
    sendBtn.disabled = false;
  }
}

async function runInstanceSpeedTest() {
  const result = $('instanceTestResult');
  const sendBtn = $('instanceTestSend');
  const speedBtn = $('instanceTestSpeedTest');
  const targetId = String(instanceTestTargetId || '').trim();

  if (!targetId) { toast('Select an instance first'); return; }

  const inst = instancesCache.find((x) => String(x.id) === targetId);
  if (!inst) { toast('Instance not found'); return; }

  const modelId = String(inst.effectiveModel || inst.pendingModel || '').trim();
  if (!modelId) { toast('Instance model is unknown; cannot run speed test'); return; }

  if (sendBtn) sendBtn.disabled = true;
  if (speedBtn) speedBtn.disabled = true;
  result.textContent = 'Running speed test — streaming 300 tokens...';

  const payload = {
    model: modelId,
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Write a detailed, thorough explanation of how transformer neural networks work, covering self-attention, positional encoding, feed-forward layers, and training.' }
    ],
    temperature: 0.7,
    max_tokens: 300,
    stream: true,
    stream_options: { include_usage: true }
  };

  const startMs = Date.now();
  let firstTokenMs = null;
  let lastTokenMs = null;
  let chunkCount = 0;
  let fullText = '';
  let usage = null;

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (settings.token) headers['Authorization'] = `Bearer ${settings.token}`;
    const url = `${settings.apiBase}/v1/instances/${encodeURIComponent(targetId)}/proxy/v1/chat/completions`;

    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errText.slice(0, 200)}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (raw === '[DONE]') continue;
        try {
          const chunk = JSON.parse(raw);
          if (chunk.usage) usage = chunk.usage;
          const delta = chunk?.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta.length > 0) {
            if (firstTokenMs === null) firstTokenMs = Date.now();
            lastTokenMs = Date.now();
            chunkCount++;
            fullText += delta;
          }
        } catch { /* ignore malformed chunks */ }
      }
    }

    const totalMs = Date.now() - startMs;
    const ttftMs = firstTokenMs !== null ? firstTokenMs - startMs : null;
    const genMs = (firstTokenMs !== null && lastTokenMs !== null) ? (lastTokenMs - firstTokenMs) : totalMs;

    const completionTokens = usage?.completion_tokens ?? chunkCount;
    const promptTokens = usage?.prompt_tokens ?? 'n/a';
    const tps = (genMs > 100 && completionTokens > 0)
      ? (completionTokens / (genMs / 1000)).toFixed(2)
      : 'n/a';
    const modelBasename = modelId.split('/').pop().split('\\').pop();

    result.textContent = [
      '=== SPEED TEST RESULTS ===',
      '',
      `  tokens/sec (gen):  ${tps} tok/s`,
      `  time to 1st token: ${ttftMs !== null ? ttftMs + ' ms' : 'n/a'}`,
      `  total latency:     ${totalMs} ms`,
      `  completion tokens: ${completionTokens}`,
      `  prompt tokens:     ${promptTokens}`,
      `  generation time:   ${genMs} ms`,
      '',
      `  instance: ${targetId}`,
      `  model: ${modelBasename}`,
      '',
      '--- response preview (first 300 chars) ---',
      fullText.trim().slice(0, 300) || '(empty)'
    ].join('\n');
    toast(`Speed test done: ${tps} tok/s`);
  } catch (error) {
    const elapsed = Date.now() - startMs;
    result.textContent = [
      'status: speed test failed',
      `instance: ${targetId}`,
      `elapsed_ms: ${elapsed}`,
      '',
      `error: ${error.message}`
    ].join('\n');
    toast(`Speed test failed: ${error.message}`);
  } finally {
    if (sendBtn) sendBtn.disabled = false;
    if (speedBtn) speedBtn.disabled = false;
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// Show only the last 3 path segments (author/repo/file.gguf) for display
function trimModelPath(modelPath) {
  const parts = String(modelPath).replace(/\\/g, "/").split("/");
  return parts.length > 3 ? parts.slice(-3).join("/") : modelPath;
}

// Trim all absolute file paths within an args string to last 3 segments
function trimArgsModelPaths(args) {
  return String(args).replace(/\/[^\s]+\.gguf/g, (match) => trimModelPath(match));
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
  if (raw === "cuda_full" || raw.includes("cuda12")) return "cuda_full";
  if (raw.includes("cuda")) return "cuda";
  if (raw === "rocm_full") return "rocm_full";
  if (raw.includes("rocm")) return "rocm";
  if (raw.includes("vulkan")) return "vulkan";
  if (raw.includes("cpu")) return "cpu";
  if (raw.includes("auto")) return "auto";
  if (["auto", "cuda", "cuda_full", "rocm", "rocm_full", "cpu", "vulkan"].includes(raw)) return raw;
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
    const power = gpu.power_draw_w != null ? `${Number(gpu.power_draw_w).toFixed(1)} W` : null;
    const powerStr = power ? ` • pwr ${power}` : "";
    return `GPU ${escapeHtml(gpu.id)}<br><span class="gpu-line">${escapeHtml(gpu.name || "Unknown")}</span><br><span class="gpu-line">mem ${used}/${total} MiB${memPct !== null ? ` (${memPct}%)` : ""} • util ${util}%${powerStr}</span><br><span class="gpu-line">temp ${temp}C • gfx ${gClock} MHz • mem ${mClock} MHz</span>`;
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
    // Reload dropdowns — they may have been empty because the token wasn't set
    // at page load time.
    void loadSystemGpus("launchGpus");
    void loadModelList("launchInstanceModel");
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
  const confirmed = window.confirm("Stop all running instances now?");
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

async function loadModelList(selectElementId) {
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
    const { data = [], warning } = await api("/v1/local-models");
    if (data.length > 0) {
      applyModels(data, "local files");
      if (warning) toast(`Models: ${warning}`);
      return;
    }

    // Fallback: models from running instances
    const { data: instances = [] } = await api("/v1/instances");
    const unique = new Set();
    for (const item of instances) {
      const model = String(item?.effectiveModel || "").trim();
      if (model) unique.add(model);
    }
    const fallbackModels = [...unique].map((id) => ({ id, name: id }));
    if (fallbackModels.length > 0) {
      applyModels(fallbackModels, "running instances");
      return;
    }

    select.innerHTML = '<option value="">-- No models found --</option>';
    if (warning) {
      toast(`No models found: ${warning}`);
    } else {
      toast("No .gguf files found. Check MODELS_DIR in llamafleet.env (also scans Ollama, HuggingFace, and Unsloth defaults).");
    }
  } catch (error) {
    const hint = error.message.includes("401") || error.message.toLowerCase().includes("unauthorized")
      ? " — enter your API token above and save"
      : "";
    toast(`Models load failed: ${error.message}${hint}`);
  }
}

async function loadSystemGpus(selectElementId = "launchGpus") {
  try {
    const { data = [], warning, diagnostics } = await api("/v1/gpus");
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
    const hint = error.message.includes("401") || error.message.toLowerCase().includes("unauthorized")
      ? " — enter your API token above and save"
      : "";
    toast(`GPU load failed: ${error.message}${hint}`);
  }
}

// Auto-load on page load
window.addEventListener("load", () => {
  setTimeout(() => loadSystemGpus("launchGpus"), 300);
  setTimeout(() => loadModelList("launchInstanceModel"), 450);
  $('launchInstanceModel').addEventListener('change', () => autoDetectMmproj());
});

async function autoDetectMmproj() {
  const modelPath = ($("launchInstanceModel")?.value || "").trim();
  const mmprojInput = $("launchMmproj");
  if (!mmprojInput || !modelPath) return;
  // Only auto-fill if field is empty or was previously auto-filled
  if (mmprojInput.value && !mmprojInput.dataset.autoFilled) return;

  try {
    const data = await api("/v1/local-models");
    const models = Array.isArray(data?.data) ? data.data : [];
    const dir = modelPath.replace(/[/\\][^/\\]+$/, "");
    const mmproj = models.find((m) => {
      const p = String(m.id || m);
      return p.startsWith(dir) && p.toLowerCase().includes("mmproj");
    });
    if (mmproj) {
      mmprojInput.value = String(mmproj.id || mmproj);
      mmprojInput.dataset.autoFilled = "1";
    } else {
      if (mmprojInput.dataset.autoFilled) {
        mmprojInput.value = "";
        mmprojInput.dataset.autoFilled = "1";
      }
    }
  } catch (_) {
    // silent — mmproj detection is best-effort
  }
}

$("launchInstance").onclick = async () => {
  try {
    const name = $("launchName").value.trim();
    const port = Number($("launchPort").value);
    const model = $("launchInstanceModel").value.trim();
    const runtimeBackend = normalizeRuntimeBackend($('launchRuntimeBackend').value);
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

    const baseRuntimeArgs = String($('launchServerArgs').value || '').trim().split(/\s+/).filter(Boolean);
    const mmprojPath = ($('launchMmproj')?.value || '').trim();
    const alreadyHasMmproj = baseRuntimeArgs.some((a) => a === '--mmproj');
    if (mmprojPath && !alreadyHasMmproj) {
      baseRuntimeArgs.push('--mmproj', mmprojPath);
    }

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
      contextLength,
      runtimeArgs: baseRuntimeArgs
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
      opt.textContent = `${inst.profileName || inst.id} (${inst.state})`;
      logsSelect.appendChild(opt);

      const tr = document.createElement("tr");
      const normalizedState = String(inst.state || "unknown").toLowerCase();
      tr.setAttribute("data-state", normalizedState);
      const baseUrl = String(inst.baseUrl || `http://${inst.host || "127.0.0.1"}:${inst.port}`);
      const proxyBaseUrl = String(inst.proxyBaseUrl || `${settings.apiBase}/v1/instances/${encodeURIComponent(inst.id)}/proxy/v1`);
      const runtimeBackend = normalizeRuntimeBackend(inst.runtime?.hardware || "auto");
      const runtimeLabel = runtimeBackend;
      const isStopped = String(inst.state || "").toLowerCase() === "stopped";
      const primaryAction = isStopped
        ? `<button class="delete" data-action="delete" data-id="${inst.id}">Delete Instance</button>`
        : `<button class="delete" data-action="delete" data-id="${inst.id}">Remove</button>`;
      const drainAction = isStopped
        ? ""
        : `<button data-action="drain" data-id="${inst.id}" data-enabled="${inst.drain ? "false" : "true"}">${inst.drain ? "\u25b6 Resume Intake" : "\u23f8 Pause Intake"}</button>`;
      const removeSecondaryAction = "";
      const testAction = isStopped
        ? ""
        : `<button class="copy" data-action="test" data-id="${inst.id}">Test Prompt</button>`;

      tr.innerHTML = `
        <td>
          <div>${escapeHtml(inst.profileName || inst.id)}</div>
          <div class="runtime-meta">${escapeHtml(inst.id)}</div>
        </td>
        <td>
          ${stateChipHtml(inst.state)}
          ${activityChipHtml(inst)}
        </td>
        <td>
          <div title="${escapeHtml(inst.effectiveModel || "-")}">${escapeHtml(trimModelPath(inst.effectiveModel || "-"))}${inst.modelNameAmbiguous ? ' <span title="Multiple running instances share this model name — routing via /v1/chat/completions will return 409. Stop one instance or use different model paths." style="color:#ffbe5c;cursor:default;">⚠</span>' : ''}</div>
          <div class="runtime-meta">ctx: ${inst.contextLength || "auto"}</div>
          <div class="runtime-meta">runtime: ${escapeHtml(runtimeLabel)}</div>
          <div class="runtime-meta" title="${escapeHtml(Array.isArray(inst.runtime?.serverArgs) && inst.runtime.serverArgs.length > 0 ? inst.runtime.serverArgs.join(" ") : "(none)")}">args: ${escapeHtml(trimArgsModelPaths(Array.isArray(inst.runtime?.serverArgs) && inst.runtime.serverArgs.length > 0 ? inst.runtime.serverArgs.join(" ") : "(none)"))}</div>
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
              ${testAction}
              ${drainAction}
              <button class="copy" data-action="copy-base" data-id="${inst.id}" data-copy="${proxyBaseUrl}">Copy API URL</button>
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
          if (action === "drain") {
            const enable = btn.getAttribute("data-enabled") === "true";
            await api(`/v1/instances/${id}/drain`, {
              method: "POST",
              body: JSON.stringify({ enabled: enable })
            });
          } else if (action === "delete") {
            const confirmed = window.confirm(`Remove instance ${id} from LlamaFleet?`);
            if (!confirmed) return;
            await api(`/v1/instances/${id}`, {
              method: "DELETE"
            });
          } else if (action === "copy-base" || action === "copy-model") {
            copy(btn.getAttribute("data-copy") || "");
            return;
          } else if (action === "test") {
            openInstanceTestDialog(id);
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

$("exportSelectedConfig").onclick = async () => {
  try {
    const id = $("savedConfigSelect").value;
    if (!id) {
      toast("Select a saved config first");
      return;
    }
    const response = await fetch(`${settings.apiBase}/v1/instance-configs/${id}/export.yaml`, {
      headers: { authorization: `Bearer ${settings.token}` }
    });
    const text = await response.text();
    if (!response.ok) throw new Error(text || `HTTP ${response.status}`);
    downloadTextFile(`instance-config-${id}.yaml`, text);
    toast("Config YAML downloaded");
  } catch (error) {
    toast(`Download failed: ${error.message}`);
  }
};

$("importConfigYaml").onclick = () => {
  $("importConfigYamlFile").click();
};

$("importConfigYamlFile").onchange = async () => {
  const file = $("importConfigYamlFile").files?.[0];
  if (!file) return;
  $("importConfigYamlFile").value = "";
  try {
    const text = await file.text();
    const response = await fetch(`${settings.apiBase}/v1/instance-configs/import.yaml`, {
      method: "POST",
      headers: {
        "Content-Type": "application/yaml",
        ...(settings.token ? { authorization: `Bearer ${settings.token}` } : {})
      },
      body: text
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
    toast(`Imported config: ${data.name}`);
    await refreshConfigLibrary();
  } catch (error) {
    toast(`Import failed: ${error.message}`);
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

if ($("instanceTestSend")) {
  $("instanceTestSend").onclick = () => {
    void sendInstanceDiagnosticPrompt();
  };
}

if ($("instanceTestSpeedTest")) {
  $("instanceTestSpeedTest").onclick = () => {
    void runInstanceSpeedTest();
  };
}

if ($("instanceTestReset")) {
  $("instanceTestReset").onclick = () => {
    $("instanceTestPrompt").value = "Reply exactly with: OK";
    $("instanceTestResult").textContent = "Prompt reset.";
  };
}

if ($("instanceTestClose")) {
  $("instanceTestClose").onclick = closeInstanceTestDialog;
}

if ($("instanceTestDialog")) {
  $("instanceTestDialog").addEventListener("click", (event) => {
    const dialog = $("instanceTestDialog");
    const rect = dialog.getBoundingClientRect();
    const inside = rect.top <= event.clientY
      && event.clientY <= rect.bottom
      && rect.left <= event.clientX
      && event.clientX <= rect.right;
    if (!inside) {
      closeInstanceTestDialog();
    }
  });
}

syncGlobalApiTokenInput();
void refreshGlobalApiAccess();
refreshInstances();
refreshConfigLibrary();
applyRestartPolicyUi();
setInterval(refreshInstances, 2000);
setInterval(() => loadSystemGpus("launchGpus"), 15000);
