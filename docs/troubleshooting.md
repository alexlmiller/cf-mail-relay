# Troubleshooting

Start with `pnpm doctor:local`. It checks the pieces most likely to break:
Cloudflare DNS, Worker `/healthz`, D1 schema version, SMTP STARTTLS, and
optional SMTP AUTH/send behavior.

```sh
pnpm doctor:local -- \
  --domain example.com \
  --smtp-host smtp.example.com \
  --worker-url https://<worker-host>
```

## Gmail can't connect to the relay

- DNS: confirm `smtp.<domain>` or `mailer.<domain>` resolves to your relay host
  and the orange cloud is off.
- Firewall: confirm inbound `587/tcp` is open at the host and provider firewall.
- TLS: confirm the cert covers the relay hostname and is valid.

```sh
openssl s_client -starttls smtp -connect smtp.example.com:587 -servername smtp.example.com
```

## Gmail rejects the credential

- Confirm SMTP AUTH credential in the admin UI matches what you put in Gmail.
- Check `auth_failures` in the UI for the failure reason.
- If the username is correct but attempts are being throttled, wait for the
  relay lockout window or rotate the credential.

## Mail accepted but never arrives

- Check `send_events` in the UI: is `status` `accepted`?
- Check `cf_bounced_json` — if populated, the recipient bounced.
- If domain status is `sandbox`, you can only deliver to verified recipients.
- If DMARC alignment fails at the recipient, mail may land in spam. Run `doctor:delivery`.

## `pnpm run setup` says Workers Paid was not detected

Cloudflare does not expose every billing state consistently through the account
API. Treat this as a blocking warning: verify Workers Paid in the Cloudflare
dashboard before relying on Email Sending. Email Sending will reject production
sends if the account is not eligible.

## `pnpm run setup` says an Access app is missing

Create or update the admin UI Access application:

```sh
pnpm access:setup -- \
  --account-id <account-id> \
  --name cf-mail-relay-admin \
  --pages-url https://cf-mail-relay-ui.pages.dev \
  --worker-url https://cf-mail-relay-worker.<subdomain>.workers.dev \
  --allow-email you@example.com \
  --allow-platform-hostnames \
  --apply-config worker/wrangler.toml
```

Then run `pnpm run setup` again and confirm the Access app appears in the
preflight output.

## Browser console shows CORS errors from `/admin/api/*`

This usually means the Worker cannot validate the Cloudflare Access JWT for the
Pages origin, or the Worker `ADMIN_UI_ORIGIN` binding does not match the Pages
URL.

Check:

- The Pages project is protected by the same Cloudflare Access app you expect.
- `ADMIN_UI_ORIGIN` equals the exact Pages origin, for example
  `https://cf-mail-relay-ui.pages.dev`.
- `CF_ACCESS_AUD` matches the Access application audience.
- `CF_ACCESS_ISSUER` is `https://<team-name>.cloudflareaccess.com`.

## "Schema version mismatch" on Worker `/healthz`

The Worker code requires a newer D1 schema version than is currently applied. Run pending migrations:

```sh
pnpm --filter worker exec wrangler d1 migrations apply cf-mail-relay
```

## "Replay rejected" / "stale timestamp"

The relay's clock is more than 60 seconds off. Sync NTP on the relay host.

## `send_raw` returns `email.invalid`

The upstream API rejects some full SMTP captures that include capture-hop trace
headers. The relay strips hop-specific `Received`, `X-Received`, and `X-Gm-*`
headers before sending to Cloudflare. If you reproduce this with custom tooling,
send the message from `MIME-Version`/content headers onward instead of replaying
the entire captured SMTP transcript.

## Attachments fail near the limit

Cloudflare's Email Sending limit applies after MIME encoding. Gmail base64
encoding adds roughly 33 percent overhead plus MIME boundaries. Keep original
attachments below about 3.25 MiB for reliable delivery through the MVP path.

## "Rate limit exceeded"

Check which layer rejected the request:

- SMTP AUTH rejected before login: relay-side `RELAY_AUTH_PER_MIN` or
  exponential lockout.
- SMTP connection rejected at greeting: relay-side `RELAY_CONN_PER_MIN`.
- Send request returns `rate_limited`: Worker-side D1/KV quota. Check
  `send_events.status='rate_limited'` and D1 `settings` caps.

Unset a cap or set its D1 `settings.value_json` to `null` to disable it.
