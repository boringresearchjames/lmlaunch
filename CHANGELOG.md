# Changelog

## [0.3.0] — 2026-04-26

### Added
- **Named model routing with round-robin pool support** — `POST /v1/chat/completions` now automatically distributes load across all running instances of the same model. Start multiple instances of the same GGUF and they form a pool; requests cycle across GPUs in round-robin order with no client-side changes required.
- **`GET /v1/models` pool + individual entries** — returns both a pool entry (for round-robin) and per-instance pinned aliases (`ModelName-1`, `-2`, `-3`, …) so any OpenAI-compatible client can discover and target specific GPUs via standard model selection.
- **Virtual `-1` alias for base pool member** — the first instance in a pool (whose route name has no numeric suffix) is addressable as `ModelName-1`, both in the API and shown in the dashboard, so all members are consistently pinnable.
- **Model Routing dashboard section** — visual overview between Instances and Config Library showing each model as either a round-robin pool (⇄) or a direct solo route (→), with per-instance GPU labels, pinned model names, and one-click copy buttons.

### Changed
- `GET /v1/models` response now includes `pool: true` entries alongside individual pinned-name entries (previously only returned raw instance names).
- Instance table "Copy Model ID" button now copies the `-1`-suffixed name for base pool members instead of the bare route name.
- Routing map copy buttons redesigned: pill-style "COPY" label, no clipboard emoji, consistent with dashboard aesthetic.

### Fixed
- Round-robin counter (`modelRoundRobinCounters`) correctly cycles across all active same-model instances.
- `usedNames` uniqueness check during start/restart now scans all instances (not just active), preventing duplicate route name collisions.

---

## [0.2.1] — 2026-04-24

### Added
- `GET /v1/local-models` scans Ollama, HuggingFace hub, and Unsloth Studio model directories in addition to the primary `MODELS_DIR`.
- Auto-install script (`scripts/install-llama-server.sh`) detects GPU type (NVIDIA/AMD ROCm/Vulkan/CPU) and downloads the correct `llama-server` binary from llama.cpp releases.
- GitHub Actions release pipeline (`build-release.sh`, `.github/workflows/release.yml`) with `curl` one-liner install.
- Systemd deployment runbook (`deploy/systemd/README.md`) and env template (`llamafleet.env.example`).
- Bridge router app (`apps/bridge-router`) for multi-host deployments.
- Llama emoji favicon.

### Fixed
- `CUDA_DEVICE_ORDER=PCI_BUS_ID` set on all spawned `llama-server` processes to ensure GPU index matches `nvidia-smi` PCI bus order.

---

## [0.2.0] — 2026-04-23

### Added
- Wake/restart button in the instance table (⚡) — restarts a stopped or crashed instance with its existing config.
- Prometheus metrics endpoint (`GET /metrics`) with per-instance and per-GPU telemetry.
- Smoke check support (`SMOKE_CHECK_ENABLED`, `STRICT_SMOKE_CHECK`) — optional test inference after startup.
- Per-instance log viewer with auto-tail mode and clone-setup action.
- Config profiles — save, load, delete, import/export YAML instance configurations.

---

## [0.1.0] — 2026-04-20

### Initial release
- Multi-instance `llama-server` lifecycle management (start, stop, drain, kill, remove) from a browser dashboard.
- Per-instance GPU pinning via `CUDA_VISIBLE_DEVICES` and AMD/Intel/Metal equivalents.
- OpenAI-compatible reverse proxy per instance (`/v1/instances/<id>/proxy/v1/...`).
- Top-level `/v1/chat/completions` routing by model name.
- Auto-restart with configurable backoff on unclean exits.
- 30-second health polling with auto-restart on unhealthy instances.
- Global bearer token auth for dashboard and all proxy traffic.
- VRAM bar visualisation with utilisation %, temperature, and power per GPU.
