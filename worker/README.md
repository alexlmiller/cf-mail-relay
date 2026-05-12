# worker/

Cloudflare Worker. TypeScript, Hono, D1, KV.

The Worker is the policy and delivery authority. It validates credentials,
sender permissions, quotas, idempotency, and Cloudflare Access admin JWTs before
calling Cloudflare Email Sending `send_raw`.

The Worker also enforces MIME/envelope alignment: SMTP and HTTP sends must have
a MIME `From:` matching the authorized sender, and `Bcc:` is stripped before
calling Cloudflare. Duplicate singleton identity headers (`From:`, `Sender:`,
and `Message-ID:`) are rejected before delivery.

## Routes

| Route | Purpose | Auth |
|---|---|---|
| `GET /healthz` | Liveness and D1 schema compatibility | none |
| `POST /bootstrap/admin` | Create the first admin user | bootstrap bearer token |
| `POST /relay/auth` | Verify SMTP credential | relay HMAC |
| `POST /relay/send` | Send raw MIME received from relay | relay HMAC |
| `POST /send` | Send raw MIME from an app/client | API key |
| `/admin/api/*` | Admin UI API | Cloudflare Access JWT + Origin on unsafe browser methods |
| `/self/api/*` | Sender self-service API | Cloudflare Access JWT + Origin on unsafe browser methods |

Unsafe admin/self requests from browsers must include the configured trusted
`Origin`. Non-browser scripts without `Origin` and without Fetch Metadata
headers are allowed to proceed to Cloudflare Access JWT authorization.

## Bindings

See `wrangler.toml.example`. Required bindings include:

- `D1_MAIN`
- `KV_HOT`
- `CF_API_TOKEN`
- `CF_ACCOUNT_ID`
- `CREDENTIAL_PEPPER`
- `METADATA_PEPPER`
- `RELAY_HMAC_SECRET_CURRENT`
- `BOOTSTRAP_SETUP_TOKEN`
- `ACCESS_TEAM_DOMAIN`
- `ACCESS_AUDIENCE`
- `REQUIRED_D1_SCHEMA_VERSION`

## Local Development

```sh
cd worker
pnpm typecheck
pnpm test
pnpm exec wrangler dev
```

Apply migrations with:

```sh
pnpm exec wrangler d1 migrations apply <DB_NAME>
```

Apply migrations before deploying the Worker. `/healthz` returns
`schema_version_mismatch` when the code expects a newer D1 schema.
