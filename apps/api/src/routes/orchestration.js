import express from "express";
import { state, saveState } from "../lib/state.js";
import { audit } from "../lib/audit.js";
import { now } from "../lib/utils.js";
import { getAllFrontierStats, getRouteHourlyBreakdown } from "../lib/frontier.js";
import { getOrchestrationLog, simulateRoute } from "../lib/orchestration.js";

const router = express.Router();

// ---------------------------------------------------------------------------
// Orchestration Routes
// ---------------------------------------------------------------------------

router.get("/orchestration-routes", (_req, res) => {
  const routes = (state.orchestrationRoutes || []).map((r) => ({
    ...r,
    _hourly: getRouteHourlyBreakdown(r.name)
  }));
  res.json({ data: routes });
});

router.post("/orchestration-routes", (req, res) => {
  const payload = req.body || {};
  if (!payload.name || typeof payload.name !== "string" || !payload.name.trim()) {
    return res.status(400).json({ error: "name is required" });
  }
  const name = payload.name.trim();

  // Prevent collision with existing real model names
  const existing = state.orchestrationRoutes.find((r) => r.id !== payload.id && r.name === name);
  if (existing) {
    return res.status(409).json({ error: `An orchestration route named "${name}" already exists` });
  }

  if (!payload.defaultBackend || typeof payload.defaultBackend !== "object") {
    return res.status(400).json({ error: "defaultBackend is required" });
  }

  const id = payload.id || `orch_${Date.now()}`;
  const route = {
    id,
    name,
    description: String(payload.description || ""),
    systemPromptSuffix: typeof payload.systemPromptSuffix === "string" ? payload.systemPromptSuffix : "",
    rules: Array.isArray(payload.rules) ? payload.rules : [],
    classifierRule: payload.classifierRule || null,
    defaultBackend: payload.defaultBackend,
    fallbackBackend: payload.fallbackBackend || null,
    createdAt: now(),
    updatedAt: now()
  };

  const idx = state.orchestrationRoutes.findIndex((r) => r.id === id);
  if (idx >= 0) {
    route.createdAt = state.orchestrationRoutes[idx].createdAt;
    state.orchestrationRoutes[idx] = route;
  } else {
    state.orchestrationRoutes.push(route);
  }

  saveState(state);
  audit("orchestration.route.upsert", { id: route.id, name: route.name });
  return res.status(201).json(route);
});

router.get("/orchestration-routes/:id", (req, res) => {
  const route = state.orchestrationRoutes.find((r) => r.id === req.params.id);
  if (!route) return res.status(404).json({ error: "Not found" });
  res.json({ ...route, _hourly: getRouteHourlyBreakdown(route.name) });
});

router.put("/orchestration-routes/:id", (req, res) => {
  const idx = state.orchestrationRoutes.findIndex((r) => r.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: "Not found" });

  const payload = req.body || {};
  const existing = state.orchestrationRoutes[idx];

  if (payload.name) {
    const collision = state.orchestrationRoutes.find((r) => r.id !== req.params.id && r.name === payload.name.trim());
    if (collision) return res.status(409).json({ error: `An orchestration route named "${payload.name.trim()}" already exists` });
  }

  const updated = {
    ...existing,
    name: payload.name ? payload.name.trim() : existing.name,
    description: payload.description !== undefined ? String(payload.description) : existing.description,
    systemPromptSuffix: payload.systemPromptSuffix !== undefined ? String(payload.systemPromptSuffix || "") : (existing.systemPromptSuffix || ""),
    rules: Array.isArray(payload.rules) ? payload.rules : existing.rules,
    classifierRule: payload.classifierRule !== undefined ? (payload.classifierRule || null) : existing.classifierRule,
    defaultBackend: payload.defaultBackend || existing.defaultBackend,
    fallbackBackend: payload.fallbackBackend !== undefined ? (payload.fallbackBackend || null) : existing.fallbackBackend,
    updatedAt: now()
  };

  state.orchestrationRoutes[idx] = updated;
  saveState(state);
  audit("orchestration.route.update", { id: updated.id, name: updated.name });
  return res.json(updated);
});

router.delete("/orchestration-routes/:id", (req, res) => {
  const route = state.orchestrationRoutes.find((r) => r.id === req.params.id);
  if (!route) return res.status(404).json({ error: "Not found" });
  state.orchestrationRoutes = state.orchestrationRoutes.filter((r) => r.id !== req.params.id);
  saveState(state);
  audit("orchestration.route.delete", { id: req.params.id, name: route.name });
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// Frontier Backends
// ---------------------------------------------------------------------------

function maskBackend(b) {
  const { apiKey: _omit, ...rest } = b;
  return { ...rest, apiKey: "••••" };
}

router.get("/frontier-backends", (_req, res) => {
  const stats = getAllFrontierStats();
  const data = (state.frontierBackends || []).map((b) => ({
    ...maskBackend(b),
    _stats: stats[b.id] || null
  }));
  res.json({ data });
});

router.post("/frontier-backends", (req, res) => {
  const payload = req.body || {};
  if (!payload.name || typeof payload.name !== "string" || !payload.name.trim()) {
    return res.status(400).json({ error: "name is required" });
  }
  if (!payload.baseUrl || typeof payload.baseUrl !== "string") {
    return res.status(400).json({ error: "baseUrl is required" });
  }
  if (!payload.model || typeof payload.model !== "string") {
    return res.status(400).json({ error: "model is required" });
  }

  const id = payload.id || `fb_${Date.now()}`;
  const backend = {
    id,
    name: payload.name.trim(),
    baseUrl: payload.baseUrl.trim(),
    model: payload.model.trim(),
    apiKey: typeof payload.apiKey === "string" ? payload.apiKey : "",
    headersTimeoutMs: payload.headersTimeoutMs ? Number(payload.headersTimeoutMs) : null,
    requestDefaults: payload.requestDefaults && typeof payload.requestDefaults === "object"
      ? payload.requestDefaults : null,
    extraHeaders: payload.extraHeaders && typeof payload.extraHeaders === "object"
      ? payload.extraHeaders : null,
    costPer1kInputTokens: payload.costPer1kInputTokens != null ? Number(payload.costPer1kInputTokens) : null,
    costPer1kOutputTokens: payload.costPer1kOutputTokens != null ? Number(payload.costPer1kOutputTokens) : null,
    createdAt: now(),
    updatedAt: now()
  };

  const idx = (state.frontierBackends || []).findIndex((b) => b.id === id);
  if (idx >= 0) {
    backend.createdAt = state.frontierBackends[idx].createdAt;
    // Preserve existing apiKey if not supplied in update
    if (!payload.apiKey && state.frontierBackends[idx].apiKey) {
      backend.apiKey = state.frontierBackends[idx].apiKey;
    }
    state.frontierBackends[idx] = backend;
  } else {
    state.frontierBackends.push(backend);
  }

  saveState(state);
  audit("orchestration.frontier.upsert", { id: backend.id, name: backend.name });
  return res.status(201).json(maskBackend(backend));
});

router.get("/frontier-backends/:id", (req, res) => {
  const backend = (state.frontierBackends || []).find((b) => b.id === req.params.id);
  if (!backend) return res.status(404).json({ error: "Not found" });
  const stats = getAllFrontierStats();
  res.json({ ...maskBackend(backend), _stats: stats[backend.id] || null });
});

router.put("/frontier-backends/:id", (req, res) => {
  const idx = (state.frontierBackends || []).findIndex((b) => b.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: "Not found" });

  const payload = req.body || {};
  const existing = state.frontierBackends[idx];

  const updated = {
    ...existing,
    name: payload.name ? payload.name.trim() : existing.name,
    baseUrl: payload.baseUrl ? payload.baseUrl.trim() : existing.baseUrl,
    model: payload.model ? payload.model.trim() : existing.model,
    // Only update apiKey if explicitly provided as a non-empty string
    apiKey: typeof payload.apiKey === "string" && payload.apiKey ? payload.apiKey : existing.apiKey,
    headersTimeoutMs: payload.headersTimeoutMs !== undefined ? (payload.headersTimeoutMs ? Number(payload.headersTimeoutMs) : null) : existing.headersTimeoutMs,
    requestDefaults: payload.requestDefaults !== undefined ? (payload.requestDefaults || null) : existing.requestDefaults,
    extraHeaders: payload.extraHeaders !== undefined ? (payload.extraHeaders || null) : existing.extraHeaders,
    costPer1kInputTokens: payload.costPer1kInputTokens !== undefined ? (payload.costPer1kInputTokens != null ? Number(payload.costPer1kInputTokens) : null) : existing.costPer1kInputTokens,
    costPer1kOutputTokens: payload.costPer1kOutputTokens !== undefined ? (payload.costPer1kOutputTokens != null ? Number(payload.costPer1kOutputTokens) : null) : existing.costPer1kOutputTokens,
    updatedAt: now()
  };

  state.frontierBackends[idx] = updated;
  saveState(state);
  audit("orchestration.frontier.update", { id: updated.id, name: updated.name });
  return res.json(maskBackend(updated));
});

router.delete("/frontier-backends/:id", (req, res) => {
  const backend = (state.frontierBackends || []).find((b) => b.id === req.params.id);
  if (!backend) return res.status(404).json({ error: "Not found" });
  state.frontierBackends = state.frontierBackends.filter((b) => b.id !== req.params.id);
  saveState(state);
  audit("orchestration.frontier.delete", { id: req.params.id, name: backend.name });
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// Routing Log
// ---------------------------------------------------------------------------

router.get("/orchestration-log", (_req, res) => {
  res.json({ data: getOrchestrationLog() });
});

// ---------------------------------------------------------------------------
// Simulate — dry-run rule evaluation for a given route
// ---------------------------------------------------------------------------

router.post("/orchestration-routes/:id/simulate", (req, res) => {
  const result = simulateRoute(req.params.id, req.body || {});
  if (!result) return res.status(404).json({ error: "Route not found" });
  res.json(result);
});

export default router;
