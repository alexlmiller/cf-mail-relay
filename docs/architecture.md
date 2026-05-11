# Architecture

Three components. One trust direction. One source of truth.

```
┌──────────────┐   SMTP 587 + STARTTLS + AUTH   ┌────────────────────┐
│ Gmail        │ ──────────────────────────────▶│  smtp.<domain>     │
│ "Send as"    │                                │  Docker SMTP relay │
└──────────────┘                                │   (Go, on BYO host)│
                                                └─────────┬──────────┘
                                                          │ HTTPS POST /relay/*
┌──────────────┐   HTTPS POST /send             ┌─────────▼──────────┐
│ App / script │ ──────────────────────────────▶│ Cloudflare Worker  │
└──────────────┘                                │ (Hono, TypeScript) │
                                                │ /relay /send       │
                                                │ /admin/api  /healthz│
                                                └─────────┬──────────┘
                                                          │
                              ┌───────────────────────────┼───────────────────────────┐
                              │                           │                           │
                       ┌──────▼──────┐             ┌──────▼──────┐             ┌──────▼──────────┐
                       │ D1 (TRUTH)  │             │ KV (CACHE)  │             │ CF Email Sending │
                       │ users,      │             │ creds, rate │             │ POST send_raw    │
                       │ creds (h),  │             │ idem resp,  │             │ (JSON body)      │
                       │ events,     │             │ nonces      │             └──────┬───────────┘
                       │ idem keys   │             └─────────────┘                    │
                       └─────────────┘                                                 ▼
                                                                                recipient MX
┌──────────────┐  HTTPS  ┌────────────────┐
│ Browser      │ ──────▶ │ Pages (static) │ ── fetch ──▶ Worker /admin/api/*
│ (CF Access)  │         │  UI bundle     │
└──────────────┘         └────────────────┘
```

## Trust boundaries

- **Public inbound**: relay `587` (SMTP) and Worker (HTTPS).
- **Worker is the policy and delivery authority.** Relay holds no persistent secrets except its HMAC shared secret and TLS cert.
- **D1 is the source of truth.** KV is cache only; cache misses fall back to D1.

## Data flow — SMTP submission path

1. Gmail TCP `587` to `smtp.<domain>` (relay).
2. `EHLO`, `STARTTLS` using mounted cert.
3. `AUTH PLAIN`/`LOGIN`.
4. Relay calls Worker `POST /relay/auth` (HMAC-signed) with `{username, password}`. Worker verifies against D1 (KV cache), returns short-lived `{ok, user_id, policy_version, allowed_sender_ids, ttl_seconds}`. Relay caches the decision.
5. `MAIL FROM:<sender>`, `RCPT TO:<rcpt>`, `DATA`.
6. Relay enforces sender allowlist, recipient cap (50), size cap (4.5 MiB final MIME), 8-bit rejection.
7. Relay POSTs raw MIME to Worker `POST /relay/send` (HMAC-signed + `Idempotency-Key`).
8. Worker re-verifies policy, enforces daily quotas (D1 reservation rows), calls `send_raw` (JSON), writes `send_events`, returns `{smtp_code, message_id}`.
9. Relay returns the SMTP code to Gmail.

## Data flow — HTTP submission path

1. App `POST https://worker.<domain>/send` with `Authorization: Bearer <api_key>` and `{raw: "<base64 MIME>"}`.
2. Worker validates API key via D1 (KV cache), enforces allowlist + caps + idempotency.
3. Same `send_raw` call + audit log.
4. Returns `{accepted, message_id, cf_request_id}`.

## Multi-domain

One Worker, one CF account, many sending domains. The `domains` table is plural; `allowlisted_senders.domain_id` scopes senders per-domain; `send_raw` routes by the `from` address. See `IMPLEMENTATION_PLAN.md` § Multi-domain support.

## What this architecture explicitly does not do

- No queueing of mail. Worker call is synchronous from inside `DATA`. If the Worker is unreachable, the relay returns `451 4.7.1` and the sender retries.
- No DKIM signing in the Worker. Cloudflare DKIM-signs at the platform level.
- No re-encoding of MIME. Pass-through end to end.
- No body storage. Audit log is metadata only.
- No multi-account fan-out. One Worker serves one Cloudflare account.
