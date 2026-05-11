# Cloudflare Email Sending — what adopters need to know

Cloudflare Email Sending is the upstream we call from the Worker. It's currently in **public beta**; this doc captures what's known and what to watch for.

## Plan requirement

Email Sending requires **Workers Paid**. Cloudflare's free Workers plan does not include it. Pricing as of writing: includes 3,000 outbound emails/month, then per-1,000-messages charges. Verify against Cloudflare's [pricing page](https://developers.cloudflare.com/email-service/platform/pricing/).

## DNS requirement

Cloudflare Email Sending **requires DNS managed on Cloudflare** for the sending domain. Adopters using external DNS providers must either move the domain to Cloudflare DNS or use a subdomain whose DNS is on Cloudflare.

## Domain onboarding

For each sending domain:

1. Add the domain to your Cloudflare account.
2. Enable Email Sending in the dashboard for the domain.
3. Publish the DNS records Cloudflare provisions:
   - `cf-bounce.<domain>` MX record
   - `cf-bounce.<domain>` SPF TXT record
   - DKIM record (CNAME or TXT, varies)
   - `_dmarc.<domain>` TXT — start at `v=DMARC1; p=none; rua=mailto:dmarc@<domain>`
4. Wait for verification status to flip from `pending` to `verified` (or `sandbox`).

## Sandbox vs verified

New accounts often start in **sandbox** mode where Email Sending can only deliver to **verified recipient addresses** that you add through the Cloudflare dashboard. To send to arbitrary recipients (e.g., normal Gmail-to-friend sends), the account must be **out of sandbox**.

The setup wizard surfaces this in preflight; the `domains.status` column tracks it; the UI flags sandboxed domains prominently. Trying to send to a non-verified recipient from a sandbox account will return `permanent_bounces` for that recipient.

## API

`POST /accounts/{account_id}/email/sending/send_raw`

Documented [here](https://developers.cloudflare.com/api/resources/email_sending/methods/send_raw/). JSON body, headline shape:

```json
{
  "from": "alex@example.com",
  "recipients": ["someone@example.org"],
  "mime_message": "MIME-Version: 1.0\r\nFrom: ...\r\n\r\n..."
}
```

Response (approximate; verify in MS0):

```json
{
  "result": {
    "delivered": ["someone@example.org"],
    "queued": [],
    "permanent_bounces": []
  },
  "success": true
}
```

The Worker maps delivered/queued/permanent_bounces combinations to SMTP codes per `IMPLEMENTATION_PLAN.md` "Partial-recipient policy".

## Limits

| Limit | Value | Where enforced |
|---|---|---|
| Total MIME size | 5 MiB | Cloudflare upstream; relay enforces 4.5 MiB at DATA; Worker enforces 6 MiB defense-in-depth |
| Recipients per message | 50 | Cloudflare upstream; relay rejects at RCPT TO #50; Worker rejects |
| 8-bit body content | not supported in MVP | Relay rejects at DATA with `554 5.6.0`; user instructed to use base64 or quoted-printable |
| Account-wide daily cap | account-specific | Worker `rate_reservations` row `scope_type='global_day'` |

For attachments: Gmail base64-encodes which expands by ~33%, plus MIME boundary overhead. **Practical guidance: keep original attachments below ~3.25 MiB.**

## DKIM and DMARC

- **Cloudflare DKIM-signs outgoing mail at the platform level** when Email Sending is provisioned for the domain. The Worker does **not** re-sign. Multiple DKIM signatures (e.g., one from Gmail and one from Cloudflare) are valid; one aligned passing signature satisfies DMARC.
- **DMARC alignment is via DKIM**, not SPF. Cloudflare's egress IPs are not in the adopter's SPF record; SPF will not align to the visible `From:` domain. DKIM with `d=<adopter-domain>` is the anchor.
- Adopters should **start DMARC at `p=none`** until `doctor:delivery` confirms alignment, then escalate to `quarantine`, eventually `reject`.

## Beta caveats

- API shape may change. Pin the date in `wrangler.toml`'s `compatibility_date` and the documented date in this file. Track changes via Cloudflare changelog.
- Pricing may change.
- Send-and-forget. There is no inbound delivery confirmation API in MVP; `cf_delivered_json` in `send_events` records Cloudflare's accept-time response, not recipient-mailbox confirmation.

## MIME quirks (MS0 spike will populate)

> Populated by MS0 spike with concrete observations.

| Scenario | Result | Notes |
|---|---|---|
| Plain text from Gmail | TBD | |
| HTML with inline image | TBD | |
| 4 MB PDF attachment + non-ASCII subject + existing DKIM-Signature | TBD | |
| 8-bit body content | rejected by relay | MVP decision |
| Long subject lines (>78 chars) | TBD | |
| iCal/multipart/alternative | TBD | |

## References

- [Email Service overview](https://developers.cloudflare.com/email-service/)
- [Pricing](https://developers.cloudflare.com/email-service/platform/pricing/)
- [Limits](https://developers.cloudflare.com/email-service/platform/limits/)
- [send_raw API](https://developers.cloudflare.com/api/resources/email_sending/methods/send_raw/)
- [Domain configuration](https://developers.cloudflare.com/email-service/configuration/domains/)
- [KV consistency](https://developers.cloudflare.com/kv/concepts/how-kv-works/)
