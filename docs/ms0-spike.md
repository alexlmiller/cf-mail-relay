# MS0 send_raw spike runbook

MS0 proves the locked assumption that Cloudflare Email Sending `send_raw` can deliver Gmail-originated MIME without breaking DKIM/DMARC alignment. Do not start MS1 until this runbook has real evidence attached.

## Prerequisites

- Cloudflare account is on Workers Paid.
- Email Sending is enabled for the sending domain.
- Sending domain is verified and out of sandbox if testing arbitrary Gmail, Outlook, and iCloud recipients.
- A Cloudflare API token with Email Sending permission.
- A public SMTP capture host on TCP 587 with a valid certificate for the hostname.
- Three recipient inboxes for the live test: Gmail, Outlook, and iCloud.

Cloudflare-mutating commands in this document, including `wrangler secret put` and `wrangler deploy`, require explicit approval before an agent runs them.

Read-only Wrangler discovery can identify the account and zone:

```sh
pnpm --filter @cf-mail-relay/worker exec wrangler whoami
CLOUDFLARE_ACCOUNT_ID=<account-id> pnpm --filter @cf-mail-relay/worker exec wrangler email sending list
```

With a Cloudflare API token in `CLOUDFLARE_API_TOKEN`, run the MS0 preflight:

```sh
pnpm ms0:preflight \
  --account-id <account-id> \
  --zone-id <zone-id> \
  --domain <sending-domain>
```

The preflight verifies token/account/zone access and checks the official Email Sending subdomains and DNS-record APIs. It cannot prove non-sandbox status; MS0 still requires the live delivery tests below.

## 1. Configure the disposable spike Worker

From the repo root:

```sh
cp worker/wrangler.spike.toml.example worker/wrangler.spike.toml
```

Edit `worker/wrangler.spike.toml` and set `CF_ACCOUNT_ID`.

Set secrets from `worker/`:

```sh
cd worker
pnpm exec wrangler secret put CF_API_TOKEN --config wrangler.spike.toml
pnpm exec wrangler secret put MS0_SPIKE_TOKEN --config wrangler.spike.toml
```

Run locally without sending mail:

```sh
pnpm ms0:spike:dev
```

Deploy only when ready for the live MS0 gate:

```sh
pnpm ms0:spike:deploy
```

## 2. Capture Gmail-originated MIME

Run the disposable capture SMTP server on the host that Gmail can reach:

```sh
cd relay
export MS0_SMTP_PASSWORD='REPLACE_WITH_RANDOM_PASSWORD'
go run ./cmd/ms0-capture \
  -addr :587 \
  -cert /etc/letsencrypt/live/smtp.example.com/fullchain.pem \
  -key /etc/letsencrypt/live/smtp.example.com/privkey.pem \
  -username ms0-capture \
  -out ../.ai-runs/ms0-captures
```

If the Go toolchain is unavailable on the capture host, use the disposable
Python helper instead:

```sh
export MS0_SMTP_PASSWORD='REPLACE_WITH_RANDOM_PASSWORD'
python3 infra/ms0/capture_smtp.py \
  --host 0.0.0.0 \
  --port 587 \
  --cert /etc/letsencrypt/live/smtp.example.com/fullchain.pem \
  --key /etc/letsencrypt/live/smtp.example.com/privkey.pem \
  --username ms0-capture \
  --out .ai-runs/ms0-captures
```

Configure Gmail "Send mail as" with:

- SMTP server: the capture hostname.
- Port: `587`.
- Username: `ms0-capture`.
- Password: the value in `MS0_SMTP_PASSWORD`.
- Secured connection using TLS.

Send these messages from Gmail and preserve the captured `.eml` files:

| Fixture | Required content |
|---|---|
| `plain-text.eml` | Simple plain text. |
| `html-with-image.eml` | HTML body with an inline image. |
| `attachment-pdf-4mb.eml` | Approximately 4 MB PDF attachment, non-ASCII subject, and Gmail's existing `DKIM-Signature` header if present. |
| `8bit-body.eml` | Explicit 8-bit body content for documenting rejection behavior. |

Place sanitized captures under `examples/gmail-mime-fixture/` only if they contain no private content. Otherwise keep them in `.ai-runs/ms0-captures/`, which is gitignored.

## 3. Dry-run request assembly

Dry-run verifies that the Worker can decode the MIME bytes and build the documented JSON request shape without calling Cloudflare:

```sh
export MS0_SPIKE_TOKEN='REPLACE_WITH_SPIKE_TOKEN'
pnpm ms0:spike:send \
  --fixture .ai-runs/ms0-captures/plain-text.eml \
  --from sender@example.com \
  --recipients gmail-recipient@example.net \
  --worker-url https://<spike-worker-host> \
  --label plain-text \
  --dry-run
```

Expected:

- `ok: true`.
- `mime_size_bytes` matches the file size.
- `mime_sha256` is recorded in the MS0 evidence.
- `mime_round_trip_verified` is `true`.
- `cf_status` is `null`.
- Evidence JSON is written under `.ai-runs/ms0-evidence/`.

Invalid non-UTF-8 bytes must be rejected before a live send:

```sh
printf 'Subject: invalid\r\n\r\n\xff\r\n' > .ai-runs/ms0-invalid-utf8.eml
pnpm ms0:spike:send \
  --fixture .ai-runs/ms0-invalid-utf8.eml \
  --from sender@example.com \
  --recipients gmail-recipient@example.net \
  --worker-url https://<spike-worker-host> \
  --label invalid-utf8 \
  --dry-run
```

Expected: HTTP `422` with `error: mime_not_utf8_json_safe`.

## 4. Live send_raw tests

For each captured fixture, send to Gmail, Outlook, and iCloud:

```sh
pnpm ms0:spike:send \
  --fixture .ai-runs/ms0-captures/plain-text.eml \
  --from sender@example.com \
  --recipients gmail@example.net,outlook@example.net,icloud@example.net \
  --worker-url https://<spike-worker-host> \
  --label plain-text-live \
  --live
```

Record for each run:

- Fixture filename.
- `mime_sha256` returned by the spike Worker.
- `cf_status`, `cf_ray_id`, and `cf_request_id`.
- Cloudflare `result.delivered`, `result.queued`, and `result.permanent_bounces`.
- Inbox placement for Gmail, Outlook, and iCloud.
- Authentication results headers from each mailbox.

The `pnpm ms0:spike:send` command writes request/response evidence JSON under `.ai-runs/ms0-evidence/`; keep those files with the run notes. They are intentionally gitignored because they may include private addresses and Cloudflare request metadata.

## MS0 exit checklist

- [ ] `send_raw` JSON shape verified live with `from`, `recipients`, and `mime_message`.
- [ ] Plain text Gmail MIME delivered to Gmail, Outlook, and iCloud.
- [ ] HTML plus inline image Gmail MIME delivered to Gmail, Outlook, and iCloud.
- [ ] At least one of the plain text or HTML tests shows DKIM pass with `d=<adopter-domain>` and DMARC pass in all three recipient services.
- [ ] 4 MB PDF attachment plus non-ASCII subject behavior documented, including any quirks.
- [ ] 8-bit/non-UTF-8 behavior documented.
- [ ] Worker input MIME bytes and the `mime_message` value round-trip with identical SHA-256.
- [ ] `docs/cloudflare-email-sending.md` MIME quirks table updated with real observations.

MS0 passes only after the live delivery evidence is captured. Until then, the project remains blocked before MS1.
