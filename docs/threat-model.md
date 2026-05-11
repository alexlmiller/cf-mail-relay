# Threat Model

> Lands in MS5. This stub captures the events the threat-model document must cover.

## Events covered

| Event | Detection signals | Mitigation | Recovery |
|---|---|---|---|
| Compromised relay host | TBD | Rotate HMAC secret; revoke SMTP credentials | TBD |
| Leaked SMTP credential | `auth_failures` spike or `send_events` from unexpected source | Revoke credential in UI | Issue new credential |
| Leaked Worker HMAC secret | TBD | Dual-secret rotation | TBD |
| Leaked CF API token | TBD | `wrangler secret put CF_API_TOKEN`; rotate CF-side | TBD |
| Cloudflare Access misconfiguration | Unexpected admin access | Tighten Access policy; review `users.access_subject` history | TBD |
| Open-relay attempt | `auth_failures` spike with varied `attempted_username` | Auth-failure throttle; consider blocking IP at Hetzner firewall | N/A |
| `send_raw` flood | `send_events` row creation rate above `rate_reservations` cap | D1 reservation rejects; KV soft cap fires earlier | Investigate compromised credential |

MS5 fills each row with concrete signals and procedures.
