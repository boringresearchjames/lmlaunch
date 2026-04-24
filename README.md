# LM Launch

LM Launch is a Docker-first orchestration layer for running multiple headless LM Studio instances in parallel on a single GPU host.

Primary target:
- Ubuntu 24.03
- Multi-GPU NVIDIA hosts (including V100 clusters on one machine)
- Qwen 3.6 VLM workflows with parallel job fan-out

This project is designed for the exact case where a single runtime path is not delivering enough parallel throughput on older cards, and multiple LM Studio instances are used as the concurrency strategy.

## Status

Active implementation with Docker-first orchestration.

Current implementation includes:
- Docker compose stack with API, host bridge, and web UI
- Profile CRUD and instance lifecycle endpoints
- Ready-only manifest endpoint for external harness routing
- Dashboard controls for start/stop/kill/drain/model switch
- Copy-ready URL and model controls in the UI
- Log tail, clear, and copy controls in the UI

Recent changes (April 2026):
- Profile ID is auto-generated from profile name in the UI
- Profiles no longer require a model
- Model is selected per launched instance
- Max inflight concurrency is now per instance (launch-time), not profile-level
- GPU selection uses multi-select loaded from nvidia-smi via bridge/API
- Dashboard includes a README/help card for operator guidance

## Quick Start

1. Set secrets in your shell before launching:
	- API_AUTH_TOKEN
	- BRIDGE_AUTH_TOKEN
	- Use non-default values (services refuse startup with placeholder tokens)
2. Start the stack:
	- docker compose up --build -d
3. Open UI:
	- http://localhost:8080
4. API endpoint:
	- http://localhost:8081
5. Bridge endpoint:
	- internal Docker network only (`bridge:8090`), not host-exposed by default

Before first launch on Ubuntu, complete Docker and GPU permissions setup (see Docker Permissions section below).

First run flow:
1. Create a profile in UI with runtime defaults (host, port, GPUs).
2. Start one or more instances from the profile and choose model + max inflight per instance.
3. Copy per-instance base/chat URLs for your external harness.
4. Use ready manifest output as the source for routing eligible instances.

## LM Studio Defaults Used By LM Launch

- Default server host in this project is set to 127.0.0.1 for each instance profile.
- Default server port is set to 1234 when profile port is not provided.
- LM Studio CLI supports explicit port via lms server start --port <port>.
- LM Studio local server behavior is localhost-first unless separately configured for network serving.

## Can Docker Command LM Studio Startup?

Yes, with one of these modes:

1. In-container runtime mode
- Bridge container installs lms during image build (default INSTALL_LMS=true).
- Bridge can execute runtime start commands directly, including lms daemon up and lms server start.
- This is the simplest mode for Docker-first control.

2. Host-managed runtime mode
- Keep LM Studio installed on host and run runtime there.
- Bridge/API still orchestrate profile and lifecycle logic, but execution target must be host reachable.
- Use this when you need host-native runtime placement guarantees.

## Docker Permissions (Ubuntu)

Required host permissions and runtime configuration:

1. Docker access for your user
- Add user to docker group:
	- sudo usermod -aG docker $USER
- Re-login (or reboot) so group membership is applied.
- Verify:
	- docker ps

2. NVIDIA container runtime for GPU access
- Install and configure NVIDIA Container Toolkit on the host.
- Verify Docker GPU visibility:
	- docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi

3. Network and port permissions
- Ensure ports 8080 and 8081 are allowed locally.
- Ensure per-instance LM Studio ports are allowed for your harness callers.

4. Secrets and runtime env
- Set API_AUTH_TOKEN and BRIDGE_AUTH_TOKEN before compose up.
- Optional: set INSTALL_LMS=true (default) to install lms in bridge image build.
- API and bridge fail fast if tokens are unset or left as default placeholders.

5. Host binary and model/data permissions
- If running in-container runtime mode, ensure container has read/write access to model/cache volumes you mount.
- If running host-managed runtime mode, ensure host-side lms process user can read model files and bind target ports.

Recommended bring-up checks:
1. docker compose config
2. docker compose up --build -d
3. docker compose ps
4. docker compose logs -f bridge

Common permission failures and fixes:
- "permission denied while trying to connect to Docker daemon socket": user not in docker group or session not refreshed.
- "could not select device driver \"\" with capabilities: [[gpu]]": NVIDIA Container Toolkit missing/misconfigured.
- "EACCES" on model/log paths: fix file ownership/permissions for mounted host directories.

## Headless Install Instructions (Ubuntu)

Install LM Studio headless tooling:
- curl -fsSL https://lmstudio.ai/install.sh | bash

Start daemon and server manually:
- lms daemon up
- lms server start --port 1234

Useful lifecycle commands:
- lms ps
- lms load <model>
- lms unload --all

Planned capabilities:
- Profile-driven model/runtime configuration
- Manual multi-GPU selection per instance (from `nvidia-smi`)
- Multi-instance start/stop/restart
- Per-instance model switch controls after spawn
- Operator kill controls (graceful stop and force kill)
- Health and readiness tracking per instance
- OpenAI-compatible endpoint map per running instance
- Copy-ready endpoint display per instance (base URL + common API paths)
- Copy-ready model display per instance (profile model + effective model)
- Ready-only instance manifest for external harnesses
- Capacity-aware routing metadata (inflight, queue depth, max inflight)
- Dockerized launcher API and dashboard by default
- Dockerized host bridge by default with host runtime control
- Log controls (live tail, pause/resume stream, clear view, download/export)

## Architecture

LM Launch has three runtime components:

1. Launcher API (Node.js)
- Stores profiles and runtime state
- Validates GPU/port conflicts
- Manages instance lifecycle
- Exposes APIs for dashboard and automation

2. Web Dashboard (Static HTML/JS)
- Create/edit model profiles
- Select one or more GPUs per profile
- Launch and monitor instances
- View process logs and health

3. Host Bridge Service (containerized)
- Runs as a Docker service with host access for process control
- Starts/stops/checks local `lms` processes
- Exposes a local control API for the launcher API

Why this split:
- Docker portability and reproducible deployments for all LM Launch components
- Runtime process management remains explicit and isolated
- Host dependency drift is minimized through pinned container images

## Runtime Model

Each instance profile defines:
- Runtime target (for example `lms`/`llmster`) and runtime version/tag preference
- Runtime launch template (env vars + optional extra args)
- Port assignment
- GPU selection list
- Context and startup settings
- Startup timeout and optional idle controls

A launched instance becomes one LM Studio server endpoint. External jobs can shard requests across active endpoints for parallel execution.

Running instances track the effective model (chosen at launch, and switchable later).

### Instance State Machine

Each instance must expose one of the following states:
- `starting`
- `warming`
- `ready`
- `draining`
- `switching_model`
- `unhealthy`
- `stopped`

Only instances in `ready` are returned by ready-only routing endpoints used by external harnesses.

### Readiness Contract

An instance is considered `ready` only when all conditions are true:
- Process is alive.
- API health check passes.
- Target model is loaded and active.
- A lightweight VLM-compatible inference smoke check has succeeded since last start/switch.
- Current inflight count is below configured max inflight threshold.

## Operator Controls

The dashboard/operator API should expose:
- Lifecycle controls: start, stop, restart, force kill
- Log controls: follow/unfollow stream, pause/resume rendering, clear local view, export logs
- Runtime controls: select runtime type per profile, set runtime version/tag, and override launch arguments when needed
- Model controls: switch model for a specific running instance, with restart-aware apply mode
- Copy controls: one-click copy for instance base URL, health URL, and active model name
- Traffic controls: set drain mode on/off for each instance

Safety behavior:
- Force kill is explicit and confirmation-gated in UI
- Every lifecycle action is audited with timestamp, actor/source, and result
- Runtime changes apply only to new launches unless an explicit restart is requested
- Model switching supports two apply modes: `next_restart` (default) and `restart_now` (explicit)
- Restart, model switch (`restart_now`), and force kill should require explicit drain or force override behavior.
- In `draining`, new jobs are rejected for that instance while in-flight work is allowed to finish.

## Deployment Model

### Default (Docker-first, Ubuntu production)
- Launcher API in Docker
- Web Dashboard in Docker
- Host Bridge service in Docker
- LM Studio headless runtime (`lms`/llmster) on host

### Fallback
- Host-only mode (no Docker) only for emergency recovery or troubleshooting

## Prerequisites

Host:
- Ubuntu 24.03
- NVIDIA driver + `nvidia-smi`
- LM Studio headless tooling (`lms`)
- Docker Engine + Docker Compose plugin (required)

Operational:
- Available port range for multiple LM instances
- Sufficient VRAM plan for chosen quantizations and concurrency

## Planned API Surface (v1)

Core endpoints:
- Profile CRUD
- GPU inventory probe
- Instance lifecycle: start, stop, restart, list
- Instance force-kill endpoint
- Health/status listing
- Capacity view for external job routers
- Ready-only instance manifest endpoint for harnesses
- Runtime configuration endpoint per profile (runtime type/version/args)
- Instance model switch endpoint (set effective model per running instance)
- Log endpoints (tail stream, fetch window, export)
- Instance connection metadata endpoint (copy-ready URLs + profile/effective model fields)

Required ready-only manifest fields per instance:
- `instance_id`
- `state`
- `base_url`

## License

This project is licensed under the MIT License. See `LICENSE`.
- `api_paths` (for common callable routes)
- `profile_model`
- `effective_model`
- `inflight_requests`
- `max_inflight_requests`
- `queue_depth`
- `last_health_ok_at`
- `last_error`

Required policy defaults:
- Request timeout per routed call
- Retry count and backoff strategy
- Unhealthy ejection window before retrying an instance
- Over-capacity behavior (`reject` or `queue`)

Optional helper:
- Simple round-robin assignment endpoint over healthy instances

## Agent Interface (Hosted Container Friendly)

If you want an external agent container to integrate quickly, use the agent gateway instead of wiring many endpoints.

Discovery:
- GET /v1/agent/capabilities

Single action endpoint:
- POST /v1/agent/action

Action payload format:
- { "action": "instances.start", "input": { ... } }

Supported actions:
- manifest.ready
- profiles.list
- instances.list
- instances.start
- instances.stop
- instances.kill
- instances.drain
- instances.switchModel
- instances.logs
- instances.connection

Example call:
- curl -X POST http://localhost:8081/v1/agent/action \
	-H "Authorization: Bearer $API_AUTH_TOKEN" \
	-H "Content-Type: application/json" \
	-d '{"action":"manifest.ready","input":{}}'

Why this helps:
- Hosted agents only need one authenticated endpoint contract.
- Action names stay stable while backend routes evolve.
- Easier to add allow-listing and auditing for automation clients.

API service docs:
- apps/api/README.md
- Runtime help endpoint: GET /help on the API service

## Persistent Settings Storage

Yes. Settings are persisted.

- API persistent state file:
	- /data/state.json inside the API container
	- Backed by host volume: ./data/api:/data
- Shareable YAML snapshot:
	- /data/shared-config.yaml inside the API container
	- Also backed by host volume: ./data/api:/data
- Persisted objects include:
	- profiles
	- instances (metadata)
	- audit records
	- security settings (TLS file paths, auth mode, session TTL)
	- user accounts (password hashes only)
	- active login sessions (token + expiry)

Security settings endpoints (admin token required):
- GET /v1/settings/security
- PUT /v1/settings/security

User management endpoints (admin token required):
- GET /v1/users
- POST /v1/users
- DELETE /v1/users/:username

User login/session endpoints:
- POST /auth/login
- POST /auth/logout

YAML export endpoint (admin token required):
- GET /v1/config/export.yaml

Config status endpoint (admin token required):
- GET /v1/config/status

YAML import endpoint (admin token required):
- POST /v1/config/import.yaml?dryRun=true
- POST /v1/config/import.yaml?dryRun=false

YAML export behavior:
- Includes: profiles, security settings, user list (username/disabled only)
- Excludes: API tokens, user password hashes, active sessions
- Regenerated automatically whenever state is saved

YAML import behavior:
- Validates schema and returns errors/warnings
- `dryRun=true` validates without applying changes
- `dryRun=false` applies validated settings and profiles
- User entries only update existing local users' disabled flag (password hashes are never imported)

Dashboard support:
- The web UI includes a Config YAML panel for export, copy, download, dry-run import, and apply import.
- The panel also shows config sync markers:
	- currentExportHash
	- lastImportedAt + lastImportedHash
	- lastDryRunAt + lastDryRunHash

Example import:
- curl -X POST "http://localhost:8081/v1/config/import.yaml?dryRun=true" \
	-H "Authorization: Bearer $API_AUTH_TOKEN" \
	-H "Content-Type: application/yaml" \
	--data-binary @shared-config.yaml

TLS note:
- Current persistence stores TLS cert/key/CA file paths for operational configuration.
- API/UI TLS termination should still be done at a reverse proxy/load balancer in production.

## Security Notes

- Keep host bridge API bound to local interface by default.
- Require shared token between launcher API and host bridge service.
- Restrict dashboard/API exposure behind firewall or reverse proxy auth when not local-only.
- Avoid running launcher container with unnecessary privileges.
- Require auth for external harness clients and apply per-client rate limits.
- Keep bridge service internal-only in Docker unless you explicitly need host-level debugging access.
- For non-local deployments, terminate TLS with managed certificates in front of API/UI.

## Observability Requirements

Per-instance metrics required for tuning and routing confidence:
- Request count and error rate
- P50/P95 latency
- TTFT and throughput (tokens/sec where available)
- Inflight and queue depth trends
- Last successful response time and last failure reason

## Verification Plan

Functional checks:
1. Launcher container starts and UI/API are reachable.
2. GPU probe matches `nvidia-smi` output.
3. Two or more profiles launch on distinct ports and become healthy.
4. OpenAI-compatible requests succeed per instance.
5. Crash handling marks instance failed and preserves logs.
6. Conflict validation catches duplicate ports and invalid GPU assignments.
7. State survives launcher restart.
8. Switching a running instance model updates effective model and applies according to selected mode (`next_restart` or `restart_now`).
9. Dashboard shows copyable API URLs and model names for each instance and copy actions work reliably.
10. Ready-only manifest excludes non-ready instances and includes required capacity/model fields.
11. Drain mode rejects new work but lets in-flight work complete before restart/switch/kill.
12. Routing policy defaults are enforced (timeout, retries, unhealthy ejection, over-capacity behavior).

## Roadmap

v1:
- Single-host, multi-GPU orchestration
- Manual GPU assignment
- Docker-first deployment for launcher API, dashboard, and host bridge

v1.1:
- Improved tuning UX for concurrency/context presets
- Better throughput telemetry and queue signals

v2:
- Multi-node scheduling abstraction
- Cluster-aware placement policies

## Notes for Qwen 3.6 VLM Workloads

Recommended operational strategy:
- Start with conservative concurrency per instance.
- Scale by adding instances across GPUs before pushing per-instance concurrency too high.
- Validate memory headroom under real image batch shape and prompt length.
- Keep model settings profile-based so you can A/B throughput and quality quickly.

## Contributing

Until the base scaffold is complete, keep contributions focused on:
- Core lifecycle correctness
- Deterministic error handling
- Clear observability for instance state and logs

## License

Add your preferred license before first public release.
