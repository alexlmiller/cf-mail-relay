# infra/

Adopter-side tooling. Not deployed; runs locally on the adopter's workstation or CI.

| Path | Purpose | Milestone |
|---|---|---|
| `wrangler/setup.ts` | `pnpm setup` wizard: preflight checks, D1/KV creation, migrations, secret setting, Worker+Pages deploy, per-domain DNS guidance | MS6 |
| `docker/relay.compose.yml` | Reference compose file for the relay alone | MS5 |
| `docker/relay-with-lego.compose.yml` | Compose with `lego` sidecar for DNS-01 ACME via Cloudflare | MS5 |
| `docker/relay-with-traefik.compose.yml` | Compose with Traefik fronting the relay | MS5 |
| `docker/relay-with-host-certbot.md` | Host-managed `certbot` + bind-mount instructions | MS5 |
| `opentofu/cloudflare/` | Optional IaC module for adopters who prefer Terraform/OpenTofu | post-MVP |
| `setup/doctor-local.sh` | Automated DNS/TLS/SMTP/Worker/D1 check | MS5 |
| `setup/doctor-delivery.sh` | Guided DKIM/DMARC delivery check | MS5 |
