# infra/

Adopter-side tooling. Not deployed; runs locally on the adopter's workstation or CI.

| Path | Purpose |
|---|---|
| `wrangler/setup.mjs` | Setup orchestrator. Default mode = preflight checker; `--apply` end-to-end creator (D1 + KV + Access + secrets + migrate + deploy + bootstrap + runbook). |
| `wrangler/access-app.mjs` | Create/update the Cloudflare Access app (path-scoped destinations: `/admin/api/*`, `/self/api/*`). |
| `wrangler/access-apply.mjs` | Write Access values into `worker/wrangler.toml`. |
| `wrangler/access-verify.mjs` | Strict live verifier for the Access gate. |
| `wrangler/rotate-hmac.mjs` | Generate a new HMAC secret and print the rotation runbook. |
| `docker/relay.compose.yml` | Reference compose for the relay alone (BYO ACME). |
| `docker/relay-with-caddy.compose.yml` | Relay + Caddy ACME sidecar (HTTP-01 by default). |
| `docker/relay-with-lego.compose.yml` | Relay + lego ACME sidecar (Cloudflare DNS-01). |
| `docker/relay-with-traefik.compose.yml` | Relay behind Traefik TCP routing. |
| `docker/relay-with-host-certbot.md` | Host-managed certbot instructions. |
| `docker/README.md` | Picking a compose; required `.env` shape. |
| `opentofu/` | Optional declarative provisioning of D1, KV, Access (worker script + secrets stay out of tfstate). |
| `setup/doctor-local.sh` | DNS/TLS/SMTP/Worker check. |
| `setup/doctor-delivery.sh` | Guided DKIM/DMARC delivery check. |
