# infra/

Adopter-side tooling. Not deployed; runs locally on the adopter's workstation or CI.

| Path | Purpose | Milestone |
|---|---|---|
| `wrangler/setup.mjs` | Setup preflight and command plan |
| `wrangler/access-app.mjs` | Create/update the Cloudflare Access app |
| `wrangler/access-apply.mjs` | Write Access values into `worker/wrangler.toml` |
| `wrangler/access-verify.mjs` | Verify Pages and Worker Access protection |
| `docker/relay.compose.yml` | Reference compose file for the relay alone |
| `docker/relay-with-lego.compose.yml` | Relay plus lego certificate issuance |
| `docker/relay-with-traefik.compose.yml` | Relay behind Traefik TCP routing |
| `docker/relay-with-host-certbot.md` | Host-managed certbot instructions |
| `setup/doctor-local.sh` | DNS/TLS/SMTP/Worker check |
| `setup/doctor-delivery.sh` | Guided DKIM/DMARC delivery check |
