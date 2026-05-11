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
target account. Cloudflare's Access application API documents this permission
for the `/access/apps` endpoints:
<https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/applications/methods/get/>.
Then run:

```sh
CLOUDFLARE_ACCOUNT_ID=fa774a1ed55e467890d48394f4409bdd \
CLOUDFLARE_API_TOKEN=... \
pnpm access:setup --allow-email alex@alexmiller.net
```

Use `--dry-run` to inspect the Access app and policy payload without calling
Cloudflare:

```sh
pnpm access:setup --dry-run --account-id fa774a1ed55e467890d48394f4409bdd \
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

## Current live status

The MS3 Worker and Pages UI are already deployed:

- Worker: `https://cf-mail-relay-worker.milfred.workers.dev`
- Pages: `https://cf-mail-relay-ui.pages.dev`

The currently available Wrangler OAuth token and the Email Sending API token do
not have Access permissions. Both fail on Access organization read with
Cloudflare API error `10000: Authentication error`. Use an API token with
`Access: Apps and Policies Write`, or create the Access app manually and copy
the resulting values into `worker/wrangler.toml`.
