# Operations

Day-2 procedures for an adopter running cf-mail-relay. This document is
intentionally slim; the canonical architecture lives in `docs/architecture.md`,
and adopter setup is in the project `README.md`.

## Secrets you can rotate

| Secret | Where | When to rotate | Grace window |
|---|---|---|---|
| `RELAY_HMAC_SECRET_CURRENT` | Worker secret + relay env | Yearly, or when the relay host is suspected compromised | 1 h overlap via `RELAY_HMAC_SECRET_PREVIOUS` |
| `CF_API_TOKEN` | Worker secret | When the token is rotated in the Cloudflare dashboard | None — single shot |
| `CREDENTIAL_PEPPER` | Worker secret | Avoid — rotating invalidates every stored SMTP credential and API key hash | None |
| `METADATA_PEPPER` | Worker secret | Avoid — rotating breaks audit-log hash continuity | None |
| `BOOTSTRAP_SETUP_TOKEN` | Worker secret | Delete it after the first admin is bootstrapped | N/A |

### Rotate the relay → Worker HMAC secret

```sh
pnpm rotate:hmac
```

The script emits a fresh 32-byte secret and a step-by-step runbook. The four
steps are:

1. `wrangler secret put RELAY_HMAC_SECRET_PREVIOUS` ← the **existing** current
   value. The Worker accepts both `_CURRENT` and `_PREVIOUS` so the relay's
   restart can take a few minutes without dropping submissions.
2. `wrangler secret put RELAY_HMAC_SECRET_CURRENT` ← the **new** value.
3. Update the relay container's `RELAY_HMAC_SECRET` env and `docker compose
   up -d relay` to restart with the new value.
4. After the relay is healthy (next successful authed SMTP submission), delete
   `RELAY_HMAC_SECRET_PREVIOUS`.

The HMAC contract binds the request body **and** the relay headers that affect
authorization. Both sides include a sorted `signedHeaders` block (names +
normalized values) in the canonical string. Mismatched values surface as
`missing_signed_headers` or `missing_required_signed_header` on the worker.

### Rotate the Cloudflare API token

```sh
pnpm exec wrangler secret put CF_API_TOKEN --config worker/wrangler.toml
```

`CF_API_TOKEN` is account-scoped (Email Sending Edit). Workers pick up the new
value on the next request after `wrangler secret put` lands, so no overlap is
needed. The dashboard's **Cloudflare API** health pill flips green within a
minute.

## Ops actions on the dashboard

The Operations card on the admin dashboard exposes two safe-to-click maintenance
actions; both are also available as POST endpoints:

- `POST /admin/api/ops/bump-policy-version` — increments `settings.policy_version`,
  which is part of every KV credential cache key. Forces SMTP and API auth to
  re-fetch credentials from D1 on the next request. Use after editing a user
  or domain row directly in D1 if you want changes to propagate immediately.
- `POST /admin/api/ops/flush-caches` — bulk deletes `cred:`, `apikey:`,
  `domain:`, `sender:`, `idem:`, `tombstone:cred:`, `tombstone:apikey:` KV
  entries. Use sparingly; rebuilds cost one D1 round-trip per cache miss.

## Idempotency semantics

- **`/relay/send`**: idempotency key is `sha256(source ‖ envelope_from ‖
  sorted_recipients ‖ message_id_header ‖ stripped_mime_sha256)`. Reused key
  with a different request hash returns `409 idempotency_key_conflict`.
- **`/send`** (HTTP API): the supplied `Idempotency-Key` header is namespaced
  by `api_key_id` to prevent cross-tenant collisions. If you reuse a key with
  a different `from`/`recipients`/MIME, expect a `409 idempotency_key_conflict`
  — pick a fresh key.
- Worker uses D1 as the authority. KV mirrors completed responses with a 24h
  TTL purely for the fast-replay path; D1 wins on conflict.

## MIME spoof defenses (informational)

The Worker rejects messages where:

- The MIME `From:` header doesn't match the authenticated envelope/body
  `from` → `from_header_mismatch` (403).
- A `Sender:` header is present but not on the user's allowed-senders list
  → `sender_header_not_allowed` (403).
- Multiple `From:` / `Sender:` / `Reply-To:` / `Message-ID:` headers are present
  → `singleton_header_duplicated` (400).
- The MIME bytes are not UTF-8 → `mime_not_utf8_json_safe` (422).

Outbound, the Worker strips `Bcc:`, `Received:`, `X-Received:`, and
`X-Gm-message-state:` headers before calling Cloudflare's `send_raw`.

## Bootstrap audit signal

Failed `POST /bootstrap/admin` attempts (wrong token, malformed body, already
completed) land in `auth_failures` with `source = 'bootstrap'`. The Events page
has a Bootstrap chip on the Auth Failures tab and a warning-tinted Source pill
to make those rows easy to spot. The dashboard's `bootstrap_failures_24h`
probe flips warning if any rows appear in the last 24 hours.

If you see bootstrap failures **after** completing your initial bootstrap,
something is poking at your relay's bootstrap endpoint — verify
`BOOTSTRAP_SETUP_TOKEN` is unset:

```sh
pnpm exec wrangler secret delete BOOTSTRAP_SETUP_TOKEN
```

## Cron handler

The Worker has a scheduled handler (`crons = ["17 3 * * *"]` in
`wrangler.toml`) that runs at 03:17 UTC and prunes expired
`relay_nonces` rows. The cadence is intentionally off-cycle to avoid the top
of every hour. Bump the schedule if you operate at scale and start seeing
nonce-table growth between runs.

## Schema migrations

`worker/migrations/` is the canonical migration directory. Apply remote:

```sh
pnpm --dir worker exec wrangler d1 migrations apply cf-mail-relay --remote
```

`/healthz` returns `schema_version_mismatch` (500) until the deployed Worker's
`REQUIRED_D1_SCHEMA_VERSION` matches `settings.schema_version`. Always migrate
before deploying a newer worker.

Current schema baseline: `worker/migrations/0001_init.sql` + `0002_security_hardening.sql`
+ `0003_drop_retention.sql` (current version: 3).

## Managing infra with OpenTofu (optional)

The setup wizard is idempotent and will reuse existing D1/KV/Access apps when
given `--d1-id`, `--kv-id`, `--access-app-id` flags or when it finds matching
names. Adopters who prefer declarative state can drive the resource creation
via OpenTofu and pass the resulting IDs to `pnpm setup`.

A reference module is in `infra/opentofu/`; see its `README.md` for the
two-phase workflow.

Secrets stay out of tfstate. The wizard always pushes secrets via `wrangler
secret put`, never through Terraform/OpenTofu.
