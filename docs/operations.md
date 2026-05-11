# Operations

## Routine Tasks

| Task | Procedure |
|---|---|
| Rotate `RELAY_HMAC_SECRET` | Set `RELAY_HMAC_SECRET_PREVIOUS` to the current value, deploy a new `RELAY_HMAC_SECRET_CURRENT`, update relay hosts, then remove previous after one hour. |
| Rotate `CF_API_TOKEN` | `wrangler secret put CF_API_TOKEN`, then run `pnpm doctor:local`. |
| Rotate a leaked SMTP credential | Revoke it in the UI, create a replacement, and update Gmail "Send mail as". |
| Rotate a leaked API key | Revoke it in the UI, create a replacement, and update clients. |
| Audit recent sends | UI -> Events. Check `source`, `credential_id`/`api_key_id`, status, CF Ray, and timestamp. |
| Audit auth failures | UI -> Auth failures. Repeated failures for one username indicate brute force or a stale client password. |

## Rate Limits

Relay-side throttles are configured with environment variables:

| Variable | Default | Scope |
|---|---:|---|
| `RELAY_CONN_PER_MIN` | `60` | Connections per remote IP per UTC minute |
| `RELAY_AUTH_PER_MIN` | `20` | AUTH attempts per username per UTC minute |
| `RELAY_AUTH_LOCKOUT_BASE_SECONDS` | `30` | Exponential lockout base after failed AUTH |

Worker-side send quotas are controlled by rows in D1 `settings`. Missing or
`null` values disable that cap.

| Setting key | Scope |
|---|---|
| `sender_minute_cap` | KV soft cap per sender per minute |
| `daily_cap_global` | D1 strict daily cap for all sends |
| `daily_cap_sender` | D1 strict daily cap per envelope sender |
| `daily_cap_domain` | D1 strict daily cap per sender domain |
| `daily_cap_credential` | D1 strict daily cap per SMTP credential/API key |

Example:

```sh
pnpm --dir worker exec wrangler d1 execute cf-mail-relay --remote --command \
  "INSERT OR REPLACE INTO settings (key, value_json, updated_at)
   VALUES ('daily_cap_sender', '500', unixepoch());"
```

When a cap is exceeded, the Worker writes a `send_events` row with
`status='rate_limited'` and returns a retryable error.

## Backup and Restore

D1 Time Travel is always on for production D1 databases. Cloudflare currently
documents a 30-day retention window.

Restore is destructive: the database is replaced at the target timestamp.

```sh
wrangler d1 time-travel restore cf-mail-relay --timestamp <RFC3339-or-bookmark>
```

After restore:

- Verify `settings.schema_version` still matches the Worker's
  `REQUIRED_D1_SCHEMA_VERSION`.
- Rotate secrets that may have been valid at the restore timestamp.
- Run `pnpm doctor:local`.
- Check the UI for expected users, senders, SMTP credentials, and API keys.

## Doctor Scripts

| Script | Scope |
|---|---|
| `pnpm doctor:local -- --domain <domain> --worker-url <url>` | DNS, Worker `/healthz`, SMTP STARTTLS/AUTH, optional synthetic SMTP send, optional D1 event visibility. |
| `pnpm doctor:delivery -- --domain <domain>` | Guided recipient-header check for DKIM and DMARC pass. |

For a full local check, provide SMTP credentials and a recipient:

```sh
CF_MAIL_RELAY_SMTP_USERNAME=gmail \
CF_MAIL_RELAY_SMTP_PASSWORD=... \
CF_MAIL_RELAY_FROM=gmail@example.com \
CF_MAIL_RELAY_TO=you@example.org \
pnpm doctor:local -- --domain example.com --worker-url https://<worker-host>
```

For delivery alignment, send a message with the generated subject token, paste
the received headers, and confirm DKIM/DMARC pass before tightening DMARC beyond
`p=none`.
