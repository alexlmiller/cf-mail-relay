# Gmail "Send mail as" configuration

> Stub. Walkthrough with screenshots lands in MS6.

For each custom address you want to send as (e.g., `alex@example.com`):

1. Create an SMTP credential in this project's admin UI (Credentials → New). Note the plaintext shown once.
2. In Gmail: Settings → "Accounts and Import" → "Send mail as" → "Add another email address".
3. Email: `alex@example.com`. Uncheck "Treat as an alias" if you want it to act like a separate identity.
4. SMTP server: your relay hostname, e.g., `smtp.alexmiller.net`. Port `587`. TLS (STARTTLS).
5. Username: the SMTP credential's `username`. Password: the plaintext from step 1.
6. Gmail will send a verification email to the address. Click the link.

## Multiple custom addresses across multiple domains

Repeat steps 1–6 for each address. **All addresses can use the same relay hostname** even when they're on different domains. The relay's SMTP server doesn't need a hostname matching the sender domain.

Per-credential scoping is configured in the admin UI under Credentials → Edit → "Allowed senders". A single credential can be allowlisted for many `(domain, address)` pairs, or you can issue one credential per address for tighter scoping.

## If the verification email doesn't arrive

1. Check the admin UI → Events. You should see a `send_events` row with `status=accepted`.
2. Check the recipient's spam folder.
3. Run `pnpm doctor:delivery --domain <the-domain>` to verify DKIM/DMARC.
4. Check the domain's status in the UI — if `sandbox`, you can only deliver to addresses you've verified in the Cloudflare dashboard.
