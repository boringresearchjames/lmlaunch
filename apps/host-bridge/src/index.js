import express from "express";
import { execFile } from "child_process";
import fs from "fs";
import path from "path";

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
const bootstrapLmsServer = process.env.BOOTSTRAP_LMS_SERVER !== "false";
const cleanupOldInstancesOnStart = process.env.CLEANUP_OLD_INSTANCES_ON_START !== "false";
const cleanupOldInstancesOnExit = process.env.CLEANUP_OLD_INSTANCES_ON_EXIT !== "false";
const cleanupUnloadModelsOnStart = process.env.CLEANUP_UNLOAD_MODELS_ON_START !== "false";
const cleanupUnloadModelsOnExit = process.env.CLEANUP_UNLOAD_MODELS_ON_EXIT !== "false";
const cleanupStopDaemonOnExit = process.env.CLEANUP_STOP_DAEMON_ON_EXIT === "true";
const gpuBleedMaxDeltaMiB = Number(process.env.GPU_BLEED_MAX_DELTA_MIB || 256);
const allowBleedOnOtherAssignedGpus = process.env.GPU_BLEED_ALLOW_OTHER_ASSIGNED === "true";
const bootstrapHost = String(process.env.LMSTUDIO_HOST || "127.0.0.1");
const bootstrapPort = Number(process.env.LMSTUDIO_PORT || 1234);

if (!bridgeAuthEnabled) {
  console.warn("Bridge auth disabled: BRIDGE_AUTH_TOKEN not set.");
}

const dataRoot = process.env.DATA_ROOT || path.resolve(process.cwd(), "data");
const logsDir = path.join(dataRoot, "logs");
fs.mkdirSync(logsDir, { recursive: true });

const instances = new Map();
let numactlSupportedCache = null;
let serverStartApiKeySupportedCache = null;
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
    : ["server", "start", "--port", "{port}"];

  const contextValue = Number.isInteger(Number(profile?.contextLength)) && Number(profile?.contextLength) > 0
    ? String(Number(profile.contextLength))
    : "auto";

  const bindHost = String(profile?.bindHost || "0.0.0.0").trim() || "0.0.0.0";

  const args = raw.map((arg) => String(arg)
    .replaceAll("{port}", String(profile?.port || ""))
    .replaceAll("{model}", String(profile?.model || ""))
    .replaceAll("{contextLength}", contextValue)
    .replaceAll("{bindHost}", bindHost));

  const hasBind = args.some((arg, idx) => arg === "--bind" || (idx > 0 && args[idx - 1] === "--bind") || arg.startsWith("--bind="));
  if (!hasBind) {
    args.push("--bind", bindHost);
  }

  return args;
}

function normalizeRuntimeBackend(value) {
  const raw = String(value || "auto").trim().toLowerCase();
  if (raw === "valkun") return "vulkan";
  if (["auto", "cuda", "cuda12", "cpu", "vulkan"].includes(raw)) return raw;
  return "auto";
}

function normalizeGpuList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((gpu) => String(gpu).trim()).filter(Boolean))];
}

function applyGpuVisibilityEnv(env, gpuList) {
  const value = Array.isArray(gpuList) ? gpuList.join(",") : "";
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
    env.LMSTUDIO_RUNTIME_BACKEND = "cpu";
    env.LMSTUDIO_COMPUTE_BACKEND = "cpu";
    return { env, backend, gpuIds };
  }

  if (backend === "vulkan") {
    applyGpuVisibilityEnv(env, gpuIds);
    env.LMSTUDIO_RUNTIME_BACKEND = "vulkan";
    env.LMSTUDIO_COMPUTE_BACKEND = "vulkan";
    env.GGML_VULKAN = "1";
    return { env, backend, gpuIds };
  }

  if (backend === "cuda" || backend === "cuda12") {
    applyGpuVisibilityEnv(env, gpuIds);
    env.LMSTUDIO_RUNTIME_BACKEND = "cuda";
    env.LMSTUDIO_COMPUTE_BACKEND = "cuda";
    return { env, backend, gpuIds };
  }

  applyGpuVisibilityEnv(env, gpuIds);
  env.LMSTUDIO_RUNTIME_BACKEND = "auto";
  env.LMSTUDIO_COMPUTE_BACKEND = "auto";
  return { env, backend: "auto", gpuIds };
}

async function runLms(args, env, options = {}) {
  const { instanceId = null, label = args.join(" "), numaNode = null } = options;
  const startedAt = Date.now();
  let command = "lms";
  let commandArgs = Array.isArray(args) ? args.map((x) => String(x)) : [];

  if (Number.isInteger(numaNode) && Number(numaNode) >= 0 && await isNumactlSupported()) {
    command = "numactl";
    commandArgs = [
      `--cpunodebind=${Number(numaNode)}`,
      `--membind=${Number(numaNode)}`,
      "lms",
      ...commandArgs
    ];
  }

  if (instanceId) {
    writeMeta(instanceId, "lms.exec.start", {
      label: redactSensitiveText(label),
      command,
      args: redactCommandArgs(commandArgs),
      numa_node: Number.isInteger(Number(numaNode)) ? Number(numaNode) : null
    });
  }

  return new Promise((resolve, reject) => {
    execFile(command, commandArgs, { env }, (error, stdout, stderr) => {
      const durationMs = Date.now() - startedAt;
      const stdoutText = clipText(stdout);
      const stderrText = clipText(stderr);

      if (instanceId) {
        writeMeta(instanceId, "lms.exec.finish", {
          label: redactSensitiveText(label),
          duration_ms: durationMs,
          ok: !error,
          stdout: stdoutText,
          stderr: stderrText,
          error: error ? String(error.message || error) : null
        });
      }

      if (error) {
        return reject(new Error(`${label} failed: ${stderr || stdout || error.message}`));
      }
      return resolve({ stdout, stderr, durationMs });
    });
  });
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

async function isServerStartApiKeySupported() {
  if (typeof serverStartApiKeySupportedCache === "boolean") {
    return serverStartApiKeySupportedCache;
  }

  const help = await runCommand("lms", ["server", "start", "--help"]);
  const text = `${help.stdout || ""}\n${help.stderr || ""}`.toLowerCase();
  serverStartApiKeySupportedCache = text.includes("--api-key");
  return serverStartApiKeySupportedCache;
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
  const result = await runCommand("nvidia-smi", [
    "--query-gpu=index,memory.used",
    "--format=csv,noheader,nounits"
  ]);

  if (!result.ok) {
    return null;
  }

  const map = new Map();
  const lines = String(result.stdout || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const [indexRaw, memRaw] = line.split(",").map((x) => String(x || "").trim());
    const mem = Number(memRaw);
    if (indexRaw !== "" && Number.isFinite(mem)) {
      map.set(String(indexRaw), mem);
    }
  }

  return map;
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

function isNoRunningServersMessage(text) {
  const msg = String(text || "").toLowerCase();
  return msg.includes("no server") || msg.includes("no running") || msg.includes("not running");
}

function isNoLoadedModelsMessage(text) {
  const msg = String(text || "").toLowerCase();
  return msg.includes("no loaded models")
    || msg.includes("there are no models loaded")
    || msg.includes("nothing to unload")
    || msg.includes("no models are loaded");
}

async function appearsLoaded(instanceId, modelId) {
  const result = await runCommand("lms", ["ps"]);
  if (!result.ok) {
    return false;
  }

  const text = `${result.stdout}\n${result.stderr}`.toLowerCase();
  const needles = [String(instanceId || "").trim(), String(modelId || "").trim()]
    .filter(Boolean)
    .map((x) => x.toLowerCase());

  return needles.some((needle) => text.includes(needle));
}

function knownModelsFromInstances() {
  return [...new Set(
    [...instances.values()]
      .map((record) => String(record?.profile?.model || "").trim())
      .filter(Boolean)
  )];
}

function hasOtherActiveInstances(excludeInstanceId = null) {
  for (const [id, record] of instances.entries()) {
    if (excludeInstanceId && id === excludeInstanceId) continue;
    if (!record || record.state === "stopped") continue;
    return true;
  }
  return false;
}

async function unloadModels(reason = "unspecified") {
  const knownModels = knownModelsFromInstances();
  const allResult = await runCommand("lms", ["unload", "--all"]);
  const allCombined = `${allResult.stdout}\n${allResult.stderr}\n${allResult.error || ""}`;

  if (allResult.ok || isNoLoadedModelsMessage(allCombined)) {
    console.log(`LM Studio cleanup (${reason}): unload-all completed`);
  } else {
    console.warn(`LM Studio cleanup (${reason}) unload-all failed: ${clipText(allCombined, 300)}`);
  }

  for (const model of knownModels) {
    const result = await runCommand("lms", ["unload", model]);
    const combined = `${result.stdout}\n${result.stderr}\n${result.error || ""}`;
    if (!(result.ok || isNoLoadedModelsMessage(combined))) {
      console.warn(`LM Studio cleanup (${reason}) unload ${model} failed: ${clipText(combined, 240)}`);
    }
  }
}

async function stopDaemon(reason = "unspecified") {
  const result = await runCommand("lms", ["daemon", "down"]);
  const combined = `${result.stdout}\n${result.stderr}\n${result.error || ""}`;
  if (result.ok || isNoRunningServersMessage(combined)) {
    console.log(`LM Studio cleanup (${reason}): daemon down completed`);
    return;
  }
  console.warn(`LM Studio cleanup (${reason}) daemon down failed: ${clipText(combined, 300)}`);
}

function isObserverShutdownRequested(text) {
  const msg = String(text || "").toLowerCase();
  return msg.includes("system resources observer shutdown requested")
    || msg.includes("observer shutdown requested");
}

async function waitForDaemonReady(instanceId = null, reason = "daemon_up") {
  const timeoutMs = 15000;
  const startedAt = Date.now();
  let lastDetail = "";

  while ((Date.now() - startedAt) < timeoutMs) {
    const probe = await runCommand("lms", ["ps"]);
    const combined = `${probe.stdout}\n${probe.stderr}\n${probe.error || ""}`;
    lastDetail = clipText(combined, 220);

    if (probe.ok && !isObserverShutdownRequested(combined)) {
      return;
    }

    if (isObserverShutdownRequested(combined) && instanceId) {
      writeMeta(instanceId, "instance.daemon.wait", {
        reason,
        detail: lastDetail
      });
    }

    await sleep(400);
  }

  throw new Error(`LM Studio daemon did not stabilize after ${timeoutMs}ms (${lastDetail || "no detail"})`);
}

function daemonSettleDelayMs() {
  const raw = Number(process.env.LM_LAUNCH_DAEMON_SETTLE_MS || "1800");
  if (!Number.isFinite(raw) || raw < 0) {
    return 1800;
  }
  return Math.min(raw, 10000);
}

async function recycleDaemonWithEnv(env, instanceId = null, reason = "prelaunch") {
  try {
    await runLms(["daemon", "down"], env, {
      instanceId,
      label: `lms daemon down (${reason})`
    });
  } catch (error) {
    const text = String(error.message || error).toLowerCase();
    const benign = text.includes("not running") || text.includes("no running");
    if (!benign) {
      throw error;
    }
  }

  await runLms(["daemon", "up"], env, {
    instanceId,
    label: `lms daemon up (${reason})`
  });

  await waitForDaemonReady(instanceId, reason);
  await sleep(daemonSettleDelayMs());
}

async function stopAllServers(reason = "unspecified", options = {}) {
  const {
    unloadModelsAfterStop = false,
    stopDaemonAfterStop = false
  } = options;
  const env = { ...process.env };
  try {
    await ensureDaemonUp(env);
  } catch (error) {
    console.warn(`LM Studio daemon check failed during cleanup (${reason}): ${String(error.message || error)}`);
    return;
  }

  const result = await runCommand("lms", ["server", "stop"]);
  const combined = `${result.stdout}\n${result.stderr}\n${result.error || ""}`;
  const stopOk = result.ok || isNoRunningServersMessage(combined);
  if (stopOk) {
    console.log(`LM Studio cleanup (${reason}): stop-all completed`);
    for (const [instanceId, record] of instances.entries()) {
      record.state = "stopped";
      record.lastError = null;
      writeMeta(instanceId, "instance.lifecycle.cleaned", { reason, action: "server_stop_all" });
    }
  } else {
    console.warn(`LM Studio cleanup (${reason}) failed: ${clipText(combined, 300)}`);
  }

  if (unloadModelsAfterStop) {
    await unloadModels(reason);
  }

  if (stopDaemonAfterStop) {
    await stopDaemon(reason);
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

async function ensureDaemonUp(env, instanceId = null) {
  await runLms(["daemon", "up"], env, {
    instanceId,
    label: "lms daemon up"
  });

  await waitForDaemonReady(instanceId, "ensure_daemon_up");
}

async function ensureServerStart(env, port, instanceId = null) {
  await runLms(["server", "start", "--port", String(port)], env, {
    instanceId,
    label: `lms server start --port ${port}`
  });
}

async function ensureServerStartWithArgs(env, args, instanceId = null, options = {}) {
  const startArgs = Array.isArray(args) && args.length > 0
    ? args.map((x) => String(x))
    : ["server", "start"];
  const numaNode = options?.numaNode;
  await runLms(startArgs, env, {
    instanceId,
    label: `lms ${startArgs.join(" ")}`,
    numaNode
  });
}

async function selectRuntime(runtimeId, env, instanceId = null) {
  if (!runtimeId || runtimeId === "auto") {
    return;
  }
  const runtimeIdStr = String(runtimeId || "").trim();
  if (!runtimeIdStr) {
    return;
  }
  try {
    await runLms(["runtime", "select", runtimeIdStr], env, {
      instanceId,
      label: `lms runtime select ${runtimeIdStr}`
    });
    if (instanceId) {
      writeMeta(instanceId, "instance.runtime.selected", {
        runtime_id: runtimeIdStr
      });
    }
  } catch (error) {
    if (instanceId) {
      writeMeta(instanceId, "instance.runtime.selection.failed", {
        runtime_id: runtimeIdStr,
        error: String(error?.message || error)
      });
    }
    throw new Error(`Failed to select runtime ${runtimeIdStr}: ${error?.message || error}`);
  }
}

async function ensureModelLoaded(model, env, instanceId = null, options = {}) {
  const modelId = String(model || "").trim();
  if (!modelId) {
    throw new Error("model is required for load");
  }

  const args = ["load", modelId];
  if (instanceId) {
    args.push("--identifier", String(instanceId));
  }
  const ttlSeconds = Number(options?.ttlSeconds);
  if (Number.isInteger(ttlSeconds) && ttlSeconds > 0) {
    args.push("--ttl", String(ttlSeconds));
  }

  const parallel = Number(options?.parallel);
  if (Number.isInteger(parallel) && parallel > 0) {
    args.push("--parallel", String(parallel));
  }

  const numaNode = options?.numaNode;
  try {
    await runLms(args, env, {
      instanceId,
      label: `lms ${args.join(" ")}`,
      numaNode
    });
  } catch (error) {
    const message = String(error?.message || error || "");
    if (!isObserverShutdownRequested(message)) {
      throw error;
    }

    if (instanceId) {
      writeMeta(instanceId, "instance.model.load.retry", {
        reason: "observer_shutdown_requested",
        delay_ms: daemonSettleDelayMs()
      });
    }

    await sleep(daemonSettleDelayMs());
    await runLms(args, env, {
      instanceId,
      label: `lms ${args.join(" ")} (retry)` ,
      numaNode
    });
  }
}

async function stopServer(profile, env, instanceId = null) {
  const port = Number(profile?.port);
  if (Number.isInteger(port) && port > 0) {
    try {
      await runLms(["server", "stop", "--port", String(port)], env, {
        instanceId,
        label: `lms server stop --port ${port}`
      });
      return;
    } catch (error) {
      const text = String(error.message || error).toLowerCase();
      const unsupportedPortFlag = text.includes("unknown option '--port'");
      if (!unsupportedPortFlag) {
        throw error;
      }

      if (instanceId) {
        writeMeta(instanceId, "instance.stop.port_flag_unsupported", {
          port,
          detail: "falling back to lms server stop"
        });
      }
    }
  }

  await runLms(["server", "stop"], env, {
    instanceId,
    label: "lms server stop"
  });
}

function hasOtherActiveInstanceUsingModel(instanceId, modelId) {
  const normalizedModel = String(modelId || "").trim();
  if (!normalizedModel) return false;

  for (const [id, record] of instances.entries()) {
    if (id === instanceId) continue;
    if (!record || record.state === "stopped") continue;
    const peerModel = String(record?.profile?.model || "").trim();
    if (peerModel && peerModel === normalizedModel) {
      return true;
    }
  }
  return false;
}

async function unloadInstanceModel(instanceId, modelId, reason = "instance_stop") {
  const instanceTag = String(instanceId || "").trim();
  if (!instanceTag) return { unloaded: false, reason: "missing_instance_id" };

  const identifierResult = await runCommand("lms", ["unload", "--identifier", instanceTag]);
  const identifierCombined = `${identifierResult.stdout}\n${identifierResult.stderr}\n${identifierResult.error || ""}`;
  if (identifierResult.ok || isNoLoadedModelsMessage(identifierCombined)) {
    const stillLoaded = await appearsLoaded(instanceTag, modelId);
    if (stillLoaded && !hasOtherActiveInstances(instanceTag)) {
      const allResult = await runCommand("lms", ["unload", "--all"]);
      const allCombined = `${allResult.stdout}\n${allResult.stderr}\n${allResult.error || ""}`;
      const allOk = allResult.ok || isNoLoadedModelsMessage(allCombined);
      writeMeta(instanceTag, "instance.model.unload", {
        reason,
        method: "all_verify",
        ok: allOk,
        detail: clipText(allCombined, 200)
      });
      if (allOk) {
        return { unloaded: true, method: "all_verify" };
      }
    }

    writeMeta(instanceTag, "instance.model.unload", {
      reason,
      method: "identifier",
      ok: true,
      detail: clipText(identifierCombined, 200)
    });
    return { unloaded: true, method: "identifier" };
  }

  const model = String(modelId || "").trim();
  if (!model) {
    writeMeta(instanceTag, "instance.model.unload", {
      reason,
      method: "identifier",
      ok: false,
      detail: clipText(identifierCombined, 200)
    });
    return { unloaded: false, reason: "identifier_failed_no_model" };
  }

  if (hasOtherActiveInstanceUsingModel(instanceTag, model)) {
    writeMeta(instanceTag, "instance.model.unload.skipped", {
      reason,
      model,
      detail: "other active instance uses same model"
    });
    return { unloaded: false, reason: "shared_model_active" };
  }

  const modelResult = await runCommand("lms", ["unload", model]);
  const modelCombined = `${modelResult.stdout}\n${modelResult.stderr}\n${modelResult.error || ""}`;
  const modelOk = modelResult.ok || isNoLoadedModelsMessage(modelCombined);
  writeMeta(instanceTag, "instance.model.unload", {
    reason,
    method: "model",
    model,
    ok: modelOk,
    detail: clipText(modelCombined, 200)
  });

  if (!modelOk) {
    if (!hasOtherActiveInstances(instanceTag)) {
      const allResult = await runCommand("lms", ["unload", "--all"]);
      const allCombined = `${allResult.stdout}\n${allResult.stderr}\n${allResult.error || ""}`;
      const allOk = allResult.ok || isNoLoadedModelsMessage(allCombined);
      writeMeta(instanceTag, "instance.model.unload", {
        reason,
        method: "all",
        ok: allOk,
        detail: clipText(allCombined, 200)
      });
      if (allOk) {
        return { unloaded: true, method: "all" };
      }
    }
    return { unloaded: false, reason: "model_unload_failed" };
  }

  if (!hasOtherActiveInstances(instanceTag)) {
    const stillLoaded = await appearsLoaded(instanceTag, model);
    if (stillLoaded) {
      const allResult = await runCommand("lms", ["unload", "--all"]);
      const allCombined = `${allResult.stdout}\n${allResult.stderr}\n${allResult.error || ""}`;
      const allOk = allResult.ok || isNoLoadedModelsMessage(allCombined);
      writeMeta(instanceTag, "instance.model.unload", {
        reason,
        method: "all_verify",
        ok: allOk,
        detail: clipText(allCombined, 200)
      });
      if (allOk) {
        return { unloaded: true, method: "all_verify" };
      }
      return { unloaded: false, reason: "verify_still_loaded" };
    }
  }

  return { unloaded: true, method: "model" };
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

async function checkServerReady(host, port) {
  const timeout = withTimeout(readinessHttpTimeoutMs);
  const response = await fetch(`http://${host}:${port}/v1/models`, { signal: timeout.signal });
  timeout.done();
  if (!response.ok) {
    throw new Error(`models endpoint not ready (${response.status})`);
  }
}

async function bootstrapServer() {
  if (!bootstrapLmsServer) {
    return;
  }

  const env = { ...process.env };
  await ensureDaemonUp(env);

  try {
    await checkServerReady(bootstrapHost, bootstrapPort);
    console.log(`LM Studio server already reachable at ${bootstrapHost}:${bootstrapPort}`);
    return;
  } catch {
    // Not ready yet, try to start it.
  }

  await ensureServerStart(env, bootstrapPort);

  const startedAt = Date.now();
  const timeoutMs = 30000;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await checkServerReady(bootstrapHost, bootstrapPort);
      console.log(`LM Studio server ready at ${bootstrapHost}:${bootstrapPort}`);
      return;
    } catch {
      await sleep(750);
    }
  }

  throw new Error(`LM Studio server did not become ready on ${bootstrapHost}:${bootstrapPort} within ${timeoutMs}ms`);
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

  const runtimeArgs = resolveServerArgs(profile);
  const requestedApiKey = String(profile?.instanceApiKey || "").trim();
  const apiKeySupported = requestedApiKey ? await isServerStartApiKeySupported() : false;
  const apiKeyApplied = Boolean(requestedApiKey && apiKeySupported);
  if (requestedApiKey && apiKeySupported) {
    const hasApiKeyArg = runtimeArgs.some((arg, idx) => arg === "--api-key" || (idx > 0 && runtimeArgs[idx - 1] === "--api-key") || arg.startsWith("--api-key="));
    if (!hasApiKeyArg) {
      runtimeArgs.push("--api-key", requestedApiKey);
    }
  }
  if (requestedApiKey && !apiKeySupported) {
    writeMeta(instanceId, "instance.auth.api_key.unsupported", {
      detail: "lms server start --help does not include --api-key; launching without instance auth"
    });
  }
  record.apiKeyApplied = apiKeyApplied;
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
    instance_api_key_requested: Boolean(requestedApiKey),
    instance_api_key_applied: apiKeyApplied,
    numa_node: Number.isInteger(Number(numaNode)) ? Number(numaNode) : null,
    runtime_args: redactSensitiveText(runtimeArgs.join(" ")),
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

  const singleInstanceMode = !hasOtherActiveInstances(instanceId);
  if (runtimeEnv.backend !== "cpu" && selectedGpuIds.length > 0 && singleInstanceMode) {
    writeMeta(instanceId, "instance.daemon.recycle", {
      reason: "single_instance_gpu_isolation"
    });
    await recycleDaemonWithEnv(env, instanceId, "single_instance_gpu_isolation");
  } else {
    await ensureDaemonUp(env, instanceId);
  }

  const runtimeSelection = String(profile?.runtime?.selection || "").trim();
  if (runtimeSelection && runtimeSelection !== "auto") {
    await selectRuntime(runtimeSelection, env, instanceId);
  }

  await ensureServerStartWithArgs(env, runtimeArgs, instanceId, { numaNode });
  await ensureModelLoaded(profile.model, env, instanceId, {
    ttlSeconds: profile.modelTtlSeconds,
    parallel: profile.modelParallel,
    numaNode
  });

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
      throw new Error(
        `GPU bleed detected on unassigned devices: ${bleed.map((x) => `${x.gpuId}(+${x.deltaMiB}MiB)`).join(", ")}`
      );
    }
  }

  writeMeta(instanceId, "instance.start.model.loaded", {
    model: String(profile.model),
    ttl_seconds: Number(profile.modelTtlSeconds || 0) || null,
    parallel: Number(profile.modelParallel || 0) || null
  });

  record.state = "warming";
  record.lastError = null;
  writeMeta(instanceId, "instance.start.warming", {
    reason: "awaiting readiness checks"
  });
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

    try {
      await stopServer(record.profile, process.env, instanceId);
    } catch {
      // Best effort pre-restart cleanup.
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
        expected: "Lists GPU devices on host"
      },
      {
        name: "LM Studio CLI availability",
        command: "lms --version",
        expected: "Confirms LM Studio CLI is installed on host"
      },
      {
        name: "Bridge service user PATH",
        command: "which nvidia-smi",
        expected: "Bridge process user can resolve nvidia-smi"
      }
    ],
    instructions: [
      "Install/update NVIDIA GPU driver on the server and verify host nvidia-smi works.",
      "Ensure nvidia-smi is on PATH for the service account running LM Launch.",
      "If running under systemd, define Environment=PATH=... including NVIDIA binary location.",
      "Restart services after changes: bridge, api, then web."
    ],
    detail: String(detail || "nvidia-smi not found")
  };
}

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "bridge", at: new Date().toISOString() });
});

app.use("/v1", auth);

app.get("/v1/runtime/backends", async (_req, res) => {
  const lm = await runCommand("lms", ["--version"]);
  const lmVersion = (lm.stdout || lm.stderr).trim().split("\n").find(Boolean) || null;

  const osLabelByPlatform = {
    win32: "Windows",
    linux: "Linux",
    darwin: "macOS"
  };
  const osLabel = osLabelByPlatform[process.platform] || process.platform;

  const ggufRuntimes = [
    {
      id: "gguf:auto",
      backend: "auto",
      label: `Auto llama.cpp (${osLabel})`,
      version: lmVersion,
      available: true,
      detail: "Let LM Studio choose the best GGUF runtime"
    },
    {
      id: "gguf:cpu",
      backend: "cpu",
      label: `CPU llama.cpp (${osLabel})`,
      version: lmVersion,
      available: true,
      detail: `CPU runtime on ${process.arch}`
    }
  ];

  // Query all available runtimes from lms runtime ls
  // Format: llama.cpp-<platform>-<backend>-<arch>@<version>
  const runtimesList = await runCommand("lms", ["runtime", "ls"]);
  if (runtimesList.ok) {
    const lines = (runtimesList.stdout || "").split("\n").map(l => l.trim()).filter(Boolean);
    const cudaVersions = new Set();
    const cuda12Versions = new Set();
    let hasVulkan = false;

    for (const line of lines) {
      // Skip header lines
      if (line.includes("LLM ENGINE") || line.includes("SELECTED")) continue;

      // Parse llama.cpp-<platform>-<backend>-<arch>@<version>
      const match = line.match(/llama\.cpp-[^-]+-([^-@]+)(?:-[^@]*)?@([0-9.]+)/);
      if (!match) continue;

      const backend = match[1]; // e.g., "nvidia-cuda", "nvidia-cuda12", "vulkan", "avx2"
      const version = match[2]; // e.g., "2.13.0"

      if (backend.includes("cuda12")) {
        cuda12Versions.add(String(version));
      } else if (backend.includes("cuda")) {
        cudaVersions.add(String(version));
      } else if (backend.includes("vulkan")) {
        hasVulkan = true;
      }
    }

    // Add CUDA versions (non-cuda12)
    const sortedCudaVersions = Array.from(cudaVersions).sort((a, b) => {
      const aparts = a.split(".").map(Number);
      const bparts = b.split(".").map(Number);
      for (let i = 0; i < Math.max(aparts.length, bparts.length); i++) {
        const av = aparts[i] || 0;
        const bv = bparts[i] || 0;
        if (av !== bv) return bv - av;
      }
      return 0;
    });

    for (const version of sortedCudaVersions) {
      const major = String(version).split(".")[0];
      ggufRuntimes.push({
        id: `gguf:cuda:${version}`,
        backend: "cuda",
        label: `CUDA ${major} llama.cpp (${osLabel})`,
        version: lmVersion,
        available: true,
        detail: `CUDA ${version}`
      });
    }

    // Add CUDA 12 versions
    const sortedCuda12Versions = Array.from(cuda12Versions).sort((a, b) => {
      const aparts = a.split(".").map(Number);
      const bparts = b.split(".").map(Number);
      for (let i = 0; i < Math.max(aparts.length, bparts.length); i++) {
        const av = aparts[i] || 0;
        const bv = bparts[i] || 0;
        if (av !== bv) return bv - av;
      }
      return 0;
    });

    for (const version of sortedCuda12Versions) {
      ggufRuntimes.push({
        id: `gguf:cuda12:${version}`,
        backend: "cuda12",
        label: `CUDA 12 llama.cpp (${osLabel})`,
        version: lmVersion,
        available: true,
        detail: `CUDA 12 • ${version}`
      });
    }

    // Add Vulkan if detected
    if (hasVulkan) {
      ggufRuntimes.push({
        id: "gguf:vulkan",
        backend: "vulkan",
        label: `Vulkan llama.cpp (${osLabel})`,
        version: lmVersion,
        available: true,
        detail: "Vulkan runtime"
      });
    }
  } else {
    // Fallback: detect via nvidia-smi and vulkaninfo if lms runtime ls fails
    const nvidiaSummary = await runCommand("nvidia-smi", []);
    const cudaMatch = (nvidiaSummary.stdout || "").match(/CUDA Version:\s*([0-9.]+)/i);
    const driverMatch = (nvidiaSummary.stdout || "").match(/Driver Version:\s*([0-9.]+)/i);
    const hasCuda = nvidiaSummary.ok;

    const vulkanSummary = await runCommand("vulkaninfo", ["--summary"]);
    const vulkanFirstLine = (vulkanSummary.stdout || "").trim().split("\n").find(Boolean) || null;
    const hasVulkan = vulkanSummary.ok;

    const cudaVersion = cudaMatch ? String(cudaMatch[1]) : null;
    const cudaMajor = cudaVersion ? String(cudaVersion).split(".")[0] : null;

    if (hasCuda && cudaVersion) {
      ggufRuntimes.push({
        id: `gguf:cuda:${cudaVersion}`,
        backend: "cuda",
        label: `CUDA ${cudaMajor || "detected"} llama.cpp (${osLabel})`,
        version: lmVersion,
        available: true,
        detail: driverMatch ? `NVIDIA driver ${driverMatch[1]} • CUDA ${cudaVersion}` : `CUDA ${cudaVersion}`
      });
    }

    if (hasVulkan) {
      ggufRuntimes.push({
        id: "gguf:vulkan",
        backend: "vulkan",
        label: `Vulkan llama.cpp (${osLabel})`,
        version: lmVersion,
        available: true,
        detail: vulkanFirstLine || "Vulkan runtime detected"
      });
    }
  }

  return res.json({
    lmstudio_version: lmVersion,
    gguf_runtimes: ggufRuntimes
  });
});

app.post("/v1/system/close", async (req, res) => {
  const unloadModelsAfterStop = req.body?.unloadModels !== false;
  const stopDaemonAfterStop = req.body?.stopDaemon !== false;

  try {
    await stopAllServers("api:system_close", {
      unloadModelsAfterStop,
      stopDaemonAfterStop
    });

    return res.json({
      success: true,
      unloadedModels: unloadModelsAfterStop,
      stoppedDaemon: stopDaemonAfterStop
    });
  } catch (error) {
    return res.status(502).json({ error: String(error.message || error) });
  }
});

app.get("/v1/gpus", (_req, res) => {
  execFile(
    "nvidia-smi",
    [
      "--query-gpu=index,name,memory.total,memory.used,utilization.gpu,temperature.gpu,clocks.current.graphics,clocks.current.memory",
      "--format=csv,noheader,nounits"
    ],
    (error, stdout) => {
      if (error) {
        return res.json({
          data: [],
          warning: "nvidia-smi unavailable",
          diagnostics: gpuRuntimeDiagnostics(error.message)
        });
      }

      const data = stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [index, name, total, used, util, temp, graphicsClock, memoryClock] = line.split(",").map((x) => x.trim());
          const parseMaybeNumber = (value) => {
            const num = Number(value);
            return Number.isFinite(num) ? num : null;
          };
          return {
            id: index,
            name,
            memory_total_mib: Number(total),
            memory_used_mib: Number(used),
            utilization_percent: Number(util),
            temperature_c: parseMaybeNumber(temp),
            graphics_clock_mhz: parseMaybeNumber(graphicsClock),
            memory_clock_mhz: parseMaybeNumber(memoryClock)
          };
        });
      return res.json({
        data,
        diagnostics: {
          runtimeDetected: true,
          detail: "nvidia-smi is available to the bridge service"
        }
      });
    }
  );
});

app.get("/v1/models", async (req, res) => {
  const host = String(req.query.host || "127.0.0.1");
  const port = Number(req.query.port || 1234);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return res.status(400).json({ error: "invalid port" });
  }

  const allowedHosts = ["127.0.0.1", "localhost", "::1"];
  if (!allowedHosts.includes(host)) {
    return res.status(400).json({ error: "invalid host: only loopback addresses are permitted" });
  }

  try {
    const timeout = withTimeout(readinessHttpTimeoutMs);
    const response = await fetch(`http://${host}:${port}/v1/models`, {
      method: "GET",
      headers: { "content-type": "application/json" },
      signal: timeout.signal
    });
    timeout.done();

    if (!response.ok) {
      const text = await response.text();
      return res.status(502).json({
        error: "lmstudio models unavailable",
        detail: text || `status ${response.status}`
      });
    }

    const data = await response.json();
    return res.json(data);
  } catch (error) {
    return res.status(502).json({ error: "lmstudio models unavailable", detail: String(error.message || error) });
  }
});

app.get("/v1/instances", (_req, res) => {
  const data = [...instances.entries()].map(([instanceId, value]) => ({
    instanceId,
    pid: value.process?.pid || null,
    state: value.state,
    inflightRequests: value.inflightRequests,
    queueDepth: value.queueDepth,
    drain: value.drain,
    apiKeyApplied: Boolean(value.apiKeyApplied)
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
    apiKeyApplied: false,
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
    let stopError = null;
    let unload = null;
    try {
      await stopServer(profile, process.env, instanceId);
    } catch (cleanupError) {
      stopError = String(cleanupError.message || cleanupError);
    }
    try {
      unload = await unloadInstanceModel(instanceId, profile?.model, "startup_failure");
    } catch (unloadError) {
      unload = {
        unloaded: false,
        reason: "startup_failure_unload_exception",
        detail: String(unloadError.message || unloadError)
      };
    }
    writeMeta(instanceId, "instance.start.failed", {
      error: record.lastError,
      stop_error: stopError,
      unload
    });
    if (!isInputError) {
      void maybeAutoRestart(instanceId, record, "startup_failure");
    }
    return res.status(isInputError ? 400 : 500).json({ error: errorText });
  }

  res.status(201).json({
    success: true,
    instanceId,
    pid: null,
    state: record.state,
    apiKeyApplied: Boolean(record.apiKeyApplied)
  });
});

app.post("/v1/instances/:id/stop", async (req, res) => {
  if (!isValidInstanceId(req.params.id)) return res.status(400).json({ error: "invalid instance id" });
  const record = instances.get(req.params.id);
  if (!record) return res.status(404).json({ error: "instance not found" });

  try {
    let stopError = null;
    writeMeta(req.params.id, "instance.stop.request", {
      has_process: Boolean(record.process && !record.process.killed),
      port: Number(record.profile?.port)
    });
    record.state = "draining";
    if (record.process && !record.process.killed) {
      record.process.kill("SIGTERM");
    } else {
      try {
        await stopServer(record.profile, process.env, req.params.id);
      } catch (error) {
        stopError = String(error.message || error);
      }
    }
    record.state = "stopped";
    const unload = await unloadInstanceModel(req.params.id, record.profile?.model, "instance_stop");
    record.restartInFlight = false;
    record.restartAttempts = 0;
    writeMeta(req.params.id, "instance.stop.completed", { state: record.state, stop_error: stopError, unload });
    if ((!unload.unloaded || stopError) && !hasOtherActiveInstances(req.params.id)) {
      return res.status(502).json({
        error: stopError ? "instance stop encountered errors" : "instance stopped but model unload failed",
        stopError,
        unload
      });
    }
    res.json({ success: true, stopError, unload });
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
    let stopError = null;
    writeMeta(req.params.id, "instance.kill.request", {
      has_process: Boolean(record.process && !record.process.killed),
      port: Number(record.profile?.port)
    });
    if (record.process && !record.process.killed) {
      record.process.kill("SIGKILL");
    } else {
      try {
        await stopServer(record.profile, process.env, req.params.id);
      } catch (error) {
        stopError = String(error.message || error);
      }
    }
    const unload = await unloadInstanceModel(req.params.id, record.profile?.model, "instance_kill");
    record.state = "stopped";
    record.restartInFlight = false;
    record.restartAttempts = 0;
    writeMeta(req.params.id, "instance.kill.completed", { state: record.state, stop_error: stopError, unload });
    if ((!unload.unloaded || stopError) && !hasOtherActiveInstances(req.params.id)) {
      return res.status(502).json({
        error: stopError ? "instance kill encountered errors" : "instance killed but model unload failed",
        stopError,
        unload
      });
    }
    res.json({ success: true, stopError, unload });
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
  void (async () => {
    if (cleanupOldInstancesOnStart) {
      await stopAllServers("startup", {
        unloadModelsAfterStop: cleanupUnloadModelsOnStart,
        stopDaemonAfterStop: false
      });
    }

    await bootstrapServer().catch((error) => {
      console.warn(`LM Studio bootstrap warning: ${String(error.message || error)}`);
    });
  })();
});

let shutdownInProgress = false;

async function gracefulShutdown(signal) {
  if (shutdownInProgress) return;
  shutdownInProgress = true;
  console.log(`Bridge shutdown signal received: ${signal}`);

  server.close(() => {
    // No-op callback; shutdown flow continues below.
  });

  if (cleanupOldInstancesOnExit) {
    await stopAllServers(`shutdown:${signal}`, {
      unloadModelsAfterStop: cleanupUnloadModelsOnExit,
      stopDaemonAfterStop: cleanupStopDaemonOnExit
    });
  }

  process.exit(0);
}

process.on("SIGINT", () => {
  void gracefulShutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void gracefulShutdown("SIGTERM");
});
