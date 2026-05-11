# worker/

Cloudflare Worker. TypeScript. [Hono](https://hono.dev) framework.

The Worker is the policy and delivery authority. It calls the Cloudflare Email Sending `send_raw` API.

## Status

MS1 relay endpoints are implemented. D1-backed credentials, audit logging,
idempotency, admin APIs, and the HTTP `/send` API land in later milestones per
`IMPLEMENTATION_PLAN.md`.

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
- `RELAY_HMAC_KEY_ID` (var, optional) — if set, only this relay key id is accepted.
- `RELAY_AUTH_USERNAME` / `RELAY_AUTH_PASSWORD` (secrets for MS1 only) — temporary SMTP credential check before D1-backed credentials land in MS2.
- `RELAY_ALLOWED_SENDERS` (var for MS1 only) — comma-separated policy snapshot returned by `/relay/auth`.
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

## MS0 spike

MS0 uses a disposable Worker entrypoint at `src/spike.ts`; it is not the production relay API. Copy `wrangler.spike.toml.example` to `wrangler.spike.toml`, set the required secrets, and follow [`../docs/ms0-spike.md`](../docs/ms0-spike.md).

```sh
pnpm ms0:spike:dev
pnpm ms0:spike:deploy
```

## Migrations

```sh
pnpm exec wrangler d1 migrations apply <DB_NAME>
```

The setup wizard (`pnpm setup` from repo root, MS6) automates all of this.
