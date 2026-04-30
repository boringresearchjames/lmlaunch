import express from "express";
import { execFile, spawn } from "child_process";
import crypto from "crypto";
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
// Fraction of free VRAM to reserve as a safety buffer when auto-sizing ctx.
// e.g. 0.20 = keep 20% of free VRAM free, use the other 80% for KV cache.
const autoCtxVramBufferFraction = Math.min(0.9, Math.max(0, Number(process.env.AUTO_CTX_VRAM_BUFFER || 0.05)));
// Bytes of KV cache consumed per context token per layer (fp16 K+V = 2*2 bytes per head).
// This is a conservative heuristic; actual usage depends on model architecture & kv quant.
const autoCtxBytesPerTokenPerLayer = Number(process.env.AUTO_CTX_BYTES_PER_TOKEN_PER_LAYER || 512);
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

function timingSafeStringEq(a, b) {
  const ab = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  if (ab.length !== bb.length) {
    // Compare against self to keep timing constant on length mismatch.
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

function auth(req, res, next) {
  if (!bridgeAuthEnabled) {
    return next();
  }
  const token = req.header("x-bridge-token") || "";
  if (!timingSafeStringEq(token, bridgeToken)) {
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

  // Default --flash-attn on for any GPU-backed instance. Saves 10–30% on prompt
  // processing and is a prerequisite for V-cache quantisation. Skipped for CPU.
  // Users can override by passing `--flash-attn off` (or `--flash-attn auto`)
  // explicitly in serverArgs.
  if (backend !== "cpu") {
    const hasFlashAttn = args.some((arg, idx) =>
      arg === "--flash-attn" || arg === "-fa" || arg.startsWith("--flash-attn=") ||
      (idx > 0 && (args[idx - 1] === "--flash-attn" || args[idx - 1] === "-fa"))
    );
    if (!hasFlashAttn) {
      args.push("--flash-attn", "on");
    }
  }

  // Default --parallel to maxInflightRequests so llama-server's continuous
  // batching can actually serve concurrent requests instead of serialising
  // them on a single slot. modelParallel (multi-process) and --parallel
  // (multi-slot inside one process) compose: total concurrency is N_proc * N_slot.
  const hasParallel = args.some((arg, idx) =>
    arg === "--parallel" || arg === "-np" || arg.startsWith("--parallel=") ||
    (idx > 0 && (args[idx - 1] === "--parallel" || args[idx - 1] === "-np"))
  );
  if (!hasParallel) {
    const inflight = Number(profile?.maxInflightRequests);
    if (Number.isInteger(inflight) && inflight > 1) {
      args.push("--parallel", String(Math.min(inflight, 64)));
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

  // Auto-size --ctx-size when the user left contextLength unset.
  // Query free VRAM across the assigned GPUs and compute a safe ceiling
  // with autoCtxVramBufferFraction reserved as headroom.
  const needsAutoCtx = !(Number.isInteger(Number(profile.contextLength)) && Number(profile.contextLength) > 0);
  if (needsAutoCtx) {
    const gpuIds = Array.isArray(profile.gpus) ? profile.gpus.map(String) : [];
    if (gpuIds.length > 0) {
      try {
        const freeMibMap = await getGpuFreeMemoryMap();

        // Read GGUF metadata once: gives us layer count, GQA dims, max ctx, name, arch.
        let ggufMeta = null;
        const modelPath = String(profile.model || "").trim();
        if (modelPath) {
          try { ggufMeta = readGgufMetadata(modelPath); } catch (_) { /* proceed without */ }
        }

        // Layer count: profile override > GGUF block_count > safe fallback of 32.
        const numLayers = (Number.isInteger(Number(profile.numLayers)) && Number(profile.numLayers) > 0)
          ? Number(profile.numLayers)
          : (ggufMeta?.blockCount || 32);

        // Exact KV bytes-per-token-per-layer from GGUF GQA fields.
        // Formula: 2 (K+V) × kv_heads × head_dim × bytesPerElement
        // Default bytesPerElement = 2 (fp16). If user passes -ctk/-ctv quant flags,
        // each element shrinks: q8_0 → 1 byte, q4_0/q4_1 → 0.5 bytes, q5_0/q5_1 → 0.625 bytes.
        // We use the larger of ctk/ctv to stay conservative.
        const kvQuantBytesPerElement = (() => {
          const serverArgs = Array.isArray(profile?.runtime?.serverArgs) ? profile.runtime.serverArgs : [];
          function quantBytes(flag) {
            // Find the value after -ctk or -ctv in the args array
            const idx = serverArgs.findIndex((a) => a === flag);
            const val = idx >= 0 ? String(serverArgs[idx + 1] || "").toLowerCase() : "";
            if (val === "f32") return 4;
            if (val === "f16") return 2;
            if (val === "bf16") return 2;
            if (val === "q8_0") return 1;
            if (val === "q5_0" || val === "q5_1") return 0.625;
            if (val === "q4_0" || val === "q4_1") return 0.5;
            return 2; // unknown or not set → assume fp16
          }
          return Math.max(quantBytes("-ctk"), quantBytes("-ctv"));
        })();

        let bytesPerTokenPerLayer = null;
        if (ggufMeta?.headCountKv && ggufMeta?.embeddingLength && ggufMeta?.headCount) {
          const headDim = Math.floor(ggufMeta.embeddingLength / ggufMeta.headCount);
          bytesPerTokenPerLayer = 2 * ggufMeta.headCountKv * headDim * kvQuantBytesPerElement;
        }

        // Estimate model weight VRAM from GGUF file size on disk.
        // Free VRAM is sampled BEFORE the model loads, so weights must be subtracted.
        let modelSizeMib = 0;
        if (modelPath) {
          try {
            const stat = fs.statSync(modelPath);
            modelSizeMib = stat.size / (1024 * 1024);
          } catch (_) {
            // model file not accessible — modelSizeMib stays 0; buffer is the only guard
          }
        }

        // Store GGUF name/arch on profile so /v1/instances can surface them.
        if (ggufMeta?.name) profile._ggufName = ggufMeta.name;
        if (ggufMeta?.architecture) profile._ggufArchitecture = ggufMeta.architecture;

        let autoCtx = computeAutoCtxSize(freeMibMap, gpuIds, numLayers, modelSizeMib, bytesPerTokenPerLayer);
        // Cap against the model's trained context length stored in the GGUF header.
        // Exceeding this produces garbage output (RoPE embeddings out of distribution).
        if (autoCtx && ggufMeta?.contextLength && autoCtx > ggufMeta.contextLength) {
          autoCtx = ggufMeta.contextLength;
        }
        if (autoCtx) {
          profile.contextLength = autoCtx;
          writeMeta(instanceId, "instance.auto_ctx", {
            free_mib: Object.fromEntries(freeMibMap),
            model_size_mib: Math.round(modelSizeMib),
            model_max_ctx: ggufMeta?.contextLength ?? null,
            num_layers: numLayers,
            kv_heads: ggufMeta?.headCountKv ?? null,
            bytes_per_token_per_layer: bytesPerTokenPerLayer,
            kv_quant_bytes_per_element: kvQuantBytesPerElement,
            gpu_ids: gpuIds,
            buffer_fraction: autoCtxVramBufferFraction,
            computed_ctx: autoCtx
          });
        }
      } catch (err) {
        console.warn(`[auto-ctx] failed to compute auto ctx-size for ${instanceId}: ${err.message}`);
      }
    }
  }

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

// Returns a Map<gpuIndex:string, freeMiB:number> for all GPUs.
// nvidia-smi on NVIDIA; rocm-smi JSON fallback for AMD. Returns null on failure.
async function getGpuFreeMemoryMap() {
  const nvResult = await runCommand("nvidia-smi", [
    "--query-gpu=index,memory.free",
    "--format=csv,noheader,nounits"
  ]);

  if (nvResult.ok) {
    const map = new Map();
    for (const line of String(nvResult.stdout || "").split("\n").map((l) => l.trim()).filter(Boolean)) {
      const [indexRaw, memRaw] = line.split(",").map((x) => String(x || "").trim());
      const mem = Number(memRaw);
      if (indexRaw !== "" && Number.isFinite(mem) && mem >= 0) map.set(String(indexRaw), mem);
    }
    if (map.size > 0) return map;
  }

  // AMD fallback: rocm-smi reports total and used; derive free = total - used.
  const rocmResult = await runCommand("rocm-smi", ["--showmeminfo", "vram", "--json"]);
  if (!rocmResult.ok) return null;

  try {
    const parsed = JSON.parse(rocmResult.stdout);
    const map = new Map();
    for (const [cardKey, cardData] of Object.entries(parsed)) {
      const idx = String(cardKey).replace(/^card/i, "");
      const totalBytes = Number(cardData["VRAM Total Memory (B)"] ?? cardData["vram total memory"] ?? NaN);
      const usedBytes = Number(cardData["VRAM Total Used Memory (B)"] ?? cardData["vram total used memory"] ?? NaN);
      if (Number.isFinite(totalBytes) && Number.isFinite(usedBytes)) {
        map.set(idx, Math.max(0, (totalBytes - usedBytes) / 1024 / 1024));
      }
    }
    return map.size > 0 ? map : null;
  } catch {
    return null;
  }
}

// Reads key metadata from a GGUF file's binary header.
// Returns: { contextLength, blockCount, headCountKv, embeddingLength, headCount, name, architecture }
// All fields are null if not present or if the file is not a valid GGUF.
function readGgufMetadata(filePath) {
  const GGUF_MAGIC_LE = 0x46554747; // 'GGUF'
  // Read up to 2 MB — enough to cover all metadata KV pairs for any known model.
  const fd = fs.openSync(filePath, "r");
  const buf = Buffer.alloc(2 * 1024 * 1024);
  const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
  fs.closeSync(fd);
  const data = buf.subarray(0, bytesRead);

  let off = 0;
  function u8()  { const v = data.readUInt8(off);      off += 1; return v; }
  function u16() { const v = data.readUInt16LE(off);   off += 2; return v; }
  function u32() { const v = data.readUInt32LE(off);   off += 4; return v; }
  function i32() { const v = data.readInt32LE(off);    off += 4; return v; }
  function f32() { const v = data.readFloatLE(off);    off += 4; return v; }
  function u64() { const v = Number(data.readBigUInt64LE(off)); off += 8; return v; }
  function i64() { const v = Number(data.readBigInt64LE(off));  off += 8; return v; }
  function f64() { const v = data.readDoubleLE(off);   off += 8; return v; }
  function str() { const len = u64(); const s = data.toString("utf8", off, off + len); off += len; return s; }
  function val(type) {
    switch (type) {
      case 0:  return u8();             // UINT8
      case 1:  return u8();             // INT8
      case 2:  return u16();            // UINT16
      case 3:  return u16();            // INT16
      case 4:  return u32();            // UINT32
      case 5:  return i32();            // INT32
      case 6:  return f32();            // FLOAT32
      case 7:  return u8() !== 0;       // BOOL
      case 8:  return str();            // STRING
      case 9:  { const t = u32(); const cnt = u64(); for (let i = 0; i < cnt; i++) val(t); return null; } // ARRAY — skip
      case 10: return u64();            // UINT64
      case 11: return i64();            // INT64
      case 12: return f64();            // FLOAT64
      default: throw new Error(`Unknown GGUF type ${type}`);
    }
  }

  if (u32() !== GGUF_MAGIC_LE) return null;
  const version = u32();
  if (version < 1 || version > 3) return null;
  u64(); // n_tensors
  const nKv = u64();

  const result = {
    contextLength: null,  // *.context_length  — model's max trained context window
    blockCount: null,     // *.block_count      — number of transformer layers
    headCountKv: null,    // *.attention.head_count_kv — GQA KV heads
    embeddingLength: null,// *.embedding_length — hidden dimension
    headCount: null,      // *.attention.head_count    — query heads
    name: null,           // general.name       — human-readable model name
    architecture: null,   // general.architecture — e.g. "llama", "qwen2", "mistral"
  };

  // Model-specific metadata (architecture params) always appears before tokenizer
  // data in well-formed GGUF files. Tokenizer vocabulary arrays can be 10-50 MB
  // (150K+ string entries for large models) — far beyond our 2 MB read buffer.
  // Strategy: return as soon as all 7 fields are found. If the buffer runs out
  // mid-array (RangeError), catch it and return whatever we collected so far —
  // the important fields will already be populated.
  const WANT = 7;
  let found = 0;
  for (let i = 0; i < nKv; i++) {
    try {
      const key = str();
      const type = u32();
      const value = val(type);
      if (key === "general.name" && typeof value === "string" && !result.name)                                    { result.name = value; found++; }
      else if (key === "general.architecture" && typeof value === "string" && !result.architecture)               { result.architecture = value; found++; }
      else if (key.endsWith(".context_length") && typeof value === "number" && value > 0 && !result.contextLength) { result.contextLength = value; found++; }
      else if (key.endsWith(".block_count") && typeof value === "number" && value > 0 && !result.blockCount)     { result.blockCount = value; found++; }
      else if (key.endsWith(".attention.head_count_kv") && typeof value === "number" && value > 0 && !result.headCountKv) { result.headCountKv = value; found++; }
      else if (key.endsWith(".embedding_length") && typeof value === "number" && value > 0 && !result.embeddingLength) { result.embeddingLength = value; found++; }
      else if (key.endsWith(".attention.head_count") && typeof value === "number" && value > 0 && !result.headCount) { result.headCount = value; found++; }
      if (found === WANT) break; // all fields collected, no need to scan tokenizer data
    } catch (_) {
      // Buffer exhausted mid-entry (e.g. inside a large tokenizer array).
      // Return what we have — model params always precede tokenizer in GGUF.
      break;
    }
  }
  return result;
}

// Computes a safe --ctx-size from free VRAM across the assigned GPU set.
// freeMibMap: Map<gpuIndex, freeMiB>; gpuIds: string[]; numLayers: number.
// bytesPerTokenPerLayer: exact KV cost from GGUF metadata (falls back to autoCtxBytesPerTokenPerLayer).
// Returns null if inputs are insufficient (caller skips auto-sizing).
function computeAutoCtxSize(freeMibMap, gpuIds, numLayers, modelSizeMib = 0, bytesPerTokenPerLayer = null) {
  if (!(freeMibMap instanceof Map) || freeMibMap.size === 0) return null;
  if (!Array.isArray(gpuIds) || gpuIds.length === 0) return null;
  if (!Number.isInteger(numLayers) || numLayers <= 0) return null;

  // Sum free VRAM across the assigned GPUs.
  let totalFreeMiB = 0;
  for (const id of gpuIds) {
    const mib = freeMibMap.get(String(id));
    if (!Number.isFinite(mib)) return null; // unknown GPU — skip auto-sizing
    totalFreeMiB += mib;
  }

  // Subtract model weight VRAM (free VRAM is sampled before the model loads, so the
  // model file size must be deducted to avoid model + KV cache exceeding total VRAM).
  const kvBudgetMib = Math.max(0, totalFreeMiB - (Number.isFinite(modelSizeMib) ? modelSizeMib : 0));

  // Use caller-supplied exact KV cost if available, else fall back to env-var heuristic.
  const bpt = (Number.isFinite(bytesPerTokenPerLayer) && bytesPerTokenPerLayer > 0)
    ? bytesPerTokenPerLayer
    : autoCtxBytesPerTokenPerLayer;

  // Reserve buffer fraction, convert remaining to bytes.
  const usableBytes = kvBudgetMib * (1 - autoCtxVramBufferFraction) * 1024 * 1024;
  const ctxSize = Math.floor(usableBytes / (numLayers * bpt));

  // Clamp: minimum 512 tokens, round down to nearest 256 for clean numbers.
  if (ctxSize < 512) return null;
  return Math.floor(ctxSize / 256) * 256;
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
    drain: value.drain,
    resolvedContextLength: Number.isInteger(Number(value.profile?.contextLength)) && Number(value.profile?.contextLength) > 0
      ? Number(value.profile.contextLength)
      : null,
    ggufName: value.profile?._ggufName ?? null,
    ggufArchitecture: value.profile?._ggufArchitecture ?? null
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

app.get("/v1/info", auth, async (_req, res) => {
  const info = {
    platform: os.platform(),
    arch: os.arch(),
    llamaServerBin: llamaServerBinary,
    llamaServerVersion: null,
  };
  try {
    await new Promise((resolve) => {
      execFile(llamaServerBinary, ["--version"], { timeout: 4000 }, (_err, stdout, stderr) => {
        const raw = (stdout || stderr || "").trim();
        const match = raw.match(/version:\s*(\S+)/) || raw.match(/build\s+(\d+)/);
        if (match) info.llamaServerVersion = match[1].slice(0, 80);
        resolve();
      });
    });
  } catch { /* leave null */ }
  res.json(info);
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
