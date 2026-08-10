# Worker

Cloudflare Worker for policy, delivery, and state. It also serves the admin UI
from `worker/public/` through Workers Static Assets.

Before calling Email Sending `send_raw`, the Worker validates credentials,
sender grants, quotas, idempotency, Cloudflare Access JWTs, MIME `From:`
alignment, and singleton identity headers. It strips `Bcc` and capture-hop
headers. See [the route and trust-boundary reference](../docs/architecture.md).

## Configuration

Copy `wrangler.toml.example` to the gitignored `wrangler.toml`, or generate it
with `pnpm run setup`. Required bindings and values are:

- `D1_MAIN` and `KV_HOT`
- `CF_ACCOUNT_ID` and runtime secret `CF_API_TOKEN`
- `CREDENTIAL_PEPPER` and `METADATA_PEPPER`
- `RELAY_HMAC_KEY_ID` and `RELAY_HMAC_SECRET_CURRENT`
- `ACCESS_TEAM_DOMAIN` and `ACCESS_AUDIENCE`
- `REQUIRED_D1_SCHEMA_VERSION`

The runtime Cloudflare token needs Account Email Sending Edit and Zone Read for
sending zones. `RELAY_HMAC_SECRET_PREVIOUS` is optional during rotation.
`BOOTSTRAP_SETUP_TOKEN` is optional and only for manual recovery; normal setup
creates the first admin directly in D1.

## Local development

```sh
cp worker/wrangler.toml.example worker/wrangler.toml
pnpm --dir worker exec wrangler d1 migrations apply cf-mail-relay --local
pnpm --dir worker test
pnpm --dir worker typecheck
pnpm --dir ui build
pnpm --dir worker exec wrangler dev
```

Apply remote migrations before newer Worker code. `/healthz` reports
`schema_version_mismatch` until code and D1 agree.
