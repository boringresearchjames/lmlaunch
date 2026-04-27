# Security

## Architecture and threat model

LlamaFleet is a **single-tenant control plane** intended for use on trusted local networks — homelabs, air-gapped workstations, and private GPU servers. It is not designed or hardened for direct public internet exposure.

One bearer token (`API_AUTH_TOKEN`) gates the entire dashboard and API. There is no per-user auth, per-instance isolation, or multi-tenant access control. Anyone who holds the token, or who can reach the API port on an unprotected network, has full control over every instance and model.

---

## Recommended deployment

**Minimum baseline:**
- Set `API_AUTH_TOKEN` and `BRIDGE_AUTH_TOKEN` to independent 32+ character random hex strings. Without these, the API is open to every device on the network.
  ```bash
  openssl rand -hex 32   # run twice, once per token
  ```
- Keep port `8090` (host bridge) bound to `127.0.0.1` — it has no auth. It should never be reachable from other machines.
- Keep port `8081` (API + dashboard) restricted to your LAN interface. Do not bind it to `0.0.0.0` if the host is internet-reachable.

**If you need remote access:**
- Put a TLS-terminating reverse proxy (nginx, Caddy, Traefik) in front of port `8081`. LlamaFleet serves plain HTTP.
- Restrict access with IP allowlisting at the proxy or firewall level.
- Do not expose port `8090` through the proxy under any circumstances.

**Firewall rule summary:**

| Port | Accessible from | Notes |
|------|----------------|-------|
| `8081` | LAN only (or behind reverse proxy) | Dashboard + API |
| `8090` | `127.0.0.1` only | Host bridge — no auth |

---

## Known limitations

- **No TLS** — use a reverse proxy for HTTPS.
- **No per-user or per-instance auth** — one global token for all operations.
- **No rate limiting** — handle at the proxy or firewall layer.
- **No audit log for API calls** — only instance lifecycle events (start, stop, restart) are recorded.
- **CORS defaults to `*`** — set `CORS_ORIGIN` to your specific origin if the dashboard is served over a network.

---

## Reporting vulnerabilities

There is no dedicated security email at this time. Please open a [GitHub Issue](https://github.com/boringresearchjames/llamafleet/issues) and mark it with the `security` label. For sensitive disclosures, use GitHub's private vulnerability reporting feature on the repository's Security tab.
