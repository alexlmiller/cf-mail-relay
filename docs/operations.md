# Operations

Day-2 procedures. Setup is in [README.md](../README.md); security boundaries are
in [architecture.md](architecture.md).

## Rotate secrets

| Secret | Guidance |
|---|---|
| `RELAY_HMAC_SECRET_CURRENT` | Rotate yearly or after relay-host exposure. Use `_PREVIOUS` only for the restart overlap. |
| `CF_API_TOKEN` | Replace after token rotation or exposure. No overlap is needed. |
| `CREDENTIAL_PEPPER` | Avoid routine rotation; it invalidates all SMTP credentials and API keys. |
| `METADATA_PEPPER` | Avoid routine rotation; it breaks audit-hash continuity. |
| `BOOTSTRAP_SETUP_TOKEN` | Manual recovery only. Delete immediately after bootstrap. |

### Relay HMAC

```sh
pnpm rotate:hmac
```

The command prints the new secret and exact steps:

1. Put the existing current value in `RELAY_HMAC_SECRET_PREVIOUS`.
2. Put the new value in `RELAY_HMAC_SECRET_CURRENT`.
3. Update the relay's `RELAY_HMAC_SECRET` and restart it.
4. Verify an authenticated submission, then delete
   `RELAY_HMAC_SECRET_PREVIOUS`.

The Worker accepts `_PREVIOUS` until it is deleted. Keep the overlap short;
there is no automatic expiry.

### Runtime Cloudflare token

```sh
pnpm --dir worker exec wrangler secret put CF_API_TOKEN
```

The runtime token needs Account Email Sending Edit and Zone Read for sending
zones. Reload the dashboard or select **Refresh** to update its health result.

## Dashboard actions

- **Bump policy version** invalidates credential and API-key cache keys. Use it
  after direct D1 policy edits.
- **Flush caches** removes credential, API-key, idempotency, and Access-JWKS KV
  entries. D1 remains authoritative.

The equivalent endpoints are `POST /admin/api/ops/bump-policy-version` and
`POST /admin/api/ops/flush-caches`.

## Idempotency

- SMTP: the Worker derives a fingerprint from the source, envelope sender,
  sorted recipients, client `Message-ID`, and stripped MIME digest. Reservations
  and completed responses remain in D1 for seven days.
- HTTP: caller `Idempotency-Key` values are scoped to the API key. Reusing one
  for different content returns `409 idempotency_key_conflict`. Without a key,
  the Worker derives one. HTTP records remain for 24 hours.
- KV mirrors completed results only as a fast path. D1 wins on conflict.
- An explicitly ambiguous SMTP provider result is fenced for one hour, after
  which one retry may reclaim it. A confirmed acceptance whose completion write
  fails remains fenced for seven days. HTTP ambiguity is never retried through
  the SMTP lease.

### Break-glass SMTP retry release

Normally, let an `ambiguous` row reach its one-hour retry lease and leave an
`in_flight` row fenced until expiry. Cloudflare may already have accepted an
`in_flight` message, so deleting it can cause duplicate delivery. **Flush
caches** does not release either state because D1 is authoritative.

After confirming the originating SMTP and Worker request has ended, inspect
live rows that have been unchanged for at least five minutes:

```sh
pnpm --dir worker exec wrangler d1 execute <d1-database-name> --remote --command \
"SELECT idempotency_key, request_hash, status, updated_at, expires_at
   FROM idempotency_keys
  WHERE source = 'smtp'
    AND status IN ('in_flight', 'ambiguous')
    AND updated_at <= unixepoch() - 300
    AND expires_at > unixepoch()
  ORDER BY updated_at DESC;"
```

Correlate the timestamps with relay, Worker, and provider records. Age alone
does not prove the provider rejected the message. Only when duplicate risk is
explicitly acceptable, delete the exact unchanged `in_flight` row:

```sh
pnpm --dir worker exec wrangler d1 execute <d1-database-name> --remote --command \
"DELETE FROM idempotency_keys
  WHERE idempotency_key = '<observed-idempotency-key>'
    AND request_hash = '<observed-request-hash>'
    AND source = 'smtp'
    AND status = 'in_flight'
    AND updated_at = <observed-updated-at>
    AND updated_at <= unixepoch() - 300
    AND expires_at = <observed-expires-at>;"
```

If no row changes, query again. Do not weaken the predicates or bulk-delete
fences. The next client retry creates a fresh reservation; no KV deletion is
needed because only completed responses are cached there.

## Bootstrap signal

The normal setup wizard creates the first admin directly in D1 and does not set
`BOOTSTRAP_SETUP_TOKEN`. Manual `POST /bootstrap/admin` calls with a wrong token
are written to `auth_failures` with `source = 'bootstrap'`; invalid bodies and
already-completed responses are not.

If wrong-token attempts appear after setup, verify that the optional secret is
absent:

```sh
pnpm --dir worker exec wrangler secret delete BOOTSTRAP_SETUP_TOKEN
```

## Migrations and recovery

Apply all pending migrations before deploying newer Worker code:

```sh
pnpm --dir worker exec wrangler d1 migrations apply <d1-database-name> --remote
```

`/healthz` returns `schema_version_mismatch` until code and D1 agree. The current
schema is migration version 6.

Migration `0005_privacy_retention_hardening.sql` deletes every existing
idempotency row because older rows may contain provider responses. Apply it
during low traffic: retries of pre-migration requests temporarily lose their
duplicate-send fence. Migration `0006_extend_smtp_idempotency.sql` extends
surviving SMTP fences to seven days.

Cloudflare [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
provides point-in-time recovery. A restore overwrites the database, so record
the pre-restore bookmark and follow Cloudflare's current procedure.

## Cleanup

The scheduled handler runs daily at `03:17 UTC`. It removes expired relay
nonces, idempotency rows, auth failures, and quota reservations. Keep the
`[triggers]` block from `worker/wrangler.toml.example`.

## MIME handling

The Worker rejects misaligned or duplicate sender identity headers and strips
`Bcc` plus capture-hop authentication headers before delivery. See the
[SMTP flow](architecture.md#smtp-flow) for the contract. Cloudflare response
arrays are stored only as counts and categorical status/reason codes.

## OpenTofu

The setup wizard is the default provisioning path. The optional
[OpenTofu module](../infra/opentofu/README.md) can own D1, KV, and Access.
Secrets and Worker deployment stay with Wrangler so secret values never enter
tfstate.
