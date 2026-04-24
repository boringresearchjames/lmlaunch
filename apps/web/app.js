const settings = {
  apiBase: localStorage.getItem("apiBase") || "http://localhost:8081",
  token: localStorage.getItem("apiToken") || "change-me"
};

const $ = (id) => document.getElementById(id);

$("apiBase").value = settings.apiBase;
$("apiToken").value = settings.token;

function toast(msg) {
  $("toast").textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
}

async function api(path, options = {}) {
  const response = await fetch(`${settings.apiBase}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${settings.token}`,
      ...(options.headers || {})
    }
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

function copy(value) {
  navigator.clipboard.writeText(value);
  toast(`Copied: ${value}`);
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

$("saveApi").onclick = () => {
  settings.apiBase = $("apiBase").value.trim();
  settings.token = $("apiToken").value.trim();
  localStorage.setItem("apiBase", settings.apiBase);
  localStorage.setItem("apiToken", settings.token);
  toast("API settings saved");
};

async function loadLMStudioModels(selectElementId) {
  try {
    const { models = [] } = await api("/v1/lmstudio/models");
    const select = $(selectElementId);
    const currentValue = select.value;

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

    toast(`Loaded ${models.length} models from LM Studio`);
  } catch (error) {
    toast(`Models load failed: ${error.message}`);
  }
}

$("loadLaunchModelsBtn").onclick = () => loadLMStudioModels("launchInstanceModel");

async function loadSystemGpus() {
  try {
    const { data = [] } = await api("/v1/system/gpus");
    const gpusSelect = $("profileGpus");
    const currentSelected = Array.from(gpusSelect.selectedOptions).map((opt) => opt.value);

    gpusSelect.innerHTML = "";
    data.forEach((gpu) => {
      const option = document.createElement("option");
      option.value = gpu.id;
      option.textContent = `GPU ${gpu.id}: ${gpu.name} (${gpu.memory_total_mib}MB)`;
      if (currentSelected.includes(gpu.id)) {
        option.selected = true;
      }
      gpusSelect.appendChild(option);
    });

    toast(`Loaded ${data.length} GPUs`);
  } catch (error) {
    toast(`GPU load failed: ${error.message}`);
  }
}

$("loadGpusBtn").onclick = () => loadSystemGpus();

// Auto-load on page load
window.addEventListener("load", () => {
  setTimeout(() => loadSystemGpus(), 300);
});

$("upsertProfile").onclick = async () => {
  try {
    const name = $("profileName").value.trim();
    if (!name) {
      toast("Profile name is required");
      return;
    }

    const gpusSelect = $("profileGpus");
    const selectedGpus = Array.from(gpusSelect.selectedOptions).map((opt) => opt.value);

    const payload = {
      id: `prof_${name.toLowerCase().replace(/\s+/g, "_")}`,
      name,
      host: $("profileHost").value.trim() || "127.0.0.1",
      port: Number($("profilePort").value),
      gpus: selectedGpus
    };

    await api("/v1/profiles", {
      method: "POST",
      body: JSON.stringify(payload)
    });

    toast("Profile saved");
    await refreshProfiles();
  } catch (error) {
    toast(`Profile error: ${error.message}`);
  }
};

async function refreshProfiles() {
  try {
    const data = await api("/v1/profiles");
    $("profilesView").textContent = JSON.stringify(data.data || [], null, 2);
  } catch (error) {
    toast(`Profiles refresh failed: ${error.message}`);
  }
}

$("refreshProfiles").onclick = refreshProfiles;

$("launchInstance").onclick = async () => {
  try {
    const model = $("launchInstanceModel").value.trim();
    if (!model) {
      toast("Model selection is required");
      return;
    }

    const payload = {
      profileId: $("launchProfileId").value.trim(),
      instanceId: $("launchInstanceId").value.trim() || undefined,
      model,
      maxInflightRequests: Number($("launchInflight").value || 4)
    };

    await api("/v1/instances/start", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    toast("Instance started");
    await refreshInstances();
    await refreshManifest();
  } catch (error) {
    toast(`Start failed: ${error.message}`);
  }
};

async function refreshInstances() {
  try {
    const { data } = await api("/v1/instances");
    const tbody = $("instanceRows");
    tbody.innerHTML = "";

    for (const inst of data || []) {
      const tr = document.createElement("tr");
      const baseUrl = `http://${inst.host || "127.0.0.1"}:${inst.port}`;

      tr.innerHTML = `
        <td>${inst.id}</td>
        <td>${inst.state}</td>
        <td>${inst.effectiveModel}</td>
        <td>${inst.port}</td>
        <td>
          <div><button class="copy" data-copy="${baseUrl}">Copy Base</button></div>
          <div><button class="copy" data-copy="${baseUrl}/v1/chat/completions">Copy Chat URL</button></div>
          <div><button class="copy" data-copy="${inst.effectiveModel}">Copy Model</button></div>
        </td>
        <td class="actions">
          <button data-action="stop" data-id="${inst.id}">Stop</button>
          <button class="kill" data-action="kill" data-id="${inst.id}">Kill</button>
          <button data-action="drain" data-id="${inst.id}">${inst.drain ? "Undrain" : "Drain"}</button>
        </td>
      `;

      tbody.appendChild(tr);
    }

    tbody.querySelectorAll("button[data-copy]").forEach((btn) => {
      btn.onclick = () => copy(btn.getAttribute("data-copy"));
    });

    tbody.querySelectorAll("button[data-action]").forEach((btn) => {
      btn.onclick = async () => {
        const id = btn.getAttribute("data-id");
        const action = btn.getAttribute("data-action");
        try {
          if (action === "stop") {
            await api(`/v1/instances/${id}/stop`, { method: "POST", body: "{}" });
          } else if (action === "kill") {
            await api(`/v1/instances/${id}/kill`, {
              method: "POST",
              body: JSON.stringify({ reason: "operator" })
            });
          } else if (action === "drain") {
            const enable = btn.textContent === "Drain";
            await api(`/v1/instances/${id}/drain`, {
              method: "POST",
              body: JSON.stringify({ enabled: enable })
            });
          }

          toast(`Action ${action} applied on ${id}`);
          await refreshInstances();
          await refreshManifest();
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

async function refreshManifest() {
  try {
    const data = await api("/v1/manifest/ready");
    $("manifestView").textContent = JSON.stringify(data, null, 2);
  } catch (error) {
    toast(`Manifest refresh failed: ${error.message}`);
  }
}

$("refreshManifest").onclick = refreshManifest;

$("refreshLogs").onclick = async () => {
  try {
    const instanceId = $("logsInstanceId").value.trim();
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

async function refreshConfigStatus() {
  try {
    const data = await api("/v1/config/status");
    $("configStatus").textContent = JSON.stringify(data, null, 2);
  } catch (error) {
    $("configStatus").textContent = `Status unavailable: ${error.message}`;
  }
}

$("refreshConfigStatus").onclick = refreshConfigStatus;

$("exportYaml").onclick = async () => {
  try {
    const response = await fetch(`${settings.apiBase}/v1/config/export.yaml`, {
      headers: {
        authorization: `Bearer ${settings.token}`
      }
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(text || `HTTP ${response.status}`);
    }
    $("yamlEditor").value = text;
    $("yamlResult").textContent = "Exported YAML loaded into editor.";
    toast("YAML export complete");
    await refreshConfigStatus();
  } catch (error) {
    toast(`YAML export failed: ${error.message}`);
  }
};

$("copyYaml").onclick = () => {
  const content = $("yamlEditor").value || "";
  copy(content);
};

$("downloadYaml").onclick = () => {
  const content = $("yamlEditor").value || "";
  if (!content.trim()) {
    toast("YAML editor is empty");
    return;
  }
  downloadTextFile("shared-config.yaml", content);
  toast("YAML download started");
};

async function importYaml(dryRun) {
  try {
    const yamlBody = $("yamlEditor").value || "";
    if (!yamlBody.trim()) {
      toast("Paste YAML content first");
      return;
    }

    const response = await fetch(
      `${settings.apiBase}/v1/config/import.yaml?dryRun=${dryRun ? "true" : "false"}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${settings.token}`,
          "content-type": "application/yaml"
        },
        body: yamlBody
      }
    );

    const text = await response.text();
    let payload;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { raw: text };
    }

    if (!response.ok) {
      throw new Error(payload.error || text || `HTTP ${response.status}`);
    }

    $("yamlResult").textContent = JSON.stringify(payload, null, 2);
    toast(dryRun ? "YAML dry-run complete" : "YAML import applied");
    await refreshConfigStatus();
    if (!dryRun) {
      await refreshProfiles();
      await refreshInstances();
      await refreshManifest();
    }
  } catch (error) {
    toast(`YAML import failed: ${error.message}`);
  }
}

$("importYamlDryRun").onclick = async () => importYaml(true);
$("importYamlApply").onclick = async () => importYaml(false);

refreshProfiles();
refreshInstances();
refreshManifest();
refreshConfigStatus();
