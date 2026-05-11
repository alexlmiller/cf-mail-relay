# Troubleshooting

> Stub. Lands in MS6 with real symptoms from real adopters.

## Gmail can't connect to the relay

- DNS: confirm `smtp.<domain>` resolves to your relay host (and the orange cloud is off).
- Firewall: confirm inbound `587/tcp` is open at the host and any provider firewall.
- TLS: confirm the cert covers `smtp.<domain>` and is valid. Try `openssl s_client -starttls smtp -connect smtp.<domain>:587`.

## Gmail rejects the credential

- Confirm SMTP AUTH credential in the admin UI matches what you put in Gmail.
- Check `auth_failures` in the UI for the failure reason.

## Mail accepted but never arrives

- Check `send_events` in the UI: is `status` `accepted`?
- Check `cf_bounced_json` — if populated, the recipient bounced.
- If domain status is `sandbox`, you can only deliver to verified recipients.
- If DMARC alignment fails at the recipient, mail may land in spam. Run `doctor:delivery`.

## "Schema version mismatch" on Worker `/healthz`

The Worker code requires a newer D1 schema version than is currently applied. Run pending migrations:

```sh
pnpm --filter worker exec wrangler d1 migrations apply cf-mail-relay
```

## "Replay rejected" / "stale timestamp"

The relay's clock is more than 60 seconds off. Sync NTP on the relay host.
