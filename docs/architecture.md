# Architecture

Contributor reference for the current design. [README.md](../README.md) is the
adopter setup guide.

## Components

```text
SMTP client -> Go relay :587 -> HMAC HTTPS -> Worker -> Email Sending
HTTP client ----------------> bearer API -> Worker -> Email Sending
Browser -> public UI shell -> Access-gated API -> Worker -> D1/KV
```

| Path | Responsibility |
|---|---|
| `relay/` | Go SMTP STARTTLS/AUTH adapter and local limits |
| `worker/` | Policy, auth, delivery, state, and static UI hosting |
| `ui/` | Astro admin and sender self-service UI |
| `demo/` | Separate static demo with a browser-local mock API |
| `shared/` | Cross-runtime HMAC test vectors |
| `infra/` | Setup, operations, OpenTofu, and relay deployment tools |

The UI builds into `worker/public/`. Workers Static Assets serves it from the
same origin as the API. The demo has no production bindings or send routes.

Cloudflare also offers [native SMTP submission](https://developers.cloudflare.com/email-service/api/send-emails/smtp/)
on port `465`. This project's external relay remains useful for STARTTLS on
`587`, per-user credentials, sender policy, quotas, auditing, and idempotency.

## Trust boundaries

- D1 is authoritative. KV is a cache.
- The relay host is trusted but revocable. The Worker rechecks credentials,
  sender policy, quotas, and idempotency.
- Relay requests use HMAC. Cloudflare Access is not on the SMTP data path.
- `/send` uses scoped bearer API keys.
- `/admin/api/*` and `/self/api/*` use Cloudflare Access JWTs. The Worker checks
  issuer, audience, expiry, and token type. Unsafe browser methods also require
  the trusted `Origin`.
- The static UI, `/relay/*`, `/send`, `/bootstrap/admin`, and `/healthz` are not
  Access-gated. Each has its own auth or liveness contract.
- This project does not persist bodies, subjects, attachments, or recipient
  addresses. Cloudflare [Email Preview](https://developers.cloudflare.com/email-service/configuration/domains/#email-preview)
  is separate provider-side storage.

## SMTP flow

1. The client connects to port `587`, starts TLS, and uses `AUTH PLAIN` or
   `AUTH LOGIN`.
2. The relay calls `/relay/auth` with HMAC authentication.
3. The Worker validates the SMTP credential and returns its sender policy.
4. The relay enforces local connection, auth, sender, recipient, and size limits.
5. The relay sends raw MIME to `/relay/send` with signed envelope headers.
6. The Worker rechecks policy; validates singleton identity headers and MIME
   `From:` alignment; strips `Bcc` and capture-hop headers; and derives a
   deterministic idempotency fingerprint.
7. When safe and within Cloudflare's per-header value limit, the Worker appends
   the client's `Message-ID` to `References` as a conversation anchor.
8. The Worker reserves quota, calls Email Sending `send_raw`, records sanitized
   metadata, and returns a categorical result that the relay maps to SMTP.

## HTTP flow

`POST /send` requires:

- `Authorization: Bearer <api-key>`.
- JSON `from`, `recipients`, and base64/base64url raw MIME.
- A MIME `From:` that matches `from`.
- A user allowed to send as `from`.

`Idempotency-Key` is optional. User-supplied keys are scoped to the API key and
cannot replay a different request. Without one, the Worker derives a stable
request fingerprint.

## Relay HMAC

Every request includes:

- `x-relay-key-id`
- `x-relay-timestamp`
- `x-relay-nonce`
- `x-relay-body-sha256`
- `x-relay-version`
- `x-relay-signed-headers`
- `x-relay-signature`

The canonical HMAC-SHA256 input binds the method, pathname, timestamp, nonce,
body digest, key ID, and sorted signed header names and values. `/relay/send`
also signs the credential ID, envelope sender, and recipients. The trace ID is
diagnostic and intentionally unsigned.

The Worker accepts current and previous HMAC secrets during rotation. Timestamp
checks and D1 nonce reservations reject replays; D1 idempotency is the duplicate
send authority. The exact contract is implemented in `worker/src/hmac.ts` and
`relay/internal/hmacsign/`, with shared vectors in `shared/test-vectors.json`.

## State

The current schema is the ordered migration set in `worker/migrations/`
(version 6). Important state includes users, sending domains, sender grants,
SMTP credentials, API keys, settings, events, auth failures, quota reservations,
relay nonces, and idempotency records.

Credential and API-key hashes use HMAC-SHA256 with `CREDENTIAL_PEPPER`.
`METADATA_PEPPER` hashes recipient-domain sets, Message-ID values, and remote
IPs. Provider delivery arrays are reduced to counts and categorical
status/reason codes before storage.

## Limits and policy

- 50 recipients per message.
- Cloudflare's [standard message limit](https://developers.cloudflare.com/email-service/platform/limits/)
  is 5 MiB; 25 MiB applies only when every destination is verified.
- Relay MIME limit: 4.5 MiB by default.
- Worker decoded raw-MIME guard: 6 MiB; JSON encoding overhead is separate.
- The relay rejects 8BITMIME content; use base64 or quoted-printable.
- Cloudflare signs outbound mail with DKIM.
- Each relay process limits AUTH attempts per username and per remote IP at
  five times that limit. Exponential lockout is per username and remote-IP pair.
- Worker quotas cover minute-level sender traffic and daily global, domain,
  sender, and credential traffic.

## Routes

| Route | Auth |
|---|---|
| `GET /healthz` | Public liveness and schema check |
| `POST /bootstrap/admin` | Bootstrap token; manual recovery only |
| `POST /relay/auth` | Relay HMAC |
| `POST /relay/send` | Relay HMAC |
| `POST /send` | Bearer API key |
| `/admin/api/*` | Access JWT; admin role; Origin on unsafe browser methods |
| `/self/api/*` | Access JWT; Origin on unsafe browser methods |
| UI assets and SPA fallback | Public shell; data calls require Access |

## Scope

- Send-only raw MIME.
- One Cloudflare account per deployment; many sending domains are allowed.
- No inbound mail, templates, scheduling, mailing lists, multi-tenant SaaS, or
  message-body storage.

## Checks

```sh
pnpm test
pnpm typecheck
pnpm build

cd relay
go vet ./...
go test ./...
```

CI also validates local D1 migrations, Wrangler dry-runs, OpenTofu, shell and
Compose tooling, vulnerability checks, and multi-architecture relay builds.
Release-please owns the unified version; published relay images are built from
release tags.
