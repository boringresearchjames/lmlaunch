import express from "express";
import fs from "fs";
import { corsOrigin, port, webRoot } from "./lib/config.js";
import { auth } from "./lib/auth.js";
import { state, saveState } from "./lib/state.js";
import { instanceBaseUrl } from "./lib/urls.js";
import { now } from "./lib/utils.js";
import { audit } from "./lib/audit.js";
import { restorePartialDownloads } from "./lib/hub.js";
import { cleanupSessions } from "./lib/auth.js";

import healthRouter from "./routes/health.js";
import metricsRouter from "./routes/metrics.js";
import helpRouter from "./routes/help.js";
import authRouter from "./routes/auth.js";
import settingsRouter from "./routes/settings.js";
import instanceConfigsRouter from "./routes/instance-configs.js";
import profilesRouter from "./routes/profiles.js";
import instancesRouter from "./routes/instances.js";
import modelsRouter from "./routes/models.js";
import localModelsRouter from "./routes/local-models.js";
import hubRouter from "./routes/hub.js";
import systemRouter from "./routes/system.js";
import orchestrationRouter from "./routes/orchestration.js";
import { matchOrchestrationRoute, resolveBackend, getFrontierBackend, appendOrchestrationLog, injectSystemPrompt } from "./lib/orchestration.js";
import { proxyToFrontier } from "./lib/frontier.js";
import { resolveInstanceByModelName } from "./lib/routing.js";
import { proxyToInstance } from "./lib/proxy.js";

const corsHeaders = "Authorization, Content-Type, X-Bridge-Token, X-HF-Token";

const app = express();
// Body parsing is split: most endpoints use a small 1mb limit. Routes that
// proxy multimodal payloads (base64 images/audio inside chat completions)
// install their own larger parser — see routes/models.js.
const smallJson = express.json({ limit: "1mb" });
const LARGE_BODY_PATHS = /^\/v1\/(chat\/completions|completions|instances\/[^/]+\/proxy(\/|$))/;
app.use((req, res, next) => {
  if (LARGE_BODY_PATHS.test(req.path)) return next();
  return smallJson(req, res, next);
});

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", corsOrigin);
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", corsHeaders);
  res.header("X-Content-Type-Options", "nosniff");
  res.header("X-Frame-Options", "DENY");
  res.header("Referrer-Policy", "strict-origin-when-cross-origin");
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  return next();
});

// Public routes (no auth)
app.use(healthRouter);
app.use(metricsRouter);
app.use(helpRouter);
app.use(authRouter);

// Static web app
if (fs.existsSync(webRoot)) {
  app.use(express.static(webRoot));
}

// All /v1 routes require auth (applied before mounting v1 routers)
app.use("/v1", auth);

app.use("/v1", settingsRouter);
app.use("/v1", instanceConfigsRouter);
app.use("/v1", profilesRouter);
app.use("/v1", instancesRouter);

// ---------------------------------------------------------------------------
// Orchestration intercept — runs before modelsRouter for /v1/chat/completions
// ---------------------------------------------------------------------------
const largeJsonOrch = express.json({ limit: "50mb" });
app.post("/v1/chat/completions", largeJsonOrch, async (req, res, next) => {
  const modelName = String(req.body?.model || "").trim();
  const route = matchOrchestrationRoute(modelName);
  if (!route) return next(); // not an orchestration route — fall through to modelsRouter

  const startedAt = Date.now();
  const { backend, ruleId } = await resolveBackend(route, req.body);
  if (route.systemPromptSuffix) req.body = injectSystemPrompt(req.body, route);

  async function dispatchBackend(b) {
    if (b.type === "frontier") {
      const fb = getFrontierBackend(b.backendId);
      if (!fb) {
        res.status(502).json({ error: { message: `Frontier backend "${b.backendId}" not found`, type: "server_error" } });
        return;
      }
      await proxyToFrontier(fb, req, res, route.name);
    } else if (b.type === "local") {
      const resolved = resolveInstanceByModelName(b.model);
      if (resolved.error) {
        res.status(resolved.status).json({ error: { message: resolved.error, type: "invalid_request_error" } });
        return;
      }
      const targetUrl = `${instanceBaseUrl(resolved.instance)}${req.path}`;
      await proxyToInstance(resolved.instance, req, res, targetUrl);
    } else if (b.type === "config") {
      const config = (state.instanceConfigs || []).find(c => c.id === b.configId);
      if (!config || !Array.isArray(config.instances) || config.instances.length === 0) {
        res.status(502).json({ error: { message: `Config "${b.configId}" not found`, type: "server_error" } });
        return;
      }
      // Try each config instance model/name until one resolves to a running instance
      let resolved = null;
      for (const cfgInst of config.instances) {
        const attempt = resolveInstanceByModelName(cfgInst.model);
        if (!attempt.error) { resolved = attempt; break; }
        const attempt2 = resolveInstanceByModelName(cfgInst.name);
        if (!attempt2.error) { resolved = attempt2; break; }
      }
      if (!resolved) {
        res.status(503).json({ error: { message: `No instances running for config "${b.configName || b.configId}"`, type: "server_error" } });
        return;
      }
      const targetUrl = `${instanceBaseUrl(resolved.instance)}${req.path}`;
      await proxyToInstance(resolved.instance, req, res, targetUrl);
    } else {
      res.status(500).json({ error: { message: `Unknown backend type: ${b.type}`, type: "server_error" } });
    }
  }

  let dispatchOk = false;
  try {
    await dispatchBackend(backend);
    dispatchOk = true;
  } catch (err) {
    if (!res.headersSent && route.fallbackBackend) {
      audit("orchestration.fallback", {
        route: route.name, primaryBackend: backend, ruleId,
        error: err?.message, latencyMs: Date.now() - startedAt
      });
      try {
        await dispatchBackend(route.fallbackBackend);
        dispatchOk = true;
      } catch (fallbackErr) {
        if (!res.headersSent) {
          res.status(502).json({ error: { message: `Fallback also failed: ${fallbackErr?.message}`, type: "proxy_error" } });
        } else if (!res.writableEnded) {
          res.end();
        }
      }
    } else if (!res.headersSent) {
      res.status(502).json({ error: { message: err?.message || "Orchestration dispatch failed", type: "proxy_error" } });
    } else if (!res.writableEnded) {
      res.end();
    }
  }

  if (dispatchOk) {
    const latencyMs = Date.now() - startedAt;
    const hasTools = Array.isArray(req.body?.tools) && req.body.tools.length > 0;
    audit("orchestration.routed", {
      route: route.name, backend, ruleId, latencyMs
    });
    appendOrchestrationLog({
      id: `log_${startedAt}`,
      at: new Date(startedAt).toISOString(),
      routeName: route.name,
      ruleId,
      backend,
      latencyMs,
      toolsPresent: hasTools || req.body?.tool_choice != null,
      toolCount: Array.isArray(req.body?.tools) ? req.body.tools.length : 0,
      messageCount: Array.isArray(req.body?.messages) ? req.body.messages.length : 0,
      estimatedTokens: Math.ceil(
        (Array.isArray(req.body?.messages) ? req.body.messages : [])
          .reduce((s, m) => s + (typeof m?.content === "string" ? m.content.length : 0), 0) / 4
      ),
      // Compact snapshot — enough to evaluate all condition types client-side
      requestSnapshot: {
        model: req.body?.model,
        tool_choice: req.body?.tool_choice ?? null,
        tools: (Array.isArray(req.body?.tools) ? req.body.tools : [])
          .map(t => ({ function: { name: t?.function?.name ?? "" } })),
        messages: (Array.isArray(req.body?.messages) ? req.body.messages : [])
          .slice(-5)
          .map(m => {
            // Flatten array content to text
            let content;
            if (typeof m.content === "string") {
              content = m.content.slice(0, 400);
            } else if (Array.isArray(m.content)) {
              const text = m.content.filter(p => p.type === "text").map(p => p.text || "").join(" ");
              content = text ? text.slice(0, 400) : "[image/multi-part]";
            } else {
              content = null;
            }
            // Capture actual tool calls made by the assistant
            const toolCalls = Array.isArray(m.tool_calls)
              ? m.tool_calls.map(tc => ({
                  name: tc.function?.name ?? "",
                  args: (tc.function?.arguments ?? "").slice(0, 120)
                }))
              : null;
            return {
              role: m.role,
              content,
              ...(toolCalls?.length ? { toolCalls } : {})
            };
          })
      }
    });
  }
});

app.use("/api", auth, orchestrationRouter);

app.use("/v1", modelsRouter);
app.use("/v1", localModelsRouter);
app.use("/v1", hubRouter);
app.use("/v1", systemRouter);

// ---------------------------------------------------------------------------
// Periodic health polling
// ---------------------------------------------------------------------------

const HEALTH_POLL_INTERVAL_MS = 30_000;
const HEALTH_POLL_TIMEOUT_MS = 8_000;

async function pollInstanceHealth() {
  const targets = state.instances.filter(
    (x) => x.state !== "stopped" && x.state !== "starting" && x.state !== "switching_model"
  );
  let dirty = false;
  for (const inst of targets) {
    const url = `${instanceBaseUrl(inst)}/health`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_POLL_TIMEOUT_MS);
    try {
      const resp = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (resp.ok) {
        inst.lastHealthOkAt = now();
        if (inst.state === "unhealthy") {
          inst.state = "ready";
          inst.lastError = null;
          inst.updatedAt = now();
          dirty = true;
          audit("instance.health.recovered", { instanceId: inst.id });
        }
      } else {
        clearTimeout(timer);
        if (inst.state !== "unhealthy") {
          inst.state = "unhealthy";
          inst.lastError = `Health check returned HTTP ${resp.status}`;
          inst.updatedAt = now();
          dirty = true;
          audit("instance.health.fail", { instanceId: inst.id, status: resp.status });
        }
      }
    } catch (err) {
      clearTimeout(timer);
      if (inst.state !== "unhealthy" && inst.state !== "stopped") {
        inst.state = "unhealthy";
        inst.lastError = `Health check failed: ${String(err.message || err).slice(0, 200)}`;
        inst.updatedAt = now();
        dirty = true;
        audit("instance.health.fail", { instanceId: inst.id, error: inst.lastError });
      }
    }
  }
  if (dirty) {
    saveState(state);
  }
}

setInterval(() => { void pollInstanceHealth(); }, HEALTH_POLL_INTERVAL_MS);

// ── llama.cpp update check ─────────────────────────────────────────────────
// Fetch the latest llama.cpp release from GitHub once at startup. Result is
// cached in-process and served through /v1/system/info so the frontend can
// show a badge when the installed build is behind.
export let llamaCppLatest = null; // { latestBuild, latestTag, checkedAt }

async function checkLlamaCppUpdate() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(
      "https://api.github.com/repos/ggml-org/llama.cpp/releases/latest",
      { headers: { "User-Agent": "llamafleet-update-check" }, signal: controller.signal }
    );
    clearTimeout(timer);
    if (!res.ok) return;
    const data = await res.json();
    const tag = data.tag_name || "";
    const buildMatch = tag.match(/^b(\d+)$/);
    llamaCppLatest = {
      latestBuild: buildMatch ? Number(buildMatch[1]) : null,
      latestTag: tag,
      checkedAt: new Date().toISOString()
    };
  } catch { /* not critical — leave null */ }
}

// Sweep expired auth sessions hourly. Without this, sessions accumulated up to
// the slice(-1000) cap and stayed valid until pushed off by new logins.
const SESSION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
setInterval(() => {
  const before = state.sessions.length;
  cleanupSessions();
  if (state.sessions.length !== before) saveState(state);
}, SESSION_CLEANUP_INTERVAL_MS);
// Run once at startup so stale sessions from previous runs are dropped.
cleanupSessions();

restorePartialDownloads();
void checkLlamaCppUpdate();

app.listen(port, () => {
  console.log(`lmlaunch api+web listening on ${port}`);
});
