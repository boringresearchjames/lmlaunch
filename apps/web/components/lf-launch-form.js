/**
 * lf-launch-form.js — Light DOM custom element <lf-launch-form>
 * Owns: launch form HTML, all launch-related event handlers, GPU select,
 * runtime backend UI, restart policy UI, model list loading.
 * Exports setOperationPending, applyGpuAvailability, loadModelList for
 * use by sibling components.
 */
import { settings, api } from '../api.js';
import { store } from '../store.js';
import {
  normalizeRuntimeBackend,
  runtimeBackendUsesGpu,
  occupiedPortsSet,
  occupiedGpuSet,
  suggestNextFreePort,
  copy
} from './utils.js';

const $ = (id) => document.getElementById(id);

function toast(msg) {
  $('toast')?.notify(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

// ── Operation-pending state (shared with lf-config-library and app.js) ────

let operationPending = null;
let operationStatusTimer = null;

export function setOperationPending(info) {
  operationPending = info;
  const statusEl = $("launchStatus");
  const startBtn = $("launchInstance");
  const loadConfigBtn = $("loadSelectedConfig");
  const closeBtn = $("closeAll");

  if (!operationPending) {
    if (statusEl) statusEl.textContent = "Idle";
    if (startBtn) { startBtn.disabled = false; startBtn.textContent = "Start"; }
    if (loadConfigBtn) { loadConfigBtn.disabled = false; loadConfigBtn.textContent = "Load Selected"; }
    if (closeBtn) { closeBtn.disabled = false; closeBtn.textContent = "✕"; }
    if (operationStatusTimer) { clearInterval(operationStatusTimer); operationStatusTimer = null; }
    return;
  }

  if (startBtn) startBtn.disabled = true;
  if (loadConfigBtn) loadConfigBtn.disabled = true;
  if (closeBtn) closeBtn.disabled = true;

  if (operationPending.type === "config-load") {
    if (startBtn) startBtn.textContent = "Start";
    if (loadConfigBtn) loadConfigBtn.textContent = "Loading...";
    if (closeBtn) closeBtn.textContent = "✕";
  } else if (operationPending.type === "system-close") {
    if (startBtn) startBtn.textContent = "Start";
    if (loadConfigBtn) loadConfigBtn.textContent = "Load Selected";
    if (closeBtn) closeBtn.textContent = "...";
  } else {
    if (startBtn) startBtn.textContent = "Starting...";
    if (loadConfigBtn) loadConfigBtn.textContent = "Load Selected";
    if (closeBtn) closeBtn.textContent = "✕";
  }

  const render = () => {
    if (!operationPending) return;
    const elapsedMs = Date.now() - operationPending.startedAt;
    const elapsedSec = Math.max(1, Math.round(elapsedMs / 1000));
    if (!statusEl) return;
    if (operationPending.type === "config-load") {
      statusEl.textContent = `Loading config ${operationPending.name} (${elapsedSec}s)`;
    } else if (operationPending.type === "system-close") {
      statusEl.textContent = `Closing instances and unloading models (${elapsedSec}s)`;
    } else {
      statusEl.textContent = `Starting ${operationPending.name} on ${operationPending.host}:${operationPending.port} (${elapsedSec}s)`;
    }
  };

  render();
  if (operationStatusTimer) clearInterval(operationStatusTimer);
  operationStatusTimer = setInterval(render, 500);
}

// ── GPU / model helpers ───────────────────────────────────────────────────

export function applyGpuAvailability() {
  const select = $("launchGpus");
  if (!select) return;
  const occupied = occupiedGpuSet();
  const currentlySelected = new Set(Array.from(select.selectedOptions).map((opt) => opt.value));
  Array.from(select.options).forEach((opt) => {
    const inUse = occupied.has(opt.value);
    if (inUse && currentlySelected.has(opt.value)) opt.selected = false;
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

export function applyRuntimeBackendUi() {
  const backend = normalizeRuntimeBackend($("launchRuntimeBackend").value);
  const gpuSelect = $("launchGpus");
  if (!gpuSelect) return;
  const usesGpu = runtimeBackendUsesGpu(backend);
  gpuSelect.disabled = !usesGpu;
  if (!usesGpu) {
    Array.from(gpuSelect.options).forEach((opt) => { opt.selected = false; opt.disabled = true; });
    return;
  }
  Array.from(gpuSelect.options).forEach((opt) => { opt.disabled = false; });
  applyGpuAvailability();
}

export function applyRestartPolicyUi() {
  const mode = String($("launchRestartMode")?.value || "never");
  const disabled = mode !== "on-failure";
  const retries = $("launchRestartRetries");
  const backoff = $("launchRestartBackoffMs");
  if (retries) retries.disabled = disabled;
  if (backoff) backoff.disabled = disabled;
}

export async function loadModelList(selectElementId) {
  const select = $(selectElementId);
  if (!select) return;
  const currentValue = select.value;

  function fmtSize(bytes) {
    if (!bytes) return "";
    if (bytes >= 1e9) return ` — ${(bytes / 1e9).toFixed(1)} GB`;
    if (bytes >= 1e6) return ` — ${(bytes / 1e6).toFixed(0)} MB`;
    return ` — ${(bytes / 1e3).toFixed(0)} KB`;
  }

  const SOURCE_LABELS = {
    ollama: "Ollama",
    huggingface: "Hugging Face",
    unsloth: "Unsloth Studio",
  };

  function applyModels(models, sourceLabel) {
    select.innerHTML = '<option value="">-- Select model --</option>';

    // Bucket models by their source tag (or inferred from first path segment)
    const PATH_TAGS = { unsloth: "unsloth", huggingface: "huggingface", ollama: "ollama" };
    const groups = new Map();
    for (const model of models) {
      const raw = model.name || model.id;
      const tagMatch = raw.match(/^\[([^\]]+)\]\s*(.+)$/);
      let tag, relPath;
      if (tagMatch) {
        tag = tagMatch[1].toLowerCase();
        relPath = tagMatch[2];
      } else {
        relPath = raw;
        const firstSeg = raw.split(/[\/\\]/)[0].toLowerCase();
        tag = PATH_TAGS[firstSeg] ?? "local";
      }
      const filePart = relPath.split(/[\/\\]/).pop();
      if (!groups.has(tag)) groups.set(tag, []);
      groups.get(tag).push({ model, filePart });
    }

    // Render: "local" first, then alphabetically by tag
    const order = ["local", ...([...groups.keys()].filter(k => k !== "local").sort())];
    for (const tag of order) {
      if (!groups.has(tag)) continue;
      const items = groups.get(tag);
      const groupLabel = SOURCE_LABELS[tag] ?? (tag === "local" ? "Local Models" : tag);
      const group = document.createElement("optgroup");
      group.label = groupLabel;
      for (const { model, filePart } of items) {
        const option = document.createElement("option");
        option.value = model.id;
        option.textContent = filePart + fmtSize(model.size);
        option.title = model.id;
        group.appendChild(option);
      }
      select.appendChild(group);
    }

    if (currentValue) select.value = currentValue;
    toast(`Loaded ${models.length} models (${sourceLabel})`);
  }

  try {
    const { data = [], warning } = await api("/v1/local-models");
    if (data.length > 0) {
      applyModels(data, "local files");
      if (warning) toast(`Models: ${warning}`);
      return;
    }
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

function renderGpuSelect({ data = [], warning, diagnostics } = {}) {
  const gpusSelect = $("launchGpus");
  if (!gpusSelect) return;
  const currentSelected = Array.from(gpusSelect.selectedOptions).map((opt) => opt.value);
  gpusSelect.innerHTML = "";
  data.forEach((gpu) => {
    const option = document.createElement("option");
    option.value = gpu.id;
    const temp = gpu.temperature_c ?? "n/a";
    const util = gpu.utilization_percent ?? "n/a";
    option.textContent = `GPU ${gpu.id}: ${gpu.name} (${gpu.memory_total_mib} MiB, util ${util}%, ${temp}C)`;
    if (currentSelected.includes(gpu.id)) option.selected = true;
    gpusSelect.appendChild(option);
  });
  applyRuntimeBackendUi();
  if (warning) {
    const diagDetail = diagnostics?.detail ? ` (${diagnostics.detail})` : "";
    toast(`GPU runtime warning: ${warning}${diagDetail}`);
    return;
  }
  toast(`Loaded ${data.length} GPUs`);
}

async function autoDetectMmproj() {
  const modelPath = ($("launchInstanceModel")?.value || "").trim();
  const mmprojInput = $("launchMmproj");
  if (!mmprojInput || !modelPath) return;
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
    } else if (mmprojInput.dataset.autoFilled) {
      mmprojInput.value = "";
      mmprojInput.dataset.autoFilled = "1";
    }
  } catch (_) { /* best-effort */ }
}

function parseContextLengthInput() {
  const preset = $("launchContextPreset").value;
  if (preset === "auto") return "auto";
  if (preset === "custom") {
    const custom = Number($("launchContextCustom").value);
    if (!Number.isInteger(custom) || custom < 256) throw new Error("Custom context must be an integer >= 256");
    return custom;
  }
  const presetValue = Number(preset);
  if (!Number.isInteger(presetValue) || presetValue < 256) throw new Error("Invalid context preset selected");
  return presetValue;
}

function parseOptionalPositiveIntegerInput(id) {
  const raw = String($(id).value || "").trim();
  if (!raw) return null;
  const num = Number(raw);
  if (!Number.isInteger(num) || num < 1) throw new Error(`${id} must be a positive integer`);
  return num;
}

// ── Custom element ────────────────────────────────────────────────────────

class LfLaunchForm extends HTMLElement {
  connectedCallback() {
    this.innerHTML = `
<section class="card span-12">
  <div class="section-header">
    <div>
      <h2>Instances</h2>
      <p class="card-subtitle">Launch and operate instances from one place.</p>
    </div>
    <button id="copyApiUrl" class="copy" type="button" title="Copy the unified API base URL for use in OpenAI clients">Copy API URL</button>
  </div>
  <div class="launch-box">
    <h3>Launch New Instance</h3>
    <div id="launchStatus" class="launch-status">Idle</div>
    <div class="launch-grid">
      <label class="launch-field launch-field-span-2">
        Model
        <select id="launchInstanceModel" class="launch-input">
          <option value="">-- Select model --</option>
        </select>
      </label>
      <label class="launch-field">
        Instance Name
        <input id="launchName" placeholder="qwen-run-1" class="launch-input" />
      </label>
      <label class="launch-field">
        Port
        <input id="launchPort" type="number" value="1234" min="1" max="65535" class="launch-input" />
      </label>
      <label class="launch-field">
        Runtime
        <select id="launchRuntimeBackend" class="launch-input">
          <option value="auto" selected>Auto</option>
          <option value="cuda">CUDA</option>
          <option value="cuda_full">CUDA (full offload)</option>
          <option value="rocm">ROCm (AMD)</option>
          <option value="rocm_full">ROCm (AMD, full offload)</option>
          <option value="vulkan">Vulkan</option>
          <option value="cpu">CPU</option>
        </select>
      </label>
      <label class="launch-field launch-field-span-3">
        GPUs
        <select id="launchGpus" multiple class="launch-input launch-gpu-select">
        </select>
        <small class="launch-field-help">Hold Ctrl / Cmd to select multiple. Leave empty to use all GPUs.</small>
      </label>
      <details class="launch-advanced launch-field-span-4">
        <summary>Advanced</summary>
        <div class="launch-advanced-grid">
          <label class="launch-field launch-field-span-2">
            Context Window
            <select id="launchContextPreset" class="launch-input">
              <option value="auto" selected>Auto</option>
              <option value="4096">4096</option>
              <option value="8192">8192</option>
              <option value="16384">16384</option>
              <option value="32768">32768</option>
              <option value="65536">65536</option>
              <option value="custom">Custom</option>
            </select>
          </label>
          <label class="launch-field">
            Custom Context
            <input id="launchContextCustom" type="number" min="256" step="256" placeholder="e.g. 24576" class="launch-input" disabled />
          </label>
          <label class="launch-field">
            Max Inflight
            <input id="launchInflight" type="number" value="4" min="1" class="launch-input" />
          </label>
          <label class="launch-field">
            Queue Limit
            <input id="launchQueueLimit" type="number" value="64" min="1" class="launch-input" />
          </label>
          <label class="launch-field">
            Max Parallel
            <input id="launchModelParallel" type="number" value="1" min="1" class="launch-input" />
          </label>
          <label class="launch-field">
            Model TTL (sec)
            <input id="launchModelTtl" type="number" min="1" placeholder="optional" class="launch-input" />
          </label>
          <label class="launch-field launch-field-span-3">
            Server Args
            <input id="launchServerArgs" type="text" value="--flash-attn on -b 2048 -ub 1024 --mlock -ctk q8_0 -ctv q8_0 -ngl 999" placeholder="e.g. --flash-attn on -b 2048" class="launch-input" />
            <small class="launch-field-help">Extra flags passed directly to llama-server. Separate with spaces.</small>
          </label>
          <label class="launch-field">
            Multimodal Proj (mmproj)
            <input id="launchMmproj" type="text" placeholder="auto-detect or paste path" class="launch-input" />
            <small class="launch-field-help">Optional. Path to mmproj GGUF for vision support.</small>
          </label>
          <label class="launch-field launch-field-span-2">
            Auto Restart
            <select id="launchRestartMode" class="launch-input">
              <option value="never" selected>Never</option>
              <option value="on-failure">On Failure</option>
            </select>
          </label>
          <label class="launch-field">
            Restart Retries
            <input id="launchRestartRetries" type="number" value="2" min="1" class="launch-input" />
          </label>
          <label class="launch-field">
            Restart Backoff (ms)
            <input id="launchRestartBackoffMs" type="number" value="3000" min="250" step="250" class="launch-input" />
          </label>
        </div>
      </details>
      <div class="launch-actions-row">
        <button id="launchInstance" class="launch-start">Start</button>
      </div>
    </div>
  </div>
</section>`;

    this._wireEvents();
    store.subscribe('gpuHardware', renderGpuSelect);
    setTimeout(() => store.refresh('gpuHardware').catch(() => {}), 300);
    setTimeout(() => loadModelList("launchInstanceModel"), 450);
    $('launchInstanceModel').addEventListener('change', () => autoDetectMmproj());
    applyRestartPolicyUi();
  }

  _wireEvents() {
    $("copyApiUrl").onclick = () => {
      copy(`${(settings.apiBase || "").replace(/\/$/, "")}/v1`);
    };

    $("launchContextPreset").onchange = () => {
      const customInput = $("launchContextCustom");
      const isCustom = $("launchContextPreset").value === "custom";
      customInput.disabled = !isCustom;
      if (!isCustom) customInput.value = "";
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

    $("launchRestartMode").onchange = () => applyRestartPolicyUi();

    $("launchInstanceModel").onchange = () => {
      const nameInput = $("launchName");
      if (String(nameInput.value || "").trim()) return;
      const rawModel = String($("launchInstanceModel").value || "").trim();
      if (!rawModel) return;
      const base = rawModel
        .split("/").pop()
        .replace(/\.[^.]+$/, "")
        .replace(/[^a-zA-Z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .toLowerCase();
      if (base) nameInput.value = base;
    };

    $("launchInstance").onclick = async () => {
      try {
        const name = $("launchName").value.trim();
        const port = Number($("launchPort").value);
        const model = $("launchInstanceModel").value.trim();
        const runtimeBackend = normalizeRuntimeBackend($('launchRuntimeBackend').value);
        let selectedGpus = Array.from($("launchGpus").selectedOptions).map((opt) => opt.value);

        if (!name) { toast("Instance name is required"); return; }
        if (!Number.isInteger(port) || port < 1 || port > 65535) { toast("Valid port is required"); return; }
        const occupiedPorts = occupiedPortsSet();
        if (occupiedPorts.has(port)) { toast(`Port ${port} is already in use by a running instance`); return; }

        if (runtimeBackendUsesGpu(runtimeBackend)) {
          const occupiedGpus = occupiedGpuSet();
          const gpuConflict = selectedGpus.find((g) => occupiedGpus.has(String(g)));
          if (gpuConflict) { toast(`GPU ${gpuConflict} is already assigned to a running instance`); return; }
        } else {
          selectedGpus = [];
        }

        if (!model) { toast("Model selection is required"); return; }

        const contextLength = parseContextLengthInput();
        const baseRuntimeArgs = String($('launchServerArgs').value || '').trim().split(/\s+/).filter(Boolean);
        const mmprojPath = ($('launchMmproj')?.value || '').trim();
        const alreadyHasMmproj = baseRuntimeArgs.some((a) => a === '--mmproj');
        if (mmprojPath && !alreadyHasMmproj) baseRuntimeArgs.push('--mmproj', mmprojPath);

        const payload = {
          name, port, model,
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

        const launchPoll = setInterval(() => { void store.refresh('instances').catch(() => {}); }, 1000);
        setOperationPending({ type: "launch", name, host: "127.0.0.1", port, startedAt: Date.now() });
        try {
          await api("/v1/instances/start", { method: "POST", body: JSON.stringify(payload) });
        } finally {
          clearInterval(launchPoll);
          setOperationPending(null);
        }
        toast("Instance started");
        await store.refresh('instances');
      } catch (error) {
        toast(`Start failed: ${error.message}`);
      }
    };
  }

  /** Public method — called by lf-instances-panel when cloning an instance setup. */
  fillFromInstance(inst) {
    const modelSelect = $("launchInstanceModel");
    if (inst.effectiveModel && !Array.from(modelSelect.options).some((o) => o.value === inst.effectiveModel)) {
      const opt = document.createElement("option");
      opt.value = inst.effectiveModel;
      opt.textContent = inst.effectiveModel.replace(/\\/g, "/").split("/").slice(-3).join("/");
      modelSelect.appendChild(opt);
    }
    if (inst.effectiveModel) modelSelect.value = inst.effectiveModel;

    $("launchName").value = "";
    $("launchPort").value = String(suggestNextFreePort(Number(inst.port) + 1));

    const backend = normalizeRuntimeBackend(inst.runtime?.hardware || "auto");
    $("launchRuntimeBackend").value = backend;
    applyRuntimeBackendUi();

    const rawArgs = Array.isArray(inst.runtime?.serverArgs) ? inst.runtime.serverArgs : [];
    const filteredArgs = [];
    for (let i = 0; i < rawArgs.length; i++) {
      if (rawArgs[i] === "--port") { i++; continue; }
      filteredArgs.push(rawArgs[i]);
    }
    $("launchServerArgs").value = filteredArgs.join(" ");

    const ctx = inst.contextLength;
    const presetOptions = ["4096", "8192", "16384", "32768", "65536"];
    if (ctx == null) {
      $("launchContextPreset").value = "auto";
    } else if (presetOptions.includes(String(ctx))) {
      $("launchContextPreset").value = String(ctx);
    } else {
      $("launchContextPreset").value = "custom";
      $("launchContextCustom").value = String(ctx);
      $("launchContextCustom").disabled = false;
    }

    $("launchInflight").value = String(inst.maxInflightRequests || 4);
    $("launchQueueLimit").value = String(inst.queueLimit || 64);
    $("launchModelParallel").value = String(inst.modelParallel || 1);

    const rp = inst.restartPolicy || { mode: "never" };
    $("launchRestartMode").value = rp.mode || "never";
    $("launchRestartRetries").value = String(rp.maxRetries || 2);
    $("launchRestartBackoffMs").value = String(rp.backoffMs || 3000);
    applyRestartPolicyUi();

    $("launchInstance").scrollIntoView({ behavior: "smooth", block: "center" });
    $("launchName").focus();
    toast(`Cloned setup from "${inst.profileName || inst.id}" — enter a name and click Start`);
  }
}

customElements.define('lf-launch-form', LfLaunchForm);
