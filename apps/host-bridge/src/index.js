import express from "express";
import { spawn, execFile } from "child_process";
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
const smokeCheckEnabled = process.env.SMOKE_CHECK_ENABLED !== "false";

if (!bridgeAuthEnabled) {
  console.warn("Bridge auth disabled: BRIDGE_AUTH_TOKEN not set.");
}

const dataRoot = "/data";
const logsDir = path.join(dataRoot, "logs");
fs.mkdirSync(logsDir, { recursive: true });

const instances = new Map();

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

function resolveArgs(profile) {
  const args = Array.isArray(profile.runtime?.serverArgs)
    ? profile.runtime.serverArgs
    : ["server", "start", "--port", "{port}"];

  return args.map((arg) =>
    String(arg)
      .replaceAll("{port}", String(profile.port))
      .replaceAll("{model}", String(profile.model || ""))
      .replaceAll("{contextLength}", String(profile.contextLength || 8192))
  );
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

async function ensureDaemonUp(env) {
  return new Promise((resolve, reject) => {
    execFile("lms", ["daemon", "up"], { env }, (error, stdout, stderr) => {
      if (error) {
        return reject(new Error(`lms daemon up failed: ${stderr || stdout || error.message}`));
      }
      return resolve();
    });
  });
}

async function checkInstanceReady(profile) {
  const host = profile.host || "127.0.0.1";
  const baseUrl = `http://${host}:${profile.port}`;

  const modelsTimeout = withTimeout(readinessHttpTimeoutMs);
  const modelsResponse = await fetch(`${baseUrl}/v1/models`, { signal: modelsTimeout.signal });
  modelsTimeout.done();
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
    if (!smokeResponse.ok) {
      throw new Error(`smoke check failed (${smokeResponse.status})`);
    }
  }
}

async function monitorReadiness(instanceId, record) {
  const startedAt = Date.now();
  const timeoutMs = Number(record.profile?.startupTimeoutMs || 180000);

  while (Date.now() - startedAt < timeoutMs) {
    if (!instances.has(instanceId) || record.state === "stopped") {
      return;
    }

    try {
      await checkInstanceReady(record.profile);
      record.lastHealthOkAt = new Date().toISOString();
      record.lastError = null;
      record.state = record.drain ? "draining" : "ready";
      writeLog(instanceId, "meta", "readiness check passed\n");
      return;
    } catch (error) {
      record.lastError = String(error.message || error);
      record.state = "warming";
      await sleep(readinessPollMs);
    }
  }

  record.state = "unhealthy";
  writeLog(instanceId, "meta", `readiness timeout after ${timeoutMs}ms\n`);
}

function tail(filePath, lines) {
  if (!fs.existsSync(filePath)) return "";
  const content = fs.readFileSync(filePath, "utf8");
  const rows = content.split("\n");
  return rows.slice(-lines).join("\n");
}

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "bridge", at: new Date().toISOString() });
});

app.use("/v1", auth);

app.get("/v1/gpus", (_req, res) => {
  execFile(
    "/usr/bin/nvidia-smi",
    [
      "--query-gpu=index,name,memory.total,memory.used,utilization.gpu",
      "--format=csv,noheader,nounits"
    ],
    (error, stdout) => {
      if (error) {
        return res.status(500).json({ error: "nvidia-smi unavailable", detail: error.message });
      }

      const data = stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [index, name, total, used, util] = line.split(",").map((x) => x.trim());
          return {
            id: index,
            name,
            memory_total_mib: Number(total),
            memory_used_mib: Number(used),
            utilization_percent: Number(util)
          };
        });

      return res.json({ data });
    }
  );
});

app.get("/v1/models", async (req, res) => {
  const host = String(req.query.host || "127.0.0.1");
  const port = Number(req.query.port || 1234);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return res.status(400).json({ error: "invalid port" });
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
  if (running?.process && !running.process.killed) {
    return res.status(409).json({ error: "instance already running" });
  }

  const command = "lms";
  const args = resolveArgs(profile);
  const env = {
    ...process.env,
    CUDA_VISIBLE_DEVICES: Array.isArray(profile.gpus) ? profile.gpus.join(",") : ""
  };

  try {
    await ensureDaemonUp(env);
  } catch (error) {
    return res.status(500).json({ error: String(error.message || error) });
  }

  const child = spawn(command, args, { env, detached: false });

  const record = {
    profile,
    process: child,
    state: "starting",
    inflightRequests: 0,
    queueDepth: 0,
    drain: false,
    lastHealthOkAt: null,
    lastError: null
  };

  instances.set(instanceId, record);
  writeLog(instanceId, "meta", `launch command=${command} args=${JSON.stringify(args)}\n`);

  child.stdout.on("data", (chunk) => writeLog(instanceId, "stdout", `${chunk}`));
  child.stderr.on("data", (chunk) => writeLog(instanceId, "stderr", `${chunk}`));
  child.on("error", (error) => {
    record.state = "unhealthy";
    record.lastError = String(error.message || error);
    writeLog(instanceId, "meta", `spawn error=${record.lastError}\n`);
  });
  child.on("spawn", () => {
    record.state = "warming";
  });
  child.on("exit", (code, signal) => {
    record.state = "stopped";
    record.lastError = code === 0 ? null : `exit code=${String(code)} signal=${String(signal)}`;
    writeLog(instanceId, "meta", `exit code=${String(code)} signal=${String(signal)}\n`);
  });

  void monitorReadiness(instanceId, record);

  res.status(201).json({
    success: true,
    instanceId,
    pid: child.pid,
    state: record.state
  });
});

app.post("/v1/instances/:id/stop", (req, res) => {
  if (!isValidInstanceId(req.params.id)) return res.status(400).json({ error: "invalid instance id" });
  const record = instances.get(req.params.id);
  if (!record?.process) return res.status(404).json({ error: "instance not found" });

  record.state = "draining";
  record.process.kill("SIGTERM");
  res.json({ success: true });
});

app.post("/v1/instances/:id/kill", (req, res) => {
  if (!isValidInstanceId(req.params.id)) return res.status(400).json({ error: "invalid instance id" });
  const record = instances.get(req.params.id);
  if (!record?.process) return res.status(404).json({ error: "instance not found" });

  record.process.kill("SIGKILL");
  record.state = "stopped";
  res.json({ success: true });
});

app.post("/v1/instances/:id/drain", (req, res) => {
  if (!isValidInstanceId(req.params.id)) return res.status(400).json({ error: "invalid instance id" });
  const record = instances.get(req.params.id);
  if (!record) return res.status(404).json({ error: "instance not found" });

  const enabled = Boolean(req.body?.enabled);
  record.drain = enabled;
  record.state = enabled ? "draining" : "ready";
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

app.listen(port, () => {
  console.log(`lmlaunch bridge listening on ${port}`);
});
