# Threat Model

The relay is adopter-operated infrastructure. The Worker, D1, and KV are the
policy and delivery authority.

## Events Covered

| Event | Detection signals | Mitigation | Recovery |
|---|---|---|---|
| Compromised relay host | Unexpected `send_events.source='smtp'`, unusual recipient-domain hashes, relay host logs showing unknown sessions, HMAC nonce failures after host rebuild | Rotate relay HMAC secret, revoke SMTP credentials that transited the host, rebuild host from a clean image | Set `RELAY_HMAC_SECRET_PREVIOUS` only during planned rotation, redeploy Worker, restart relay with new secret, verify with `doctor:local` |
| Leaked SMTP credential | `auth_failures` followed by successful sends for one credential, sends outside expected sender/recipient pattern | Revoke credential in UI, create replacement, tighten sender allowlist | Update Gmail "Send mail as"; review `send_events` for abuse window |
| Leaked HTTP API key | `send_events.source='http'` for unknown clients, unexpected `api_key_id`, rate limits firing for one key | Revoke API key in UI, create replacement with explicit sender restriction | Update clients; consider lowering `daily_cap_credential` |
| Leaked Worker HMAC secret | Valid-looking `/relay/*` requests from an unexpected host, nonce replays, sudden relay-auth volume without matching relay host logs | Rotate HMAC secret immediately; firewall relay host; inspect Worker logs | Deploy new current secret, move old to previous only if known-safe, then remove previous after relay restart |
| Leaked CF API token | Cloudflare audit logs show token use outside Worker deploy/runtime, token health check fails unexpectedly, Email Sending calls from unknown context | Rotate the Cloudflare API token with least-privilege scopes; `wrangler secret put CF_API_TOKEN` | Re-run `doctor:local`; review Cloudflare audit logs and Email Sending activity |
| Cloudflare Access misconfiguration | Pages UI or `/admin/api/*` reachable without Access redirect, `requireAdmin` errors disappear for unauthenticated requests | Re-apply Access app, verify public hostnames, run strict `access:verify` | Review D1 `users` rows and Access policy membership; rotate credentials created during exposure |
| Open-relay attempt | `auth_failures` spike with varied usernames/IPs, relay AUTH/min throttles firing | Relay AUTH required; per-IP and per-username throttles; optional provider firewall block | No credential rotation required unless a real credential succeeded |
| `send_raw` flood | `rate_limited` send events, D1 `rate_reservations` near caps, Cloudflare Email Sending errors | Worker KV sender/minute cap and D1 daily caps | Identify credential/API key, revoke if compromised, then reset or raise caps intentionally |
| D1 restore to stale state | `/healthz` reports `schema_version_mismatch`, old revoked credentials appear active | Health check blocks mismatched schema; run restore checklist | Reapply migrations, rotate secrets valid at restore timestamp, audit users and credentials |

## Recovery Principles

- Prefer revocation over deletion so audit trails remain meaningful.
- Rotate shared secrets from the Worker outward: deploy Worker secret first, then
  update relay/client configuration.
- Keep `CF_API_TOKEN` scoped only to the account features this Worker needs.
- Keep Cloudflare Access as the admin trust boundary; the UI stores no secrets.
