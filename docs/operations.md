# Operations

> Stub. Lands in MS5/MS6.

## Routine tasks

| Task | Procedure |
|---|---|
| Rotate `RELAY_HMAC_SECRET` | See `docs/security.md` § Secret rotation |
| Rotate `CF_API_TOKEN` | `wrangler secret put CF_API_TOKEN` |
| Rotate a leaked SMTP credential | Revoke in UI; issue new; update Gmail "Send mail as" |
| Audit recent sends | UI → Events, filter by domain/time/status |
| Audit auth failures | UI → Auth failures |
| Prune old events | Scheduled Worker cron handles automatically per `settings.retention_days` |

## Backup and restore

D1 Time Travel is always-on for production D1 databases. Retention is documented in Cloudflare's docs (currently 30 days).

To restore:

```sh
# WARNING: this is destructive. The database is replaced at the target timestamp.
wrangler d1 time-travel restore cf-mail-relay --timestamp <RFC3339-or-bookmark>
```

After restore:
- Verify `settings.schema_version` still matches the Worker's `REQUIRED_D1_SCHEMA_VERSION`.
- Rotate any secrets that may have been valid at the restore timestamp.

## Doctor scripts

| Script | Scope |
|---|---|
| `pnpm doctor:local` | Fully automated. DNS resolution, TLS handshake on `smtp.<domain>:587`, SMTP AUTH with bootstrap cred, Worker `/healthz`, D1 reachability, synthetic event creation. |
| `pnpm doctor:delivery --domain <name>` | Guided. Sends a test message and prompts the adopter to paste recipient headers for DKIM/DMARC verification. |
