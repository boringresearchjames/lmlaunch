import express from "express";
import { state, saveState } from "../lib/state.js";
import { requireAdminToken } from "../lib/auth.js";
import { audit } from "../lib/audit.js";
import { now } from "../lib/utils.js";
import { bridgeFetch, localApi } from "../lib/bridge.js";

const router = express.Router();

// ── GPUs / host stats ────────────────────────────────────────────────────────

router.get("/gpus", async (_req, res) => {
  try {
    const result = await bridgeFetch("GET", "/v1/gpus");
    res.json(result);
  } catch (error) {
    res.status(502).json({ error: String(error.message || error) });
  }
});

router.get("/host-stats", async (_req, res) => {
  try {
    const result = await bridgeFetch("GET", "/v1/host-stats");
    res.json(result);
  } catch (error) {
    res.status(502).json({ error: String(error.message || error) });
  }
});

router.get("/system/info", async (_req, res) => {
  try {
    const result = await bridgeFetch("GET", "/v1/info");
    res.json(result);
  } catch {
    res.json({ platform: process.platform, arch: process.arch, llamaServerBin: null, llamaServerVersion: null });
  }
});

// ── Audit log ─────────────────────────────────────────────────────────────

router.get("/audit", requireAdminToken, (_req, res) => {
  res.json({ data: state.audit });
});

// ── Agent interface ──────────────────────────────────────────────────────────

router.get("/agent/capabilities", (_req, res) => {
  res.json({
    version: "1.0",
    name: "lmlaunch-agent-interface",
    actions: [
      { name: "manifest.ready", input: {}, output: "ready manifest with routing policy and capacity fields" },
      { name: "profiles.list", input: {}, output: "list of profiles" },
      { name: "instances.list", input: {}, output: "list of instance state" },
      { name: "instances.start", input: { profileId: "string", instanceId: "string (optional)" }, output: "started instance payload" },
      { name: "instances.stop", input: { instanceId: "string" }, output: "operation status" },
      { name: "instances.kill", input: { instanceId: "string", reason: "string (optional)" }, output: "operation status" },
      { name: "instances.drain", input: { instanceId: "string", enabled: "boolean" }, output: "operation status" },
      { name: "instances.switchModel", input: { instanceId: "string", model: "string", applyMode: "next_restart | restart_now" }, output: "updated instance" },
      { name: "instances.logs", input: { instanceId: "string", lines: "number (optional)" }, output: "log text" },
      { name: "instances.connection", input: { instanceId: "string" }, output: "copy-ready URLs and model fields" }
    ]
  });
});

router.post("/agent/action", async (req, res) => {
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
        return res.status(400).json({ success: false, error: "unknown action", action });
    }
  } catch (error) {
    return res.status(500).json({ success: false, action, error: String(error.message || error) });
  }
});

// ── System ───────────────────────────────────────────────────────────────────

router.get("/system/gpus", requireAdminToken, async (req, res) => {
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

router.post("/system/close", requireAdminToken, async (req, res) => {
  const unloadModels = req.body?.unloadModels !== false;
  const stopDaemon = req.body?.stopDaemon !== false;

  try {
    const data = await bridgeFetch("POST", "/v1/system/close", { unloadModels, stopDaemon });

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

export default router;
