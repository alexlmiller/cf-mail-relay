# infra/

Adopter-side tooling. Not deployed; runs locally on the adopter's workstation or CI.

| Path | Purpose | Milestone |
|---|---|---|
| `wrangler/setup.mjs` | `pnpm run setup` wizard: preflight checks, command plan, Access/D1/KV/secret verification, and per-domain DNS guidance | MS6 |
| `wrangler/access-app.mjs` | Creates or updates the Cloudflare Access self-hosted app for the MS3 admin UI | MS3 |
| `docker/relay.compose.yml` | Reference compose file for the relay alone | MS5 |
| `docker/relay-with-lego.compose.yml` | Compose with `lego` certificate renewal via Cloudflare DNS | MS6 |
| `docker/relay-with-traefik.compose.yml` | Compose with Traefik managing ACME and TCP routing | MS6 |
| `docker/relay-with-host-certbot.md` | Host-managed `certbot` + bind-mount instructions | MS6 |
| `opentofu/cloudflare/` | Optional IaC module for adopters who prefer Terraform/OpenTofu | post-MVP |
| `setup/doctor-local.sh` | Automated DNS/TLS/SMTP/Worker/D1 check | MS5 |
| `setup/doctor-delivery.sh` | Guided DKIM/DMARC delivery check | MS5 |
