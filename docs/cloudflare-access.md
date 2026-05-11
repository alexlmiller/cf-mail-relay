# Cloudflare Access for the admin UI

MS3 requires one Cloudflare Access self-hosted application covering both the
static Pages UI and the Worker admin API:

- `https://cf-mail-relay-ui.pages.dev`
- `https://cf-mail-relay-worker.milfred.workers.dev/admin/api/*`

The Worker validates the `Cf-Access-Jwt-Assertion` header against the Access
JWKS endpoint and the configured audience. The display email header is not a
trust root.

## API setup

Create a Cloudflare API token with `Access: Apps and Policies Write` on the
target account. Then run:

```sh
CLOUDFLARE_ACCOUNT_ID=fa774a1ed55e467890d48394f4409bdd \
CLOUDFLARE_API_TOKEN=... \
node infra/wrangler/access-app.mjs \
  --allow-email alex@alexmiller.net
```

The script creates or updates:

- A self-hosted Access app named `cf-mail-relay-admin`.
- Public destinations for the Pages UI and Worker `/admin/api/*`.
- A CORS configuration that allows the Pages origin to call the Worker API with
  Access credentials.
- An allow policy for the provided email addresses.

It prints:

- `access_team_domain`
- `access_audience`

Set those values in `worker/wrangler.toml`:

```toml
ACCESS_TEAM_DOMAIN = "<access_team_domain>"
ACCESS_AUDIENCE = "<access_audience>"
ADMIN_CORS_ORIGIN = "https://cf-mail-relay-ui.pages.dev"
```

Then deploy the Worker:

```sh
pnpm --dir worker exec wrangler deploy
```

## Manual setup

In Cloudflare Zero Trust, create a self-hosted Access application with:

- Name: `cf-mail-relay-admin`
- Application domain: `cf-mail-relay-ui.pages.dev`
- Additional public destination: `cf-mail-relay-worker.milfred.workers.dev/admin/api/*`
- Policy action: Allow
- Include: the admin email addresses that should be allowed to use the UI
- Session duration: `24h`
- CORS:
  - Allow credentials: enabled
  - Allowed origin: `https://cf-mail-relay-ui.pages.dev`
  - Allowed methods: `GET`, `POST`, `OPTIONS`
  - Allowed headers: `content-type`

Copy the application audience tag into `ACCESS_AUDIENCE` and the team domain
into `ACCESS_TEAM_DOMAIN`.
