import express from "express";
import { execFile, spawn } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";

const app = express();
app.use(express.json({ limit: "2mb" }));

const port = Number(process.env.BRIDGE_PORT || 8090);
const bridgeToken = process.env.BRIDGE_AUTH_TOKEN || "change-me";
const bridgeAuthEnabled = Boolean(bridgeToken && bridgeToken !== "change-me");
const defaultLogLines = Number(process.env.LOG_LINES_DEFAULT || 200);
const readinessPollMs = Number(process.env.READINESS_POLL_MS || 2000);
const readinessHttpTimeoutMs = Number(process.env.READINESS_HTTP_TIMEOUT_MS || 5000);
const smokeCheckEnabled = process.env.SMOKE_CHECK_ENABLED === "true";
const strictSmokeCheck = process.env.STRICT_SMOKE_CHECK === "true";
const gpuBleedMaxDeltaMiB = Number(process.env.GPU_BLEED_MAX_DELTA_MIB || 256);
const allowBleedOnOtherAssignedGpus = process.env.GPU_BLEED_ALLOW_OTHER_ASSIGNED === "true";
const enforceGpuBleedInMultiInstance = process.env.GPU_BLEED_ENFORCE_MULTI_INSTANCE === "true";
const llamaServerBinary = String(process.env.LLAMA_SERVER_BIN || "llama-server").trim() || "llama-server";

if (!bridgeAuthEnabled) {
  console.warn("Bridge auth disabled: BRIDGE_AUTH_TOKEN not set.");
}

const dataRoot = process.env.DATA_ROOT || path.resolve(process.cwd(), "data");
const logsDir = path.join(dataRoot, "logs");
fs.mkdirSync(logsDir, { recursive: true });

const instances = new Map();
let numactlSupportedCache = null;
let gpuNumaMapCache = null;
let gpuNumaMapCachedAt = 0;
const gpuNumaMapCacheTtlMs = 15000;

function isValidInstanceId(value) {
  return typeof value === "string" && /^[a-zA-Z0-9_-]+$/.test(value);
}

function auth(req, res, next) {
  if (!bridgeAuthEnabled) {
    return next();
  }
  const token = req.header("x-bridge-token") || "";
  if (token !== bridgeToken) {
    return res.status(401).json({ error: "Unauthorized bridge token" });
  }
  return next();
}

function writeLog(instanceId, stream, line) {
  const file = path.join(logsDir, `${instanceId}.log`);
  fs.appendFileSync(file, `[${new Date().toISOString()}] [${stream}] ${line}`);
}

function clipText(value, max = 400) {
  const text = String(value || "").replaceAll("\r", "").trim();
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function redactSensitiveText(value) {
  return String(value || "").replace(/(--api-key(?:=|\s+))(\S+)/gi, "$1***redacted***");
}

function redactCommandArgs(args = []) {
  const parts = Array.isArray(args) ? args.map((x) => String(x)) : [];
  const redacted = [];
  for (let i = 0; i < parts.length; i += 1) {
    const current = parts[i];
    if (current.toLowerCase() === "--api-key") {
      redacted.push(current);
      if (i + 1 < parts.length) {
        redacted.push("***redacted***");
        i += 1;
      }
      continue;
    }
    redacted.push(current.replace(/^--api-key=.*/i, "--api-key=***redacted***"));
  }
  return redacted;
}

function writeMeta(instanceId, event, fields = {}) {
  const safe = Object.entries(fields).reduce((acc, [key, value]) => {
    acc[key] = typeof value === "string" ? clipText(value) : value;
    return acc;
  }, {});
  writeLog(instanceId, "meta", `${JSON.stringify({ event, ...safe })}\n`);
}

function resolveServerArgs(profile) {
  const raw = Array.isArray(profile?.runtime?.serverArgs) && profile.runtime.serverArgs.length > 0
    ? profile.runtime.serverArgs
    : ["--port", "{port}", "--host", "{bindHost}", "--model", "{model}"];

  const contextValue = Number.isInteger(Number(profile?.contextLength)) && Number(profile?.contextLength) > 0
    ? String(Number(profile.contextLength))
    : "";

  const bindHost = String(profile?.bindHost || "0.0.0.0").trim() || "0.0.0.0";
  const model = String(profile?.model || "").trim();

  const args = raw.map((arg) => String(arg)
    .replaceAll("{port}", String(profile?.port || ""))
    .replaceAll("{model}", model)
    .replaceAll("{contextLength}", contextValue || "")
    .replaceAll("{bindHost}", bindHost))
    .filter((x) => x !== "");

  const hasModel = args.some((arg, idx) => arg === "--model" || arg === "-m" || (idx > 0 && (args[idx - 1] === "--model" || args[idx - 1] === "-m")));
  const hasPort = args.some((arg, idx) => arg === "--port" || arg === "-p" || (idx > 0 && (args[idx - 1] === "--port" || args[idx - 1] === "-p")));
  const hasHost = args.some((arg, idx) => arg === "--host" || (idx > 0 && args[idx - 1] === "--host") || arg.startsWith("--host="));
  const hasCtx = args.some((arg, idx) => arg === "--ctx-size" || arg === "-c" || (idx > 0 && (args[idx - 1] === "--ctx-size" || args[idx - 1] === "-c")));

  if (!hasModel && model) {
    args.push("--model", model);
  }
  if (!hasPort) {
    args.push("--port", String(profile?.port || "1234"));
  }
  if (!hasHost) {
    args.push("--host", bindHost);
  }
  if (!hasCtx && contextValue) {
    args.push("--ctx-size", contextValue);
  }

  const backend = normalizeRuntimeBackend(profile?.runtime?.hardware);
  if (backend === "cuda_full" || backend === "rocm_full") {
    const hasNgl = args.some((arg, idx) =>
      arg === "--n-gpu-layers" || arg === "-ngl" ||
      (idx > 0 && (args[idx - 1] === "--n-gpu-layers" || args[idx - 1] === "-ngl"))
    );
    if (!hasNgl) {
      args.push("--n-gpu-layers", "999");
    }
  }

  return args;
}

function normalizeRuntimeBackend(value) {
  const raw = String(value || "auto").trim().toLowerCase();
  if (raw === "valkun") return "vulkan";
  if (["auto", "cuda", "cuda_full", "rocm", "rocm_full", "cpu", "vulkan"].includes(raw)) return raw;
  return "auto";
}

function normalizeGpuList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((gpu) => String(gpu).trim()).filter(Boolean))];
}

function applyGpuVisibilityEnv(env, gpuList) {
  const value = Array.isArray(gpuList) ? gpuList.join(",") : "";
  // Force PCI bus ID ordering so CUDA device indices match nvidia-smi physical
  // indices. Without this, CUDA uses "fastest first" enumeration which can
  // reverse the device order on NVLink/SXM2 systems (e.g. CUDA_VISIBLE_DEVICES=8,9
  // maps CUDA0→GPU9 instead of CUDA0→GPU8, causing all VRAM to appear on one GPU).
  env.CUDA_DEVICE_ORDER = "PCI_BUS_ID";
  env.CUDA_VISIBLE_DEVICES = value;
  env.NVIDIA_VISIBLE_DEVICES = value;
  env.GPU_DEVICE_ORDINAL = value;
  env.HIP_VISIBLE_DEVICES = value;
  env.ROCR_VISIBLE_DEVICES = value;
  env.ZE_AFFINITY_MASK = value;
  env.GGML_VK_VISIBLE_DEVICES = value;
  env.VK_VISIBLE_DEVICES = value;
}

function buildRuntimeEnv(baseEnv, profile) {
  const env = { ...baseEnv };
  const backend = normalizeRuntimeBackend(profile?.runtime?.hardware);
  const gpuIds = normalizeGpuList(profile?.gpus);

  if (backend === "cpu") {
    applyGpuVisibilityEnv(env, []);
    return { env, backend, gpuIds };
  }

  applyGpuVisibilityEnv(env, gpuIds);
  if (backend === "vulkan") {
    env.GGML_VULKAN = "1";
  }
  return { env, backend, gpuIds };
}

async function runCommand(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { env: process.env }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: String(stdout || ""),
        stderr: String(stderr || ""),
        error: error ? String(error.message || error) : null
      });
    });
  });
}

async function spawnLlamaServer(instanceId, record, env, numaNode = null) {
  const profile = record?.profile || {};
  const args = resolveServerArgs(profile);
  let command = String(llamaServerBinary).trim() || "llama-server";
  let commandArgs = [...args];

  if (Number.isInteger(Number(numaNode)) && Number(numaNode) >= 0 && await isNumactlSupported()) {
    commandArgs = [
      `--cpunodebind=${Number(numaNode)}`,
      `--membind=${Number(numaNode)}`,
      command,
      ...commandArgs
    ];
    command = "numactl";
  }

  writeMeta(instanceId, "llama.exec.start", {
    command,
    args: redactCommandArgs(commandArgs),
    numa_node: Number.isInteger(Number(numaNode)) ? Number(numaNode) : null
  });

  const child = await new Promise((resolve, reject) => {
    const proc = spawn(command, commandArgs, {
      env: { ...env },
      stdio: ["ignore", "pipe", "pipe"]
    });

    let settled = false;

    proc.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(new Error(`failed to spawn ${command}: ${String(error.message || error)}`));
    });

    proc.once("spawn", () => {
      if (settled) return;
      settled = true;
      resolve(proc);
    });
  });

  record.process = child;

  const streamLog = (stream, chunk) => {
    const text = redactSensitiveText(String(chunk || ""));
    if (!text) return;
    writeLog(instanceId, stream, text);
  };

  child.stdout?.on("data", (chunk) => streamLog("stdout", chunk));
  child.stderr?.on("data", (chunk) => streamLog("stderr", chunk));

  child.on("exit", (code, signal) => {
    writeMeta(instanceId, "instance.process.exit", {
      code: Number.isInteger(Number(code)) ? Number(code) : null,
      signal: signal || null,
      state: record.state
    });
    record.process = null;

    if (record.state === "stopped" || record.state === "draining") {
      return;
    }

    record.state = "unhealthy";
    record.lastError = `llama.cpp process exited (code=${String(code)}, signal=${String(signal)})`;
    void maybeAutoRestart(instanceId, record, "process_exit");
  });

  writeMeta(instanceId, "llama.exec.spawned", {
    pid: child.pid || null,
    command,
    args: redactCommandArgs(commandArgs)
  });
}

async function isNumactlSupported() {
  if (process.platform !== "linux") {
    return false;
  }
  if (typeof numactlSupportedCache === "boolean") {
    return numactlSupportedCache;
  }
  const check = await runCommand("numactl", ["--show"]);
  numactlSupportedCache = Boolean(check.ok);
  return numactlSupportedCache;
}

async function getGpuNumaNodeMap() {
  if (process.platform !== "linux") {
    return new Map();
  }

  const nowMs = Date.now();
  if (gpuNumaMapCache && (nowMs - gpuNumaMapCachedAt) < gpuNumaMapCacheTtlMs) {
    return gpuNumaMapCache;
  }

  const result = await runCommand("nvidia-smi", [
    "--query-gpu=index,numa.node",
    "--format=csv,noheader,nounits"
  ]);

  const map = new Map();
  if (result.ok) {
    const lines = String(result.stdout || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    for (const line of lines) {
      const [indexRaw, nodeRaw] = line.split(",").map((x) => String(x || "").trim());
      const node = Number(nodeRaw);
      if (indexRaw !== "" && Number.isInteger(node) && node >= 0) {
        map.set(String(indexRaw), node);
      }
    }
  }

  gpuNumaMapCache = map;
  gpuNumaMapCachedAt = nowMs;
  return map;
}

async function resolvePinnedNumaNode(gpuIds) {
  if (!Array.isArray(gpuIds) || gpuIds.length === 0) {
    return null;
  }

  if (!await isNumactlSupported()) {
    return null;
  }

  const gpuNumaMap = await getGpuNumaNodeMap();
  if (gpuNumaMap.size === 0) {
    return null;
  }

  const nodes = new Set();
  for (const gpuId of gpuIds) {
    const key = String(gpuId);
    if (!gpuNumaMap.has(key)) {
      return null;
    }
    nodes.add(gpuNumaMap.get(key));
  }

  if (nodes.size !== 1) {
    return null;
  }
  return [...nodes][0];
}

async function getGpuMemoryUsageMap() {
  // Try nvidia-smi first.
  const nvResult = await runCommand("nvidia-smi", [
    "--query-gpu=index,memory.used",
    "--format=csv,noheader,nounits"
  ]);

  if (nvResult.ok) {
    const map = new Map();
    for (const line of String(nvResult.stdout || "").split("\n").map((l) => l.trim()).filter(Boolean)) {
      const [indexRaw, memRaw] = line.split(",").map((x) => String(x || "").trim());
      const mem = Number(memRaw);
      if (indexRaw !== "" && Number.isFinite(mem)) map.set(String(indexRaw), mem);
    }
    return map;
  }

  // Fall back to rocm-smi (AMD).
  const rocmResult = await runCommand("rocm-smi", ["--showmeminfo", "vram", "--json"]);
  if (!rocmResult.ok) return null;

  try {
    const parsed = JSON.parse(rocmResult.stdout);
    const map = new Map();
    for (const [cardKey, cardData] of Object.entries(parsed)) {
      const idx = String(cardKey).replace(/^card/i, "");
      const usedBytes = Number(cardData["VRAM Total Used Memory (B)"] ?? cardData["vram total used memory"] ?? NaN);
      if (Number.isFinite(usedBytes)) map.set(idx, usedBytes / 1024 / 1024);
    }
    return map;
  } catch {
    return null;
  }
}

function activeAssignedGpuSet(excludeInstanceId = null) {
  const assigned = new Set();
  for (const [id, record] of instances.entries()) {
    if (excludeInstanceId && id === excludeInstanceId) continue;
    if (!record || record.state === "stopped") continue;
    const gpus = Array.isArray(record?.profile?.gpus) ? record.profile.gpus : [];
    for (const gpu of gpus) {
      assigned.add(String(gpu));
    }
  }
  return assigned;
}

function detectGpuBleed(beforeMap, afterMap, selectedGpuIds, allowedGpuIds, maxDeltaMiB) {
  if (!(beforeMap instanceof Map) || !(afterMap instanceof Map)) {
    return [];
  }

  const selected = new Set((selectedGpuIds || []).map((g) => String(g)));
  const allowed = new Set((allowedGpuIds || []).map((g) => String(g)));
  const violations = [];

  for (const [gpuId, afterMiB] of afterMap.entries()) {
    if (selected.has(gpuId)) continue;
    if (allowed.has(gpuId)) continue;

    const beforeMiB = Number(beforeMap.get(gpuId) || 0);
    const delta = Number(afterMiB) - beforeMiB;
    if (delta > maxDeltaMiB) {
      violations.push({ gpuId, beforeMiB, afterMiB, deltaMiB: delta });
    }
  }

  return violations;
}

async function stopAllServers(reason = "unspecified") {
  for (const [instanceId, record] of instances.entries()) {
    if (!record || !record.process || record.process.killed) continue;
    try {
      record.process.kill("SIGTERM");
    } catch {
      // Best effort.
    }
    record.state = "stopped";
    record.lastError = null;
    writeMeta(instanceId, "instance.lifecycle.cleaned", { reason, action: "process_stop_all" });
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    done: () => clearTimeout(timeout)
  };
}

async function checkInstanceReady(profile) {
  const host = profile.host || "127.0.0.1";
  const baseUrl = `http://${host}:${profile.port}`;
  const startedAt = Date.now();
  const status = {
    models_status: null,
    smoke_status: null,
    duration_ms: 0
  };

  const modelsTimeout = withTimeout(readinessHttpTimeoutMs);
  const modelsResponse = await fetch(`${baseUrl}/v1/models`, { signal: modelsTimeout.signal });
  modelsTimeout.done();
  status.models_status = modelsResponse.status;
  if (!modelsResponse.ok) {
    throw new Error(`models endpoint not ready (${modelsResponse.status})`);
  }

  if (smokeCheckEnabled) {
    const smokeTimeout = withTimeout(readinessHttpTimeoutMs);
    const smokeResponse = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: smokeTimeout.signal,
      body: JSON.stringify({
        model: profile.model,
        messages: [{ role: "user", content: "ok" }],
        max_tokens: 1,
        temperature: 0
      })
    });
    smokeTimeout.done();
    status.smoke_status = smokeResponse.status;
    if (!smokeResponse.ok) {
      const smokeText = await smokeResponse.text();
      const smokeError = `smoke check failed (${smokeResponse.status}) ${clipText(smokeText, 240)}`;
      status.smoke_error = smokeError;
      if (strictSmokeCheck) {
        throw new Error(smokeError);
      }
    }
  }

  status.duration_ms = Date.now() - startedAt;
  return status;
}

function normalizeRestartPolicy(value = {}) {
  const rawMode = String(value?.mode || "never").trim().toLowerCase();
  const mode = rawMode === "on-failure" ? "on-failure" : "never";
  const maxRetries = mode === "on-failure"
    ? Math.min(20, Math.max(1, Number(value?.maxRetries || 2)))
    : 0;
  const backoffMs = mode === "on-failure"
    ? Math.min(120000, Math.max(250, Number(value?.backoffMs || 3000)))
    : 0;
  return { mode, maxRetries, backoffMs };
}

async function launchRuntimeForInstance(instanceId, record, reason = "start") {
  const profile = record.profile || {};
  const runtimeEnv = buildRuntimeEnv(process.env, profile);
  const env = runtimeEnv.env;

  if (runtimeEnv.backend !== "cpu" && runtimeEnv.gpuIds.length === 0) {
    throw new Error("non-CPU runtime requires explicit GPU selection");
  }

  const selectedGpuIds = runtimeEnv.gpuIds.map((g) => String(g));
  const numaNode = runtimeEnv.backend !== "cpu"
    ? await resolvePinnedNumaNode(selectedGpuIds)
    : null;
  const allowedOtherGpuIds = allowBleedOnOtherAssignedGpus ? activeAssignedGpuSet(instanceId) : new Set();
  let gpuMemoryBefore = null;
  if (runtimeEnv.backend !== "cpu" && selectedGpuIds.length > 0) {
    gpuMemoryBefore = await getGpuMemoryUsageMap();
  }

  writeMeta(instanceId, "instance.start.request", {
    reason,
    host: String(profile.host || "127.0.0.1"),
    bind_host: String(profile.bindHost || "0.0.0.0"),
    port: Number(profile.port),
    model: String(profile.model),
    gpus: runtimeEnv.gpuIds.join(","),
    visible_devices: {
      cuda: env.CUDA_VISIBLE_DEVICES || "",
      nvidia: env.NVIDIA_VISIBLE_DEVICES || "",
      rocm: env.ROCR_VISIBLE_DEVICES || "",
      vulkan: env.GGML_VK_VISIBLE_DEVICES || ""
    },
    runtime_backend: runtimeEnv.backend,
    numa_node: Number.isInteger(Number(numaNode)) ? Number(numaNode) : null,
    context_length: Number.isInteger(Number(profile.contextLength)) && Number(profile.contextLength) > 0
      ? Number(profile.contextLength)
      : "auto",
    startup_timeout_ms: Number(profile.startupTimeoutMs || 180000),
    queue_limit: Number(profile.queueLimit || 64),
    model_ttl_seconds: Number(profile.modelTtlSeconds || 0) || null,
    model_parallel: Number(profile.modelParallel || 0) || null,
    restart_policy: normalizeRestartPolicy(profile.restartPolicy),
    readiness_poll_ms: readinessPollMs,
    smoke_check_enabled: smokeCheckEnabled,
    strict_smoke_check: strictSmokeCheck
  });

  await spawnLlamaServer(instanceId, record, env, numaNode);

  if (runtimeEnv.backend !== "cpu" && selectedGpuIds.length > 0) {
    const gpuMemoryAfter = await getGpuMemoryUsageMap();
    const bleed = detectGpuBleed(
      gpuMemoryBefore,
      gpuMemoryAfter,
      selectedGpuIds,
      [...allowedOtherGpuIds],
      gpuBleedMaxDeltaMiB
    );

    if (bleed.length > 0) {
      writeMeta(instanceId, "instance.start.gpu_bleed_detected", {
        selected_gpus: selectedGpuIds.join(","),
        threshold_mib: gpuBleedMaxDeltaMiB,
        bleed
      });
      if (!enforceGpuBleedInMultiInstance) {
        writeMeta(instanceId, "instance.start.gpu_bleed_ignored", {
          reason: "enforce_disabled",
          selected_gpus: selectedGpuIds.join(","),
          threshold_mib: gpuBleedMaxDeltaMiB,
          bleed
        });
      } else {
        throw new Error(
          `GPU bleed detected on unassigned devices: ${bleed.map((x) => `${x.gpuId}(+${x.deltaMiB}MiB)`).join(", ")}`
        );
      }
    }
  }

  record.state = "warming";
  record.lastError = null;
  writeMeta(instanceId, "instance.start.warming", { reason: "awaiting readiness checks" });
  void monitorReadiness(instanceId, record);
}

async function maybeAutoRestart(instanceId, record, reason) {
  if (!instances.has(instanceId) || !record) return;

  const policy = normalizeRestartPolicy(record.profile?.restartPolicy);
  if (policy.mode !== "on-failure") {
    return;
  }
  if (record.state === "stopped") {
    return;
  }
  if (record.restartInFlight) {
    return;
  }

  const attempts = Number(record.restartAttempts || 0);
  if (attempts >= policy.maxRetries) {
    writeMeta(instanceId, "instance.restart.exhausted", {
      reason,
      attempts,
      max_retries: policy.maxRetries
    });
    return;
  }

  record.restartInFlight = true;
  record.restartAttempts = attempts + 1;
  const backoffMs = policy.backoffMs * record.restartAttempts;
  writeMeta(instanceId, "instance.restart.scheduled", {
    reason,
    attempt: record.restartAttempts,
    max_retries: policy.maxRetries,
    backoff_ms: backoffMs
  });
  record.state = "restarting";

  let shouldRetry = false;
  try {
    await sleep(backoffMs);

    if (!instances.has(instanceId) || record.state === "stopped") {
      return;
    }

    if (record.process && !record.process.killed) {
      record.process.kill("SIGTERM");
    }

    await launchRuntimeForInstance(instanceId, record, `auto_restart_${record.restartAttempts}`);
    writeMeta(instanceId, "instance.restart.completed", {
      attempt: record.restartAttempts,
      reason
    });
  } catch (error) {
    record.state = "unhealthy";
    record.lastError = String(error.message || error);
    writeMeta(instanceId, "instance.restart.failed", {
      attempt: record.restartAttempts,
      error: record.lastError
    });
    shouldRetry = true;
  } finally {
    record.restartInFlight = false;
  }

  if (shouldRetry) {
    void maybeAutoRestart(instanceId, record, "restart_failure");
  }
}

async function monitorReadiness(instanceId, record) {
  const startedAt = Date.now();
  const timeoutMs = Number(record.profile?.startupTimeoutMs || 180000);
  let attempts = 0;
  let lastLoggedError = null;

  while (Date.now() - startedAt < timeoutMs) {
    if (!instances.has(instanceId) || record.state === "stopped") {
      writeMeta(instanceId, "readiness.cancelled", {
        elapsed_ms: Date.now() - startedAt,
        state: record.state
      });
      return;
    }

    attempts += 1;
    try {
      const ready = await checkInstanceReady(record.profile);
      record.lastHealthOkAt = new Date().toISOString();
      record.lastError = null;
      record.restartAttempts = 0;
      record.state = record.drain ? "draining" : "ready";
      writeMeta(instanceId, "readiness.passed", {
        attempts,
        elapsed_ms: Date.now() - startedAt,
        ...ready
      });
      return;
    } catch (error) {
      record.lastError = String(error.message || error);
      record.state = "warming";
      if (record.lastError !== lastLoggedError || attempts === 1 || attempts % 5 === 0) {
        writeMeta(instanceId, "readiness.retry", {
          attempts,
          elapsed_ms: Date.now() - startedAt,
          wait_ms: readinessPollMs,
          error: record.lastError
        });
        lastLoggedError = record.lastError;
      }
      await sleep(readinessPollMs);
    }
  }

  record.state = "unhealthy";
  writeMeta(instanceId, "readiness.timeout", {
    attempts,
    timeout_ms: timeoutMs,
    last_error: record.lastError
  });
  void maybeAutoRestart(instanceId, record, "readiness_timeout");
}

function tail(filePath, lines) {
  if (!fs.existsSync(filePath)) return "";
  const content = fs.readFileSync(filePath, "utf8");
  const rows = content.split("\n");
  return rows.slice(-lines).join("\n");
}

function gpuRuntimeDiagnostics(detail) {
  return {
    runtimeDetected: false,
    checks: [
      {
        name: "Host NVIDIA driver",
        command: "nvidia-smi",
        expected: "Lists GPU devices on host (NVIDIA)"
      },
      {
        name: "Host AMD ROCm runtime",
        command: "rocm-smi",
        expected: "Lists GPU devices on host (AMD)"
      },
      {
        name: "llama-server binary availability",
        command: "llama-server --version",
        expected: "Confirms llama-server is installed on host"
      },
      {
        name: "Bridge service user PATH",
        command: "which nvidia-smi || which rocm-smi",
        expected: "Bridge process user can resolve nvidia-smi or rocm-smi"
      }
    ],
    instructions: [
      "NVIDIA: install/update driver and verify nvidia-smi works.",
      "AMD: install ROCm and verify rocm-smi works (https://rocm.docs.amd.com/).",
      "Ensure nvidia-smi or rocm-smi is on PATH for the service account.",
      "If running under systemd, define Environment=PATH=... including GPU tool location.",
      "Ensure llama-server is installed and on PATH (set LLAMA_SERVER_BIN if needed).",
      "Restart services after changes: bridge, api."
    ],
    detail: String(detail || "nvidia-smi and rocm-smi not found")
  };
}

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "bridge", at: new Date().toISOString() });
});

app.use("/v1", auth);

app.post("/v1/system/close", async (_req, res) => {
  try {
    await stopAllServers("api:system_close");
    return res.json({ success: true });
  } catch (error) {
    return res.status(502).json({ error: String(error.message || error) });
  }
});

app.get("/v1/gpus", (_req, res) => {
  execFile(
    "nvidia-smi",
    [
      "--query-gpu=index,name,memory.total,memory.used,utilization.gpu,temperature.gpu,clocks.current.graphics,clocks.current.memory,power.draw",
      "--format=csv,noheader,nounits"
    ],
    (nvError, nvStdout) => {
      if (!nvError) {
        const data = nvStdout
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const [index, name, total, used, util, temp, graphicsClock, memoryClock, powerDraw] = line.split(",").map((x) => x.trim());
            const parseMaybeNumber = (value) => { const num = Number(value); return Number.isFinite(num) ? num : null; };
            return {
              id: index,
              name,
              memory_total_mib: Number(total),
              memory_used_mib: Number(used),
              utilization_percent: Number(util),
              temperature_c: parseMaybeNumber(temp),
              graphics_clock_mhz: parseMaybeNumber(graphicsClock),
              memory_clock_mhz: parseMaybeNumber(memoryClock),
              power_draw_w: parseMaybeNumber(powerDraw)
            };
          });
        return res.json({ data, diagnostics: { runtimeDetected: true, detail: "nvidia-smi is available to the bridge service" } });
      }

      // NVIDIA unavailable — try AMD ROCm.
      execFile("rocm-smi", ["--showmeminfo", "vram", "--showuse", "--showtemp", "--showproductname", "--showpower", "--json"], (rocmError, rocmStdout) => {
        if (rocmError) {
          return res.json({
            data: [],
            warning: "nvidia-smi and rocm-smi unavailable",
            diagnostics: gpuRuntimeDiagnostics(`nvidia-smi: ${nvError.message}; rocm-smi: ${rocmError.message}`)
          });
        }

        try {
          const parsed = JSON.parse(rocmStdout);
          const parseMaybeNumber = (value) => { const num = Number(String(value ?? "").replace(/[^0-9.\-]/g, "")); return Number.isFinite(num) ? num : null; };
          const data = Object.entries(parsed).map(([cardKey, d]) => {
            const idx = String(cardKey).replace(/^card/i, "");
            const totalBytes = Number(d["VRAM Total Memory (B)"] ?? d["vram total memory"] ?? 0);
            const usedBytes  = Number(d["VRAM Total Used Memory (B)"] ?? d["vram total used memory"] ?? 0);
            return {
              id: idx,
              name: String(d["Card series"] ?? d["Card model"] ?? `AMD GPU ${idx}`).trim(),
              memory_total_mib: Math.round(totalBytes / 1048576),
              memory_used_mib:  Math.round(usedBytes  / 1048576),
              utilization_percent: parseMaybeNumber(d["GPU use (%)"] ?? d["GPU Use (%)"]),
              temperature_c: parseMaybeNumber(d["Temperature (Sensor edge) (C)"] ?? d["Temperature (Sensor junction) (C)"]),
              graphics_clock_mhz: null,
              memory_clock_mhz: null,
              power_draw_w: parseMaybeNumber(d["Average Graphics Package Power (W)"] ?? d["Current Socket Graphics Package Power (W)"])
            };
          });
          return res.json({ data, diagnostics: { runtimeDetected: true, detail: "rocm-smi is available to the bridge service" } });
        } catch (parseErr) {
          return res.json({
            data: [],
            warning: "rocm-smi output could not be parsed",
            diagnostics: gpuRuntimeDiagnostics(String(parseErr.message || parseErr))
          });
        }
      });
    }
  );
});

// ---------------------------------------------------------------------------
// Host stats — CPU utilization (sampled delta) + system RAM
// ---------------------------------------------------------------------------

let _prevCpuSample = os.cpus().map((c) => ({ ...c.times }));

function computeCpuUtilization() {
  const curr = os.cpus().map((c) => ({ ...c.times }));
  const perCore = curr.map((core, i) => {
    const prev = _prevCpuSample[i];
    if (!prev) return null;
    const totalDelta =
      (core.user - prev.user) +
      (core.nice - prev.nice) +
      (core.sys  - prev.sys) +
      (core.idle - prev.idle) +
      (core.irq  - prev.irq);
    if (totalDelta === 0) return 0;
    const idleDelta = core.idle - prev.idle;
    return Math.round((1 - idleDelta / totalDelta) * 100);
  }).filter((v) => v !== null);
  _prevCpuSample = curr;
  return perCore;
}

app.get("/v1/host-stats", (_req, res) => {
  const memTotal = os.totalmem();
  const memFree  = os.freemem();
  const loadavg  = os.loadavg();
  const cpus     = os.cpus();
  const cpuPerCore = computeCpuUtilization();
  const cpuAvg = cpuPerCore.length > 0
    ? Math.round(cpuPerCore.reduce((a, b) => a + b, 0) / cpuPerCore.length)
    : null;
  res.json({
    mem_total_mib: Math.round(memTotal / 1048576),
    mem_used_mib:  Math.round((memTotal - memFree) / 1048576),
    loadavg,
    cpu_count: cpus.length,
    cpu_model: cpus[0]?.model?.replace(/\s+/g, " ").trim() || "Unknown CPU",
    cpu_utilization_percent: cpuAvg,
    cpu_per_core: cpuPerCore
  });
});

app.get("/v1/instances", (_req, res) => {
  const data = [...instances.entries()].map(([instanceId, value]) => ({
    instanceId,
    pid: value.process?.pid || null,
    state: value.state,
    inflightRequests: value.inflightRequests,
    queueDepth: value.queueDepth,
    drain: value.drain
  }));
  res.json({ data });
});

app.post("/v1/instances/start", async (req, res) => {
  const instanceId = req.body?.instanceId;
  const profile = req.body?.profile;
  if (!isValidInstanceId(instanceId) || !profile?.port || !profile?.model) {
    return res.status(400).json({ error: "valid instanceId, profile.port, and profile.model are required" });
  }

  const running = instances.get(instanceId);
  if (running && running.state !== "stopped") {
    return res.status(409).json({ error: "instance already running" });
  }

  const restartPolicy = normalizeRestartPolicy(profile?.restartPolicy);

  const record = {
    profile,
    process: null,
    state: "starting",
    inflightRequests: 0,
    queueDepth: 0,
    drain: false,
    lastHealthOkAt: null,
    lastError: null,
    restartPolicy,
    restartAttempts: 0,
    restartInFlight: false
  };

  instances.set(instanceId, record);

  try {
    await launchRuntimeForInstance(instanceId, record, "start_request");
  } catch (error) {
    const errorText = String(error.message || error);
    const isInputError = errorText.includes("non-CPU runtime requires explicit GPU selection");
    record.state = "unhealthy";
    record.lastError = errorText;
    writeMeta(instanceId, "instance.start.failed", { error: record.lastError });
    if (!isInputError) {
      void maybeAutoRestart(instanceId, record, "startup_failure");
    }
    return res.status(isInputError ? 400 : 500).json({ error: errorText });
  }

  res.status(201).json({
    success: true,
    instanceId,
    pid: record.process?.pid || null,
    state: record.state
  });
});

app.post("/v1/instances/:id/stop", async (req, res) => {
  if (!isValidInstanceId(req.params.id)) return res.status(400).json({ error: "invalid instance id" });
  const record = instances.get(req.params.id);
  if (!record) return res.status(404).json({ error: "instance not found" });

  try {
    writeMeta(req.params.id, "instance.stop.request", {
      has_process: Boolean(record.process && !record.process.killed),
      port: Number(record.profile?.port)
    });
    record.state = "draining";
    if (record.process && !record.process.killed) {
      record.process.kill("SIGTERM");
    }
    record.state = "stopped";
    record.restartInFlight = false;
    record.restartAttempts = 0;
    writeMeta(req.params.id, "instance.stop.completed", { state: record.state });
    res.json({ success: true });
  } catch (error) {
    writeMeta(req.params.id, "instance.stop.failed", { error: String(error.message || error) });
    res.status(502).json({ error: String(error.message || error) });
  }
});

app.post("/v1/instances/:id/kill", async (req, res) => {
  if (!isValidInstanceId(req.params.id)) return res.status(400).json({ error: "invalid instance id" });
  const record = instances.get(req.params.id);
  if (!record) return res.status(404).json({ error: "instance not found" });

  try {
    writeMeta(req.params.id, "instance.kill.request", {
      has_process: Boolean(record.process && !record.process.killed),
      port: Number(record.profile?.port)
    });
    if (record.process && !record.process.killed) {
      record.process.kill("SIGKILL");
    }
    record.state = "stopped";
    record.restartInFlight = false;
    record.restartAttempts = 0;
    writeMeta(req.params.id, "instance.kill.completed", { state: record.state });
    res.json({ success: true });
  } catch (error) {
    writeMeta(req.params.id, "instance.kill.failed", { error: String(error.message || error) });
    res.status(502).json({ error: String(error.message || error) });
  }
});

app.post("/v1/instances/:id/drain", (req, res) => {
  if (!isValidInstanceId(req.params.id)) return res.status(400).json({ error: "invalid instance id" });
  const record = instances.get(req.params.id);
  if (!record) return res.status(404).json({ error: "instance not found" });

  const enabled = Boolean(req.body?.enabled);
  record.drain = enabled;
  record.state = enabled ? "draining" : "ready";
  writeMeta(req.params.id, "instance.drain.updated", { enabled, state: record.state });
  res.json({ success: true, enabled });
});

app.get("/v1/instances/:id/logs", (req, res) => {
  if (!isValidInstanceId(req.params.id)) return res.status(400).json({ error: "invalid instance id" });
  const lines = Number(req.query.lines || defaultLogLines);
  const file = path.join(logsDir, `${req.params.id}.log`);
  res.json({
    instanceId: req.params.id,
    lines,
    data: tail(file, lines)
  });
});

const server = app.listen(port, () => {
  console.log(`lmlaunch bridge listening on ${port}`);
});

let shutdownInProgress = false;

async function gracefulShutdown(signal) {
  if (shutdownInProgress) return;
  shutdownInProgress = true;
  console.log(`Bridge shutdown signal received: ${signal}`);

  server.close(() => {
    // No-op callback; shutdown flow continues below.
  });

  await stopAllServers(`shutdown:${signal}`);
  process.exit(0);
}

process.on("SIGINT", () => {
  void gracefulShutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void gracefulShutdown("SIGTERM");
});
