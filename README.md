# LlamaFleet

**Run multiple llama.cpp instances in parallel, each pinned to its own GPUs, from one browser dashboard.**

LlamaFleet is a lightweight Node.js control plane and operator dashboard for multi-instance llama.cpp deployments. It lets you partition a multi-GPU machine — assigning specific GPUs to specific models — and manage the full lifecycle of each instance (launch, reload, drain, restart, remove) from a single browser UI without touching a terminal.

Each instance runs as an independent `llama-server` process on its own port, with its own context window, queue limit, TTL, and GPU subset. LlamaFleet tracks state, catches crashes, and auto-restarts instances with configurable backoff.

Every instance is accessible through a single **OpenAI-compatible API** at `http://host:8081/v1/instances/<id>/proxy/v1/...` — same bearer token, same `/v1/chat/completions` and `/v1/completions` endpoints. Point any OpenAI-compatible client at a specific instance proxy URL and it just works, with no extra ports to expose or firewall rules to manage.

**Key capabilities:**
- Per-instance GPU pinning via `CUDA_VISIBLE_DEVICES` and equivalent env vars for AMD/Intel/Metal
- Headless runtime process management (start, stop, drain, kill, remove)
- **OpenAI-compatible proxy per instance** — all `llama-server` processes bind to `127.0.0.1`; external clients reach each model through `http://host:8081/v1/instances/<id>/proxy/v1/...`, one port for everything
- Global API key enforcement — a single bearer token gates both the control-plane API and all proxy traffic; disable for open-access internal setups
- GPU bleed detection via pre/post memory snapshots
- Auto-restart with backoff on unclean exits
- Config profiles — save a model + GPU + context + TTL combination and relaunch in one click
- Token-authenticated API and bridge layers for deployment behind a reverse proxy

LlamaFleet uses GGUF models via llama.cpp's `llama-server` directly (no LM Studio required), so it works on NVIDIA (including older pre-Ampere cards), AMD, Apple Silicon, and CPU — no CUDA toolkit required.

## Dashboard

![LlamaFleet dashboard](docs/llamafleet-dashboard.png)

## Background

This started as a practical fix. Running a fleet of V100s with LM Studio: VRAM was bleeding between GPUs after a few model swaps, the process would eventually crash under sustained load, and there was no way to pin a model to specific cards or isolate instances from each other. There was no existing tool — GUI or headless — that managed independent `llama-server` processes per GPU subset from a single control plane. So this is that tool.

The GPU isolation problem is particularly acute for pre-Ampere hardware. vLLM and SGLang require CUDA 11+ with Ampere-class features for reliable inference; older V100s and GTX 10/20 series cards either hit capability gaps or produce incorrect results. llama.cpp has strong support for this hardware generation, but running multiple instances of it by hand — with correct `CUDA_VISIBLE_DEVICES` per process, log management, readiness polling, and crash recovery — is operationally tedious. LlamaFleet wraps all of that.

---

## Why LlamaFleet Instead of the Alternatives

### vs. LM Studio multi-instance (GUI)

LM Studio's GUI is designed around a single interactive session. You can load multiple models but they share one server port and one GPU assignment strategy — you cannot pin specific GPUs per instance, enforce per-instance queue limits, or automate restarts. LlamaFleet runs fully headless `llama-server` processes, assigns exact GPUs to each instance, and exposes a unified API so an external router can treat the fleet as a pool.

### vs. vLLM

vLLM is excellent for high-throughput serving of a single model on a single node. It does not support running dissimilar models concurrently on different GPU subsets from one control plane, has no built-in multi-instance orchestration UI, and requires Python + CUDA with matching driver versions. vLLM also has limited or no support for older NVIDIA GPUs (pre-Ampere cards like V100, GTX 10/20 series often hit capability gaps or produce incorrect results), and its quantization support is narrower — GGUF and many GGUF-based quant formats (IQ2, IQ3, Q4_K_S, etc.) are not natively supported. LlamaFleet spawns `llama-server` processes directly, so it runs on any hardware llama.cpp supports (NVIDIA including older cards, AMD, Apple Silicon, CPU) without a CUDA toolkit dependency and with the full range of GGUF quantization formats.

### vs. multiple llama.cpp processes

Running `llama-server` manually on different ports works, but you have to manage process lifecycle, log tailing, GPU pinning, and health checks yourself. LlamaFleet wraps all of that: it enforces `CUDA_VISIBLE_DEVICES` and seven other device-visibility env vars per instance, runs pre/post memory snapshots to catch GPU bleed, monitors readiness, and can auto-restart crashed instances with configurable backoff — all from a browser UI.

### vs. SGLang

SGLang (from the LMSYS group) is a high-performance serving framework targeting large-scale production — RadixAttention prefix caching, prefill-decode disaggregation, speculative decoding, tensor/pipeline/expert parallelism. It runs on 400k+ GPUs in production and is arguably the best choice for maximizing throughput on a single very large model. Like vLLM, it requires CUDA, does not support GGUF, and is designed around a single model per deployment rather than a multi-model fleet on consumer or prosumer hardware. If you have a rack of H100s and want to serve one Llama 70B as fast as possible, SGLang is worth evaluating. If you have 4–8 consumer or data center GPUs and want different models running concurrently with minimal operational overhead, LlamaFleet is a better fit.

### vs. GPUStack

[GPUStack](https://github.com/gpustack/gpustack) is the closest conceptual peer — a Python-based GPU cluster manager that orchestrates vLLM and SGLang across multiple hosts. If you already run vLLM or SGLang and want cluster-level scheduling with a web UI, GPUStack is worth looking at. The key differences: GPUStack inherits vLLM/SGLang's hardware and quantization constraints (no GGUF, requires CUDA); it's oriented toward multi-host clusters rather than single-host GPU partitioning; and it's significantly heavier to deploy. LlamaFleet is a single-host tool that spawns `llama-server` processes directly, trades cluster-scale for zero-CUDA simplicity and GGUF support.

### vs. Ollama

Ollama serializes requests to one model at a time per runtime and is optimized for single-user local use. It has no concept of pinning a model to a specific GPU subset, no queue depth control, and no multi-instance fleet view. LlamaFleet is designed specifically for the case where you have multiple GPUs and want different models running concurrently on different GPU subsets with independent ports, context windows, and TTLs.

### When LlamaFleet makes sense

- You have 4–8 GPUs and want each instance isolated to specific cards
- You want to run different models in parallel (e.g. a coding model and a chat model) without them competing for VRAM
- You need a lightweight operator dashboard without deploying Kubernetes or Ray Serve
- You want named config profiles you can load/save to reproduce a multi-instance setup
- You need auto-restart with backoff for long-running unattended inference workloads

---

## Known Limitations and Roadmap Considerations

Things that are currently out of scope or worth being aware of before adopting:

- **Single-host only** — LlamaFleet manages instances on one machine. A bridge-router component exists for multi-host deployments (see `apps/bridge-router`) but multi-host is not the primary target.
- **No Prometheus/metrics endpoint** — Per-instance token throughput, queue depth, and latency metrics are not yet exposed. This is a common ask in the llama.cpp and serving community; a `/metrics` endpoint is a natural addition.
- **`llama-server` binary required** — The host must have a `llama-server` binary on the path (or configured via `LLAMA_SERVER_BIN`). LlamaFleet does not bundle or build it. Get a binary from the [llama.cpp releases page](https://github.com/ggerganov/llama.cpp/releases) or build from source with `cmake -DGGML_CUDA=on`.
- **No model download management** — LlamaFleet does not download or manage model files. Models must be present on the host filesystem and reachable via the path entered in the launch form.
- **No authentication per-instance** — Individual instances bind to `127.0.0.1` and are accessed exclusively through the LlamaFleet proxy at `/v1/instances/<id>/proxy/v1/...`. Auth is enforced by the global `API_AUTH_TOKEN` bearer token at the proxy layer. There is no per-instance key.
- **No speculative decoding or prefix caching** — LlamaFleet passes arguments through to `llama-server` verbatim. Advanced inference features like speculative decoding or RadixAttention-style prefix caching are outside the scope of this tool; pass the relevant `llama-server` flags via `runtimeArgs` if the binary supports them.

## Planned / TODO

Roughly prioritized:

- [ ] **Model-name routing at the top-level API** — a single `/v1/chat/completions` endpoint at the root that reads the `model` field from the request body and routes to the running instance serving that model. Set `base_url = http://host:8081/v1` once and use model names directly — no per-instance proxy URLs needed by clients.
- [ ] **Ongoing health monitoring for live instances** — readiness polling currently runs only at startup. A periodic lightweight `GET /health` tick on running instances would detect hangs mid-run and trigger auto-restart without waiting for a process exit.
- [ ] **Hung request detection and recovery** — if a request to a backend takes longer than a configurable timeout and never resolves, detect the hung process, kill and restart it, and surface an error to the waiting client rather than blocking indefinitely.
- [ ] **Per-instance llama.cpp binary selection** — allow each instance to specify its own `llama-server` binary path. Enables running different llama.cpp forks or custom builds side by side (e.g. comparing upstream vs. a fork with experimental CUDA kernels, or serving a build compiled specifically for a particular GPU architecture) without system-wide changes.
- [ ] **Multi-host support** — extend the bridge concept to remote hosts so a single LlamaFleet API can manage instances across multiple machines. Natural next step for GPU clusters that exceed one box.
- [ ] **NUMA-aware instance pinning** — on multi-socket systems, allow per-instance CPU and memory affinity (for example `numactl`/cpuset style controls) so each instance can stay local to the CPU node nearest its assigned GPU(s).
- [ ] **Runtime diagnostics and fallback matrix** — investigate why Vulkan runtime is unavailable on Linux hosts, why alternative CUDA llama.cpp runtime builds cannot currently be selected, and harden proxy/runtime failure handling when specific backends fail model startup or inference.
- [ ] **Prometheus `/metrics` endpoint** — expose per-instance token throughput, queue depth, latency p50/p95, and GPU memory as a Prometheus scrape target. Useful for Grafana dashboards and alerting on unhealthy instances.
- [ ] **Reverse proxy / load balancer manifest** — emit a ready-made nginx/Caddy/Traefik config or a simple built-in round-robin proxy across healthy instances of the same model, so clients can hit one endpoint and LlamaFleet routes the request.
- [ ] **Startup timeout and smoke check config** — currently readiness polling is fixed; expose timeout, retry interval, and expected response schema as per-instance options.
- [ ] **TLS/SSL termination** — add native HTTPS support to the API service so LlamaFleet can terminate TLS directly without requiring a reverse proxy in front. Includes cert/key file config via env vars and optional mTLS for bridge-to-API authentication. Useful for deployments where adding nginx or Caddy is undesirable.
- [ ] **Save as default template** — let users mark a launch configuration as the default so the form pre-fills on reload.
- [ ] **llama.cpp build tooling** — the current bundled `llama-server` binary (`b760272`) shows a ~5% throughput gap vs. LM Studio's binary on V100 hardware. Investigate and document a reproducible build process for the latest llama.cpp (`cmake -DGGML_CUDA=on -DCMAKE_CUDA_ARCHITECTURES="70;86"`), benchmark against LM Studio, and consider packaging a prebuilt binary or build script in `scripts/` so fresh deployments don't rely on whatever version happens to be installed.

## Built-in Proxy

Each `llama-server` instance launched by LlamaFleet binds to `127.0.0.1` on its assigned port — it is never directly exposed to the network. Instead, the API serves a built-in OpenAI-compatible reverse proxy for every instance:

```
http://<host>:8081/v1/instances/<id>/proxy/v1/chat/completions
http://<host>:8081/v1/instances/<id>/proxy/v1/models
http://<host>:8081/v1/instances/<id>/proxy/v1/...
```

**This is the only URL you need to give to clients.** The proxy:

- **Enforces global auth** — if `API_AUTH_TOKEN` is set and "Require API Key" is enabled (configurable from the dashboard topbar), every proxied request must carry `Authorization: Bearer <token>`. Toggle it to "Open" for local/trusted-network use without a key.
- **Passes through transparently** — JSON, binary, multipart file uploads, streaming responses, arbitrary query strings, and all request headers are forwarded verbatim. The proxy does not re-encode or buffer bodies; non-JSON content-types are forwarded as raw streams.
- **Tracks activity** — the dashboard shows a live token counter and "Active" state chip updated from the `usage` field of completed responses.
- **Single port** — expose only port `8081` on your firewall/reverse proxy. No per-instance port management required.

The proxy base URL for each instance is shown in the dashboard under the instance row's "Options" menu ("Proxy Base URL" and "Proxy Chat URL" copy buttons).

---

## Architecture

LlamaFleet is two core Node.js services (plus an optional bridge router for multi-host setups):

- **API + dashboard** (`apps/api`, port `8081`) — serves the browser dashboard and REST API. Owns all state persistence (`state.json`) and config profiles. Forwards instance lifecycle commands to the bridge. Authenticates inbound requests via `API_AUTH_TOKEN`.
- **Host bridge** (`apps/host-bridge`, port `8090`) — runs natively on the host and spawns `llama-server` child processes directly, one per instance. Sets `CUDA_VISIBLE_DEVICES` and six other device-visibility env vars per instance to enforce GPU pinning. Reads GPU state via `nvidia-smi` and polls instance readiness. Authenticates requests from the API via `BRIDGE_AUTH_TOKEN`.
- **Bridge router** (`apps/bridge-router`, optional) — sits between the API and multiple host bridges. Useful when instances are spread across more than one physical machine. Configure via `BRIDGE_POOLS_JSON`.

The bridge must run natively on the host (it spawns processes). The API can run anywhere that can reach the bridge.

### systemd deployment (Ubuntu, no containers)

One systemd unit runs everything. Each instance gets a dedicated `llama-server` child process pinned to its assigned GPUs.

```bash
sudo bash scripts/install-ubuntu-systemd.sh
```

- Service unit: `deploy/systemd/llamafleet.service`
- Env template: `deploy/systemd/env/llamafleet.env.example` → `/etc/llamafleet/llamafleet.env`
- Full runbook: `deploy/systemd/README.md`

## Dependencies

Required:

- Node.js 18+
- `llama-server` binary on the host path, or path set via `LLAMA_SERVER_BIN`
  - Get a pre-built binary from the [llama.cpp releases page](https://github.com/ggerganov/llama.cpp/releases)
  - Or build from source: `cmake -B build -DGGML_CUDA=on && cmake --build build --target llama-server -j$(nproc)`

For GPU visibility in the dashboard:

- NVIDIA driver installed on host
- `nvidia-smi` on the host path

## Quick Start (Ubuntu — one line)

```bash
curl -fsSL https://github.com/boringresearchjames/llamafleet/releases/latest/download/install.sh | sudo bash
```

This downloads the latest release, installs the systemd service, and auto-detects your GPU (NVIDIA/AMD/Vulkan/CPU) to install a matching `llama-server` binary.

After install, edit `/etc/llamafleet/llamafleet.env` to set your tokens, then:

```bash
sudo systemctl restart llamafleet
```

Open **http://localhost:8081** — dashboard and API are both served from this port.

## Quick Start (Manual / Development)

1. Install dependencies (uses `--no-bin-links` to avoid symlink failures on network shares):

```bash
npm run install:deps
```

2. Start all services:

```bash
npm start
```

3. Open **http://localhost:8081** — dashboard and API are both served from this port.

## Development

Run all services with file-watch restarts:

```bash
npm run dev
```

Run individual services:

```bash
npm run start:bridge
npm run start:api
```

## Environment Variables

### Shared

| Variable | Default | Description |
|---|---|---|
| `API_AUTH_TOKEN` | *(unset)* | Bearer token for dashboard + API. When unset, auth is disabled. |
| `BRIDGE_AUTH_TOKEN` | *(unset)* | Internal API↔bridge token. When unset, bridge auth is disabled. |

### API (`apps/api`)

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8081` | API + dashboard listen port |
| `BRIDGE_URL` | `http://127.0.0.1:8090` | URL of the host bridge |
| `STATE_FILE` | `./data/state.json` | Persistent state path |
| `SHARED_CONFIG_FILE` | `./data/shared-config.yaml` | Shared config (profiles, security) |
| `MODELS_DIR` | `~/.lmstudio/models` | Primary directory scanned for `.gguf` files. Additional locations are auto-scanned automatically: `~/.ollama/models`, `~/.cache/huggingface/hub`, `~/unsloth_studio` |
| `LLAMAFLEET_PUBLIC_HOST` | *(unset)* | This machine's IP, used in proxy URLs shown in the dashboard |
| `CORS_ORIGIN` | `*` | Value of `Access-Control-Allow-Origin` |

### Bridge (`apps/host-bridge`)

| Variable | Default | Description |
|---|---|---|
| `BRIDGE_PORT` | `8090` | Bridge listen port |
| `LLAMA_SERVER_BIN` | `llama-server` | Path to the `llama-server` binary |
| `DATA_ROOT` | `./data` | Root directory for logs and instance metadata |
| `LOG_LINES_DEFAULT` | `200` | Default line count for log tail requests |
| `READINESS_POLL_MS` | `2000` | How often to poll instance `/health` during startup |
| `READINESS_HTTP_TIMEOUT_MS` | `5000` | Per-request timeout during readiness polling |
| `GPU_BLEED_MAX_DELTA_MIB` | `256` | Max allowed post-stop VRAM increase before flagging bleed |
| `SMOKE_CHECK_ENABLED` | `false` | Run a test inference after startup to verify the instance responds |
| `STRICT_SMOKE_CHECK` | `false` | Treat a failed smoke check as a fatal startup error |

## GPU Diagnostics

If GPU detection cannot run, `/v1/system/gpus` returns:

- `data: []`
- `warning`
- `diagnostics` with checks and remediation steps

This allows non-GPU dev machines to run cleanly while still giving actionable server diagnostics.

## License

MIT
