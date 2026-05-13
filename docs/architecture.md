# Architecture

This document is the compact contributor and agent reference for the project.
The README is the user-facing setup guide.

## Components

```text
SMTP client or application
  -> Go relay on TCP 587
  -> HMAC-signed HTTPS request
  -> Cloudflare Worker at mail.<zone>/relay/send
  -> Cloudflare Email Sending send_raw
  -> recipient MX

Browser
  -> public UI shell
  -> Worker serves /index.html via Workers Static Assets
  -> Cloudflare Access (path-scoped admin/self API)
  -> Worker /admin/api/* and /self/api/*  (same origin)
  -> D1/KV

HTTP client
  -> Worker /send (mail.<zone>/send)
  -> Cloudflare Email Sending send_raw
```

| Component | Runtime | Responsibility |
|---|---|---|
| `relay/` | Go, Docker | SMTP STARTTLS/AUTH, size and recipient caps, HMAC relay calls |
| `worker/` | TypeScript, Hono, Cloudflare Workers | Policy, auth, idempotency, quotas, audit metadata, Email Sending API calls, **serves the admin UI bundle via Workers Static Assets** |
| `ui/` | Astro, static bundle | Admin UI source; builds into `worker/public/` and is shipped with the Worker |
| `demo/` | Astro + Workers Static Assets | Standalone public demo Worker with an in-browser mock API and no production bindings |
| `shared/` | TypeScript | Shared schemas and delivery status mapping |
| `infra/` | Shell/Node/Docker examples | Setup, Access helper, doctors, relay deployment examples |

### Single-Origin Admin

The admin UI is served by the Worker (Workers Static Assets), not from a
separate Cloudflare Pages project. Everything an adopter exposes lives at one
hostname — `mail.<zone>` by default — so:

- One Cloudflare Access app with path-scoped destinations for `/admin/api/*`
  and `/self/api/*`.
- `/`, `/_astro/*`, `/relay/*`, `/send`, `/bootstrap/admin`, and `/healthz` are
  deliberately not Access-gated. The static UI shell is public, while the data
  APIs validate Access JWTs. Relay/send/bootstrap/health use HMAC, bearer,
  bootstrap-token, or public liveness semantics.
- No cross-origin requests from the UI to the API; the browser never issues a
  CORS preflight and Access never gates an `OPTIONS` request.
- No `PUBLIC_CF_MAIL_RELAY_API_BASE` to bake into the UI build; admin/self API
  calls go to relative URLs.
- No `ADMIN_CORS_ORIGIN` to configure in the common path; the Worker defaults
  its trusted Origin to its own URL. The env var only needs to be set if an
  operator chooses to serve the UI on a different origin.

Workers Static Assets is configured in `worker/wrangler.toml`:

```toml
[assets]
directory = "./public"
binding = "ASSETS"
not_found_handling = "single-page-application"
run_worker_first = true
```

`run_worker_first = true` lets the Worker handle its own routes (API,
`/healthz`, `/relay/*`, `/send`) before assets are checked. Unknown routes
fall through to the catch-all in `worker/src/index.ts` which delegates to
`env.ASSETS.fetch(req)` — Workers Static Assets serves the matched file or
the SPA shell (`/index.html`) per the `single-page-application` fallback.

### Public Demo

The click-through demo is a separate static Worker under `demo/`. It imports the
same UI app shell and installs an in-browser mock API before booting. It must
not share the production Worker's route list, D1 database, KV namespace, Access
app, Email Sending token, relay HMAC secrets, or bootstrap token.

Production `worker/wrangler.toml` should only bind the real relay/admin
hostname. Demo deployments use `demo/wrangler.toml` and currently bind
`relay-demo.alexmiller.net`.

## Cloudflare Boundary

Worker (UI + API), D1, KV, Access, and Email Sending run on Cloudflare. The
SMTP relay does not, because SMTP submission requires a public raw TCP
listener on port `587`; Cloudflare Workers and Containers currently expose
HTTP/WebSocket request handling rather than arbitrary inbound TCP services.

The relay is intentionally a thin edge adapter. It can run on existing
infrastructure or a small public VM, including a GCP free-tier eligible
`e2-micro` instance, while policy, credentials, quotas, idempotency, and
delivery remain in Cloudflare. Provider free tiers usually have region, disk,
and egress limits, so deployment docs should avoid promising zero cost.

The Worker runtime Cloudflare API token is intentionally narrower than the
setup token. It needs Account Email Sending Edit for `send_raw` plus Zone Read
for the sending zones so admin domain create/refresh can discover zone IDs and
Email Sending status. It does not need DNS edit or Access/D1/KV management
permissions at runtime.

## Trust Model

- D1 is the source of truth.
- KV is cache only.
- The relay is trusted infrastructure but still treated as revocable: Worker
  re-checks credentials, sender policy, quotas, and idempotency.
- Relay-to-Worker auth is HMAC. Cloudflare Access is not used on the SMTP data
  path. Relay HMAC signatures bind the request body and the relay headers that
  affect authorization.
- Admin UI auth is Cloudflare Access. The Worker validates the Access JWT for
  `/admin/api/*` and `/self/api/*`, including issuer, audience, expiry, and
  Access token type. Unsafe browser admin/self methods also enforce the
  configured `Origin`; non-browser scripts without `Origin` or Fetch Metadata
  headers proceed to Access JWT authorization.
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
7. Worker re-checks policy, rejects duplicate singleton identity headers,
   requires the MIME `From:` header to match the authorized SMTP envelope,
   reserves quota, strips capture-hop and `Bcc` headers, calls Cloudflare Email
   Sending `send_raw`, and records a metadata audit row.
8. Relay maps the Worker result to an SMTP status for the client.

## HTTP Flow

`POST /send` accepts raw MIME from application clients.

- Auth: `Authorization: Bearer <api-key>`.
- Body: `from`, `recipients`, and base64/base64url raw MIME. The MIME `From:`
  header must match `from`; recipients must be valid mailbox addresses; `Bcc:`
  is stripped before delivery.
- Idempotency: `Idempotency-Key` header, with a deterministic fallback when
  absent. Supplied HTTP keys are scoped to the API key and cannot replay a
  different request hash.
- Authorization: API key user must be allowed to send as the `from` address.

## HMAC Contract

Relay requests include:

- `x-relay-key-id`
- `x-relay-timestamp`
- `x-relay-nonce`
- `x-relay-body-sha256`
- `x-relay-signed-headers`
- `x-relay-signature`

Canonical string:

```text
<METHOD>\n
<PATH>\n
<TIMESTAMP>\n
<NONCE>\n
<BODY_SHA256_HEX>\n
<KEY_ID>\n
<SIGNED_HEADER_NAMES>\n
<SIGNED_HEADER_VALUES>
```

Signature is HMAC-SHA256 over the canonical string using the relay shared
secret. `<PATH>` is the URL pathname only; relay endpoints do not use query
strings, avoiding ambiguous query canonicalization rules. Worker accepts
current and previous secrets for rotation. Replay
protection uses timestamp skew plus D1-backed nonce reservations, with
idempotency as the authoritative duplicate-send defense.

`/relay/send` must sign:

- `x-relay-credential-id`
- `x-relay-envelope-from`
- `x-relay-recipients`
- `x-relay-version`

Shared test vectors live in `shared/test-vectors.json` and are exercised by both
the Go relay and TypeScript Worker tests.

## Data Model

The schema is in `worker/migrations/0001_init.sql`.

Important tables:

- `users`
- `domains` — Cloudflare zone ID and Email Sending status are synced through
  the Cloudflare API on create and via the admin refresh action.
- `allowlisted_senders`
- `smtp_credentials`
- `api_keys`
- `send_events`
- `auth_failures`
- `idempotency_keys`
- `relay_nonces`
- `rate_reservations`
- `settings`

Credential and API key hashes use HMAC-SHA256 keyed with `CREDENTIAL_PEPPER`.
Audit metadata that could reveal recipient domains, message IDs, or IPs uses
`METADATA_PEPPER`. Cloudflare delivery arrays are summarized before storage so
audit rows do not persist full recipient addresses from provider responses; the
summary keeps only counts and categorical reason/status codes.

## Limits and Policy

- Max recipients: 50.
- Relay max MIME size: about 4.5 MiB by default.
- Worker defense-in-depth max body: 6 MiB.
- 8BITMIME is rejected by the relay for conservative JSON safety.
- Cloudflare Email Sending signs outbound mail; the Worker does not DKIM-sign.
- DMARC alignment is expected through Cloudflare DKIM on the sender domain.

Quotas:

- Relay: connection rate per remote IP, auth attempts per username+remote pair
  with a remote-IP aggregate bucket, exponential auth-failure lockout.
- Worker: per-sender minute and daily global/domain/sender/credential caps in
  D1 reservation rows.

## Routes

| Route | Purpose | Auth |
|---|---|---|
| `GET /healthz` | Liveness and D1 schema compatibility | none |
| `POST /bootstrap/admin` | Create first admin user | bootstrap token |
| `POST /relay/auth` | SMTP credential auth | HMAC |
| `POST /relay/send` | SMTP raw MIME send | HMAC |
| `POST /send` | HTTP raw MIME send | API key |
| `GET /` and `/_astro/*` | Admin UI bundle | none; API calls require Access |
| `/self/api/login` | Browser login bounce back to the UI after Access auth | Cloudflare Access JWT |
| `/admin/api/*` | Admin API | Cloudflare Access JWT + Origin on unsafe browser methods |
| `/self/api/*` | Sender self-service API | Cloudflare Access JWT + Origin on unsafe browser methods |

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
