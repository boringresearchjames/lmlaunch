import express from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import yaml from "js-yaml";

const app = express();
app.use(express.json({ limit: "2mb" }));

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
const stateFile = process.env.STATE_FILE || "/data/state.json";
const sharedConfigFile = process.env.SHARED_CONFIG_FILE || "/data/shared-config.yaml";
const apiAuthEnabled = Boolean(apiToken && apiToken !== "change-me");
const bridgeAuthEnabled = Boolean(bridgeToken && bridgeToken !== "change-me");

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
  instances: [],
  audit: [],
  settings: {
    security: {
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
  next.instances = Array.isArray(next.instances) ? next.instances : [];
  next.audit = Array.isArray(next.audit) ? next.audit : [];
  next.settings = next.settings || {};
  next.settings.security = next.settings.security || {};
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
        target: "lms",
        mode: "server",
        serverArgs: ["server", "start", "--port", "{port}"]
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
  return crypto.timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
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
  if (!apiAuthEnabled) {
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
  if (!apiAuthEnabled) {
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

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "api", at: now() });
});

app.get("/", (_req, res) => {
  res.json({
    name: "lmlaunch-api",
    status: "ok",
    docs: {
      help: "/help",
      health: "/health",
      capabilities: "/v1/agent/capabilities"
    }
  });
});

app.get("/help", (_req, res) => {
  const readmeUrl =
    process.env.HELP_README_URL ||
    "https://github.com/boringresearchjames/lmlaunch/blob/main/README.md";
  res.redirect(302, readmeUrl);
});

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

      saveState(state);
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

  if (payload.runtimeTarget && payload.runtimeTarget !== "lms") {
    return res.status(400).json({ error: "runtimeTarget must be 'lms'" });
  }

  const id = payload.id || `prof_${Date.now()}`;
  const profile = {
    id,
    name: payload.name,
    runtime: {
      target: "lms",
      mode: "server",
      serverArgs: ["server", "start", "--port", "{port}"]
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
  try {
    const bridgeState = await bridgeFetch("GET", "/v1/instances");
    state.instances = state.instances.map((inst) => {
      const runtime = bridgeState.data.find((x) => x.instanceId === inst.id);
      return {
        ...inst,
        pid: runtime?.pid || null,
        state: runtime?.state || inst.state,
        inflightRequests: runtime?.inflightRequests ?? inst.inflightRequests ?? 0,
        queueDepth: runtime?.queueDepth ?? inst.queueDepth ?? 0,
        updatedAt: now()
      };
    });
    saveState(state);
  } catch {
    // Keep last-known state if bridge is unavailable.
  }

  res.json({ data: state.instances });
});

app.post("/v1/instances/start", async (req, res) => {
  const profileRef = String(req.body?.profileId || "").trim();
  const profile = state.profiles.find((p) => p.id === profileRef || p.name === profileRef);
  if (!profile) {
    return res.status(404).json({ error: "profile not found (id or name)" });
  }

  const instanceId = req.body?.instanceId || `inst_${Date.now()}`;
  const modelToUse = String(req.body?.model || "").trim();
  const maxInflightRequests = Number(req.body?.maxInflightRequests || 4);
  if (!modelToUse) {
    return res.status(400).json({ error: "model is required" });
  }
  
  const existing = state.instances.find((x) => x.id === instanceId);
  if (existing && existing.state !== "stopped") {
    return res.status(409).json({ error: "instance already exists and is not stopped" });
  }

  try {
    const launch = await bridgeFetch("POST", "/v1/instances/start", {
      instanceId,
      profile: {
        ...profile,
        model: modelToUse,
        maxInflightRequests
      }
    });

    const instance = {
      id: instanceId,
      profileId: profile.id,
      profileName: profile.name,
      effectiveModel: modelToUse,
      pendingModel: null,
      host: profile.host || "127.0.0.1",
      port: profile.port,
      state: launch.state || "starting",
      pid: launch.pid || null,
      gpus: profile.gpus,
      maxInflightRequests,
      inflightRequests: 0,
      queueDepth: 0,
      drain: false,
      lastHealthOkAt: null,
      lastError: null,
      startedAt: now(),
      updatedAt: now()
    };

    if (existing) {
      const idx = state.instances.findIndex((x) => x.id === instanceId);
      state.instances[idx] = instance;
    } else {
      state.instances.push(instance);
    }

    saveState(state);
    audit("instance.start", { instanceId, profileId: profile.id });
    res.status(201).json(instance);
  } catch (error) {
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

  const profile = state.profiles.find((p) => p.id === instance.profileId);
  if (!profile) return res.status(404).json({ error: "profile not found for instance" });

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
    res.status(502).json({ error: String(error.message || error) });
  });
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
      base_url: instanceBaseUrl(x),
      api_paths: {
        health: `${instanceBaseUrl(x)}/v1/models`,
        chat_completions: `${instanceBaseUrl(x)}/v1/chat/completions`,
        responses: `${instanceBaseUrl(x)}/v1/responses`
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

  const base = instanceBaseUrl(instance);
  res.json({
    instance_id: instance.id,
    base_url: base,
    urls: {
      models: `${base}/v1/models`,
      chat_completions: `${base}/v1/chat/completions`,
      responses: `${base}/v1/responses`
    },
    profile_model: null,
    effective_model: instance.effectiveModel,
    pending_model: instance.pendingModel || null
  });
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

app.get("/v1/lmstudio/models", async (_req, res) => {
  try {
    const lmStudioPort = process.env.LMSTUDIO_PORT || 1234;
    const lmStudioHost = process.env.LMSTUDIO_HOST || "127.0.0.1";
    const data = await bridgeFetch(
      "GET",
      `/v1/models?host=${encodeURIComponent(String(lmStudioHost))}&port=${encodeURIComponent(String(lmStudioPort))}`
    );
    const models = Array.isArray(data.data)
      ? data.data.map((m) => ({ id: m.id, name: m.id }))
      : [];

    res.json({ models });
  } catch (error) {
    res.status(503).json({
      error: "LM Studio connection failed",
      message: String(error.message || error)
    });
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

app.listen(port, () => {
  console.log(`lmlaunch api listening on ${port}`);
});
