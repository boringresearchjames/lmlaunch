# LM Launch

LM Launch is a Node.js control plane and dashboard for running multiple headless LM Studio instances in parallel on a single host.

This repo runs as a host-native Node deployment.

## Dashboard

![LM Launch dashboard](docs/lmlaunch-dashboard.png)

## Why LM Launch Instead of the Alternatives

### vs. LM Studio multi-instance (GUI)

LM Studio's GUI is designed around a single interactive session. You can load multiple models but they share one server port and one GPU assignment strategy — you cannot pin specific GPUs per instance, enforce per-instance queue limits, or automate restarts. LM Launch runs fully headless, lets you assign exact GPUs to each instance, and exposes a unified API so an external router can treat the fleet as a pool.

### vs. vLLM

vLLM is excellent for high-throughput serving of a single model on a single node. It does not support running dissimilar models concurrently on different GPU subsets from one control plane, has no built-in multi-instance orchestration UI, and requires Python + CUDA with matching driver versions. LM Launch uses GGUF models via LM Studio's llama.cpp backend, so it runs on any hardware LM Studio supports (NVIDIA, AMD, Apple Silicon, CPU) without a CUDA toolkit dependency.

### vs. multiple llama.cpp processes

Running `llama-server` manually on different ports works, but you have to manage process lifecycle, log tailing, GPU pinning, and health checks yourself. LM Launch wraps all of that: it enforces `CUDA_VISIBLE_DEVICES` and seven other device-visibility env vars per instance, runs pre/post memory snapshots to catch GPU bleed, monitors readiness, and can auto-restart crashed instances with configurable backoff — all from a browser UI.

### vs. Ollama

Ollama serializes requests to one model at a time per runtime and is optimized for single-user local use. It has no concept of pinning a model to a specific GPU subset, no queue depth control, and no multi-instance fleet view. LM Launch is designed specifically for the case where you have multiple GPUs and want different models running concurrently on different GPU subsets with independent ports, context windows, and TTLs.

### When LM Launch makes sense

- You have 4–8 GPUs and want each instance isolated to specific cards
- You want to run different models in parallel (e.g. a coding model and a chat model) without them competing for VRAM
- You need a lightweight operator dashboard without deploying Kubernetes or Ray Serve
- You want named config profiles you can load/save to reproduce a multi-instance setup
- You need auto-restart with backoff for long-running unattended inference workloads

---

## What It Does

- Manage runtime profiles (host, port, GPU selection, bind host, context window)
- Launch/stop/kill/drain LM Studio instances
- Select model per launched instance with optional TTL and parallel slots
- Queue limit and max parallel inference requests per instance
- Auto-restart on failure with configurable retries and exponential backoff
- Expose ready-only manifest for external routing
- Show logs and operator actions in a lightweight dashboard
- Discover models and GPUs through the host bridge
- Save/load named config profiles for repeatable multi-instance setups

## Architecture (Node Native)

1. API + dashboard service (`apps/api`) on port `8081`
2. Host bridge (`apps/host-bridge`) on port `8090`

## Dependencies

Required:

- Node.js 20+
- LM Studio CLI/runtime (`lms`) available on host

If you want GPU visibility in LM Launch:

- NVIDIA driver installed on host
- `nvidia-smi` available on host path

## Quick Start (Native)

1. Install dependencies:

```bash
npm run install:native
```

If running from an SMB/GVFS mount, this command already disables npm bin symlinks for compatibility.

2. Start all services:

```bash
npm run start:native
```

3. Open dashboard:

- http://localhost:8081

4. API endpoint:

- http://localhost:8081

## Development

Run all services with watch-enabled API and bridge:

```bash
npm run dev:native
```

Run individual services:

```bash
npm run start:bridge
npm run start:api
```

## Environment Variables

### Shared

- `API_AUTH_TOKEN` (optional; when unset, API auth is disabled)
- `BRIDGE_AUTH_TOKEN` (optional; when unset, bridge auth is disabled)

### API

- `PORT` (default `8081`)
- `BRIDGE_URL` (default `http://127.0.0.1:8090`)
- `STATE_FILE` (default `./data/state.json`)
- `SHARED_CONFIG_FILE` (default `./data/shared-config.yaml`)

### Bridge

- `BRIDGE_PORT` (default `8090`)
- `LOG_LINES_DEFAULT` (default `200`)
- `READINESS_POLL_MS` (default `2000`)
- `READINESS_HTTP_TIMEOUT_MS` (default `5000`)
- `SMOKE_CHECK_ENABLED` (`true` by default)

## LM Studio Notes

Expected host commands:

```bash
lms daemon up
lms server start --port 1234
```

LM Launch starts/stops instances through the bridge service and tracks readiness per instance.

## GPU Diagnostics

If GPU detection cannot run, `/v1/system/gpus` returns:

- `data: []`
- `warning`
- `diagnostics` with checks and remediation steps

This allows non-GPU dev machines to run cleanly while still giving actionable server diagnostics.

## API Help

- Dashboard Help button opens API `/help`
- `/help` redirects to this README by default

## License

MIT
