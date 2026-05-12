# Relay docker-compose recipes

The `pnpm setup --apply` wizard writes a per-adopter `RUNBOOK.md` that includes
a docker-compose block with every value pre-filled. The files in this directory
are the templates the wizard chooses from.

| File | What it provides | When to pick it |
|---|---|---|
| `relay.compose.yml` | Relay only, certs mounted from `./tls/` | You already run your own ACME (host certbot, Traefik, ansible, etc.). |
| `relay-with-lego.compose.yml` | Relay + `lego` ACME sidecar with Cloudflare DNS-01 | **Recommended default.** Works behind NAT, no port 80 needed. Requires a CF API token scoped to **Zone:DNS:Edit** on the relay's zone. |
| `relay-with-caddy.compose.yml` | Relay + Caddy ACME (HTTP-01 by default) | Useful if you already run Caddy or want the optional reverse-proxy benefits. Needs port 80 reachable. |
| `relay-with-traefik.compose.yml` | Relay + Traefik with its built-in ACME | Drop-in if you already run Traefik on the same host. |
| `relay-with-host-certbot.md` | Notes for running certbot on the host (no sidecar) | When you'd rather manage certs at the OS level. |

## Required env (`.env` next to the compose file)

```env
# Identity
RELAY_DOMAIN=smtp.example.com
RELAY_HOSTNAME=smtp.example.com         # alias used by some templates
ACME_EMAIL=ops@example.com

# Worker contract — copy from RUNBOOK.md after `pnpm setup --apply`
RELAY_WORKER_URL=https://mail.example.com
RELAY_KEY_ID=rel_01
RELAY_HMAC_SECRET=...                   # 32-byte base64url, matches worker RELAY_HMAC_SECRET_CURRENT

# Only when using lego (or Caddy in DNS-01 mode)
CLOUDFLARE_DNS_API_TOKEN=...            # Zone:DNS:Edit on the relay's zone
```

`CLOUDFLARE_DNS_API_TOKEN` is **distinct** from the worker's `CF_API_TOKEN`. The
worker token is account-scoped Email Sending Edit; the relay's DNS token is
zone-scoped DNS Edit. Don't reuse the same token for both.

## Quickstart with the recommended default

```sh
cp infra/docker/relay-with-lego.compose.yml /opt/cf-mail-relay/compose.yml
cp .env.example /opt/cf-mail-relay/.env     # fill in the values from RUNBOOK.md
cd /opt/cf-mail-relay
docker compose run --rm lego                # issue the cert once
docker compose up -d relay                  # start serving SMTP 587
```

The lego container exits after issuance; the renewal loop is short — re-run
`docker compose run --rm lego` from cron weekly, or wrap it in a tiny shell
service if you prefer one container that does both.

## Notes on the SMTP port and DNS

- Bind the relay to a public IP on `tcp/587`. The hostname (`smtp.<your-zone>`)
  must be **DNS-only** in Cloudflare (no orange cloud — Cloudflare's HTTP
  proxy doesn't proxy SMTP).
- ACME challenges only need port 80 for HTTP-01 (Caddy default). DNS-01 (lego)
  bypasses this and works behind NAT.
