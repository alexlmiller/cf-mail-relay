# DNS records

For each sending domain you need three families of records on Cloudflare DNS:

1. **Email Sending records** (outbound; `cf-bounce.<domain>` set + DKIM + DMARC).
2. **The relay hostname** (`smtp.<some-domain>` A/AAAA, DNS-only, **not** orange-clouded).
3. **Email Routing records** if you also use Cloudflare Email Routing for inbound (separate; on the apex; do not conflict with the outbound set).

## Single domain example: `example.com`

```
; Email Sending (provisioned by Cloudflare's Email Sending setup):
cf-bounce.example.com.            MX  10 routes.mx.cloudflare.net.
cf-bounce.example.com.            TXT "v=spf1 include:_spf.mx.cloudflare.net ~all"
cf-bounce._domainkey.example.com. TXT  "v=DKIM1; ... (Cloudflare-generated)"
_dmarc.example.com.               TXT "v=DMARC1; p=none; rua=mailto:dmarc@example.com"

; SMTP relay (DNS-only; the orange cloud must be OFF):
smtp.example.com.                 A    198.51.100.7
smtp.example.com.                 AAAA 2001:db8::7

; Optional: Cloudflare Email Routing inbound (apex MX, distinct from cf-bounce):
example.com.                      MX  10 amir.mx.cloudflare.net.
example.com.                      MX  20 isaac.mx.cloudflare.net.
example.com.                      MX  30 linda.mx.cloudflare.net.
example.com.                      TXT "v=spf1 include:_spf.mx.cloudflare.net ~all"
```

Notes:
- The `cf-bounce.<domain>` MX is Cloudflare's bounce-handling endpoint and is **distinct** from any apex MX you have for inbound Email Routing.
- The SPF record on `cf-bounce.<domain>` is Cloudflare's bounce sender's SPF — separate from any apex SPF you publish.
- DMARC alignment for outgoing mail uses **DKIM** (Cloudflare signs with `d=<your-domain>`). SPF will not align to the visible `From:` because Cloudflare's egress IPs are not in your SPF.

## Multi-domain example: `alexmiller.net` + `example.org`

The same Worker handles both domains. Each domain gets its **own** complete set of Email Sending records. The relay hostname can live on one domain and serve sends from many.

```
; Domain 1 — alexmiller.net (Email Sending):
cf-bounce.alexmiller.net.            MX  10 routes.mx.cloudflare.net.
cf-bounce.alexmiller.net.            TXT "v=spf1 include:_spf.mx.cloudflare.net ~all"
cf-bounce._domainkey.alexmiller.net. TXT "v=DKIM1; ..."
_dmarc.alexmiller.net.               TXT "v=DMARC1; p=none; rua=mailto:dmarc@alexmiller.net"

; Domain 2 — example.org (Email Sending):
cf-bounce.example.org.               MX  10 routes.mx.cloudflare.net.
cf-bounce.example.org.               TXT "v=spf1 include:_spf.mx.cloudflare.net ~all"
cf-bounce._domainkey.example.org.    TXT "v=DKIM1; ..."
_dmarc.example.org.                  TXT "v=DMARC1; p=none; rua=mailto:dmarc@example.org"

; Shared SMTP relay hostname — pick whichever domain you prefer.
; Gmail "Send mail as" for both addresses points to the same SMTP server.
smtp.alexmiller.net.                 A    198.51.100.7

; Both domains can use the same Cloudflare Email Routing inbound on their apexes
; if you also want inbound. Configure each independently.
```

Tradeoff for the relay hostname: it must be a single name with a TLS cert. Pick the primary domain; the cert covers `smtp.<primary>`. Adopters configuring Gmail "Send mail as" for `alex@example.org` will still use the relay hostname `smtp.alexmiller.net`. Gmail doesn't care about hostname-to-address alignment for the submission server.

## Checklist per added domain

- [ ] Domain added to Cloudflare account.
- [ ] Email Sending enabled in the dashboard.
- [ ] Email Sending verification flipped to `verified` (not `pending` or `sandbox` if you want to send to arbitrary recipients).
- [ ] `cf-bounce.<domain>` MX, SPF, DKIM records published.
- [ ] `_dmarc.<domain>` published with `p=none` initially.
- [ ] Domain status in this project's UI marked `verified`.
- [ ] Allowlisted sender(s) added for this domain.
- [ ] `doctor:delivery --domain <domain>` run and headers verified.
- [ ] DMARC escalated to `p=quarantine` after delivery verification.

## Do not

- Orange-cloud the `smtp.<domain>` record. Cloudflare cannot proxy SMTP on `587`.
- Mix Email Sending `cf-bounce.<domain>` records with apex MX/SPF.
- Skip DMARC. It guards against your domain being used for spoofing.
- Set DMARC to `quarantine` or `reject` before `doctor:delivery` is green — you will black-hole legitimate mail during DNS propagation.
