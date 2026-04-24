# LM Launch API

This service is the control plane for profiles, instances, routing manifest, and agent integration.

## Local run

- npm install
- npm run start

Default port:
- 8081

## Runtime env vars

- PORT (default: 8081)
- API_AUTH_TOKEN (required for /v1 routes)
- BRIDGE_URL (default: http://localhost:8090)
- BRIDGE_AUTH_TOKEN (required for bridge calls)
- STATE_FILE (default: /data/state.json)

## Built-in docs endpoints

- GET / -> service info + links
- GET /help -> API usage and examples
- GET /health -> health check

## Core endpoints

Authenticated under /v1:

- GET /v1/profiles
- POST /v1/profiles
- DELETE /v1/profiles/:id
- GET /v1/instances
- POST /v1/instances/start
- POST /v1/instances/:id/stop
- POST /v1/instances/:id/kill
- POST /v1/instances/:id/drain
- POST /v1/instances/:id/model
- GET /v1/instances/:id/logs
- GET /v1/instances/:id/connection
- GET /v1/manifest/ready
- GET /v1/audit

Agent interface:

- GET /v1/agent/capabilities
- POST /v1/agent/action

## Agent action examples

POST /v1/agent/action body:

{
  "action": "manifest.ready",
  "input": {}
}

{
  "action": "instances.start",
  "input": {
    "profileId": "prof_qwen",
    "instanceId": "inst_qwen_1"
  }
}
