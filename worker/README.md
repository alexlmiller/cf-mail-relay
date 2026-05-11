# worker/

Cloudflare Worker. TypeScript. [Hono](https://hono.dev) framework.

The Worker is the policy and delivery authority. It calls the Cloudflare Email Sending `send_raw` API.

## Status

Scaffold only. Implementation lands across MS1–MS5 per `IMPLEMENTATION_PLAN.md`.

## Routes (planned)

| Route | Purpose | Auth |
|---|---|---|
| `GET /healthz` | Liveness + version + git SHA | none |
| `POST /relay/auth` | Verify SMTP credential, return short-lived policy snapshot | HMAC |
| `POST /relay/send` | Accept raw MIME from relay, call `send_raw` | HMAC + idempotency |
| `POST /send` | HTTP API for apps; raw MIME only in MVP | API key + idempotency |
| `GET /admin/api/*` | Admin endpoints consumed by the UI | CF Access JWT |

## Bindings

`wrangler.toml.example` lists the bindings adopters need to create. The Worker depends on:

- `D1_MAIN` — D1 database; schema in `migrations/0001_init.sql`.
- `KV_HOT` — KV namespace for credential cache, rate-limit counters, idempotency response cache, replay nonces.
- `CF_API_TOKEN` (secret) — scoped to Email Sending only.
- `CF_ACCOUNT_ID` (var).
- `CREDENTIAL_PEPPER` (secret) — HMAC pepper for SMTP credential and API key hashing.
- `METADATA_PEPPER` (secret) — HMAC pepper for hashed recipient domains, Message-IDs, IPs in audit log.
- `RELAY_HMAC_SECRET_CURRENT` (secret) — verifies HMAC-signed relay requests.
- `RELAY_HMAC_SECRET_PREVIOUS` (secret, optional) — for the rotation window.
- `BOOTSTRAP_SETUP_TOKEN` (secret, one-time) — admits the first admin user; rotated immediately after first use.
- `ACCESS_TEAM_DOMAIN` (var) — for JWKS URL.
- `ACCESS_AUDIENCE` (var) — JWT `aud` claim to enforce.

## Local development

```sh
cd worker
pnpm install
pnpm typecheck
pnpm test
pnpm exec wrangler dev
```

## Migrations

```sh
pnpm exec wrangler d1 migrations apply <DB_NAME>
```

The setup wizard (`pnpm setup` from repo root, MS6) automates all of this.
