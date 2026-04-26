import express from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import os from "os";
import { Readable } from "stream";
import yaml from "js-yaml";
import { fileURLToPath } from "url";

const app = express();
app.use(express.json({ limit: "50mb" }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const webRoot = path.resolve(__dirname, "..", "..", "web");

const corsOrigin = process.env.CORS_ORIGIN || "*";
const corsHeaders = "Authorization, Content-Type, X-Bridge-Token";

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", corsOrigin);
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", corsHeaders);
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  return next();
});

const port = Number(process.env.PORT || 8081);
const apiToken = process.env.API_AUTH_TOKEN || "change-me";
const bridgeUrl = process.env.BRIDGE_URL || "http://localhost:8090";
const bridgeToken = process.env.BRIDGE_AUTH_TOKEN || "change-me";
const stateFile = process.env.STATE_FILE || path.resolve(process.cwd(), "data", "state.json");
const sharedConfigFile = process.env.SHARED_CONFIG_FILE || path.resolve(process.cwd(), "data", "shared-config.yaml");
const apiAuthEnabled = Boolean(apiToken && apiToken !== "change-me");
const bridgeAuthEnabled = Boolean(bridgeToken && bridgeToken !== "change-me");
const publicHostOverride = String(process.env.LLAMAFLEET_PUBLIC_HOST || "").trim();
const modelsDir = String(process.env.MODELS_DIR || "").trim() || path.join(os.homedir(), ".lmstudio", "models");

if (!apiAuthEnabled) {
  console.warn("API auth disabled: API_AUTH_TOKEN not set.");
}

if (!bridgeAuthEnabled) {
  console.warn("Bridge auth disabled: BRIDGE_AUTH_TOKEN not set.");
}

const stateDir = path.dirname(stateFile);
fs.mkdirSync(stateDir, { recursive: true });

const defaultState = {
  profiles: [],
  instanceConfigs: [],
  instances: [],
  audit: [],
  settings: {
    security: {
      api: {
        requireApiKey: true
      },
      tls: {
        enabled: false,
        certFile: "",
        keyFile: "",
        caFile: ""
      },
      auth: {
        enabled: false,
        sessionTtlMinutes: 720
      }
    },
    configSync: {
      lastImportedAt: null,
      lastImportedHash: "",
      lastDryRunAt: null,
      lastDryRunHash: ""
    }
  },
  users: [],
  sessions: []
};

function migrateState(raw) {
  const next = raw || {};
  next.profiles = Array.isArray(next.profiles) ? next.profiles : [];
  next.instanceConfigs = Array.isArray(next.instanceConfigs) ? next.instanceConfigs : [];
  next.instances = Array.isArray(next.instances) ? next.instances : [];
  next.audit = Array.isArray(next.audit) ? next.audit : [];
  next.settings = next.settings || {};
  next.settings.security = next.settings.security || {};
  next.settings.security.api = {
    requireApiKey: apiAuthEnabled
      ? next.settings.security.api?.requireApiKey !== false
      : false
  };
  next.settings.security.tls = {
    enabled: Boolean(next.settings.security.tls?.enabled),
    certFile: next.settings.security.tls?.certFile || "",
    keyFile: next.settings.security.tls?.keyFile || "",
    caFile: next.settings.security.tls?.caFile || ""
  };
  next.settings.security.auth = {
    enabled: Boolean(next.settings.security.auth?.enabled),
    sessionTtlMinutes: Number(next.settings.security.auth?.sessionTtlMinutes || 720)
  };
  next.settings.configSync = {
    lastImportedAt: next.settings.configSync?.lastImportedAt || null,
    lastImportedHash: next.settings.configSync?.lastImportedHash || "",
    lastDryRunAt: next.settings.configSync?.lastDryRunAt || null,
    lastDryRunHash: next.settings.configSync?.lastDryRunHash || ""
  };
  next.users = Array.isArray(next.users) ? next.users : [];
  next.sessions = Array.isArray(next.sessions) ? next.sessions : [];
  return next;
}

function loadState() {
  try {
    if (!fs.existsSync(stateFile)) {
      fs.writeFileSync(stateFile, JSON.stringify(defaultState, null, 2));
      return structuredClone(defaultState);
    }
    return migrateState(JSON.parse(fs.readFileSync(stateFile, "utf8")));
  } catch {
    return structuredClone(defaultState);
  }
}

function saveState(state) {
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  writeSharedConfig(state);
}

function toSharedConfig(state) {
  return {
    version: "1",
    generatedAt: now(),
    note: "Shareable config. Secrets, password hashes, and session tokens are excluded.",
    settings: {
      security: state.settings?.security || defaultState.settings.security
    },
    profiles: state.profiles || [],
    users: (state.users || []).map((u) => ({
      username: u.username,
      disabled: Boolean(u.disabled)
    }))
  };
}

function cleanRuntime(runtime) {
  const rawArgs = Array.isArray(runtime?.serverArgs) && runtime.serverArgs.length > 0
    ? runtime.serverArgs
    : null;
  // Migrate old LMS-style args ("server", "start", ...) to llama.cpp defaults
  const isLmsArgs = Array.isArray(rawArgs) && rawArgs[0] === "server" && rawArgs[1] === "start";
  return {
    serverArgs: (!rawArgs || isLmsArgs)
      ? ["--port", "{port}"]
      : rawArgs.map((x) => String(x)),
    hardware: normalizeRuntimeBackend(runtime?.hardware || "auto")
  };
}

function currentInstanceTemplates() {
  return (state.instances || []).map((inst) => ({
    name: String(inst.profileName || inst.id || "instance").trim() || "instance",
    host: String(inst.host || "127.0.0.1"),
    bindHost: String(inst.bindHost || "0.0.0.0"),
    port: Number(inst.port || 1234),
    model: String(inst.effectiveModel || inst.pendingModel || "").trim(),
    gpus: Array.isArray(inst.gpus) ? inst.gpus.map((g) => String(g)) : [],
    runtime: cleanRuntime(inst.runtime),
    contextLength: parseContextLength(inst.contextLength),
    maxInflightRequests: Number(inst.maxInflightRequests || 4),
    queueLimit: parsePositiveInteger(inst.queueLimit, 64, 1, 100000),
    modelTtlSeconds: parseOptionalPositiveInteger(inst.modelTtlSeconds),
    modelParallel: parseOptionalPositiveInteger(inst.modelParallel),
    restartPolicy: parseRestartPolicy(inst.restartPolicy)
  }));
}

function sanitizeInstanceConfigPayload(raw = {}) {
  const id = String(raw.id || `cfg_${Date.now()}`).trim();
  const name = String(raw.name || "Untitled Config").trim() || "Untitled Config";
  const instances = Array.isArray(raw.instances) ? raw.instances : [];

  const cleaned = instances
    .map((inst, index) => {
      const model = String(inst?.model || "").trim();
      const port = Number(inst?.port);
      if (!model || !Number.isInteger(port) || port < 1 || port > 65535) {
        return null;
      }

      return {
        name: String(inst?.name || `instance-${index + 1}`).trim() || `instance-${index + 1}`,
        host: String(inst?.host || "127.0.0.1"),
        bindHost: parseBindHost(inst?.bindHost),
        port,
        model,
        gpus: Array.isArray(inst?.gpus) ? inst.gpus.map((g) => String(g)) : [],
        runtime: cleanRuntime(inst?.runtime),
        contextLength: parseContextLength(inst?.contextLength),
        maxInflightRequests: parsePositiveInteger(inst?.maxInflightRequests, 4, 1, 1024),
        queueLimit: parsePositiveInteger(inst?.queueLimit, 64, 1, 100000),
        modelTtlSeconds: parseOptionalPositiveInteger(inst?.modelTtlSeconds),
        modelParallel: parseOptionalPositiveInteger(inst?.modelParallel),
        restartPolicy: parseRestartPolicy(inst?.restartPolicy)
      };
    })
    .filter(Boolean);

  return {
    id,
    name,
    instances: cleaned
  };
}

function toInstanceConfigYamlDoc(config) {
  return {
    version: "1",
    kind: "lmlaunch-instance-config",
    generatedAt: now(),
    id: config.id,
    name: config.name,
    instances: config.instances
  };
}

function writeSharedConfig(state) {
  try {
    const doc = yaml.dump(toSharedConfig(state), { noRefs: true, lineWidth: 120 });
    fs.writeFileSync(sharedConfigFile, doc);
  } catch {
    // Keep state write resilient even if yaml export fails.
  }
}

function configHash(rawYaml) {
  return crypto.createHash("sha256").update(String(rawYaml || "")).digest("hex");
}

function validateSharedConfig(doc) {
  const errors = [];
  const warnings = [];

  if (!doc || typeof doc !== "object") {
    return { errors: ["config must be a YAML object"], warnings, normalized: null };
  }

  const normalized = {
    settings: {
      security: {
        api: {
          requireApiKey: apiAuthEnabled
        },
        tls: {
          enabled: false,
          certFile: "",
          keyFile: "",
          caFile: ""
        },
        auth: {
          enabled: false,
          sessionTtlMinutes: 720
        }
      }
    },
    profiles: [],
    users: []
  };

  if (doc.version && String(doc.version) !== "1") {
    warnings.push("config version is not '1'; proceeding with best-effort import");
  }

  const security = doc.settings?.security;
  if (security) {
    const requireApiKey = Boolean(security.api?.requireApiKey);
    if (requireApiKey && !apiAuthEnabled) {
      warnings.push("settings.security.api.requireApiKey ignored because API_AUTH_TOKEN is not configured");
      normalized.settings.security.api.requireApiKey = false;
    } else {
      normalized.settings.security.api.requireApiKey = requireApiKey;
    }

    normalized.settings.security.tls.enabled = Boolean(security.tls?.enabled);
    normalized.settings.security.tls.certFile = String(security.tls?.certFile || "");
    normalized.settings.security.tls.keyFile = String(security.tls?.keyFile || "");
    normalized.settings.security.tls.caFile = String(security.tls?.caFile || "");

    const ttl = Number(security.auth?.sessionTtlMinutes || 720);
    if (!Number.isFinite(ttl) || ttl < 5 || ttl > 10080) {
      errors.push("settings.security.auth.sessionTtlMinutes must be between 5 and 10080");
    } else {
      normalized.settings.security.auth.sessionTtlMinutes = ttl;
    }
    normalized.settings.security.auth.enabled = Boolean(security.auth?.enabled);
  }

  const profiles = Array.isArray(doc.profiles) ? doc.profiles : [];
  for (const raw of profiles) {
    const name = String(raw?.name || "").trim();
    if (!name) {
      errors.push("each profile must include non-empty name");
      continue;
    }

    const port = Number(raw?.port || 1234);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      errors.push(`profile '${name}' has invalid port`);
      continue;
    }

    const profile = {
      id: String(raw?.id || `prof_${Date.now()}_${Math.floor(Math.random() * 1000)}`),
      name,
      runtime: {
        serverArgs: ["--port", "{port}"]
      },
      gpus: Array.isArray(raw?.gpus) ? raw.gpus.map((x) => String(x)) : [],
      host: String(raw?.host || "127.0.0.1"),
      port,
      contextLength: Number(raw?.contextLength || 8192),
      startupTimeoutMs: Number(raw?.startupTimeoutMs || 180000),
      queueLimit: Number(raw?.queueLimit || 64)
    };
    normalized.profiles.push(profile);
  }

  const users = Array.isArray(doc.users) ? doc.users : [];
  for (const raw of users) {
    const username = String(raw?.username || "").trim();
    if (!username) {
      warnings.push("skipping user entry without username");
      continue;
    }
    normalized.users.push({
      username,
      disabled: Boolean(raw?.disabled)
    });
  }

  return { errors, warnings, normalized };
}

let state = loadState();

function now() {
  return new Date().toISOString();
}

function parseRuntimeArgs(value) {
  if (Array.isArray(value)) {
    return value.map((x) => String(x).trim()).filter(Boolean);
  }

  const text = String(value || "").trim();
  if (!text) {
    return [];
  }

  const matches = text.match(/"([^"\\]*(\\.[^"\\]*)*)"|'([^'\\]*(\\.[^'\\]*)*)'|\S+/g) || [];
  return matches
    .map((token) => token.replace(/^['"]|['"]$/g, "").trim())
    .filter(Boolean);
}

function parseContextLength(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim().toLowerCase() === "auto") return null;
  const num = Number(value);
  if (!Number.isInteger(num) || num < 256) return null;
  return num;
}

function parseOptionalPositiveInteger(value) {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  if (!Number.isInteger(num) || num < 1) return null;
  return num;
}

function parsePositiveInteger(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const num = Number(value);
  if (!Number.isInteger(num) || num < min || num > max) {
    return fallback;
  }
  return num;
}

function parseBindHost(value) {
  const raw = String(value || "").trim();
  if (!raw) return "0.0.0.0";
  return raw;
}

function isGlobalApiKeyRequired() {
  return apiAuthEnabled && state.settings?.security?.api?.requireApiKey !== false;
}

function parseRestartPolicy(value = {}) {
  const modeRaw = String(value?.mode || value?.restartMode || "never").trim().toLowerCase();
  const mode = modeRaw === "on-failure" ? "on-failure" : "never";
  const maxRetries = mode === "on-failure"
    ? parsePositiveInteger(value?.maxRetries ?? value?.restartMaxRetries, 2, 1, 20)
    : 0;
  const backoffMs = mode === "on-failure"
    ? parsePositiveInteger(value?.backoffMs ?? value?.restartBackoffMs, 3000, 250, 120000)
    : 0;
  return { mode, maxRetries, backoffMs };
}

function normalizeRuntimeBackend(value) {
  const raw = String(value || "auto").trim().toLowerCase();
  if (raw === "valkun") return "vulkan";
  if (["auto", "cuda", "cuda_full", "cuda12", "cpu", "vulkan"].includes(raw)) return raw;
  return "auto";
}

function toInstanceId(value) {
  const text = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  return text || `inst_${Date.now()}`;
}

function nextUniqueInstanceId(baseId, existingIds = new Set()) {
  if (!existingIds.has(baseId)) {
    return baseId;
  }
  let suffix = 2;
  while (existingIds.has(`${baseId}-${suffix}`)) {
    suffix += 1;
  }
  return `${baseId}-${suffix}`;
}



function getBearerToken(req) {
  const header = req.header("authorization") || "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const digest = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${digest}`;
}

function verifyPassword(password, encoded) {
  const [salt, expected] = String(encoded || "").split(":");
  if (!salt || !expected) return false;
  const actual = crypto.scryptSync(password, salt, 64).toString("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

function createSession(username) {
  const token = crypto.randomBytes(32).toString("hex");
  const ttlMinutes = Number(state.settings.security.auth.sessionTtlMinutes || 720);
  const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString();
  const session = {
    token,
    username,
    createdAt: now(),
    expiresAt,
    lastUsedAt: now()
  };
  state.sessions.push(session);
  state.sessions = state.sessions.slice(-1000);
  saveState(state);
  return session;
}

function cleanupSessions() {
  const nowTs = Date.now();
  state.sessions = state.sessions.filter((s) => new Date(s.expiresAt).getTime() > nowTs);
}

function auth(req, res, next) {
  if (!isGlobalApiKeyRequired()) {
    return next();
  }

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (token !== apiToken) {
    if (!state.settings.security.auth.enabled) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    cleanupSessions();
    const session = state.sessions.find((s) => s.token === token);
    if (!session) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    session.lastUsedAt = now();
    saveState(state);
  }

  return next();
}

function requireAdminToken(req, res, next) {
  if (!isGlobalApiKeyRequired()) {
    return next();
  }

  const token = getBearerToken(req);
  if (token !== apiToken) {
    return res.status(403).json({ error: "Admin token required" });
  }
  return next();
}

async function bridgeFetch(method, endpoint, body) {
  const headers = {
    "content-type": "application/json"
  };

  if (bridgeAuthEnabled) {
    headers["x-bridge-token"] = bridgeToken;
  }

  const response = await fetch(`${bridgeUrl}${endpoint}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Bridge error ${response.status}: ${text}`);
  }

  return response.json();
}

function audit(action, details = {}) {
  state.audit.unshift({
    at: now(),
    action,
    details
  });
  state.audit = state.audit.slice(0, 2000);
  saveState(state);
}

function instanceBaseUrl(instance) {
  return `http://${instance.host || "127.0.0.1"}:${instance.port}`;
}

function detectMachineIpv4() {
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const item of entries || []) {
      if (!item) continue;
      const family = typeof item.family === "string" ? item.family : String(item.family);
      if (family !== "IPv4") continue;
      if (item.internal) continue;
      const addr = String(item.address || "").trim();
      if (!addr) continue;
      if (addr.startsWith("169.254.")) continue;
      return addr;
    }
  }
  return null;
}

function resolveAdvertisedHost(instance) {
  const bindHost = String(instance?.bindHost || "0.0.0.0").trim().toLowerCase();
  const internalHost = String(instance?.host || "127.0.0.1").trim() || "127.0.0.1";
  const localhostOnly = bindHost === "127.0.0.1" || bindHost === "localhost" || bindHost === "::1";
  if (localhostOnly) {
    return internalHost;
  }

  if (publicHostOverride) {
    return publicHostOverride;
  }

  const detected = detectMachineIpv4();
  return detected || internalHost;
}

function instancePublicBaseUrl(instance) {
  return `http://${resolveAdvertisedHost(instance)}:${instance.port}`;
}

function apiPublicBaseUrl() {
  const host = publicHostOverride || detectMachineIpv4() || "127.0.0.1";
  return `http://${host}:${port}`;
}

function updateInstanceRequestMetrics(instance, delta = 0) {
  if (!instance || !Number.isFinite(delta) || delta === 0) return;
  const current = Number(instance.inflightRequests || 0);
  const nextInflight = Math.max(0, current + delta);
  instance.inflightRequests = nextInflight;

  const maxInflight = Math.max(1, Number(instance.maxInflightRequests || 1));
  instance.queueDepth = Math.max(0, nextInflight - maxInflight);
  if (delta > 0) {
    instance.lastActivityAt = now();
  }
  instance.updatedAt = now();
}

function usageMetric(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return 0;
  return Math.floor(num);
}

function updateInstanceUsageMetrics(instance, responsePayload) {
  if (!instance || !responsePayload || typeof responsePayload !== "object") return;

  const usage = responsePayload.usage;
  if (!usage || typeof usage !== "object") return;

  const promptTokens = usageMetric(usage.prompt_tokens ?? usage.input_tokens);
  const completionTokens = usageMetric(usage.completion_tokens ?? usage.output_tokens);
  const inferredTotal = usageMetric(usage.total_tokens);
  const totalTokens = inferredTotal > 0 ? inferredTotal : (promptTokens + completionTokens);

  instance.totalPromptTokens = usageMetric(instance.totalPromptTokens) + promptTokens;
  instance.totalCompletionTokens = usageMetric(instance.totalCompletionTokens) + completionTokens;
  instance.totalTokens = usageMetric(instance.totalTokens) + totalTokens;
  instance.lastActivityAt = now();
  instance.updatedAt = now();
}

function markProxyCompletion(instance) {
  if (!instance) return;
  instance.completedRequests = usageMetric(instance.completedRequests) + 1;
  instance.lastActivityAt = now();
  instance.updatedAt = now();
}

function copyProxyResponseHeaders(upstreamHeaders, res) {
  const hopByHop = new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "content-length"
  ]);

  upstreamHeaders.forEach((value, key) => {
    if (hopByHop.has(String(key).toLowerCase())) return;
    res.setHeader(key, value);
  });
}

function proxyRequestHeaders(req, instance) {
  const hopByHop = new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "host",
    "content-length"
  ]);

  const headers = {};
  Object.entries(req.headers || {}).forEach(([key, value]) => {
    const name = String(key || "").toLowerCase();
    if (!name || hopByHop.has(name)) return;
    if (name === "authorization") return;
    if (value === undefined || value === null || value === "") return;
    headers[name] = value;
  });

  headers.accept = req.headers.accept || "application/json";
  if (req.headers["content-type"]) {
    headers["content-type"] = req.headers["content-type"];
  }

  return headers;
}

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "api", at: now() });
});

app.get("/help", (_req, res) => {
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>LM Launch — API Reference</title>
  <style>
    body { font-family: "Segoe UI", system-ui, sans-serif; background: #06070b; color: #e7eeff; margin: 0; padding: 32px; line-height: 1.6; }
    h1 { font-size: 28px; margin: 0 0 4px; }
    h2 { font-size: 16px; margin: 28px 0 8px; color: #7df8dd; border-bottom: 1px solid rgba(125,248,221,0.2); padding-bottom: 4px; }
    h3 { font-size: 13px; margin: 16px 0 4px; color: #9fb0d8; }
    p, li { font-size: 13px; color: #c4d2f4; margin: 4px 0; }
    code { font-family: "JetBrains Mono", Consolas, monospace; font-size: 12px; background: rgba(92,165,255,0.12); padding: 1px 5px; border-radius: 4px; color: #9dd8ff; }
    pre { background: rgba(5,8,19,0.8); border: 1px solid rgba(159,176,216,0.2); border-radius: 8px; padding: 12px; font-family: "JetBrains Mono", Consolas, monospace; font-size: 12px; color: #c4d2f4; overflow-x: auto; }
    .muted { color: #9fb0d8; }
    .endpoint { margin-bottom: 18px; }
    .method { display: inline-block; padding: 2px 7px; border-radius: 4px; font-size: 11px; font-weight: 700; margin-right: 6px; font-family: monospace; }
    .get  { background: rgba(76,219,142,0.2); color: #4cdb8e; }
    .post { background: rgba(92,165,255,0.2); color: #5ca5ff; }
    .put  { background: rgba(255,190,92,0.2); color: #ffbe5c; }
    .del  { background: rgba(255,92,122,0.2); color: #ff5c7a; }
    a { color: #5ca5ff; }
    .section { max-width: 860px; margin: 0 auto; }
    .subtitle { color: #9fb0d8; font-size: 14px; margin: 0 0 24px; }
    .badge-admin { font-size: 10px; background: rgba(255,190,92,0.15); color: #ffbe5c; border: 1px solid rgba(255,190,92,0.3); border-radius: 3px; padding: 1px 5px; margin-left: 6px; vertical-align: middle; }
  </style>
</head>
<body>
<div class="section">
  <h1>LM Launch</h1>
  <p class="subtitle">API reference. All endpoints require <code>Authorization: Bearer &lt;token&gt;</code> when auth is enabled. Endpoints marked <span class="badge-admin">admin</span> require the server API token.</p>

  <h2>Auth</h2>
  <div class="endpoint">
    <span class="method post">POST</span><code>/auth/login</code>
    <p>Exchange username + password for a session token (only when user auth is enabled).</p>
    <pre>{ "username": "alice", "password": "..." }
→ { "token": "...", "tokenType": "Bearer", "expiresAt": "...", "username": "alice" }</pre>
  </div>
  <div class="endpoint">
    <span class="method post">POST</span><code>/auth/logout</code>
    <p>Invalidate the current Bearer session token.</p>
  </div>

  <h2>Instances</h2>
  <div class="endpoint">
    <span class="method get">GET</span><code>/v1/instances</code>
    <p>List all instances with state, runtime info, and live GPU telemetry. Returns <code>{ data: [...], gpus: [...] }</code></p>
  </div>
  <div class="endpoint">
    <span class="method post">POST</span><code>/v1/instances/start</code>
    <p>Launch a new instance. <code>name</code>, <code>model</code>, and <code>port</code> are required. <code>gpus</code> is required for non-CPU backends.</p>
    <pre>{
  "name": "my-instance",          // required — display name
  "model": "/path/to/model.gguf", // required
  "port": 1234,                   // required
  "gpus": ["0", "1"],             // required for cuda/metal backends
  "runtimeBackend": "cuda_full",  // "auto" | "cuda_full" | "cpu"  (default "auto")
  "runtimeArgs": ["--flash-attn", "on", "-c", "8192"],
  "contextLength": 8192,          // integer or "auto"
  "instanceId": "my-id",          // optional — auto-generated UUID if omitted
  "host": "127.0.0.1",            // optional listen host  (default 127.0.0.1)
  "maxInflightRequests": 4,       // optional  (default 4, max 1024)
  "queueLimit": 64,               // optional  (default 64)
  "modelTtlSeconds": 300,         // optional — evict idle model after N seconds
  "modelParallel": 2,             // optional — parallel model slots
  "restartPolicy": { "mode": "on-failure", "maxRetries": 2, "backoffMs": 3000 }
}</pre>
  </div>
  <div class="endpoint">
    <span class="method post">POST</span><code>/v1/instances/:id/stop</code>
    <p>Gracefully stop an instance.</p>
  </div>
  <div class="endpoint">
    <span class="method post">POST</span><code>/v1/instances/:id/kill</code>
    <p>Force-kill an instance immediately. Body: <code>{ "reason": "optional string" }</code></p>
  </div>
  <div class="endpoint">
    <span class="method del">DEL</span><code>/v1/instances/:id</code>
    <p>Stop (if running) and remove an instance from state.</p>
  </div>
  <div class="endpoint">
    <span class="method post">POST</span><code>/v1/instances/:id/drain</code>
    <p>Pause or resume request intake. Body: <code>{ "enabled": true }</code></p>
  </div>
  <div class="endpoint">
    <span class="method post">POST</span><code>/v1/instances/:id/model</code>
    <p>Hot-swap the model on a running instance.</p>
    <pre>{
  "model": "/path/to/new-model.gguf",  // required
  "applyMode": "next_restart"          // "next_restart" (default) | "restart_now"
}</pre>
  </div>
  <div class="endpoint">
    <span class="method get">GET</span><code>/v1/instances/:id/logs</code>
    <p>Tail instance logs. Query: <code>?lines=200</code></p>
  </div>
  <div class="endpoint">
    <span class="method get">GET</span><code>/v1/instances/:id/connection</code>
    <p>Returns copy-ready direct and proxied URLs plus current model fields for an instance.</p>
  </div>
  <div class="endpoint">
    <span class="method get">GET</span><code>/v1/instances/:id/proxy/v1/...</code>
    <p>OpenAI-compatible reverse proxy to the instance. Errors are returned as <code>{ error: { message, type, param, code } }</code>.</p>
    <pre>curl http://localhost:8081/v1/instances/my-instance/proxy/v1/chat/completions \\
  -H "Authorization: Bearer &lt;token&gt;" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"...", "messages":[{"role":"user","content":"Hello"}]}'</pre>
  </div>

  <h2>Manifest</h2>
  <div class="endpoint">
    <span class="method get">GET</span><code>/v1/manifest/ready</code>
    <p>Returns all <em>ready</em> (non-draining) instances with routing policy and capacity fields. Designed for load-balancer or agent use.</p>
  </div>

  <h2>Profiles</h2>
  <div class="endpoint">
    <span class="method get">GET</span><code>/v1/profiles</code>
    <p>List saved launch profiles. Returns <code>{ data: [...] }</code></p>
  </div>
  <div class="endpoint">
    <span class="method post">POST</span><code>/v1/profiles</code>
    <p>Create a launch profile. Body mirrors the instance start schema; <code>name</code> is required.</p>
  </div>
  <div class="endpoint">
    <span class="method del">DEL</span><code>/v1/profiles/:id</code>
    <p>Delete a saved profile.</p>
  </div>

  <h2>Config Library</h2>
  <div class="endpoint">
    <span class="method get">GET</span><code>/v1/instance-configs</code>
    <p>List all saved configs. Returns <code>{ data: [...] }</code></p>
  </div>
  <div class="endpoint">
    <span class="method get">GET</span><code>/v1/instance-configs/:id</code>
    <p>Get a single saved config by ID.</p>
  </div>
  <div class="endpoint">
    <span class="method post">POST</span><code>/v1/instance-configs/save-current</code>
    <p>Save current running instances as a named config. Body: <code>{ "name": "My Config", "id": "optional-id" }</code></p>
  </div>
  <div class="endpoint">
    <span class="method post">POST</span><code>/v1/instance-configs/:id/load</code>
    <p>Launch all instances from a saved config.</p>
  </div>
  <div class="endpoint">
    <span class="method get">GET</span><code>/v1/instance-configs/current/export.yaml</code>
    <p>Export the current running instances as YAML (not saved to library).</p>
  </div>
  <div class="endpoint">
    <span class="method get">GET</span><code>/v1/instance-configs/:id/export.yaml</code>
    <p>Download a saved config as YAML.</p>
  </div>
  <div class="endpoint">
    <span class="method post">POST</span><code>/v1/instance-configs/import.yaml</code>
    <p>Import a config from YAML. Body: YAML text, <code>Content-Type: application/yaml</code></p>
  </div>
  <div class="endpoint">
    <span class="method del">DEL</span><code>/v1/instance-configs/:id</code>
    <p>Delete a saved config.</p>
  </div>

  <h2>System</h2>
  <div class="endpoint">
    <span class="method get">GET</span><code>/v1/gpus</code>
    <p>List detected GPUs with VRAM usage via bridge.</p>
  </div>
  <div class="endpoint">
    <span class="method get">GET</span><code>/v1/local-models</code>
    <p>List GGUF model files on the host. Returns <code>{ data: [{ id, name, shards }], dir }</code></p>
  </div>
  <div class="endpoint">
    <span class="method get">GET</span><code>/v1/audit</code>
    <p>Retrieve the audit log. Returns <code>{ data: [...] }</code></p>
  </div>
  <div class="endpoint">
    <span class="method get">GET</span><code>/health</code>
    <p>Health check. Returns <code>{ status: "ok", service: "api", at: "..." }</code>. No auth required.</p>
  </div>

  <h2>Agent Interface</h2>
  <div class="endpoint">
    <span class="method get">GET</span><code>/v1/agent/capabilities</code>
    <p>Describe available agent actions and their input/output schemas.</p>
  </div>
  <div class="endpoint">
    <span class="method post">POST</span><code>/v1/agent/action</code>
    <p>Execute a named agent action. Body: <code>{ "action": "instances.start", "input": { ... } }</code></p>
    <p>Actions: <code>manifest.ready</code>, <code>profiles.list</code>, <code>instances.list</code>, <code>instances.start</code>, <code>instances.stop</code>, <code>instances.kill</code>, <code>instances.drain</code>, <code>instances.switchModel</code>, <code>instances.logs</code>, <code>instances.connection</code></p>
  </div>

  <h2>Admin</h2>
  <div class="endpoint">
    <span class="method get">GET</span><code>/v1/settings/security</code> <span class="badge-admin">admin</span>
    <p>Get current security settings (auth, TLS, API key policy).</p>
  </div>
  <div class="endpoint">
    <span class="method put">PUT</span><code>/v1/settings/security</code> <span class="badge-admin">admin</span>
    <p>Update security settings.</p>
  </div>
  <div class="endpoint">
    <span class="method get">GET</span><code>/v1/users</code> <span class="badge-admin">admin</span>
    <p>List local users.</p>
  </div>
  <div class="endpoint">
    <span class="method post">POST</span><code>/v1/users</code> <span class="badge-admin">admin</span>
    <p>Create a local user. Body: <code>{ "username": "alice", "password": "..." }</code></p>
  </div>
  <div class="endpoint">
    <span class="method del">DEL</span><code>/v1/users/:username</code> <span class="badge-admin">admin</span>
    <p>Delete a local user.</p>
  </div>
  <div class="endpoint">
    <span class="method get">GET</span><code>/v1/config/export.yaml</code> <span class="badge-admin">admin</span> &nbsp;
    <span class="method post">POST</span><code>/v1/config/import.yaml</code> <span class="badge-admin">admin</span>
    <p>Export or import the full server config (security settings, profiles) as YAML. Import supports <code>?dryRun=true</code>.</p>
  </div>
  <div class="endpoint">
    <span class="method get">GET</span><code>/v1/config/status</code> <span class="badge-admin">admin</span>
    <p>Config sync status — current hash and last import timestamps.</p>
  </div>
  <div class="endpoint">
    <span class="method get">GET</span><code>/v1/system/gpus</code> <span class="badge-admin">admin</span>
    <p>GPU list via bridge (admin-gated variant of <code>/v1/gpus</code>).</p>
  </div>
  <div class="endpoint">
    <span class="method post">POST</span><code>/v1/system/close</code> <span class="badge-admin">admin</span>
    <p>Graceful shutdown. Body: <code>{ "unloadModels": true, "stopDaemon": true }</code></p>
  </div>
</div>
</body>
</html>`);
});

if (fs.existsSync(webRoot)) {
  app.use(express.static(webRoot));
}

app.post("/auth/login", (req, res) => {
  if (!state.settings.security.auth.enabled) {
    return res.status(403).json({ error: "User auth is disabled" });
  }

  const username = String(req.body?.username || "");
  const password = String(req.body?.password || "");
  if (!username || !password) {
    return res.status(400).json({ error: "username and password are required" });
  }

  const user = state.users.find((u) => u.username === username && !u.disabled);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const session = createSession(username);
  audit("auth.login", { username });
  return res.json({
    token: session.token,
    tokenType: "Bearer",
    expiresAt: session.expiresAt,
    username
  });
});

app.post("/auth/logout", (req, res) => {
  const token = getBearerToken(req);
  if (!token) return res.status(400).json({ error: "Bearer token required" });

  const before = state.sessions.length;
  state.sessions = state.sessions.filter((s) => s.token !== token);
  saveState(state);
  if (before !== state.sessions.length) {
    audit("auth.logout", {});
  }
  return res.json({ success: true });
});

app.use("/v1", auth);

app.get("/v1/settings/security", requireAdminToken, (_req, res) => {
  res.json(state.settings.security);
});

app.get("/v1/config/export.yaml", requireAdminToken, (_req, res) => {
  const doc = yaml.dump(toSharedConfig(state), { noRefs: true, lineWidth: 120 });
  res.setHeader("content-type", "application/yaml");
  res.send(doc);
});

app.get("/v1/instance-configs", (req, res) => {
  const data = (state.instanceConfigs || []).map((cfg) => ({
    id: cfg.id,
    name: cfg.name,
    instanceCount: Array.isArray(cfg.instances) ? cfg.instances.length : 0,
    createdAt: cfg.createdAt,
    updatedAt: cfg.updatedAt
  }));
  res.json({ data });
});

app.get("/v1/instance-configs/:id", (req, res) => {
  const config = (state.instanceConfigs || []).find((x) => x.id === req.params.id);
  if (!config) return res.status(404).json({ error: "instance config not found" });
  res.json(config);
});

app.post("/v1/instance-configs", (req, res) => {
  const payload = sanitizeInstanceConfigPayload(req.body || {});
  if (payload.instances.length === 0) {
    return res.status(400).json({ error: "config must contain at least one valid instance" });
  }

  const nowTs = now();
  const existingIndex = state.instanceConfigs.findIndex((x) => x.id === payload.id);
  const next = {
    ...payload,
    createdAt: existingIndex >= 0 ? state.instanceConfigs[existingIndex].createdAt : nowTs,
    updatedAt: nowTs
  };

  if (existingIndex >= 0) {
    state.instanceConfigs[existingIndex] = next;
  } else {
    state.instanceConfigs.unshift(next);
  }

  saveState(state);
  audit("instance_config.save", { id: next.id, name: next.name, instances: next.instances.length });
  return res.status(201).json(next);
});

app.post("/v1/instance-configs/save-current", (req, res) => {
  const name = String(req.body?.name || "").trim() || `Config ${new Date().toLocaleString()}`;
  const id = String(req.body?.id || `cfg_${Date.now()}`).trim();
  const instances = currentInstanceTemplates();

  if (instances.length === 0) {
    return res.status(400).json({ error: "no instances available to save" });
  }

  const nowTs = now();
  const existingIndex = state.instanceConfigs.findIndex((x) => x.id === id);
  const next = {
    id,
    name,
    instances,
    createdAt: existingIndex >= 0 ? state.instanceConfigs[existingIndex].createdAt : nowTs,
    updatedAt: nowTs
  };

  if (existingIndex >= 0) {
    state.instanceConfigs[existingIndex] = next;
  } else {
    state.instanceConfigs.unshift(next);
  }

  saveState(state);
  audit("instance_config.save_current", { id: next.id, name: next.name, instances: next.instances.length });
  return res.status(201).json(next);
});

app.delete("/v1/instance-configs/:id", (req, res) => {
  const before = state.instanceConfigs.length;
  state.instanceConfigs = state.instanceConfigs.filter((x) => x.id !== req.params.id);
  if (state.instanceConfigs.length === before) {
    return res.status(404).json({ error: "instance config not found" });
  }
  saveState(state);
  audit("instance_config.delete", { id: req.params.id });
  return res.json({ success: true });
});

app.post("/v1/instance-configs/:id/load", async (req, res) => {
  const config = state.instanceConfigs.find((x) => x.id === req.params.id);
  if (!config) return res.status(404).json({ error: "instance config not found" });

  const replaceExisting = req.body?.replaceExisting !== false;
  const started = [];
  const failed = [];
  const reservedIds = new Set(state.instances.map((x) => String(x.id)));

  if (replaceExisting) {
    for (const inst of [...state.instances]) {
      if (inst.state !== "stopped") {
        try {
          await bridgeFetch("POST", `/v1/instances/${inst.id}/kill`, { reason: "load_config_replace" });
        } catch {
          // Continue best effort.
        }
      }
    }
    state.instances = [];
    saveState(state);
  }

  for (let i = 0; i < config.instances.length; i += 1) {
    const item = config.instances[i];
    try {
      const requestedInstanceId = nextUniqueInstanceId(toInstanceId(item.name), reservedIds);
      reservedIds.add(requestedInstanceId);
      const payload = {
        name: item.name,
        host: item.host,
        bindHost: item.bindHost || "0.0.0.0",
        port: item.port,
        model: item.model,
        gpus: Array.isArray(item.gpus) ? item.gpus : [],
        maxInflightRequests: Number(item.maxInflightRequests || 4),
        queueLimit: parsePositiveInteger(item.queueLimit, 64, 1, 100000),
        modelTtlSeconds: parseOptionalPositiveInteger(item.modelTtlSeconds),
        modelParallel: parseOptionalPositiveInteger(item.modelParallel),
        restartPolicy: parseRestartPolicy(item.restartPolicy),
        runtimeBackend: item.runtime?.hardware || "auto",
        runtimeArgs: Array.isArray(item.runtime?.serverArgs) && item.runtime.serverArgs.length > 0
          ? item.runtime.serverArgs
          : ["--port", "{port}"],
        contextLength: item.contextLength ?? "auto",
        instanceId: requestedInstanceId
      };

      const startedInstance = await localApi("POST", "/v1/instances/start", payload);
      started.push({ name: item.name, instanceId: startedInstance.id, port: startedInstance.port });
    } catch (error) {
      failed.push({ name: item.name, error: String(error.message || error) });
    }
  }

  audit("instance_config.load", {
    id: config.id,
    started: started.length,
    failed: failed.length,
    replaceExisting
  });

  return res.json({
    success: true,
    configId: config.id,
    configName: config.name,
    replaceExisting,
    started,
    failed
  });
});

app.post(
  "/v1/instance-configs/import.yaml",
  requireAdminToken,
  express.text({
    type: ["application/yaml", "text/yaml", "application/x-yaml", "text/plain"],
    limit: "2mb"
  }),
  (req, res) => {
    const raw = String(req.body || "");
    if (!raw.trim()) {
      return res.status(400).json({ error: "YAML body is required" });
    }
    let parsed;
    try {
      parsed = yaml.load(raw);
    } catch (error) {
      return res.status(400).json({ error: `Invalid YAML: ${String(error.message || error)}` });
    }
    if (!parsed || typeof parsed !== "object") {
      return res.status(400).json({ error: "YAML must be an object" });
    }
    const payload = sanitizeInstanceConfigPayload(parsed);
    if (payload.instances.length === 0) {
      return res.status(400).json({ error: "config must contain at least one valid instance" });
    }
    const nowTs = now();
    const existingIndex = state.instanceConfigs.findIndex((x) => x.id === payload.id);
    const next = {
      ...payload,
      createdAt: existingIndex >= 0 ? state.instanceConfigs[existingIndex].createdAt : nowTs,
      updatedAt: nowTs
    };
    if (existingIndex >= 0) {
      state.instanceConfigs[existingIndex] = next;
    } else {
      state.instanceConfigs.unshift(next);
    }
    saveState(state);
    audit("instance_config.import_yaml", { id: next.id, name: next.name, instances: next.instances.length });
    return res.status(201).json(next);
  }
);

app.get("/v1/instance-configs/current/export.yaml", (req, res) => {
  const current = {
    id: "current",
    name: "Current Instances",
    instances: currentInstanceTemplates()
  };
  const doc = yaml.dump(toInstanceConfigYamlDoc(current), { noRefs: true, lineWidth: 120 });
  res.setHeader("content-type", "application/yaml");
  res.send(doc);
});

app.get("/v1/instance-configs/:id/export.yaml", (req, res) => {
  const config = state.instanceConfigs.find((x) => x.id === req.params.id);
  if (!config) return res.status(404).json({ error: "instance config not found" });
  const doc = yaml.dump(toInstanceConfigYamlDoc(config), { noRefs: true, lineWidth: 120 });
  res.setHeader("content-type", "application/yaml");
  res.send(doc);
});

app.get("/v1/config/status", requireAdminToken, (_req, res) => {
  const snapshot = yaml.dump(toSharedConfig(state), { noRefs: true, lineWidth: 120 });
  res.json({
    currentExportHash: configHash(snapshot),
    ...state.settings.configSync
  });
});

app.post(
  "/v1/config/import.yaml",
  requireAdminToken,
  express.text({
    type: ["application/yaml", "text/yaml", "application/x-yaml", "text/plain"],
    limit: "2mb"
  }),
  (req, res) => {
    const dryRun = String(req.query.dryRun || "false") === "true";
    const raw = String(req.body || "");
    if (!raw.trim()) {
      return res.status(400).json({ error: "YAML body is required" });
    }

    let parsed;
    try {
      parsed = yaml.load(raw);
    } catch (error) {
      return res.status(400).json({ error: `Invalid YAML: ${String(error.message || error)}` });
    }

    const result = validateSharedConfig(parsed);
    const importHash = configHash(raw);
    if (result.errors.length > 0) {
      return res.status(400).json({
        success: false,
        dryRun,
        errors: result.errors,
        warnings: result.warnings
      });
    }

    if (!dryRun) {
      state.settings.security = result.normalized.settings.security;

      const nowTs = now();
      state.profiles = result.normalized.profiles.map((p) => {
        const existing = state.profiles.find((x) => x.id === p.id);
        return {
          ...p,
          createdAt: existing?.createdAt || nowTs,
          updatedAt: nowTs
        };
      });

      const userMap = new Map(state.users.map((u) => [u.username, u]));
      for (const u of result.normalized.users) {
        const existing = userMap.get(u.username);
        if (existing) {
          existing.disabled = u.disabled;
          existing.updatedAt = nowTs;
        } else {
          result.warnings.push(`user '${u.username}' not present locally; skipped (no password hash in shared YAML)`);
        }
      }

      state.settings.configSync.lastImportedAt = now();
      state.settings.configSync.lastImportedHash = importHash;
      audit("config.import.yaml", {
        profiles: state.profiles.length,
        usersProcessed: result.normalized.users.length,
        dryRun: false
      });
      saveState(state);
    } else {
      state.settings.configSync.lastDryRunAt = now();
      state.settings.configSync.lastDryRunHash = importHash;
      saveState(state);
    }

    return res.json({
      success: true,
      dryRun,
      applied: !dryRun,
      warnings: result.warnings,
      summary: {
        profiles: result.normalized.profiles.length,
        users: result.normalized.users.length,
        security: true
      }
    });
  }
);

app.put("/v1/settings/security", requireAdminToken, (req, res) => {
  const payload = req.body || {};

  if (payload.tls) {
    state.settings.security.tls.enabled = Boolean(payload.tls.enabled);
    state.settings.security.tls.certFile = String(payload.tls.certFile || "");
    state.settings.security.tls.keyFile = String(payload.tls.keyFile || "");
    state.settings.security.tls.caFile = String(payload.tls.caFile || "");
  }

  if (payload.auth) {
    state.settings.security.auth.enabled = Boolean(payload.auth.enabled);
    state.settings.security.auth.sessionTtlMinutes = Number(payload.auth.sessionTtlMinutes || 720);
  }

  if (payload.api) {
    const wantRequire = Boolean(payload.api.requireApiKey);
    if (wantRequire && !apiAuthEnabled) {
      return res.status(400).json({
        error: "Cannot require API key when API_AUTH_TOKEN is not configured"
      });
    }
    state.settings.security.api.requireApiKey = wantRequire;
  }

  saveState(state);
  audit("settings.security.update", {});
  return res.json(state.settings.security);
});

app.get("/v1/users", requireAdminToken, (_req, res) => {
  const users = state.users.map((u) => ({
    username: u.username,
    disabled: Boolean(u.disabled),
    createdAt: u.createdAt,
    updatedAt: u.updatedAt
  }));
  res.json({ data: users });
});

app.post("/v1/users", requireAdminToken, (req, res) => {
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "");

  if (!/^[a-zA-Z0-9_.-]{3,64}$/.test(username)) {
    return res.status(400).json({ error: "username must be 3-64 chars [a-zA-Z0-9_.-]" });
  }
  if (password.length < 12) {
    return res.status(400).json({ error: "password must be at least 12 characters" });
  }

  const existing = state.users.find((u) => u.username === username);
  const passwordHash = hashPassword(password);
  if (existing) {
    existing.passwordHash = passwordHash;
    existing.disabled = false;
    existing.updatedAt = now();
  } else {
    state.users.push({
      username,
      passwordHash,
      disabled: false,
      createdAt: now(),
      updatedAt: now()
    });
  }

  saveState(state);
  audit("user.upsert", { username });
  return res.status(201).json({ success: true, username });
});

app.delete("/v1/users/:username", requireAdminToken, (req, res) => {
  const username = req.params.username;
  const before = state.users.length;
  state.users = state.users.filter((u) => u.username !== username);
  state.sessions = state.sessions.filter((s) => s.username !== username);
  saveState(state);

  if (state.users.length === before) {
    return res.status(404).json({ error: "user not found" });
  }

  audit("user.delete", { username });
  return res.json({ success: true });
});

app.get("/v1/gpus", async (_req, res) => {
  try {
    const result = await bridgeFetch("GET", "/v1/gpus");
    res.json(result);
  } catch (error) {
    res.status(502).json({ error: String(error.message || error) });
  }
});

app.get("/v1/profiles", (_req, res) => {
  res.json({ data: state.profiles });
});

app.post("/v1/profiles", (req, res) => {
  const payload = req.body || {};
  if (!payload.name) {
    return res.status(400).json({ error: "name is required" });
  }

  const id = payload.id || `prof_${Date.now()}`;
  const profile = {
    id,
    name: payload.name,
    runtime: {
      serverArgs: ["--port", "{port}"]
    },
    gpus: Array.isArray(payload.gpus) ? payload.gpus : [],
    host: payload.host || "127.0.0.1",
    port: Number(payload.port || 1234),
    contextLength: Number(payload.contextLength || 8192),
    startupTimeoutMs: Number(payload.startupTimeoutMs || 180000),
    queueLimit: Number(payload.queueLimit || 64),
    createdAt: now(),
    updatedAt: now()
  };

  const existing = state.profiles.findIndex((p) => p.id === id);
  if (existing >= 0) {
    profile.createdAt = state.profiles[existing].createdAt;
    state.profiles[existing] = profile;
  } else {
    state.profiles.push(profile);
  }

  saveState(state);
  audit("profile.upsert", { id: profile.id, name: profile.name });
  return res.status(201).json(profile);
});

app.delete("/v1/profiles/:id", (req, res) => {
  state.profiles = state.profiles.filter((p) => p.id !== req.params.id);
  saveState(state);
  audit("profile.delete", { id: req.params.id });
  res.json({ success: true });
});

app.get("/v1/instances", async (_req, res) => {
  const apiBase = apiPublicBaseUrl();
  let gpuData = [];
  try {
    const bridgeState = await bridgeFetch("GET", "/v1/instances");
    const gpus = await bridgeFetch("GET", "/v1/gpus");
    gpuData = Array.isArray(gpus?.data) ? gpus.data : [];

    const gpuById = new Map(gpuData.map((gpu) => [String(gpu.id), gpu]));
    state.instances = state.instances.map((inst) => {
      const runtime = bridgeState.data.find((x) => x.instanceId === inst.id);
      const runtimeInflight = Number(runtime?.inflightRequests);
      const runtimeQueueDepth = Number(runtime?.queueDepth);
      const localInflight = Number(inst.inflightRequests || 0);
      const localQueueDepth = Number(inst.queueDepth || 0);
      // Prefer bridge runtime counters when available so stale local cache values
      // do not keep an instance stuck in "Processing" after requests complete.
      const mergedInflight = runtime
        ? (Number.isFinite(runtimeInflight) ? Math.max(0, runtimeInflight) : 0)
        : (Number.isFinite(localInflight) ? Math.max(0, localInflight) : 0);
      const mergedQueueDepth = runtime
        ? (Number.isFinite(runtimeQueueDepth) ? Math.max(0, runtimeQueueDepth) : 0)
        : (Number.isFinite(localQueueDepth) ? Math.max(0, localQueueDepth) : 0);
      const assignedGpus = Array.isArray(inst.gpus) ? inst.gpus.map((g) => String(g)) : [];
      const gpuStats = assignedGpus
        .map((id) => gpuById.get(id))
        .filter(Boolean)
        .map((gpu) => ({
          id: String(gpu.id),
          name: gpu.name,
          memory_total_mib: gpu.memory_total_mib,
          memory_used_mib: gpu.memory_used_mib,
          utilization_percent: gpu.utilization_percent,
          temperature_c: gpu.temperature_c ?? null,
          graphics_clock_mhz: gpu.graphics_clock_mhz ?? null,
          memory_clock_mhz: gpu.memory_clock_mhz ?? null
        }));
      return {
        ...inst,
        pid: runtime?.pid || null,
        state: runtime?.state || "stopped",
        inflightRequests: mergedInflight,
        queueDepth: mergedQueueDepth,
        gpuStats,
        updatedAt: now()
      };
    });
    saveState(state);
  } catch {
    // Keep last-known state if bridge is unavailable.
  }

  const data = state.instances.map((inst) => ({
    ...inst,
    advertisedHost: resolveAdvertisedHost(inst),
    baseUrl: instancePublicBaseUrl(inst),
    proxyBaseUrl: `${apiBase}/v1/instances/${encodeURIComponent(inst.id)}/proxy/v1`
  }));

  res.json({ data, gpus: gpuData });
});

app.post("/v1/instances/start", async (req, res) => {
  const name = String(req.body?.name || "").trim();
  const launchHost = String(req.body?.host || "127.0.0.1").trim() || "127.0.0.1";
  const launchPort = Number(req.body?.port);
  const requestedId = String(req.body?.instanceId || "").trim();
  const modelToUse = String(req.body?.model || "").trim();
  const runtimeArgs = parseRuntimeArgs(req.body?.runtimeArgs);
  const contextLength = parseContextLength(req.body?.contextLength);
  const bindHost = parseBindHost(req.body?.bindHost);
  const runtimeBackend = normalizeRuntimeBackend(req.body?.runtimeBackend || "auto");
  const launchGpus = Array.isArray(req.body?.gpus)
    ? req.body.gpus.map((g) => String(g))
      : [];
  const maxInflightRequests = parsePositiveInteger(req.body?.maxInflightRequests, 4, 1, 1024);
  const queueLimit = parsePositiveInteger(req.body?.queueLimit, 64, 1, 100000);
  const modelTtlSeconds = parseOptionalPositiveInteger(req.body?.modelTtlSeconds);
  const modelParallel = parseOptionalPositiveInteger(req.body?.modelParallel);
  const restartPolicy = parseRestartPolicy(req.body?.restartPolicy);
  if (!name) {
    return res.status(400).json({ error: "name is required" });
  }
  if (!Number.isInteger(launchPort) || launchPort < 1 || launchPort > 65535) {
    return res.status(400).json({ error: "valid port is required" });
  }
  if (!modelToUse) {
    return res.status(400).json({ error: "model is required" });
  }

  const usedIds = new Set(state.instances.map((x) => String(x.id)));
  const instanceId = requestedId
    ? nextUniqueInstanceId(toInstanceId(requestedId), usedIds)
    : crypto.randomUUID();

  const activeInstances = state.instances.filter((x) => x.state !== "stopped");
  const portConflict = activeInstances.find(
    (x) => Number(x.port) === launchPort && String(x.host || "127.0.0.1") === launchHost
  );
  if (portConflict) {
    return res.status(409).json({
      error: "port already in use by running instance",
      port: launchPort,
      instanceId: portConflict.id
    });
  }

  const usesGpu = runtimeBackend !== "cpu";
  if (usesGpu && launchGpus.length === 0) {
    return res.status(400).json({
      error: "at least one GPU must be selected for non-CPU runtime"
    });
  }
  if (usesGpu) {
    const occupiedGpus = new Set(
      activeInstances
        .filter((x) => normalizeRuntimeBackend(x?.runtime?.hardware) !== "cpu")
        .flatMap((x) => (Array.isArray(x.gpus) ? x.gpus.map((g) => String(g)) : []))
    );
    const duplicateGpus = launchGpus.filter((g) => occupiedGpus.has(String(g)));
    if (duplicateGpus.length > 0) {
      return res.status(409).json({
        error: "gpu already assigned to running instance",
        gpus: [...new Set(duplicateGpus)]
      });
    }
  }

  const profile = {
    id: null,
    name,
    runtime: {
      serverArgs: runtimeArgs,
      hardware: runtimeBackend
    },
    host: launchHost,
    bindHost,
    port: launchPort,
    gpus: usesGpu ? launchGpus : [],
    contextLength,
    startupTimeoutMs: 180000,
    queueLimit,
    modelTtlSeconds,
    modelParallel,
    restartPolicy
  };
  
  const existing = state.instances.find((x) => x.id === instanceId);
  if (existing && existing.state !== "stopped") {
    return res.status(409).json({ error: "instance already exists and is not stopped" });
  }

  const provisional = {
    id: instanceId,
    profileId: null,
    profileName: name,
    effectiveModel: modelToUse,
    pendingModel: null,
    host: launchHost,
    bindHost,
    port: launchPort,
    state: "starting",
    pid: null,
    gpus: usesGpu ? launchGpus : [],
    runtime: {
      serverArgs: runtimeArgs,
      hardware: runtimeBackend
    },
    contextLength,
    maxInflightRequests,
    queueLimit,
    modelTtlSeconds,
    modelParallel,
    restartPolicy,
    inflightRequests: 0,
    queueDepth: 0,
    completedRequests: 0,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalTokens: 0,
    lastActivityAt: null,
    drain: false,
    lastHealthOkAt: null,
    lastError: null,
    gpuStats: [],
    startedAt: now(),
    updatedAt: now()
  };

  if (existing) {
    const idx = state.instances.findIndex((x) => x.id === instanceId);
    state.instances[idx] = provisional;
  } else {
    state.instances.push(provisional);
  }
  saveState(state);
  try {
    const launch = await bridgeFetch("POST", "/v1/instances/start", {
      instanceId,
      profile: {
        ...profile,
        model: modelToUse,
        maxInflightRequests
      }
    });

    const idx = state.instances.findIndex((x) => x.id === instanceId);
    const instance = {
      ...(idx >= 0 ? state.instances[idx] : provisional),
      state: launch.state || "starting",
      pid: launch.pid || null,
      lastError: null,
      updatedAt: now()
    };

    if (idx >= 0) {
      state.instances[idx] = instance;
    } else {
      state.instances.push(instance);
    }

    saveState(state);
    audit("instance.start", { instanceId, profileName: name, port: launchPort });
    res.status(201).json(instance);
  } catch (error) {
    const idx = state.instances.findIndex((x) => x.id === instanceId);
    if (idx >= 0) {
      state.instances[idx] = {
        ...state.instances[idx],
        state: "stopped",
        lastError: String(error.message || error),
        updatedAt: now()
      };
      saveState(state);
    }
    res.status(502).json({ error: String(error.message || error) });
  }
});

app.post("/v1/instances/:id/stop", async (req, res) => {
  const instance = state.instances.find((x) => x.id === req.params.id);
  if (!instance) return res.status(404).json({ error: "instance not found" });

  try {
    await bridgeFetch("POST", `/v1/instances/${instance.id}/stop`);
    instance.state = "stopped";
    instance.updatedAt = now();
    saveState(state);
    audit("instance.stop", { instanceId: instance.id });
    res.json({ success: true });
  } catch (error) {
    res.status(502).json({ error: String(error.message || error) });
  }
});

app.post("/v1/instances/:id/kill", async (req, res) => {
  const instance = state.instances.find((x) => x.id === req.params.id);
  if (!instance) return res.status(404).json({ error: "instance not found" });

  try {
    await bridgeFetch("POST", `/v1/instances/${instance.id}/kill`);
    instance.state = "stopped";
    instance.updatedAt = now();
    saveState(state);
    audit("instance.kill", { instanceId: instance.id, reason: req.body?.reason || "operator" });
    res.json({ success: true });
  } catch (error) {
    res.status(502).json({ error: String(error.message || error) });
  }
});

app.delete("/v1/instances/:id", async (req, res) => {
  const instance = state.instances.find((x) => x.id === req.params.id);
  if (!instance) return res.status(404).json({ error: "instance not found" });

  if (instance.state !== "stopped") {
    try {
      await bridgeFetch("POST", `/v1/instances/${instance.id}/kill`);
    } catch {
      // Continue deleting local record even if runtime cleanup fails.
    }
  }

  state.instances = state.instances.filter((x) => x.id !== req.params.id);
  saveState(state);
  audit("instance.delete", { instanceId: req.params.id });
  return res.json({ success: true, deleted: req.params.id });
});

app.post("/v1/instances/:id/drain", async (req, res) => {
  const instance = state.instances.find((x) => x.id === req.params.id);
  if (!instance) return res.status(404).json({ error: "instance not found" });

  const enabled = Boolean(req.body?.enabled);

  try {
    await bridgeFetch("POST", `/v1/instances/${instance.id}/drain`, { enabled });
    instance.drain = enabled;
    instance.state = enabled ? "draining" : "ready";
    instance.updatedAt = now();
    saveState(state);
    audit("instance.drain", { instanceId: instance.id, enabled });
    res.json({ success: true, enabled });
  } catch (error) {
    res.status(502).json({ error: String(error.message || error) });
  }
});

app.post("/v1/instances/:id/model", (req, res) => {
  const instance = state.instances.find((x) => x.id === req.params.id);
  if (!instance) return res.status(404).json({ error: "instance not found" });

  const model = req.body?.model;
  const applyMode = req.body?.applyMode || "next_restart";
  if (!model) return res.status(400).json({ error: "model is required" });

  const savedProfile = state.profiles.find((p) => p.id === instance.profileId);
  const profile =
    savedProfile ||
    {
      id: null,
      name: instance.profileName || instance.id,
      runtime: cleanRuntime(instance.runtime),
      host: instance.host || "127.0.0.1",
      port: instance.port,
      gpus: Array.isArray(instance.gpus) ? instance.gpus : [],
      contextLength: parseContextLength(instance.contextLength)
    };

  const applySwitch = async () => {
    if (applyMode === "restart_now") {
      instance.state = "switching_model";
      instance.updatedAt = now();
      saveState(state);

      await bridgeFetch("POST", `/v1/instances/${instance.id}/stop`);
      const launch = await bridgeFetch("POST", "/v1/instances/start", {
        instanceId: instance.id,
        profile: {
          ...profile,
          model,
          maxInflightRequests: instance.maxInflightRequests || 4
        }
      });

      instance.effectiveModel = model;
      instance.pendingModel = null;
      instance.state = launch.state || "starting";
      instance.pid = launch.pid || null;
      instance.lastError = null;
      instance.updatedAt = now();
      saveState(state);
      audit("instance.model.switch", { instanceId: instance.id, model, applyMode });
      return res.json({ success: true, instance });
    }

    instance.pendingModel = model;
    instance.updatedAt = now();
    saveState(state);
    audit("instance.model.switch", { instanceId: instance.id, model, applyMode });
    return res.json({ success: true, instance });
  };

  applySwitch().catch((error) => {
    instance.state = "unhealthy";
    instance.lastError = String(error.message || error);
    instance.updatedAt = now();
    saveState(state);
    if (!res.headersSent) {
      res.status(502).json({ error: String(error.message || error) });
    }
  });
});

app.all("/v1/instances/:id/proxy/*", async (req, res) => {
  const instance = state.instances.find((x) => x.id === req.params.id);
  if (!instance) return res.status(404).json({ error: { message: "instance not found", type: "invalid_request_error", param: "id", code: "instance_not_found" } });

  const tailPath = String(req.params[0] || "").replace(/^\/+/, "");
  if (!tailPath) {
    return res.status(400).json({ error: { message: "proxy path is required (e.g. /v1/chat/completions)", type: "invalid_request_error", param: null, code: null } });
  }

  const queryIndex = String(req.originalUrl || "").indexOf("?");
  const query = queryIndex >= 0 ? String(req.originalUrl).slice(queryIndex) : "";
  const targetUrl = `${instanceBaseUrl(instance)}/${tailPath}${query}`;
  const method = String(req.method || "GET").toUpperCase();
  const bodyAllowed = !["GET", "HEAD"].includes(method);

  const headers = proxyRequestHeaders(req, instance);

  let body;
  const contentType = String(req.headers["content-type"] || "").toLowerCase();
  const isJsonRequest = contentType.includes("application/json");
  if (bodyAllowed) {
    if (isJsonRequest) {
      body = req.body && Object.keys(req.body).length > 0 ? JSON.stringify(req.body) : undefined;
    } else {
      body = req;
    }
  }

  const abortController = new AbortController();
  // `req.close` fires after request body completion for normal POSTs; using it
  // would cancel healthy upstream inference calls. Abort only on real disconnects.
  req.on("aborted", () => {
    if (!res.writableEnded) {
      abortController.abort();
    }
  });
  res.on("close", () => {
    if (!res.writableEnded) {
      abortController.abort();
    }
  });

  let finalized = false;
  const finalize = () => {
    if (finalized) return;
    finalized = true;
    updateInstanceRequestMetrics(instance, -1);
  };

  updateInstanceRequestMetrics(instance, 1);

  try {
    const upstream = await fetch(targetUrl, {
      method,
      headers,
      body,
      duplex: bodyAllowed && !isJsonRequest ? "half" : undefined,
      signal: abortController.signal
    });

    res.status(upstream.status);
    copyProxyResponseHeaders(upstream.headers, res);

    const contentType = String(upstream.headers.get("content-type") || "").toLowerCase();
    const isJson = contentType.includes("application/json");
    const isSse = contentType.includes("text/event-stream");
    const isDiagnosticChat = method === "POST"
      && String(tailPath || "").toLowerCase().includes("chat/completions");

    if (!upstream.body || (isJson && !isSse)) {
      const raw = await upstream.text();
      markProxyCompletion(instance);
      if (isJson && raw) {
        try {
          const parsed = JSON.parse(raw);
          updateInstanceUsageMetrics(instance, parsed);
        } catch {
          // Keep proxy transparent even when upstream JSON is malformed.
        }
      }

      if (isDiagnosticChat) {
        const preview = String(raw || "").replace(/\s+/g, " ").slice(0, 280);
        audit("proxy.chat.response", {
          instanceId: instance.id,
          status: upstream.status,
          contentType,
          responseBytes: String(raw || "").length,
          preview
        });
      }

      saveState(state);
      finalize();
      return res.send(raw);
    }

    if (isDiagnosticChat) {
      audit("proxy.chat.stream", {
        instanceId: instance.id,
        status: upstream.status,
        contentType
      });
    }

    const stream = Readable.fromWeb(upstream.body);
    stream.on("end", finalize);
    stream.on("error", () => {
      finalize();
      if (!res.writableEnded) {
        res.end();
      }
    });
    res.on("close", finalize);
    stream.pipe(res);
  } catch (error) {
    finalize();
    if (abortController.signal.aborted) {
      return;
    }
    res.status(502).json({ error: { message: String(error.message || error), type: "server_error", param: null, code: "upstream_error" } });
  }
});

app.get("/v1/instances/:id/logs", async (req, res) => {
  const instance = state.instances.find((x) => x.id === req.params.id);
  if (!instance) return res.status(404).json({ error: "instance not found" });

  const lines = Number(req.query.lines || 200);
  try {
    const data = await bridgeFetch("GET", `/v1/instances/${instance.id}/logs?lines=${lines}`);
    res.json(data);
  } catch (error) {
    res.status(502).json({ error: String(error.message || error) });
  }
});

app.get("/v1/manifest/ready", (_req, res) => {
  const data = state.instances
    .filter((x) => x.state === "ready" && !x.drain)
    .map((x) => ({
      instance_id: x.id,
      state: x.state,
      base_url: instancePublicBaseUrl(x),
      api_paths: {
        health: `${instancePublicBaseUrl(x)}/v1/models`,
        chat_completions: `${instancePublicBaseUrl(x)}/v1/chat/completions`,
        responses: `${instancePublicBaseUrl(x)}/v1/responses`
      },
      profile_model: null,
      effective_model: x.effectiveModel,
      pending_model: x.pendingModel || null,
      inflight_requests: x.inflightRequests,
      max_inflight_requests: x.maxInflightRequests,
      queue_depth: x.queueDepth,
      last_health_ok_at: x.lastHealthOkAt,
      last_error: x.lastError
    }));

  res.json({
    policy: {
      request_timeout_ms: 90000,
      retry_count: 2,
      retry_backoff_ms: 750,
      unhealthy_ejection_ms: 30000,
      over_capacity_behavior: "reject"
    },
    data
  });
});

app.get("/v1/instances/:id/connection", (req, res) => {
  const instance = state.instances.find((x) => x.id === req.params.id);
  if (!instance) return res.status(404).json({ error: "instance not found" });

  const apiBase = apiPublicBaseUrl();
  const base = instancePublicBaseUrl(instance);
  const runtimeBase = instanceBaseUrl(instance);
  const globalAuthRequired = isGlobalApiKeyRequired();
  const proxyBase = `${apiBase}/v1/instances/${encodeURIComponent(instance.id)}/proxy/v1`;
  res.json({
    instance_id: instance.id,
    base_url: base,
    runtime_base_url: runtimeBase,
    advertised_host: resolveAdvertisedHost(instance),
    global_auth: globalAuthRequired
      ? {
        type: "bearer",
        required: true,
        source: "control_plane"
      }
      : {
        type: "none",
        required: false
      },
    proxy_base_url: proxyBase,
    urls: {
      models: `${base}/v1/models`,
      chat_completions: `${base}/v1/chat/completions`,
      responses: `${base}/v1/responses`
    },
    proxy_urls: {
      models: `${proxyBase}/models`,
      chat_completions: `${proxyBase}/chat/completions`,
      responses: `${proxyBase}/responses`
    },
    profile_model: null,
    effective_model: instance.effectiveModel,
    pending_model: instance.pendingModel || null
  });
});

app.get("/v1/local-models", (_req, res) => {
  const home = os.homedir();
  const primaryDir = path.resolve(modelsDir.replace(/^~/, home));

  // Well-known model directories for popular local-inference tools.
  // Each entry is checked in order; non-existent paths are skipped silently.
  // Results from extra dirs are prefixed with the tool tag for clarity.
  const extraDirs = [
    { dir: path.join(home, ".ollama", "models"), tag: "ollama" },
    { dir: "/usr/share/ollama/.ollama/models", tag: "ollama" },
    { dir: path.join(home, ".cache", "huggingface", "hub"), tag: "huggingface" },
    { dir: path.join(home, "unsloth_studio"), tag: "unsloth" },
  ];

  const seen = new Set();
  const results = [];
  const dirsScanned = [];

  function walk(dir, baseDir, tagPrefix) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath, baseDir, tagPrefix);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".gguf")) {
        if (seen.has(fullPath)) continue;
        seen.add(fullPath);
        const lower = entry.name.toLowerCase();
        // Skip non-first shards: files matching -NNNNN-of-NNNNN.gguf where NNNNN != 00001
        const shardMatch = lower.match(/-(\d{5})-of-(\d{5})\.gguf$/);
        if (shardMatch && shardMatch[1] !== "00001") continue;
        const rel = path.relative(baseDir, fullPath);
        const name = tagPrefix ? `[${tagPrefix}] ${rel}` : rel;
        const shards = shardMatch ? parseInt(shardMatch[2], 10) : null;
        results.push({ id: fullPath, name, shards });
      }
    }
  }

  // Primary dir (MODELS_DIR / LM Studio default) — no tag prefix, preserving existing behaviour.
  if (fs.existsSync(primaryDir)) {
    dirsScanned.push(primaryDir);
    walk(primaryDir, primaryDir, null);
  }

  // Extra dirs — only scan if they exist and are not the same as primaryDir.
  for (const { dir, tag } of extraDirs) {
    if (dir === primaryDir || !fs.existsSync(dir)) continue;
    dirsScanned.push(dir);
    walk(dir, dir, tag);
  }

  if (results.length === 0 && dirsScanned.length === 0) {
    return res.json({ data: [], warning: `Models directory not found: ${primaryDir}` });
  }

  results.sort((a, b) => a.name.localeCompare(b.name));
  return res.json({ data: results, dir: primaryDir, dirs: dirsScanned });
});

app.get("/v1/audit", (_req, res) => {
  res.json({ data: state.audit });
});

async function localApi(method, endpoint, body) {
  const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
    method,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiToken}`
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }

  return data;
}

app.get("/v1/agent/capabilities", (_req, res) => {
  res.json({
    version: "1.0",
    name: "lmlaunch-agent-interface",
    actions: [
      {
        name: "manifest.ready",
        input: {},
        output: "ready manifest with routing policy and capacity fields"
      },
      {
        name: "profiles.list",
        input: {},
        output: "list of profiles"
      },
      {
        name: "instances.list",
        input: {},
        output: "list of instance state"
      },
      {
        name: "instances.start",
        input: { profileId: "string", instanceId: "string (optional)" },
        output: "started instance payload"
      },
      {
        name: "instances.stop",
        input: { instanceId: "string" },
        output: "operation status"
      },
      {
        name: "instances.kill",
        input: { instanceId: "string", reason: "string (optional)" },
        output: "operation status"
      },
      {
        name: "instances.drain",
        input: { instanceId: "string", enabled: "boolean" },
        output: "operation status"
      },
      {
        name: "instances.switchModel",
        input: {
          instanceId: "string",
          model: "string",
          applyMode: "next_restart | restart_now"
        },
        output: "updated instance"
      },
      {
        name: "instances.logs",
        input: { instanceId: "string", lines: "number (optional)" },
        output: "log text"
      },
      {
        name: "instances.connection",
        input: { instanceId: "string" },
        output: "copy-ready URLs and model fields"
      }
    ]
  });
});

app.post("/v1/agent/action", async (req, res) => {
  const action = req.body?.action;
  const input = req.body?.input || {};

  const instanceIdPattern = /^[a-zA-Z0-9_-]+$/;
  const agentInstanceId = String(input.instanceId || "");
  const needsInstanceId = [
    "instances.stop", "instances.kill", "instances.drain",
    "instances.switchModel", "instances.logs", "instances.connection"
  ];
  if (needsInstanceId.includes(action) && !instanceIdPattern.test(agentInstanceId)) {
    return res.status(400).json({ success: false, error: "invalid instanceId" });
  }

  try {
    switch (action) {
      case "manifest.ready": {
        const data = await localApi("GET", "/v1/manifest/ready");
        return res.json({ success: true, action, data });
      }
      case "profiles.list": {
        const data = await localApi("GET", "/v1/profiles");
        return res.json({ success: true, action, data });
      }
      case "instances.list": {
        const data = await localApi("GET", "/v1/instances");
        return res.json({ success: true, action, data });
      }
      case "instances.start": {
        const data = await localApi("POST", "/v1/instances/start", {
          profileId: input.profileId,
          instanceId: input.instanceId
        });
        return res.json({ success: true, action, data });
      }
      case "instances.stop": {
        const data = await localApi("POST", `/v1/instances/${input.instanceId}/stop`, {});
        return res.json({ success: true, action, data });
      }
      case "instances.kill": {
        const data = await localApi("POST", `/v1/instances/${input.instanceId}/kill`, {
          reason: input.reason || "agent"
        });
        return res.json({ success: true, action, data });
      }
      case "instances.drain": {
        const data = await localApi("POST", `/v1/instances/${input.instanceId}/drain`, {
          enabled: Boolean(input.enabled)
        });
        return res.json({ success: true, action, data });
      }
      case "instances.switchModel": {
        const data = await localApi("POST", `/v1/instances/${input.instanceId}/model`, {
          model: input.model,
          applyMode: input.applyMode || "next_restart"
        });
        return res.json({ success: true, action, data });
      }
      case "instances.logs": {
        const lines = Number(input.lines || 200);
        const data = await localApi("GET", `/v1/instances/${input.instanceId}/logs?lines=${lines}`);
        return res.json({ success: true, action, data });
      }
      case "instances.connection": {
        const data = await localApi("GET", `/v1/instances/${input.instanceId}/connection`);
        return res.json({ success: true, action, data });
      }
      default:
        return res.status(400).json({
          success: false,
          error: "unknown action",
          action
        });
    }
  } catch (error) {
    return res.status(500).json({ success: false, action, error: String(error.message || error) });
  }
});

app.get("/v1/system/gpus", requireAdminToken, async (req, res) => {
  try {
    const data = await bridgeFetch("GET", "/v1/gpus");
    res.json(data);
  } catch (error) {
    res.status(503).json({
      error: "GPU detection failed",
      message: String(error.message || error)
    });
  }
});

app.post("/v1/system/close", requireAdminToken, async (req, res) => {
  const unloadModels = req.body?.unloadModels !== false;
  const stopDaemon = req.body?.stopDaemon !== false;

  try {
    const data = await bridgeFetch("POST", "/v1/system/close", {
      unloadModels,
      stopDaemon
    });

    state.instances = state.instances.map((inst) => ({
      ...inst,
      state: "stopped",
      pid: null,
      inflightRequests: 0,
      queueDepth: 0,
      drain: false,
      lastError: null,
      updatedAt: now()
    }));
    saveState(state);
    audit("system.close", { unloadModels, stopDaemon, instances: state.instances.length });

    res.json({
      success: true,
      ...data,
      instances: state.instances.length
    });
  } catch (error) {
    res.status(503).json({
      error: "system close failed",
      message: String(error.message || error)
    });
  }
});

app.listen(port, () => {
  console.log(`lmlaunch api+web listening on ${port}`);
});
