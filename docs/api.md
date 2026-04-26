# LlamaFleet API Reference

All endpoints require `Authorization: Bearer <token>` when auth is enabled. **[admin]** endpoints require the server API token specifically.

---

## Auth

### POST /auth/login

Exchange username + password for a session token (only when user auth is enabled).

```json
{ "username": "alice", "password": "..." }
```

Response: `{ "token": "...", "tokenType": "Bearer", "expiresAt": "...", "username": "alice" }`

### POST /auth/logout

Invalidate the current Bearer session token.

---

## Instances

### GET /v1/instances

List all instances with state, runtime info, and live GPU telemetry.

Response: `{ "data": [...], "gpus": [...] }`

### POST /v1/instances/start

Launch a new instance. `name`, `model`, and `port` are required. `gpus` is required for non-CPU backends.

```json
{
  "name": "my-instance",
  "model": "/path/to/model.gguf",
  "port": 1234,
  "gpus": ["0", "1"],
  "runtimeBackend": "cuda_full",
  "runtimeArgs": ["--flash-attn", "on", "-c", "8192"],
  "contextLength": 8192,
  "instanceId": "my-id",
  "host": "127.0.0.1",
  "maxInflightRequests": 4,
  "queueLimit": 64,
  "modelTtlSeconds": 300,
  "modelParallel": 2,
  "restartPolicy": { "mode": "on-failure", "maxRetries": 2, "backoffMs": 3000 }
}
```

`runtimeBackend`: `"auto"` | `"cuda_full"` | `"cpu"` (default `"auto"`)

### POST /v1/instances/:id/stop

Gracefully stop an instance.

### POST /v1/instances/:id/kill

Force-kill an instance immediately.

Body: `{ "reason": "optional string" }`

### DELETE /v1/instances/:id

Stop (if running) and remove an instance from state.

### POST /v1/instances/:id/drain

Pause or resume request intake.

Body: `{ "enabled": true }`

### POST /v1/instances/:id/model

Hot-swap the model on a running instance.

```json
{
  "model": "/path/to/new-model.gguf",
  "applyMode": "next_restart"
}
```

`applyMode`: `"next_restart"` (default) | `"restart_now"`

### GET /v1/instances/:id/logs

Tail instance logs. Query: `?lines=200`

### GET /v1/instances/:id/connection

Returns copy-ready direct and proxied URLs plus current model fields for an instance.

### GET /v1/instances/:id/proxy/v1/...

OpenAI-compatible reverse proxy to the instance. Errors are returned as `{ "error": { "message", "type", "param", "code" } }`.

```bash
curl http://localhost:8081/v1/instances/my-instance/proxy/v1/chat/completions \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"model":"...", "messages":[{"role":"user","content":"Hello"}]}'
```

---

## Model-Name Routing

### GET /v1/models

List all running (non-draining) instances as OpenAI-compatible model objects. Each `id` is the model filename stem (e.g. `Qwen2.5-7B-Q4_K_M`). Extra fields: `instance_id`, `profile_name`, `effective_model`.

### POST /v1/chat/completions

OpenAI-compatible chat completions routed by model name. The `model` field is matched against each running instance's filename stem, full basename, full path, or profile name — in that order. Returns `404` if no match, `409` if ambiguous.

```bash
curl http://localhost:8081/v1/chat/completions \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"model":"Qwen2.5-7B-Q4_K_M", "messages":[{"role":"user","content":"Hello"}]}'
```

### POST /v1/completions

OpenAI-compatible text completions routed by model name. Same routing rules as `/v1/chat/completions`.

---

## Manifest

### GET /v1/manifest/ready

Returns all *ready* (non-draining) instances with routing policy and capacity fields. Designed for load-balancer or agent use.

---

## Profiles

### GET /v1/profiles

List saved launch profiles.

Response: `{ "data": [...] }`

### POST /v1/profiles

Create a launch profile. Body mirrors the instance start schema; `name` is required.

### DELETE /v1/profiles/:id

Delete a saved profile.

---

## Config Library

### GET /v1/instance-configs

List all saved configs.

Response: `{ "data": [...] }`

### GET /v1/instance-configs/:id

Get a single saved config by ID.

### POST /v1/instance-configs/save-current

Save current running instances as a named config.

Body: `{ "name": "My Config", "id": "optional-id" }`

### POST /v1/instance-configs/:id/load

Launch all instances from a saved config.

### GET /v1/instance-configs/current/export.yaml

Export the current running instances as YAML (not saved to library).

### GET /v1/instance-configs/:id/export.yaml

Download a saved config as YAML.

### POST /v1/instance-configs/import.yaml

Import a config from YAML. Body: YAML text, `Content-Type: application/yaml`

### DELETE /v1/instance-configs/:id

Delete a saved config.

---

## System

### GET /v1/gpus

List detected GPUs with VRAM usage via bridge.

### GET /v1/local-models

List GGUF model files on the host. Scans configured dirs plus Ollama, HuggingFace, and Unsloth model directories.

Response: `{ "data": [{ "id", "name", "shards" }], "dir" }`

### GET /v1/audit

Retrieve the audit log.

Response: `{ "data": [...] }`

### GET /health

Health check. No auth required.

Response: `{ "status": "ok", "service": "api", "at": "..." }`

### GET /metrics

Prometheus scrape endpoint (auth-gated). Emits per-instance and per-GPU metrics.

**Per-instance labels:** `instance_id`, `profile_name`, `model`

| Metric | Description |
|--------|-------------|
| `llamafleet_instance_up` | 1 if instance is running |
| `llamafleet_instance_healthy` | 1 if last health check passed |
| `llamafleet_instance_inflight_requests` | Current in-flight request count |
| `llamafleet_instance_queue_depth` | Current queue depth |
| `llamafleet_instance_completed_requests_total` | Total completed requests |
| `llamafleet_instance_prompt_tokens_total` | Total prompt tokens processed |
| `llamafleet_instance_completion_tokens_total` | Total completion tokens generated |

**Per-GPU labels:** `gpu_index`

| Metric | Description |
|--------|-------------|
| `llamafleet_gpu_memory_used_mib` | VRAM used (MiB) |
| `llamafleet_gpu_memory_total_mib` | VRAM total (MiB) |
| `llamafleet_gpu_utilization_percent` | GPU utilisation % |
| `llamafleet_gpu_temperature_celsius` | GPU temperature (°C) |

Content-Type: `text/plain; version=0.0.4; charset=utf-8`

---

## Agent Interface

### GET /v1/agent/capabilities

Describe available agent actions and their input/output schemas.

### POST /v1/agent/action

Execute a named agent action.

Body: `{ "action": "instances.start", "input": { ... } }`

Available actions: `manifest.ready`, `profiles.list`, `instances.list`, `instances.start`, `instances.stop`, `instances.kill`, `instances.drain`, `instances.switchModel`, `instances.logs`, `instances.connection`

---

## Admin

### GET /v1/settings/security **[admin]**

Get current security settings (auth, TLS, API key policy).

### PUT /v1/settings/security **[admin]**

Update security settings.

### GET /v1/users **[admin]**

List local users.

### POST /v1/users **[admin]**

Create a local user.

Body: `{ "username": "alice", "password": "..." }`

### DELETE /v1/users/:username **[admin]**

Delete a local user.

### GET /v1/config/export.yaml **[admin]**

Export the full server config (security settings, profiles) as YAML.

### POST /v1/config/import.yaml **[admin]**

Import full server config from YAML. Supports `?dryRun=true`.

### GET /v1/config/status **[admin]**

Config sync status — current hash and last import timestamps.

### GET /v1/system/gpus **[admin]**

GPU list via bridge (admin-gated variant of `/v1/gpus`).

### POST /v1/system/close **[admin]**

Graceful shutdown.

Body: `{ "unloadModels": true, "stopDaemon": true }`
