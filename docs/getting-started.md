# Getting Started

> **Status**: pre-MVP. The setup wizard described here lands in MS6. Until then, follow `IMPLEMENTATION_PLAN.md` directly.

## Prerequisites

- A Cloudflare account on the **Workers Paid** plan.
- DNS managed on Cloudflare for each sending domain.
- A Docker-capable host that allows inbound TCP `587`.
- `pnpm`, `wrangler`, and `docker` installed locally.

## Adopter flow (MS6 target)

```sh
# 1. Use this template -> clone.
gh repo create my-mail-relay --template alexlmiller/cf-mail-relay --private
cd my-mail-relay
pnpm install

# 2. Run the setup wizard. It will:
#    - Verify Workers Paid, Email Sending status, D1 production backend.
#    - Prompt for one or more sending domains (REPEATABLE step).
#    - Create D1 database, KV namespace, run migrations.
#    - Set Worker secrets (HMAC, peppers, CF API token, bootstrap admin).
#    - Deploy Worker + Pages.
#    - Print the DNS records each domain needs.
pnpm setup

# 3. Add the DNS records per docs/dns.md (per domain) and wait for verification.

# 4. Bring up the relay on your host.
docker compose -f infra/docker/relay.compose.yml up -d

# 5. Health checks.
pnpm doctor:local
pnpm doctor:delivery --domain example.com

# 6. Configure Gmail "Send mail as" (see docs/gmail-send-mail-as.md).
```

Until the MS6 setup wizard exists, configure the Cloudflare Access application
for the admin UI with [`cloudflare-access.md`](./cloudflare-access.md).

## Adding multiple sending domains

Multi-domain is first-class — one Worker handles many domains in the same Cloudflare account. There are three ways to add domains:

1. **During `pnpm setup`**: the "Add domain" step is repeatable. Add as many as you want at install time.
2. **In the admin UI later**: Domains → Add domain. The UI shows the DNS records you need to publish and tracks verification status per domain.
3. **From the CLI**: `wrangler d1 execute cf-mail-relay --command "INSERT INTO domains ..."` (escape hatch; not the recommended path).

Each domain gets its own:
- `cf-bounce.<domain>` records (see `docs/dns.md`).
- DKIM CNAME/TXT.
- DMARC TXT (start at `p=none`).
- Verification status tracked in `domains.status`.

The relay hostname (`smtp.<some-domain>`) is **shared** across all domains. Pick one. Gmail's "Send mail as" doesn't care that the submission server's hostname differs from the address's domain.

## Adding multiple admin users

After your bootstrap admin exists, sign in to the UI via Cloudflare Access and add more users from the Users page. Each user signs in with their own Access identity; the `users.access_subject` column maps Access `sub` claims to local user rows.

## Where to look for more

- `docs/dns.md` — DNS records, single and multi-domain.
- `docs/cloudflare-access.md` — Access app setup for the admin UI.
- `docs/gmail-send-mail-as.md` — Gmail-side configuration.
- `docs/http-api.md` — using the HTTP `/send` API from applications.
- `docs/operations.md` — rotation, backup/restore, doctor scripts.
- `docs/security.md` — auth model, HMAC contract, threat model summary.
- `docs/cloudflare-email-sending.md` — Workers Paid, sandbox, limits, MIME quirks.
- `IMPLEMENTATION_PLAN.md` — the canonical build spec.
