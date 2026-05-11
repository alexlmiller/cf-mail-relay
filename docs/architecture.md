# Architecture

This document is the compact contributor and agent reference for the project.
The README is the user-facing setup guide.

## Components

```text
SMTP client or application
  -> Go relay on TCP 587
  -> HMAC-signed HTTPS request
  -> Cloudflare Worker
  -> Cloudflare Email Sending send_raw
  -> recipient MX

Browser
  -> Cloudflare Access
  -> Pages admin UI
  -> Worker /admin/api/*
  -> D1/KV

HTTP client
  -> Worker /send
  -> Cloudflare Email Sending send_raw
```

| Component | Runtime | Responsibility |
|---|---|---|
| `relay/` | Go, Docker | SMTP STARTTLS/AUTH, size and recipient caps, HMAC relay calls |
| `worker/` | TypeScript, Hono, Cloudflare Workers | Policy, auth, idempotency, quotas, audit metadata, Email Sending API calls |
| `ui/` | Astro, Cloudflare Pages | Static admin UI protected by Cloudflare Access |
| `shared/` | TypeScript | Shared schemas and delivery status mapping |
| `infra/` | Shell/Node/Docker examples | Setup, Access helper, doctors, relay deployment examples |

## Trust Model

- D1 is the source of truth.
- KV is cache only.
- The relay is trusted infrastructure but still treated as revocable: Worker
  re-checks credentials, sender policy, quotas, and idempotency.
- Relay-to-Worker auth is HMAC. Cloudflare Access is not used on the SMTP data
  path.
- Admin UI auth is Cloudflare Access. The Worker validates the Access JWT for
  `/admin/api/*`.
- Message bodies are not stored. `send_events` stores metadata only.

## SMTP Flow

1. An SMTP client connects to relay over TCP `587`.
2. Relay requires STARTTLS, then `AUTH PLAIN` or `AUTH LOGIN`.
3. Relay sends `/relay/auth` to the Worker with an HMAC signature.
4. Worker validates the SMTP credential and returns allowed senders plus policy
   version.
5. Relay accepts `MAIL FROM`, `RCPT TO`, and `DATA` only if local caps and the
   returned sender policy allow it.
6. Relay sends raw MIME bytes to `/relay/send` with HMAC headers and an
   idempotency key.
7. Worker re-checks policy, reserves quota, strips capture-hop headers, calls
   Cloudflare Email Sending `send_raw`, and records a metadata audit row.
8. Relay maps the Worker result to an SMTP status for the client.

## HTTP Flow

`POST /send` accepts raw MIME from application clients.

- Auth: `Authorization: Bearer <api-key>`.
- Body: `from`, `recipients`, and base64/base64url raw MIME.
- Idempotency: `Idempotency-Key` header, with a deterministic fallback when
  absent.
- Authorization: API key user must be allowed to send as the `from` address.

## HMAC Contract

Relay requests include:

- `x-relay-key-id`
- `x-relay-timestamp`
- `x-relay-nonce`
- `x-relay-body-sha256`
- `x-relay-signature`

Canonical string:

```text
<METHOD>\n
<PATH_WITH_QUERY>\n
<TIMESTAMP>\n
<NONCE>\n
<BODY_SHA256_HEX>
```

Signature is HMAC-SHA256 over the canonical string using the relay shared
secret. Worker accepts current and previous secrets for rotation. Replay
protection uses timestamp skew plus nonce caching.

Shared test vectors live in `shared/test-vectors.json` and are exercised by both
the Go relay and TypeScript Worker tests.

## Data Model

The schema is in `worker/migrations/0001_init.sql`.

Important tables:

- `users`
- `domains`
- `allowlisted_senders`
- `smtp_credentials`
- `api_keys`
- `send_events`
- `auth_failures`
- `idempotency_keys`
- `rate_reservations`
- `settings`

Credential and API key hashes use HMAC-SHA256 keyed with `CREDENTIAL_PEPPER`.
Audit metadata that could reveal recipient domains, message IDs, or IPs uses
`METADATA_PEPPER`.

## Limits and Policy

- Max recipients: 50.
- Relay max MIME size: about 4.5 MiB by default.
- Worker defense-in-depth max body: 6 MiB.
- 8BITMIME is rejected by the relay for conservative JSON safety.
- Cloudflare Email Sending signs outbound mail; the Worker does not DKIM-sign.
- DMARC alignment is expected through Cloudflare DKIM on the sender domain.

Quotas:

- Relay: connection rate per remote IP, auth attempts per username, exponential
  auth-failure lockout.
- Worker: per-sender minute soft cap in KV; daily global/domain/sender/credential
  caps in D1 reservation rows.

## Routes

| Route | Purpose | Auth |
|---|---|---|
| `GET /healthz` | Liveness and D1 schema compatibility | none |
| `POST /bootstrap/admin` | Create first admin user | bootstrap token |
| `POST /relay/auth` | SMTP credential auth | HMAC |
| `POST /relay/send` | SMTP raw MIME send | HMAC |
| `POST /send` | HTTP raw MIME send | API key |
| `/admin/api/*` | Admin API | Cloudflare Access JWT |

## Development Checks

```sh
pnpm test
pnpm typecheck
pnpm build

cd relay
go vet ./...
go test ./...
```

CI runs Worker/shared tests, UI typecheck/build, relay Go tests, and multi-arch
Docker bake. Release-please owns unified semver. Relay release images are pushed
to GHCR when a release is created.

## Scope

Keep the MVP intentionally small:

- Send-only.
- Raw MIME only.
- One Cloudflare account per deployment.
- One Worker can serve many sending domains in that account.
- No inbound mail, templates, scheduling, mailing lists, or body storage.
