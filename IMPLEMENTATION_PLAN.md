# Final Synthesis — Cloudflare Worker SMTP Mail Relay

This is the implementation-ready plan. It supersedes `draft-synthesis.md`. All Codex challenge items from `codex-synthesis-review.md` have been incorporated. None were dismissed.

The plan is for a **new standalone open-source repo** (`cf-mail-relay` or similar). Bootstrapped separately from the `alexlmiller/infra` repo. Spun out of `alexlmiller/infra#746`.

## Chosen Approach

A GitHub-template **monorepo** with three deployable components:

1. **`relay/`** — Go SMTP submission daemon, multi-arch Docker. Listens on `587` with `STARTTLS` + `AUTH PLAIN/LOGIN`. **Pass-through MIME only**; never parses or mutates message bytes. Forwards raw RFC 5322 to the Worker over HTTPS with an HMAC-signed request. TLS cert/key **mounted from disk**; example sidecar configs (lego, Caddy, Traefik, host certbot) provided.
2. **`worker/`** — TypeScript Cloudflare Worker on **Hono**. Routes: `/relay/auth`, `/relay/send`, `/send` (HTTP API), `/admin/api/*` (UI), `/healthz`. The Worker is the **policy and delivery authority**. It verifies SMTP credentials (relay never receives hashes), enforces send policy, calls Cloudflare Email Sending `send_raw` (documented JSON shape), and writes metadata-only `send_events` to D1.
3. **`ui/`** — Astro static site on Cloudflare Pages, behind a Cloudflare Access application that also fronts the Worker `/admin/api/*` route. Worker verifies `Cf-Access-Jwt-Assertion` against JWKS + audience.

Persistent state in **D1** (source of truth) with **KV** as hot-path cache. D1 owns idempotency arbitration, strict rate quotas, and revocation. KV caches credentials, allowlist, completed idempotency responses, and replay nonces.

Distribution: **GitHub template repository** + `pnpm setup` Wrangler-driven wizard with **explicit preflight checks** (Workers Paid plan, Email Sending domain verification status, D1 production backend, KV namespace, Access app).

## Key Agreements (carried forward from draft)

1. Three-component monorepo with pnpm workspaces + standalone Go module.
2. **Go** for relay (`emersion/go-smtp`), **Hono** for Worker, **Astro** for UI.
3. **Cloudflare Access** as default UI auth. No built-in password fallback in MVP; clean auth adapter boundary preserved.
4. Worker does **not** DKIM-sign; Cloudflare DKIM-signs at the platform level.
5. **Pass-through raw MIME** end-to-end. No parsing or rebuilding.
6. **D1 = source of truth, KV = cache**, with `policy_version` and revocation tombstones.
7. **No on-disk SMTP queue** in MVP; synchronous Worker call, `4xx` on Worker unreachable, Gmail retries.
8. **MS0 gate**: prove `send_raw` accepts a captured Gmail MIME payload before any other code.
9. **Strict scope gates** through MVP: no inbound, no templates, no lists, no body storage, no multi-tenant, no Cloudflare product beyond Workers + Pages + D1 + KV + Access + Email Sending.

## Multi-domain support

**One Worker handles multiple sending domains** as long as they live in the same Cloudflare account. This is first-class, not an afterthought.

- The Cloudflare Email Sending API is `POST /accounts/{account_id}/email/sending/send_raw`. It routes by the `from` address in the JSON body and verifies that domain has Email Sending enabled in the account. **One `CF_API_TOKEN`, many domains.**
- The D1 schema is plural-by-design: `domains` is a table; `allowlisted_senders.domain_id` scopes senders per-domain; `smtp_credentials.allowed_sender_ids_json` lets a single credential span one or many domains.
- Rate reservations are already scoped per `domain_day` / `sender_day` / `credential_day` / `global_day`, so per-domain quotas are free.
- The relay listens on a single `smtp.<primary-domain>` hostname and serves submissions for all configured sending domains. Gmail's "Send mail as" accepts the same SMTP server for multiple custom addresses.
- DNS records (cf-bounce MX, SPF, DKIM, DMARC, plus DNS-only `smtp.<domain>`) are per-domain. The setup wizard surfaces this explicitly.

**Where multiple Workers are required**: domains spread across multiple Cloudflare accounts (since `CF_API_TOKEN` is account-scoped). The setup docs recommend consolidating into one account; only when that's not possible should an adopter deploy one Worker per account.

## Resolved Disagreements (carried forward + tightened by Codex's final review)

| # | Topic | Decision |
|---|---|---|
| 1 | Relay → Worker auth | **HMAC only** (with concrete contract defined before MS1 — see "HMAC contract" below). No CF Access service token on data path. |
| 2 | Where credentials are verified | **Worker verifies**; relay never receives credential hashes. |
| 3 | SMTP credential hashing | **HMAC-SHA256 keyed with server-side pepper** (`CREDENTIAL_PEPPER`). |
| 4 | `send_raw` API call shape | **Documented JSON body** with `from`, `recipients`, `mime_message`. MS0 verifies + documents `mime_message` encoding for 8-bit/non-UTF-8 edge cases. |
| 5 | Relay TLS cert acquisition | **Mounted cert/key files**; reload on file change; sidecar examples shipped. |
| 6 | Admin auth verification | Verify **`Cf-Access-Jwt-Assertion`** against JWKS + AUD. Email header is display-only. |
| 7 | KV consistency model | D1 row versions + `policy_version` + revocation tombstones + short KV TTL. Security-sensitive reads fall back to D1. |
| 8 | Rate-limit split | **Relay**: SMTP-protocol abuse. **Worker**: business policy via **D1 reservation rows** for strict quotas; KV for soft pre-check only. |
| 9 | DKIM header handling | No stripping in MVP. Pass-through is the default. |
| 10 | DMARC policy in docs | Start adopters at **`p=none`**; escalate after doctor confirms alignment. |
| 11 | **Idempotency storage** | **D1-backed**, not KV-backed. Dedicated `idempotency_keys` table with `UNIQUE(idempotency_key)`. KV caches completed responses for fast replay only. |
| 12 | **SMTP idempotency key derivation** | **Does NOT include session-id.** Key = `sha256(source \|\| envelope_from \|\| sorted_recipients \|\| message_id_header \|\| mime_sha256)`. Session id is for tracing only. |
| 13 | Built-in password fallback | Not in MVP; auth adapter boundary preserved. |

## Codex final-review items folded in

All of Codex's challenge items were valid. The following were incorporated:

### Hard corrections

1. **Idempotency is D1-backed**. New table `idempotency_keys` (schema below). The Worker takes a row-level lock on the key (D1 `INSERT OR FAIL`) before calling `send_raw`. On retry, if status is `completed`, replay the cached response. If `pending`, return a transient error so the original in-flight request can finish. KV caches `completed` responses with 24 h TTL for fast read; KV miss falls through to D1.
2. **SMTP idempotency key omits session-id**. Stable key shape locks duplicate suppression across Gmail reconnects.
3. **HMAC contract is fully specified before MS1** (see "HMAC contract" below). Frozen and committed to `docs/security.md` with shared test vectors.
4. **Email Sending plan & recipient restrictions surfaced in setup preflight + docs**: Workers **Paid** plan required; new accounts often start in a sandbox where only verified recipient addresses are allowed.
5. **D1 Time Travel wording corrected**: Time Travel is always-on for production D1. Setup verifies the database is on the production backend, documents the retention window (currently 30 days), and warns that restore is **destructive** (point-in-time replaces current state).
6. **`mime_message` encoding decision**: JSON string; UTF-8. MS0 spike explicitly tests `8BITMIME` and `Content-Transfer-Encoding: 8bit` payloads. MVP decision: if the relay receives 8-bit content that cannot be safely encoded into a UTF-8 JSON string, **the relay rejects at `DATA`** with `554 5.6.0 8-bit content not supported in MVP; use base64 or quoted-printable`. Re-evaluate post-MVP if real adopters hit this.
7. **Doctor script split**:
   - `doctor:local` — DNS resolution, TLS handshake, SMTP AUTH, Worker `/healthz`, D1 reachability via Worker, event creation visible in `send_events`. Fully automated. Green/red exit code.
   - `doctor:delivery` — guided manual flow. Generates a unique subject token, instructs the adopter to send a test message via Gmail "Send mail as", then prompts the adopter to paste the received message's headers (or forward the message to a sentinel address) so the script can verify DKIM/DMARC pass.
8. **5 MiB cap surfaced in setup UX**: setup wizard prints the original-attachment guideline (~3.25 MiB after base64 expansion + headers). Relay enforces on **final MIME bytes** at `DATA`. Docs include a "why is my attachment too big" note.

### Schema corrections

9. `api_keys.user_id` is **NOT NULL** (no system keys in MVP).
10. `api_keys.key_prefix` is **UNIQUE**; create flow regenerates on collision.
11. Recipient-domain hashing uses **HMAC with a metadata pepper** (`METADATA_PEPPER`), not plain SHA-256, to prevent dictionary reversal of common domains.
12. `send_events.error_message` removed. `error_code` (categorical enum) and `cf_error_code` (Cloudflare's code) only. Raw provider error text goes to per-request debug logs with redaction, **not** to D1.

### Other corrections

13. **MS0 exit criterion** rewritten: byte-for-byte preservation between Worker input and Cloudflare API request body. Semantic preservation only at the recipient mailbox (downstream may fold headers).
14. **MS4 is raw-MIME only** for `/send`. Structured JSON assembly moved explicitly to the roadmap. No hidden MIME-builder scope.
15. **Partial-recipient policy**: defined now. CF `send_raw` returns delivered / queued / permanent_bounces. SMTP "Send mail as" path is typically one recipient at a time. MVP policy:
    - If CF returns 2xx and at least one recipient is `delivered` or `queued`: relay returns `250 2.0.0 Ok <message-id>`. Per-recipient outcomes captured in `send_events.cf_*_json`.
    - If CF returns 2xx with **all** recipients in `permanent_bounces`: relay returns `550 5.1.1 No valid recipients accepted`. (After DATA, per-recipient SMTP rejection is not possible in submission; this is the cleanest signal.)
    - If CF returns 4xx: relay returns `451 4.7.1`.
    - If CF returns 5xx: relay returns `554 5.3.0`.
    - Setup wizard preflight verifies the adopter's Email Sending account is **out of sandbox** before promising "send to any recipient" (sandbox accounts can only deliver to verified addresses, which will permanent-bounce everything else).

### New preflight checks (setup wizard)

- Cloudflare account has Workers **Paid** subscription.
- Email Sending is **enabled** on the target account.
- Email Sending domain status: `verified`; warn loudly if `sandbox`.
- D1 database is on the production backend (Time Travel available).
- KV namespace exists and is bound.
- Access application is configured and protects the UI hostname + Worker `/admin/api/*`.
- Required Worker secrets present: `CF_API_TOKEN`, `CREDENTIAL_PEPPER`, `METADATA_PEPPER`, `RELAY_HMAC_SECRET_CURRENT`, `BOOTSTRAP_SETUP_TOKEN` (one-time).

### Version compatibility

- Worker declares `REQUIRED_D1_SCHEMA_VERSION` at build time; checks `settings.schema_version` at startup. Mismatch → 500 with categorical error code.
- Relay sends `X-Relay-Version: <semver>` on every Worker call. Worker rejects unsupported relay versions with `426 Upgrade Required` (mapped to SMTP `451 4.7.0`).
- Releases are unified semver across all three components via `release-please`.

## HMAC contract (frozen for MS1)

```
Headers:
  X-Relay-Key-Id:        <opaque key id, e.g. rel_01HABCDE...>
  X-Relay-Timestamp:     <unix seconds, integer>
  X-Relay-Nonce:         <128-bit nonce, base64url, no padding>
  X-Relay-Body-SHA256:   <hex lowercase, lowercase 'sha256:' prefix optional>
  X-Relay-Version:       <relay semver>
  X-Relay-Signature:     <base64url, no padding>

Canonical string (UTF-8, joined with literal LF '\n', no trailing LF):
  uppercase(method)         e.g. "POST"
  exact-path                e.g. "/relay/send"  (no query string in MVP)
  X-Relay-Timestamp value   decimal string
  X-Relay-Nonce value       base64url
  X-Relay-Body-SHA256 value lowercase hex
  X-Relay-Key-Id value      string

Signature:
  base64url(HMAC_SHA256(secret_bytes, canonical_string))

Verification:
  - method, path normalized exactly as sent
  - timestamp skew window: ±60 seconds vs Worker's wall clock
  - nonce stored in KV at "nonce:<key_id>:<nonce>" with TTL 120 seconds; reject on present
  - constant-time signature compare
  - dual-secret rotation: accept HMAC_SECRET_CURRENT or HMAC_SECRET_PREVIOUS for up to 1 hour after rotation

Body hash:
  - Worker recomputes SHA-256 over the request body bytes before any decoding
  - Mismatch -> 400 invalid_body_hash
  - Length cap: 6 MiB at Worker (defense in depth above relay's 4.5 MiB cap)

Test vectors:
  - docs/security.md ships 3 canonical (input -> signature) examples
  - shared/test-vectors.json consumed by both worker/ unit tests and relay/ unit tests
```

## D1 Schema (consolidated, with all Codex corrections)

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id              TEXT PRIMARY KEY,            -- ulid
  email           TEXT UNIQUE NOT NULL,
  display_name    TEXT,
  access_subject  TEXT,                        -- CF Access JWT sub
  role            TEXT NOT NULL CHECK (role IN ('admin','sender')),
  disabled_at     INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE domains (
  id                 TEXT PRIMARY KEY,
  domain             TEXT UNIQUE NOT NULL,
  cloudflare_zone_id TEXT,
  status             TEXT NOT NULL,            -- pending|verified|sandbox|disabled
  dkim_status        TEXT,
  spf_status         TEXT,
  dmarc_status       TEXT,
  enabled            INTEGER NOT NULL DEFAULT 1,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

CREATE TABLE allowlisted_senders (
  id          TEXT PRIMARY KEY,
  domain_id   TEXT NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,                   -- full address or '*@<domain>' wildcard
  user_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE (domain_id, email)
);

CREATE TABLE smtp_credentials (
  id                       TEXT PRIMARY KEY,
  user_id                  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                     TEXT NOT NULL,
  username                 TEXT UNIQUE NOT NULL,
  secret_hash              TEXT NOT NULL,      -- HMAC-SHA256(CREDENTIAL_PEPPER, secret) hex
  hash_version             INTEGER NOT NULL DEFAULT 1,
  allowed_sender_ids_json  TEXT,               -- NULL = inherit user's senders
  created_at               INTEGER NOT NULL,
  last_used_at             INTEGER,
  last_used_ip_hash        TEXT,               -- HMAC(METADATA_PEPPER, ip)
  revoked_at               INTEGER
);

CREATE TABLE api_keys (
  id                       TEXT PRIMARY KEY,
  user_id                  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                     TEXT NOT NULL,
  key_prefix               TEXT UNIQUE NOT NULL,  -- first 8 chars; regenerated on collision
  secret_hash              TEXT NOT NULL,
  hash_version             INTEGER NOT NULL DEFAULT 1,
  scopes_json              TEXT,
  allowed_sender_ids_json  TEXT,
  created_at               INTEGER NOT NULL,
  last_used_at             INTEGER,
  revoked_at               INTEGER
);

CREATE TABLE send_events (
  id                     TEXT PRIMARY KEY,
  ts                     INTEGER NOT NULL,
  trace_id               TEXT NOT NULL,
  source                 TEXT NOT NULL CHECK (source IN ('smtp','http')),
  user_id                TEXT,
  credential_id          TEXT,
  api_key_id             TEXT,
  domain_id              TEXT,
  envelope_from          TEXT NOT NULL,
  recipient_count        INTEGER NOT NULL,
  recipient_domains_hash TEXT,                  -- HMAC(METADATA_PEPPER, sorted_unique_domains)
  mime_size_bytes        INTEGER NOT NULL,
  message_id_hash        TEXT,                  -- HMAC(METADATA_PEPPER, Message-ID header)
  cf_request_id          TEXT,
  cf_ray_id              TEXT,
  cf_delivered_json      TEXT,
  cf_queued_json         TEXT,
  cf_bounced_json        TEXT,
  status                 TEXT NOT NULL,         -- accepted|rejected_auth|rejected_allowlist
                                                -- |rejected_size|rejected_rcpt_cap|rejected_8bit
                                                -- |cf_error|rate_limited|all_bounced
  smtp_code              TEXT,
  error_code             TEXT,                  -- categorical enum, never raw provider text
  cf_error_code          TEXT
);
CREATE INDEX idx_send_events_ts ON send_events(ts DESC);
CREATE INDEX idx_send_events_status ON send_events(status, ts DESC);
CREATE INDEX idx_send_events_trace ON send_events(trace_id);

CREATE TABLE auth_failures (
  id                  TEXT PRIMARY KEY,
  ts                  INTEGER NOT NULL,
  source              TEXT NOT NULL,
  remote_ip_hash      TEXT,                     -- HMAC(METADATA_PEPPER, ip)
  attempted_username  TEXT,
  reason              TEXT                      -- categorical: bad_creds|disabled|tls_required|throttled
);
CREATE INDEX idx_auth_failures_ts ON auth_failures(ts DESC);

CREATE TABLE rate_reservations (                -- strict daily / per-window caps
  id           TEXT PRIMARY KEY,
  scope_type   TEXT NOT NULL,                   -- sender_day|domain_day|credential_day|global_day
  scope_key    TEXT NOT NULL,
  day          TEXT NOT NULL,                   -- YYYY-MM-DD UTC
  count        INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL,
  UNIQUE (scope_type, scope_key, day)
);

CREATE TABLE idempotency_keys (
  idempotency_key  TEXT PRIMARY KEY,
  request_hash     TEXT NOT NULL,               -- sha256 of normalized request input
  source           TEXT NOT NULL,               -- smtp|http
  status           TEXT NOT NULL,               -- pending|completed|failed
  response_json    TEXT,                        -- cached response on completed/failed
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  expires_at       INTEGER NOT NULL             -- ts + 24h
);
CREATE INDEX idx_idempotency_expires ON idempotency_keys(expires_at);

CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value_json  TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);
-- Includes: schema_version, policy_version, retention_days, daily_cap_global, etc.
```

## KV usage (consolidated)

| Key pattern | Purpose | TTL |
|---|---|---|
| `cred:<username>` | Credential cache (id, secret_hash, allowed senders, disabled, policy_version) | 300 s |
| `apikey:<key_prefix>` | API key cache | 300 s |
| `sender:<email>` | Sender allowlist precheck | 300 s |
| `domain:<name>` | Domain status precheck | 300 s |
| `nonce:<key_id>:<nonce>` | HMAC replay prevention | 120 s |
| `idem:<sha256>` | Completed idempotency response cache (D1 is arbiter) | 24 h |
| `rate:user:<id>:<minute>` | Per-user/minute soft counter | 120 s |
| `rate:ip:<ip>:<minute>` | Per-IP/minute soft counter | 120 s |
| `authban:<ip>` | Auth-failure ban-until ts | up to ban duration |
| `tombstone:cred:<id>` | Revocation tombstone | 300 s |
| `tombstone:apikey:<id>` | Revocation tombstone | 300 s |
| `policy_version` | Global cache invalidation marker | none (versioned writes) |

## Permissions Needed

This investigation produced no live infrastructure changes — all artifacts are under `.ai-runs/cf-mail-relay-2026-05-10/`. The follow-up work needs:

| Action | Approval gate |
|---|---|
| Create new GitHub repo `cf-mail-relay` (or chosen name) under `alexlmiller/` | User confirms name + visibility (public). |
| Initial commit, license (Apache-2.0 default) | User confirms license. |
| Branch protection rules, CI setup, release-please | Standard repo admin; no special grants. |
| Comment on `alexlmiller/infra#746` linking to new repo, optionally close/relabel | Simple `gh` operations; user approves issue state change. |
| Adopter-side Cloudflare resources (D1, KV, Worker, Pages, Access, Email Sending, API token) | Per-adopter, inside their own CF account at adopter time. Not part of repo bootstrap. |

No infra deploys, no `become: yes` playbooks, no privileged ops in the infra repo.

## Implementation Plan

Strict gates between milestones. Each milestone has an explicit passing demo.

### MS0 — `send_raw` spike (1 day)

**Block everything else until this passes.**

- Throwaway Worker stub `POST /spike` accepting raw MIME.
- Calls `send_raw` with the **documented JSON shape** (`from`, `recipients`, `mime_message`) against a real Cloudflare account with Email Sending **verified** (not sandbox).
- Captures three Gmail-originated MIME payloads via local debug SMTP: (a) plain text, (b) HTML with inline image, (c) 4 MB PDF attachment + non-ASCII subject + existing `DKIM-Signature` header.
- Sends each to Gmail, Outlook, iCloud.
- Verifies:
  - Delivery to inbox (not spam) on all three.
  - DKIM=pass with `d=<adopter-domain>` (Cloudflare-signed).
  - DMARC=pass (alignment via DKIM).
  - **`mime_message` JSON encoding** of 8-bit content tested explicitly; behavior documented.
  - At the Worker input vs the CF API request body: bytes are identical. (Recipient-side header folding/annotation is out of scope.)

Exit: 3 of 3 recipient services accept with DKIM+DMARC pass for at least one of (a)/(b). Document any quirks of (c).

### MS1 — End-to-end relay (3–5 days)

- Repo scaffold: pnpm workspaces root, `relay/`, `worker/`, `shared/`, CI for each.
- **HMAC contract frozen in `docs/security.md` with shared test vectors** (see "HMAC contract" above).
- Go relay using `emersion/go-smtp`: STARTTLS with mounted cert, AUTH PLAIN/LOGIN, sender allowlist via env, recipient cap, size cap (4.5 MiB), HMAC-signed POST to Worker, 8-bit rejection at DATA.
- Worker: `/relay/auth` (env-var credential for now), `/relay/send` (raw bytes → `send_raw`).
- Configure Gmail "Send mail as" against `smtp.<domain>:587`.
- 5 test messages delivered with DKIM+DMARC pass.

### MS2 — D1 state + audit log + idempotency (3–4 days)

- D1 schema migration `0001_init.sql` (full schema above).
- Worker `/relay/auth` reads from D1 via KV cache, returns short-lived auth decision.
- **Idempotency flow** wired in:
  - SMTP key = `sha256(source || envelope_from || sorted_recipients || message_id_header || mime_sha256)`.
  - Worker `INSERT OR FAIL` into `idempotency_keys` as `pending`.
  - On success: update to `completed` with `response_json`; mirror to KV `idem:<sha256>` for 24 h.
  - On retry with same key: read D1; if `completed`, replay; if `pending`, return `409` mapped to SMTP `451 4.7.1` (try again).
- Worker writes `send_events` with categorical `error_code` only.
- Relay caches auth decision 60 s (configurable), respects `policy_version` invalidation header from Worker.
- One-time bootstrap admin via `BOOTSTRAP_SETUP_TOKEN` endpoint; token rotated immediately after first admin is created.

### MS3 — Admin UI (3–5 days)

- Astro on Pages.
- Cloudflare Access app covers Pages origin + Worker `/admin/api/*`.
- Worker validates `Cf-Access-Jwt-Assertion` against JWKS + AUD.
- Pages: dashboard (24 h sends/failures, last error, CF API health), users, domains, allowed senders, SMTP credentials, API keys, send events, auth failures.
- Credential create flow: 32-byte secret, hashed with HMAC-SHA256(pepper, secret), shown plaintext once.

### MS4 — HTTP `/send` API (1–2 days)

- API key creation in UI.
- `/send` accepts **raw MIME only** (`{raw: "<base64 MIME>"}`). Structured JSON assembly is roadmap, not MVP.
- Same idempotency contract as `/relay/send` (key supplied by client header, or computed by Worker if absent).
- Example clients: `examples/curl-send/`, `examples/node-send/`, `examples/python-send/`.

### MS5 — Hardening (4–6 days)

- Rate limits:
  - Relay: per-IP conn-per-min, auth-fail sliding window with exponential lockout, per-username AUTH/min.
  - Worker: per-sender/min (KV soft) + per-{domain,credential,global}/day (D1 reservation rows).
- `doctor:local` + `doctor:delivery` scripts. `doctor:delivery` accepts `--domain <name>` to pick which configured sending domain to send the test message from; defaults to the first verified domain if omitted.
- D1 Time Travel retention documented; restore procedure in `docs/operations.md`; warning that restore is destructive.
- Trace propagation: relay generates trace id → `X-Relay-Trace-Id` → Worker captures CF Ray ID, CF API request ID → all written to `send_events`.
- **Threat model document** (`docs/threat-model.md`): compromised relay host, leaked SMTP credential, leaked HMAC secret, leaked CF API token, CF Access misconfiguration. Each row: detection signals, mitigation, recovery.
- Partial-recipient policy implemented (per the table above).
- Version compatibility: `REQUIRED_D1_SCHEMA_VERSION` check on Worker boot; `X-Relay-Version` validation.

### MS6 — Distribution polish (3–4 days)

- `pnpm setup` wizard with **preflight checks** (Workers Paid, Email Sending status, domain sandbox/verified, D1 production backend, KV namespace, Access app, required Worker secrets). The "Add domain" step is **repeatable** — adopters can configure multiple sending domains during initial setup, and can add more later via the UI. Each configured domain runs its own DNS-record preflight (cf-bounce MX, SPF, DKIM, DMARC) before being marked `verified` in D1.
- Multi-arch (`linux/amd64`, `linux/arm64`) Docker builds in CI → GHCR with semver tags.
- `release-please` for unified semver across all three components.
- Docs:
  - `README.md` quickstart + architecture diagram.
  - `docs/getting-started.md` full walkthrough, with an explicit **"Adding multiple sending domains"** section showing the repeatable wizard step, the UI add-domain flow, and the per-domain DNS records that must be published.
  - `docs/gmail-send-mail-as.md` with screenshots, including configuring one Gmail account to "Send mail as" from multiple custom addresses across different domains via the same relay.
  - `docs/dns.md` distinguishing Email Routing (apex) from Email Sending (`cf-bounce.<domain>`) records. Includes a worked example showing the full record set for **two** sending domains so adopters see the per-domain pattern.
  - `docs/http-api.md`.
  - `docs/security.md` (HMAC contract + test vectors).
  - `docs/threat-model.md`.
  - `docs/operations.md` (rotation, D1 backup/restore, doctor).
  - `docs/troubleshooting.md`.
  - `docs/cloudflare-email-sending.md` (Workers Paid requirement, sandbox/verified, limits, MIME quirks from MS0).
- OSS housekeeping: LICENSE, CONTRIBUTING.md, CODE_OF_CONDUCT.md, SECURITY.md (responsible disclosure), ADR 001 (three-component architecture), `.github/ISSUE_TEMPLATE/`.

## Repository layout

```
cf-mail-relay/
├── README.md
├── LICENSE                                  # Apache-2.0
├── CONTRIBUTING.md
├── CODE_OF_CONDUCT.md
├── SECURITY.md
├── package.json                             # pnpm workspace root
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── .github/
│   ├── workflows/{ci-relay,ci-worker,ci-ui,release}.yml
│   └── ISSUE_TEMPLATE/
│
├── relay/                                   # Go SMTP relay
│   ├── go.mod
│   ├── cmd/relay/main.go
│   ├── internal/{smtp,policy,throttle,workerclient,metrics,health}/
│   ├── Dockerfile
│   ├── docker-bake.hcl
│   └── docker-compose.example.yml
│
├── worker/                                  # Cloudflare Worker (Hono, TS)
│   ├── package.json
│   ├── wrangler.toml.example
│   ├── tsconfig.json
│   ├── src/
│   │   ├── index.ts
│   │   ├── routes/{relay,send,admin}/*.ts
│   │   ├── auth/{hmac,access-jwt}.ts
│   │   ├── lib/{d1,kv,ratelimit,policy,cloudflare-email,mime,idempotency,version}.ts
│   │   └── bootstrap.ts
│   ├── migrations/0001_init.sql
│   └── test/
│
├── ui/                                      # Cloudflare Pages (Astro)
│   ├── package.json
│   ├── astro.config.mjs
│   ├── wrangler.toml.example
│   ├── src/pages/*.astro
│   ├── src/components/
│   └── src/lib/api.ts
│
├── shared/                                  # types + zod schemas + test vectors
│   ├── package.json
│   ├── src/{types,schemas,smtp-error-map}.ts
│   └── test-vectors.json                    # HMAC canonical vectors
│
├── infra/
│   ├── wrangler/setup.ts                    # pnpm setup wizard with preflight
│   ├── docker/{relay.compose,relay-with-lego.compose,relay-with-traefik.compose}.yml
│   ├── docker/relay-with-host-certbot.md
│   ├── opentofu/cloudflare/                 # optional IaC
│   └── setup/doctor-local.sh
│   └── setup/doctor-delivery.sh
│
├── docs/
│   ├── architecture.md
│   ├── getting-started.md
│   ├── gmail-send-mail-as.md
│   ├── dns.md
│   ├── http-api.md
│   ├── security.md
│   ├── threat-model.md
│   ├── operations.md
│   ├── troubleshooting.md
│   └── cloudflare-email-sending.md
│
├── examples/
│   ├── curl-send/
│   ├── node-send/
│   ├── python-send/
│   ├── gmail-mime-fixture/                  # canned MIME from MS0
│   ├── coolify/
│   └── hetzner-ufw/
│
└── ADR/
    └── 001-three-component-architecture.md
```

## Test Plan

### MS0 gate

- [ ] `send_raw` JSON shape verified live.
- [ ] Captured Gmail MIME (text / HTML / attachment+non-ASCII / existing DKIM-Signature) delivered to Gmail / Outlook / iCloud.
- [ ] All three show DKIM=pass `d=<adopter-domain>` + DMARC=pass.
- [ ] `mime_message` JSON encoding behavior for 8-bit content documented.
- [ ] Byte-identical Worker input vs CF API request body.

### Unit / integration (MS1–MS4)

**Relay (Go)**:
- HMAC signing produces signatures matching `shared/test-vectors.json`.
- STARTTLS upgrade; AUTH rejected before TLS.
- AUTH PLAIN + AUTH LOGIN both work.
- Sender allowlist rejects with `553`; recipient cap at `RCPT TO #50`; size cap mid-DATA.
- 8-bit content rejected at DATA with `554 5.6.0`.
- Auth-failure throttle: 5 fails in 5 min → 15 min lockout, exponential.
- Worker unreachable → `451 4.7.1`; cert hot reload without dropping connections.

**Worker (TypeScript)**:
- HMAC verification: accepts valid; rejects bad ts (±60 s), replayed nonce, bad body hash, unknown key id; dual-secret window honored.
- CF Access JWT verified against test JWKS; bad AUD rejected; expired rejected. Email header ignored as trust root.
- `send_raw` JSON body assembled correctly; partial-recipient response mapping covered for each combination of `delivered`/`queued`/`permanent_bounces`.
- SMTP-code mapping table covered.
- Idempotency: D1 row created `pending`; success → `completed` with cached response; replay returns cached response; retry on `pending` returns 409 → SMTP 451.
- Rate limits: D1 reservation math correct under sequential + concurrent simulated load.
- KV invalidation on credential revoke; D1 fallback when KV says present but D1 says revoked.
- Version compatibility: unsupported relay version rejected with categorical error.

**UI (Astro)**:
- API client handles 401/403/429.
- Credential plaintext shown once, hidden on navigate.

### End-to-end (MS5–MS6)

- `doctor:local` reaches green within 10 min on a fresh Hetzner VPS after DNS propagation.
- `doctor:delivery` guides adopter through a paste-headers flow for DKIM/DMARC verification.
- Gmail "Send mail as" walkthrough completes without SQL editing.
- 100-message synthetic load over 1 hour: all logged, rate limits honored, idempotency proven under deliberate retry storms (no duplicate `send_raw` invocations).
- Disaster drill: D1 Time Travel restore; verify history + creds survive; document destructive-restore caveat.
- Threat-model spot checks:
  - Compromised relay: revoke SMTP cred in UI; relay rejects within 60 s.
  - Leaked HMAC secret: dual-secret rotation; old secret rejected after window.
  - Leaked CF API token: rotate via `wrangler secret put`; in-flight `send_raw` unaffected; next call uses new token.

### CI coverage

- `relay/`: build + test on `linux/amd64` + `linux/arm64`; Docker image Trivy scan.
- `worker/`: typecheck + Vitest + `wrangler deploy --dry-run`.
- `ui/`: typecheck + Astro build + accessibility lint.
- Shared zod schemas round-trip between Worker and UI; CI fails on contract drift.
- Release: tag → multi-arch GHCR push → Worker + Pages deploy preview to staging → smoke tests → promote.

## Risks (final list)

| ID | Risk | Mitigation |
|---|---|---|
| R1 | Cloudflare Email Sending is beta — API, limits, pricing may shift | Pin to dated API revision in `docs/cloudflare-email-sending.md`; build provider adapter boundary so Mailgun fallback is a roadmap option without rewrite. |
| R2 | `send_raw` MIME quirks (8-bit, long lines, deeply nested multipart) | MS0 exhaustive fixture set; relay rejects 8-bit at DATA in MVP. |
| R3 | 5 MiB cap + Gmail base64 expansion | Relay enforces 4.5 MiB final MIME; setup wizard and docs surface ~3.25 MiB original-attachment guideline. |
| R4 | DKIM/DMARC alignment may fail for some recipients | MS0 covers Gmail/Outlook/iCloud; `doctor:delivery` validates per-adopter. |
| R5 | CF Access dependency adds Zero Trust setup burden | Free tier covers ≤50 users; clean adapter boundary for future password/TOTP fallback. |
| R6 | Workers Paid subscription required | Preflight check + README front-page note. |
| R7 | New CF accounts in Email Sending sandbox can only deliver to verified recipients | Preflight check + clear setup-wizard warning + status surfaced in `domains.status`. |
| R8 | KV eventual consistency | D1 is arbiter for revocation + idempotency + strict quotas; KV is cache only. |
| R9 | Concurrent idempotency race | D1 `UNIQUE` constraint + `INSERT OR FAIL` resolves; `pending` retries get `451 4.7.1`. |
| R10 | Provider-error text leaking PII into D1 | `send_events.error_code` is categorical only; raw provider text not stored. |
| R11 | Recipient-domain dictionary attack on hashes | HMAC with `METADATA_PEPPER`, not plain SHA-256. |
| R12 | Adopter hosts that block port 587 outbound — N/A (we accept inbound 587 on the relay; Worker call is HTTPS outbound) | Documented; not a real risk. |
| R13 | Adopter places `smtp.<domain>` behind Cloudflare orange-cloud | Setup wizard prints "DNS-only required"; doctor verifies. |
| R14 | Adopter has sending domains spread across multiple Cloudflare accounts | `CF_API_TOKEN` is account-scoped, so one Worker = one CF account. Docs recommend consolidating; if that's impossible, deploy one Worker per account (each with its own D1/KV/UI) — supported but explicitly not the recommended path. |

## Confidence

**4** — high confidence in the design after Codex's corrections. The single remaining empirical unknown is MS0 (Gmail-MIME `send_raw` behavior + 8-bit handling). The plan is otherwise implementation-ready and the milestones are sized so MS0 fails fast if anything is wrong.
