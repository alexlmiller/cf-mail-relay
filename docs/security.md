# Security Model

This is the locked security spec. Implementation must match this document; if you need to change it, open an ADR.

## Trust model

- **Relay host**: trusted infrastructure. An attacker who compromises the relay host can see SMTP AUTH passwords in flight and abuse the HMAC shared secret until it is rotated.
- **Worker**: trusted Cloudflare-managed runtime. Holds long-lived secrets (CF API token, peppers, HMAC secrets).
- **D1 + KV**: same trust boundary as the Worker. Backed up via D1 Time Travel.
- **Pages UI**: untrusted client; treated as a browser. Bare static assets; no secrets.
- **Adopter user agents**: untrusted. All admin actions authenticate via Cloudflare Access JWT.

## Authentication

### Relay → Worker

**HMAC-SHA256** over a canonical request string. No Cloudflare Access service token on this path (would impose Zero Trust setup on every adopter).

```
Headers:
  X-Relay-Key-Id:        rel_<opaque key id>
  X-Relay-Timestamp:     <unix seconds, integer>
  X-Relay-Nonce:         <128-bit nonce, base64url, no padding>
  X-Relay-Body-SHA256:   <lowercase hex>
  X-Relay-Version:       <relay semver>
  X-Relay-Signature:     <base64url, no padding>

Canonical string (UTF-8, lines joined with literal "\n", no trailing newline):
  uppercase(method)         e.g. "POST"
  exact-path                e.g. "/relay/send"  (no query string in MVP)
  X-Relay-Timestamp value   decimal string
  X-Relay-Nonce value       base64url
  X-Relay-Body-SHA256 value lowercase hex
  X-Relay-Key-Id value      string

Signature:
  base64url(HMAC_SHA256(secret_bytes, canonical_string))

Verification on the Worker:
  - Re-derive canonical string exactly as above.
  - Recompute SHA-256 over the raw request body bytes; reject on header mismatch.
  - Reject if |now - timestamp| > 60 seconds.
  - Look up KV at "nonce:<key_id>:<nonce>"; if present, reject (replay).
  - Otherwise write the nonce with TTL 120 seconds.
  - Constant-time signature compare.
  - Dual-secret rotation: accept HMAC_SECRET_CURRENT or HMAC_SECRET_PREVIOUS
    for up to 1 hour after rotation.

Limits:
  - Body cap at Worker: 6 MiB (defense in depth above relay's 4.5 MiB).
```

Canonical test vectors live in `shared/test-vectors.json` and are consumed by both the Go signer (relay) and the TS verifier (worker) test suites. They MUST agree.

### Admin UI → Worker `/admin/api/*`

Cloudflare Access. The Worker validates the **`Cf-Access-Jwt-Assertion`** header against the team's JWKS and the application's audience claim. The `Cf-Access-Authenticated-User-Email` header is **display-only** and is not the trust root.

JWT validation:
- Fetch JWKS from `https://<ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs`. Cache for 1 hour.
- Verify signature against the kid claim.
- Verify `aud` matches the configured `ACCESS_AUDIENCE`.
- Verify `iss` matches `https://<ACCESS_TEAM_DOMAIN>`.
- Verify `exp` is in the future.
- Map `sub` (or `email`) to `users.access_subject`.

### HTTP `/send`

API key in `Authorization: Bearer <secret>`. The secret prefix (`key_prefix`, first 8 chars) is unique in D1 for fast lookup; the secret is verified by HMAC-SHA256 keyed with `CREDENTIAL_PEPPER`.

### SMTP AUTH

The relay forwards `{username, password}` to the Worker. The Worker computes `HMAC_SHA256(CREDENTIAL_PEPPER, password)` and constant-time compares against `smtp_credentials.secret_hash`. The relay receives only an auth decision + policy snapshot, never the stored hash.

## Credential hashing

| Credential type | Hash | Why |
|---|---|---|
| SMTP credential (32-byte random secret) | `HMAC-SHA256(CREDENTIAL_PEPPER, secret)` | 256-bit random → slow hashes add nothing; pepper defends against D1 leak. |
| HTTP API key (32-byte random secret) | `HMAC-SHA256(CREDENTIAL_PEPPER, secret)` | Same. |
| Future human admin password (post-MVP) | `argon2id` | Slow hash needed for human-chosen passwords. |

`hash_version` columns let us migrate algorithms without breaking existing credentials.

## Secret rotation

| Secret | Rotation procedure | Window |
|---|---|---|
| `RELAY_HMAC_SECRET_CURRENT` | Set `RELAY_HMAC_SECRET_PREVIOUS` to current, generate new current, update relay env, restart relay | 1 hour |
| `CF_API_TOKEN` | `wrangler secret put CF_API_TOKEN`. In-flight calls already in progress use the old token; new calls use the new one. | Instant |
| `CREDENTIAL_PEPPER` | One-time only; rotation requires re-hashing all stored credentials (a roadmap migration) | N/A |
| `METADATA_PEPPER` | Same — rotation invalidates audit log hashing consistency | N/A |
| `BOOTSTRAP_SETUP_TOKEN` | Rejected after the first admin exists; remove or rotate the Worker secret after bootstrap | Single-use |

## Open relay prevention

Three independent defenses:

1. **Relay**: AUTH required before any `MAIL FROM`; sender allowlist enforced before accepting `RCPT TO`.
2. **Worker**: re-checks credential, allowlist, recipient count, daily quotas. The Worker treats the relay as untrusted code an adopter operates.
3. **Cloudflare Email Sending**: `send_raw` requires the `from` address to be a verified domain in the account. Domains in sandbox mode can only deliver to verified recipients.

## Audit log

All sends and auth failures land in D1:

- `send_events` — metadata only. No subject, no body, no attachment names. Recipient domains hashed with `METADATA_PEPPER`. `error_code` is categorical; raw provider error text is never stored.
- `auth_failures` — categorical reasons; remote IP hashed with `METADATA_PEPPER`.

Retention defaults to 90 days, configurable in `settings.retention_days`. Scheduled Worker cron prunes older rows.

## Idempotency

D1 is the arbiter. Per `IMPLEMENTATION_PLAN.md` § "Idempotency storage":

```
SMTP key derivation:
  sha256(source || envelope_from || sorted_recipients || message_id_header || mime_sha256)

HTTP key:
  Client-supplied via Idempotency-Key header; if absent, Worker derives from request hash.

Flow:
  1. INSERT OR FAIL INTO idempotency_keys (key, status='pending', ...).
  2. On conflict: read existing row.
     - status='completed' or 'failed' -> replay response_json.
     - status='pending' -> 409 -> SMTP 451 4.7.1 (try again).
  3. After send_raw returns: update status='completed'/'failed' + response_json.
  4. Mirror completed response to KV "idem:<key>" with 24h TTL.
```

KV is a fast read cache only; first-write arbitration is always D1.

## Threat events covered in `docs/threat-model.md`

- Compromised relay host.
- Leaked SMTP credential.
- Leaked Worker HMAC secret.
- Leaked CF API token.
- Cloudflare Access misconfiguration.
