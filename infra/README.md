# infra/

Adopter tooling that runs on a workstation or in CI.

| Path | Purpose |
|---|---|
| `wrangler/setup.mjs` | Preflight and resumable apply for D1, KV, Access, secrets, migrations, deploy, bootstrap, and runbook. A new install pauses until the separate runtime token is set. |
| `wrangler/access-app.mjs` | Create/update the Cloudflare Access app (path-scoped destinations: `/admin/api/*`, `/self/api/*`). |
| `wrangler/access-apply.mjs` | Write Access values into `worker/wrangler.toml`. |
| `wrangler/access-verify.mjs` | Strict live verifier for the Access gate. |
| `wrangler/rotate-hmac.mjs` | Generate a new HMAC secret and print the rotation runbook. |
| `docker/relay.compose.yml` | Supported hardened relay Compose service (host-managed certificates). |
| `docker/.env.example` | Immutable image pin and runtime configuration template. |
| `docker/sync-certificates.sh` | Check a renewed certificate and key, publish them as one atomic PEM bundle, then restart the relay. |
| `docker/README.md` | Relay install, renewal, upgrade, rollback, and verification. |
| `opentofu/` | Optional declarative provisioning of D1, KV, Access (worker script + secrets stay out of tfstate). |
| `setup/doctor-local.sh` | DNS/TLS/SMTP/Worker check. |
| `setup/doctor-delivery.sh` | Guided DKIM/DMARC delivery check. |
