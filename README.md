# LlamaFleet

**Run multiple llama.cpp instances in parallel — GPU-accelerated, CPU-only, or any heterogeneous mix — from one browser dashboard.**

LlamaFleet is a lightweight Node.js control plane and operator dashboard for multi-instance llama.cpp deployments. It partitions a multi-GPU machine — assigning specific GPUs to specific models — and manages the full lifecycle of each instance (launch, reload, drain, restart, remove) from a single browser UI without touching a terminal.

Each instance runs as an independent `llama-server` process with its own context window, queue limit, TTL, and GPU subset. LlamaFleet tracks state, catches crashes, and auto-restarts instances with configurable backoff.

Every instance is reachable through a single **OpenAI-compatible API** at `http://host:8081/v1/instances/<id>/proxy/v1/...` — same bearer token, same `/v1/chat/completions` and `/v1/completions` endpoints. A top-level `/v1/chat/completions` endpoint routes by model name with **least-loaded routing** across instances sharing the same model — requests go to whichever instance has the fewest in-flight requests, with round-robin tiebreaking when all are equally idle. Set `base_url = http://host:8081/v1` once and LlamaFleet handles load distribution automatically.

**Key capabilities:**
- Per-instance GPU pinning via `CUDA_VISIBLE_DEVICES` and equivalents for AMD/Intel/Metal
- Headless process management — start, stop, drain, kill, remove from the browser or API
- OpenAI-compatible reverse proxy per instance — all `llama-server` processes bind to `127.0.0.1`; one port for everything
- **Named model routing with least-loaded pool support** — `POST /v1/chat/completions` with `"model": "MyModel"` routes to the instance with the lowest in-flight request fraction; ties are broken with round-robin. Append `-1`, `-2`, etc. to pin to a specific instance (e.g. `"model": "MyModel-1"`). `GET /v1/models` returns both the pool entry and each pinned alias so any OpenAI client can discover them automatically.
- **Heterogeneous compute pools** — combine GPU-accelerated (NVIDIA/AMD/Intel), CPU-only, and mixed-offload `llama-server` instances under a single model name. Load is distributed proportionally — a GPU instance with `maxInflightRequests=8` will absorb more traffic than a CPU fallback set to 1, so faster instances naturally handle more load.
- **Orchestration routing** — create virtual model names that route requests to different backends based on real-time conditions: which tools were called, message count, estimated token count, system prompt content, and more. Use a local model for active agentic tool loops and a frontier model (Copilot, OpenRouter, etc.) for everything else — all from one `base_url`.
- **Frontier backends** — proxy any OpenAI-compatible API as a named backend with per-backend model override, auth, request defaults, and per-request cost tracking. Mix local and cloud within a single conversation transparently.
- **Routing inspector** — rolling log of every routed request showing which rule fired, which backend was selected, latency, and a per-request snapshot of tools, messages, and tool calls. Expandable rows with newest-first message view and an inline rule tester that evaluates your edited conditions against real captured requests live.
- Global bearer token auth for both dashboard and all proxy traffic
- Config profiles — save a GPU + context + server args combination to reuse across launches
- Auto-restart with configurable backoff on unclean exits
- Periodic health monitoring — instances are polled every 30 s and auto-restarted if unhealthy
- Prometheus scrape endpoint at `GET /metrics` (per-instance + per-GPU telemetry)
- Compact VRAM bars in the GPU column with utilisation %, temperature, and power
- Aggregate GPU VRAM usage bar in the instances table footer (used/total GiB across all assigned GPUs)
- Log viewer with auto-tail and clone-setup action per instance
- Model Routing dashboard section — visual overview of which instances form a least-loaded pool vs. solo routes, with one-click copy of each pinned model name
- Speed test (TPS) per instance — uses server-side `llama.cpp` timing data (`predicted_per_second`) for accurate generation and prefill throughput measurement

LlamaFleet uses GGUF models via `llama-server` directly — no LM Studio or Ollama required. Works on NVIDIA (including pre-Ampere V100/10xx/20xx), AMD, and CPU.

> **Security note:** LlamaFleet is a **single-tenant control plane** designed for trusted local networks and homelabs. Do not expose port `8081` to the public internet without a reverse proxy and firewall rules. See [SECURITY.md](SECURITY.md) for deployment guidance.

---

## Cut AI Coding Tool Costs

AI coding assistants — GitHub Copilot, Cursor, Continue, Cline, opencode — have largely moved from flat-rate plans to **usage-based billing**. For developers running agentic workflows, costs can multiply fast: every tool-call round-trip (bash execution, file read, web fetch) is a separate billed request to the frontier API, and a single agentic session can involve dozens of them before the model gives a final answer.

LlamaFleet's orchestration routing intercepts these requests at the `base_url` level before they reach the frontier API. Route the **repetitive tool-loop turns** to a local GPU model, and reserve the frontier API for the turns where frontier quality actually matters — complex reasoning, final synthesis, architecture decisions, code review.

### What kinds of turns go where

| Turn type | Good candidate for | Why |
|---|---|---|
| Bash command execution (`bash`) | **Local model** | The model is reading output, not doing deep reasoning. A 35B local MoE handles this well. |
| File read / grep / search | **Local model** | Context retrieval, not synthesis. |
| Web fetch / docs lookup | **Local model** | Parsing and summarizing a page. |
| Initial question / final answer | **Frontier API** | Where quality matters most. |
| Architecture review, complex debugging | **Frontier API** | When you actually need the frontier model. |
| Short completions, boilerplate | **Local model** | Speed over quality; no meaningful difference. |

### Why this works

In a typical agentic coding session, the model spends the majority of its turns in a tool loop — running a command, reading output, deciding what to do next. These turns are billed the same as a hard reasoning question but require far less model capability. A capable local model (Qwen3-35B, Llama-3 70B Q4, etc.) handles tool-loop turns with the same functional accuracy as a frontier model, at near-zero marginal cost.

LlamaFleet's `toolCalledContains` condition detects when the model is **actively mid-loop** (the last assistant message contains a tool call) and routes that turn locally. The moment the model gives a final text answer with no tool calls, the condition resets and the next request goes back to the frontier — so you get frontier quality exactly when the conversation needs it.

See [Orchestration Routing](#orchestration-routing) for a step-by-step setup.

---

## Why LlamaFleet?

All four tools run `llama.cpp` under the hood. The differences are in the ops model — how much control you have over each running process and how you compose them.

| | LlamaFleet | LocalAI | Ollama | LM Studio |
|---|---|---|---|---|
| Pass-through `llama-server` flags | ✅ Any flag, per instance | ⚠ Via YAML backend configs | ⚠ Subset via `Modelfile` | ⚠ Subset via GUI/JSON |
| Per-instance GPU pinning | ✅ Explicit `CUDA_VISIBLE_DEVICES` per process | ⚠ Per-container via Docker `--gpus` | ⚠ Global env var | ⚠ Per-model GPU select (recent versions) |
| Multiple models loaded at once | ✅ Unlimited, independent processes | ✅ Multiple backends | ✅ Via `OLLAMA_MAX_LOADED_MODELS` | ✅ JIT-loaded |
| Least-loaded pooling under one model name | ✅ Built-in (round-robin tiebreak) | ❌ | ❌ | ❌ |
| Heterogeneous pools (mix GPU/CPU instances) | ✅ Mix any runtimes under one model name | ❌ | ❌ | ❌ |
| **Orchestration routing (local ↔ frontier)** | ✅ Rule-based, condition-driven | ❌ | ❌ | ❌ |
| **Frontier API proxy (OpenAI, Copilot, etc.)** | ✅ Named backends with cost tracking | ⚠ Via API backends | ❌ | ❌ |
| Any local GGUF | ✅ Scan paths + HF Hub browser | ✅ Local files | ✅ `FROM ./model.gguf` | ✅ Local files + HF browser |
| Browser dashboard | ✅ | ✅ React UI | ❌ (3rd-party only) | ❌ Desktop GUI only |
| OpenAI-compatible REST API | ✅ | ✅ | ✅ | ✅ |
| Headless server / SSH box / systemd | ✅ Native processes, systemd service | ✅ Via Docker | ✅ | ❌ Desktop app |
| Multi-user auth / RBAC | ❌ Single shared bearer token | ✅ | ❌ No auth | ❌ No auth |

**The short version:** [LocalAI](https://github.com/mudler/LocalAI) is the broadest alternative — it wraps 36+ backends (llama.cpp, Whisper, Stable Diffusion, and more) and includes RBAC and distributed mode. If you need that breadth, LocalAI is the right tool. LlamaFleet does one thing: it treats each `llama-server` process as an independently-controlled unit — its own GPUs, its own queue, its own crash domain — and routes load across them intelligently. If you need fine-grained per-process GPU control, heterogeneous compute pools, and direct `llama-server` flag access without Docker, LlamaFleet is more direct. If you want a one-command model registry on your laptop, Ollama is simpler. If you want a polished desktop GUI for trying models, LM Studio is hard to beat.

---

## In App Screenshots

<table align="center" width="100%"><tr>
<td width="50%" align="left" valign="top">

**Instances &amp; Routing**<br/>
Launch form, running instances with GPU stats, log viewer, and the routing map showing which instances share a least-loaded pool.

<a href="docs/screenshot-dashboard.png"><img src="docs/screenshot-dashboard.png" width="100%" alt="LlamaFleet dashboard — instances and routing" /></a>

</td>
<td width="50%" align="left" valign="top">

**Model Hub**<br/>
Browse and download GGUF models directly from HuggingFace. Tracks active downloads with resume/discard controls and pins favorites for one-click launch.

<a href="docs/screenshot-models.png"><img src="docs/screenshot-models.png" width="100%" alt="LlamaFleet model hub" /></a>

</td>
</tr></table>

---

## Quick Start (Linux — one line)

```bash
curl -fsSL https://github.com/boringresearchjames/llamafleet/releases/latest/download/install.sh | sudo bash
```

Auto-detects your GPU (NVIDIA/AMD/Vulkan/CPU), installs a matching `llama-server` binary, and sets up the systemd service. After install:

```bash
# Edit your tokens
sudo nano /etc/llamafleet/llamafleet.env

sudo systemctl restart llamafleet
```

Open **http://localhost:8081**.

---

## Quick Start (Manual / Development)

### 1. Prerequisites

- **Node.js 18+**
- **A `llama-server` binary** — download a pre-built binary from the [llama.cpp releases page](https://github.com/ggerganov/llama.cpp/releases) or build from source:
  ```bash
  cmake -B build -DGGML_CUDA=on && cmake --build build --target llama-server -j$(nproc)
  ```

| Platform | Binary to download |
|---|---|
| Linux (NVIDIA, CUDA) | No pre-built CUDA binary — build from source: `cmake -B build -DGGML_CUDA=on && cmake --build build --target llama-server -j$(nproc)` |
| Linux (AMD, ROCm) | `llama-*-bin-ubuntu-rocm-*-x64.tar.gz` |
| Linux (CPU) | `llama-*-bin-ubuntu-x64.tar.gz` |
| Windows (NVIDIA, CUDA 12) | `llama-*-bin-win-cuda-12.4-x64.zip` |
| Windows (NVIDIA, CUDA 13) | `llama-*-bin-win-cuda-13.1-x64.zip` |
| Windows (CPU) | `llama-*-bin-win-cpu-x64.zip` |

### 2. Install

```bash
git clone https://github.com/boringresearchjames/llamafleet.git
cd llamafleet
npm run install:deps
```

### 3. Configure

**Minimum required variables:**

| Variable | Purpose |
|---|---|
| `LLAMA_SERVER_BIN` | Full path to your `llama-server` binary |
| `API_AUTH_TOKEN` | Bearer token for the dashboard and API (omit to disable auth) |
| `BRIDGE_AUTH_TOKEN` | Internal API<->bridge token (omit to disable) |

```bash
# Linux
export LLAMA_SERVER_BIN=/usr/local/bin/llama-server
export API_AUTH_TOKEN=change-me
export BRIDGE_AUTH_TOKEN=change-me
```

```powershell
# Windows (PowerShell)
$env:LLAMA_SERVER_BIN = "C:\Tools\llama\llama-server.exe"
$env:API_AUTH_TOKEN   = "change-me"
$env:BRIDGE_AUTH_TOKEN = "change-me"
```

**MODELS_DIR** — LlamaFleet auto-scans `~/.lmstudio/models`, `~/.ollama/models`, `~/.cache/huggingface/hub`, and `~/unsloth_studio`. Override with:

```bash
export MODELS_DIR=/mnt/nas/models
```

### 4. Run

```bash
npm start
```

Open **http://localhost:8081**.

For watch-mode restarts during development:

```bash
npm run dev
```

---

## API Reference

The full REST API reference is in [`docs/api.md`](docs/api.md).

It is also served live at **`http://localhost:8081/help`** with syntax-highlighted endpoint listings, request/response schemas, and Prometheus metric names.

All endpoints require `Authorization: Bearer <token>` when auth is enabled. Endpoints marked **[admin]** require the server `API_AUTH_TOKEN` specifically.

---

## Orchestration Routing

Orchestration routing lets you define **virtual model names** that route each request to the best available backend — local `llama-server` instances or any OpenAI-compatible frontier API — based on what the request actually contains.

### How it works

Point your client (opencode, Continue, any OpenAI-compatible tool) at `http://host:8081/v1` and set `model` to a name you defined as an orchestration route. LlamaFleet inspects each incoming request and evaluates your rules in order. The first matching rule wins; if nothing matches, the route's **default backend** is used.

```
Client  →  POST /v1/chat/completions  {"model": "OpenCode"}
                        │
                        ▼
              Evaluate rules in order
                        │
          ┌─────────────┴──────────────┐
          │ rule matched               │ no match
          ▼                            ▼
    Local llama-server          Default: Frontier API
    (Qwen3 35B MoE)             (Copilot / OpenRouter)
```

### Condition types

Each rule has one or more conditions (all must match — AND logic):

| Condition | Description |
|---|---|
| `toolsPresent` | Request includes any tool definitions or `tool_choice` |
| `toolNameContains` | A tool *available* in the request has a matching name |
| `toolCalledContains` | The most recent assistant message *actually invoked* a matching tool |
| `systemPromptContains` | The system prompt contains a keyword |
| `messageContains` | Any message in the history contains a keyword |
| `estimatedTokens gt/lt` | Estimated token count exceeds or is below a threshold |
| `multiTurnDepth gt/lt` | Total message count exceeds or is below a threshold |

> **`toolCalledContains` vs `toolNameContains`**: Use `toolCalledContains` to detect active agentic loops. It fires only when the *last* assistant message invoked that tool — meaning the model is mid-loop right now. Once the model gives a final text answer (no `tool_calls` in its last message), the condition resets and the next request falls back to the default backend. `toolNameContains` checks the tools *definition* array, which is the same on every request for clients like opencode that always send all tools.

### Example: local for agentic tool loops, frontier for everything else

A typical setup for GitHub Copilot (agent mode), opencode, Continue, Cursor, or any OpenAI-compatible coding tool:

1. **Create a frontier backend** → Orchestration → Frontier Backends → point it at your provider (GitHub Copilot via `https://api.githubcopilot.com`, OpenRouter, OpenAI, etc.) with your API key stored server-side
2. **Create an orchestration route** named `OpenCode` (or any name) with:
   - Default backend → your frontier API
   - Rule: `toolCalledContains: bash` → local model
   - Rule: `toolCalledContains: read_file` → local model
   - Rule: `toolCalledContains: grep` → local model
   - Rule: `toolCalledContains: webfetch` → local model
3. Set `base_url = http://host:8081/v1` and `model = OpenCode` in your editor or tool config

Result: initial questions and final answers go to the frontier API; turns where the model is actively executing commands or reading files are handled by the local GPU model — at zero per-request cost. The routing is **automatic and stateless** — every turn is evaluated fresh based on what the model actually did in its last message, so the split happens naturally as the conversation moves between reasoning and action.

**On cost:** if your frontier provider charges per token and you run agentic workflows heavily (the model runs 20–50 tool calls per session), the majority of your token spend is now on turns the local model handles equally well. The frontier API sees only the turns that actually benefit from it.

### Frontier backends

Each frontier backend stores:
- **Base URL** — the OpenAI-compatible API root (e.g. `https://openrouter.ai/api/v1`)
- **Model** — the model name to inject on every forwarded request
- **API key** — stored server-side, never exposed to the browser after saving
- **Request defaults** — a JSON object merged as defaults into every request (caller wins on conflict). Use this to set `max_tokens`, `temperature`, or any other parameter the client does not send
- **Extra headers** — injected on every forwarded request (useful for OpenRouter's `HTTP-Referer` etc.)
- **Cost tracking** — optional `costPer1kInputTokens` / `costPer1kOutputTokens` for spend monitoring

### Routing inspector

The **Routing Log** section shows the last 200 routed requests in real time (auto-refreshed every 5 s). Each row shows the route name, which rule fired (or `default`), which backend was selected, latency, and request metadata. Expand any row to see:
- The tools available in the request
- The last 5 messages (newest first) — including tool calls made by the assistant
- The `tool_choice` value

Click **Test rules →** on any log row to open the route editor with that request pre-loaded. Conditions are evaluated live in the browser as you edit rules, showing pass/fail per condition and whether routing would change.

---

## Architecture

LlamaFleet is two core Node.js services plus an optional bridge router:

- **API + dashboard** (`apps/api`, port `8081`) — serves the browser dashboard and REST API. Owns all state persistence (`state.json`) and config profiles. Authenticates inbound requests via `API_AUTH_TOKEN`.
- **Host bridge** (`apps/host-bridge`, port `8090`) — runs natively on the host and spawns `llama-server` child processes, one per instance. Enforces `CUDA_VISIBLE_DEVICES` and six other device-visibility env vars for GPU pinning. Polls instance readiness and captures GPU telemetry via `nvidia-smi`.
- **Bridge router** (`apps/bridge-router`, optional) — sits between the API and multiple host bridges for multi-host deployments. Configure via `BRIDGE_POOLS_JSON`.

### Systemd deployment (Linux)

```bash
sudo bash scripts/install-systemd.sh
```

- Service unit: `deploy/systemd/llamafleet.service`
- Env template: `deploy/systemd/env/llamafleet.env.example` -> `/etc/llamafleet/llamafleet.env`
- Full runbook: `deploy/systemd/README.md`

---

## Environment Variables

### Shared

| Variable | Default | Description |
|---|---|---|
| `API_AUTH_TOKEN` | *(unset)* | Bearer token for dashboard + API. Unset = auth disabled. |
| `BRIDGE_AUTH_TOKEN` | *(unset)* | Internal API<->bridge token. Unset = bridge auth disabled. |

### API (`apps/api`)

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8081` | API + dashboard listen port |
| `BRIDGE_URL` | `http://127.0.0.1:8090` | URL of the host bridge |
| `STATE_FILE` | `./data/state.json` | Persistent state path |
| `SHARED_CONFIG_FILE` | `./data/shared-config.yaml` | Shared config (profiles, security) |
| `MODELS_DIR` | `~/.lmstudio/models` | Primary directory scanned for `.gguf` files. Also auto-scans `~/.ollama/models`, `/usr/share/ollama/.ollama/models`, `~/.cache/huggingface/hub`, `~/unsloth_studio` |
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

---

## Background

This started as a practical fix for running a fleet of V100s with LM Studio: VRAM was bleeding between GPUs after model swaps, processes crashed under sustained load, and there was no way to pin a model to specific cards or isolate instances. Existing tools either ran a single server process or abstracted away the process boundary entirely. LlamaFleet exposes that boundary directly — one `llama-server` process per GPU subset, managed from a single control plane.

The GPU isolation problem is particularly relevant for pre-Ampere hardware. vLLM and SGLang require CUDA 11+ with Ampere-class features; older V100s and GTX 10/20 series cards either hit capability gaps or produce incorrect results. llama.cpp supports this hardware generation well, but running multiple instances with correct `CUDA_VISIBLE_DEVICES` per process, log management, readiness polling, and crash recovery is operationally tedious. LlamaFleet wraps all of that.

---

## Network Security

LlamaFleet is designed for **homelab and internal network deployments**. It is not hardened for direct public internet exposure. Follow these recommendations before deploying:

**Always do:**
- Set `API_AUTH_TOKEN` and `BRIDGE_AUTH_TOKEN` to long random strings (32+ hex chars). Without these, the API and dashboard are open to anyone on the network.
- Bind port `8081` to your internal network interface only, not `0.0.0.0`, unless you intend it to be reachable network-wide.
- Keep port `8090` (the host bridge) firewalled — it should only be reachable from the API process on `127.0.0.1`. It has no auth by default.

**If you expose port `8081` beyond your LAN:**
- Put a reverse proxy (nginx, Caddy, Traefik) in front and terminate TLS there. LlamaFleet serves plain HTTP.
- Restrict the path via the proxy if you only want API access (not the dashboard).
- Consider IP allowlisting at the firewall or proxy level.

**Token generation:**
```bash
# Linux / macOS
openssl rand -hex 32

# PowerShell
-join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Max 256) })
```

**What LlamaFleet does not provide:**
- TLS — use a reverse proxy
- Per-user or per-instance auth — one global token for everything
- Rate limiting — your reverse proxy or firewall should handle this
- Audit logging for individual API calls — only instance lifecycle events are logged

---

## Known Limitations

- **Single-host only** — LlamaFleet manages instances on one machine. A bridge-router component exists for multi-host setups but multi-host is not the primary target.
- **`llama-server` binary required** — LlamaFleet does not bundle or build it. Get a binary from the [llama.cpp releases page](https://github.com/ggerganov/llama.cpp/releases).
- **No per-instance auth** — Auth is enforced at the proxy layer via the global `API_AUTH_TOKEN`. There is no per-instance key.
- **No speculative decoding or prefix caching** — Pass the relevant `llama-server` flags via `runtimeArgs` if the binary supports them.
- **Orchestration routing log is in-memory** — The routing log resets on service restart (last 200 entries only). It is not persisted to disk.
- **Orchestration classifier rule requires a running local instance** — The optional LLM-based classifier condition requires at least one ready local instance to handle the classification call.

## Built with AI assistance

Largely AI-generated (GitHub Copilot) with human direction on architecture and domain decisions. Released as-is under MIT — fork it, use it, improve it.

## License

MIT
