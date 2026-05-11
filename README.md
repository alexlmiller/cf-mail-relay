# Cloudflare Mail Relay

Turnkey, self-hosted, open-source SMTP-to-Cloudflare-Email-Sending bridge.

Three deployable components running on Cloudflare + one BYO Docker host:

1. **Docker SMTP relay** — accepts authenticated SMTP submission on `587` (STARTTLS + AUTH PLAIN/LOGIN), forwards raw RFC 5322 MIME to the Worker over HTTPS.
2. **Cloudflare Worker** — calls the Cloudflare Email Sending `send_raw` API. Also exposes a JSON `/send` HTTP API for applications.
3. **Cloudflare Pages admin UI** — state in D1 + KV. Auth via Cloudflare Access.

The canonical use case: replace Mailgun for Gmail's "Send mail as" feature on a custom domain, using your own Cloudflare account.

> **Status**: pre-MVP. The implementation plan is locked in [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md). The next step is **MS0** — a one-day spike proving `send_raw` accepts a captured Gmail MIME payload with DKIM/DMARC alignment intact. Block all other work until MS0 passes.

## Highlights

- **Multi-domain ready**: one Worker can send for many domains in the same Cloudflare account.
- **Send-only by design**: no inbound handling, no templates, no mailing lists, no message-body storage. The Worker is a thin policy layer in front of `send_raw`.
- **Pass-through MIME**: never parses or rebuilds messages. What Gmail sends is what gets delivered.
- **D1 = source of truth, KV = cache**: revocation, idempotency, and strict daily quotas are arbitrated in D1.
- **HMAC-signed relay → Worker**: no Cloudflare Zero Trust required for the data path.
- **Cloudflare Access on the admin UI**: standard SSO; free tier covers ≤50 users.

## Required adopter prerequisites

- A Cloudflare account on the **Workers Paid** plan (Email Sending requires Workers Paid).
- DNS managed on Cloudflare for the sending domain(s).
- Email Sending verified for each sending domain (out of sandbox if you want to send to arbitrary recipients).
- A Docker-capable host that allows inbound TCP `587` (Hetzner, Coolify, etc.). The host's outbound is HTTPS only — no SMTP outbound needed.

## Repository layout

```
relay/    Go SMTP daemon, multi-arch Docker image
worker/   Cloudflare Worker (TypeScript, Hono framework)
ui/       Cloudflare Pages admin app (Astro)
shared/   TypeScript types, zod schemas, HMAC test vectors
infra/    Setup wizard, Docker compose examples, doctor scripts
docs/     Architecture, deployment, security, threat model
examples/ Sample clients (curl, Node, Python) and Gmail MIME fixtures
ADR/      Architecture decision records
```

## Getting started

> The build is not yet underway. See [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) for the milestone-by-milestone plan.

When MS6 ships, the adopter flow will be:

```sh
# Use this template -> clone -> setup
pnpm install
pnpm setup          # wizard: CF account preflight, D1, KV, secrets, deploy
docker compose -f infra/docker/relay.compose.yml up -d
pnpm doctor:local   # automated check
pnpm doctor:delivery --domain example.com
```

## Spun out of

- [alexlmiller/infra#746](https://github.com/alexlmiller/infra/issues/746) — original SMTP-to-Cloudflare bridge plan inside the infra repo. Extracted here so others can run their own.

## License

Apache-2.0. See [`LICENSE`](./LICENSE).
