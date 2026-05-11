# worker/

Cloudflare Worker. TypeScript. [Hono](https://hono.dev) framework.

The Worker is the policy and delivery authority. It calls the Cloudflare Email Sending `send_raw` API.

## Status

MS5 is implemented. Relay and HTTP send endpoints use D1-backed credentials,
sender policy, idempotency, metadata-only audit rows, and configurable send
quotas. `/admin/api/*` is protected by Cloudflare Access JWT validation.

## Routes

| Route | Purpose | Auth |
|---|---|---|
| `GET /healthz` | Liveness, version, git SHA, and D1 schema compatibility | none |
| `POST /bootstrap/admin` | Create the first admin user when no users exist | `BOOTSTRAP_SETUP_TOKEN` bearer |
| `POST /relay/auth` | Verify SMTP credential, return short-lived policy snapshot | HMAC |
| `POST /relay/send` | Accept raw MIME from relay, call `send_raw` | HMAC + idempotency |
| `POST /send` | HTTP API for apps; raw MIME only in MVP | API key + idempotency |
| `/admin/api/*` | Dashboard, users, domains, senders, SMTP credentials, events, failures | CF Access JWT |

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
- `BOOTSTRAP_SETUP_TOKEN` (secret, one-time) — admits the first admin user while no `users` row exists.
- `ACCESS_TEAM_DOMAIN` (var) — for JWKS URL.
- `ACCESS_AUDIENCE` (var) — JWT `aud` claim to enforce.
- `ADMIN_CORS_ORIGIN` (var, optional) — Pages origin allowed to call `/admin/api/*` when the UI and Worker are on different hostnames.

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
