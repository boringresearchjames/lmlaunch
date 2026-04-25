# LM Launch

LM Launch is a Node.js control plane and dashboard for running multiple headless LM Studio instances in parallel on a single host.

This repo runs as a host-native Node deployment.

## Dashboard

![LM Launch dashboard](docs/lmlaunch-dashboard.png)

## Why LM Launch Instead of the Alternatives

### vs. LM Studio multi-instance (GUI)

LM Studio's GUI is designed around a single interactive session. You can load multiple models but they share one server port and one GPU assignment strategy — you cannot pin specific GPUs per instance, enforce per-instance queue limits, or automate restarts. LM Launch runs fully headless, lets you assign exact GPUs to each instance, and exposes a unified API so an external router can treat the fleet as a pool.

### vs. vLLM

vLLM is excellent for high-throughput serving of a single model on a single node. It does not support running dissimilar models concurrently on different GPU subsets from one control plane, has no built-in multi-instance orchestration UI, and requires Python + CUDA with matching driver versions. vLLM also has limited or no support for older NVIDIA GPUs (pre-Ampere cards like V100, GTX 10/20 series often hit capability gaps or produce incorrect results), and its quantization support is narrower — GGUF and many GGUF-based quant formats (IQ2, IQ3, Q4_K_S, etc.) are not natively supported, forcing you toward bitsandbytes or AWQ which have their own hardware and driver constraints. LM Launch uses GGUF models via LM Studio's llama.cpp backend, so it runs on any hardware LM Studio supports (NVIDIA including older cards, AMD, Apple Silicon, CPU) without a CUDA toolkit dependency and with the full range of GGUF quantization formats.

### vs. multiple llama.cpp processes

Running `llama-server` manually on different ports works, but you have to manage process lifecycle, log tailing, GPU pinning, and health checks yourself. LM Launch wraps all of that: it enforces `CUDA_VISIBLE_DEVICES` and seven other device-visibility env vars per instance, runs pre/post memory snapshots to catch GPU bleed, monitors readiness, and can auto-restart crashed instances with configurable backoff — all from a browser UI.

### Why not wrap llama.cpp directly instead of going through LM Studio?

A fair question. The short answer is that LM Studio's `lms` CLI already solves a lot of hard problems that would need to be re-solved to wrap `llama-server` directly:

- **Model discovery** — `lms` knows where your model library lives and resolves model IDs to file paths. Wrapping llama.cpp directly means you own path resolution, model scanning, and metadata parsing across GGUF split files.
- **Runtime selection** — LM Studio ships and manages multiple llama.cpp builds (AVX2, CUDA, Metal, Vulkan, ROCm, etc.) and selects the right one for the hardware automatically. Doing this yourself means bundling or locating the right binary per platform.
- **Build maintenance** — llama.cpp releases break API compatibility regularly. LM Studio tracks upstream and ships tested builds; you'd be on your own keeping a pinned or rolling llama.cpp build working across CUDA driver versions and OS updates.
- **Context window and sampling defaults** — LM Studio applies per-model defaults (RoPE scaling, context limits, recommended sampler settings) derived from model metadata. Raw llama.cpp requires you to pass all of this explicitly or accept its own defaults.

LM Launch treats LM Studio as a well-maintained runtime layer and focuses on the orchestration layer above it: fleet management, GPU partitioning, config profiles, health tracking, and the operator dashboard. If you want a minimal llama.cpp wrapper without the LM Studio dependency, that's a different project with a different set of tradeoffs.

### vs. SGLang

SGLang (from the LMSYS group) is a high-performance serving framework targeting large-scale production — RadixAttention prefix caching, prefill-decode disaggregation, speculative decoding, tensor/pipeline/expert parallelism. It runs on 400k+ GPUs in production and is arguably the best choice for maximizing throughput on a single very large model. Like vLLM, it requires CUDA, does not support GGUF, and is designed around a single model per deployment rather than a multi-model fleet on consumer or prosumer hardware. If you have a rack of H100s and want to serve one Llama 70B as fast as possible, SGLang is worth evaluating. If you have 4–8 consumer or data center GPUs and want different models running concurrently with minimal operational overhead, LM Launch is a better fit.

### vs. GPUStack

[GPUStack](https://github.com/gpustack/gpustack) is the closest conceptual peer — a Python-based GPU cluster manager that orchestrates vLLM and SGLang across multiple hosts. If you already run vLLM or SGLang and want cluster-level scheduling with a web UI, GPUStack is worth looking at. The key differences: GPUStack inherits vLLM/SGLang's hardware and quantization constraints (no GGUF, requires CUDA); it's oriented toward multi-host clusters rather than single-host GPU partitioning; and it's significantly heavier to deploy. LM Launch is a single-host tool that uses LM Studio as the runtime layer, trades cluster-scale for zero-CUDA simplicity and GGUF support.

### vs. Ollama

Ollama serializes requests to one model at a time per runtime and is optimized for single-user local use. It has no concept of pinning a model to a specific GPU subset, no queue depth control, and no multi-instance fleet view. LM Launch is designed specifically for the case where you have multiple GPUs and want different models running concurrently on different GPU subsets with independent ports, context windows, and TTLs.

### Relationship to LM Studio LM Link and llmster

LM Studio now ships two relevant features: **llmster** (headless mode — runs LM Studio without a GUI, ideal for servers) and **LM Link** (cross-device routing — routes inference requests to other machines running LM Studio on your local network). LM Launch is complementary to both:

- LM Launch uses `lms` to drive `llmster`-style headless instances on a single host
- LM Link can route to any OpenAI-compatible endpoint, so an LM Launch fleet (multiple instances across ports) can be placed behind LM Link for cross-device routing if needed

LM Launch does not compete with LM Link. The two tools operate at different layers: LM Launch manages instances on one host; LM Link routes requests across hosts.

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

## Known Limitations and Roadmap Considerations

Things that are currently out of scope or worth being aware of before adopting:

- **Single-host only** — LM Launch manages instances on one machine. For multi-host GPU pools, combine it with LM Link (cross-device routing) or use GPUStack with vLLM/SGLang.
- **No Prometheus/metrics endpoint** — Per-instance token throughput, queue depth, and latency metrics are not yet exposed. This is a common ask in the llama.cpp and serving community; a `/metrics` endpoint is a natural addition.
- **LM Studio as a dependency** — LM Studio (and its `lms` CLI) must be installed on the host. LM Launch does not manage LM Studio installation or updates.
- **LM Studio GPU tensor split bug** — As of early 2026, LM Studio has a known issue where some dual-GPU configurations (e.g. 2× RTX PRO 5000 Blackwell) resolve tensor split incorrectly, producing garbage output or crashes. LM Launch assigns GPUs per-instance via environment variables; if LM Studio has a tensor split bug for a given card pairing, that bug will manifest regardless of LM Launch.
- **No model download management** — LM Launch does not download or manage model files. Models must already be in your LM Studio model library. Use `lms get` or the LM Studio UI to download models.
- **No authentication per-instance** — The LM Launch API has a single bearer token. Individual instances expose unauthenticated OpenAI-compatible endpoints on their assigned ports. Place a reverse proxy in front if you need per-instance auth or TLS.
- **No speculative decoding or prefix caching** — LM Launch relies on whatever llama.cpp runtime LM Studio provides. Advanced inference features like speculative decoding or RadixAttention-style prefix caching are not available through this stack.

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
