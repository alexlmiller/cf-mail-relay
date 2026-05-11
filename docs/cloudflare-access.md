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

Save the output and apply those values to `worker/wrangler.toml`:

```sh
CLOUDFLARE_ACCOUNT_ID=fa774a1ed55e467890d48394f4409bdd \
CLOUDFLARE_API_TOKEN=... \
pnpm access:setup --allow-email alex@alexmiller.net \
  --apply-config worker/wrangler.toml
```

If you prefer to keep the setup and local config write as separate steps, save
the setup output and run `pnpm access:apply --json .ai-runs/access-app.json`.
If your API token can manage Access apps but cannot read the Access
organization, add `--team-domain <your-team.cloudflareaccess.com>` to skip the
organization lookup.

Then deploy the Worker:

```sh
pnpm --dir worker exec wrangler deploy
```

Verify the live gate:

```sh
pnpm access:verify
```

The verifier reads `worker/wrangler.toml`, checks that the Access team domain
and audience are no longer placeholders, fetches the Access JWKS, confirms the
Pages artifact points at the Worker URL, and verifies that unauthenticated
admin API requests are intercepted before reaching the Worker.

For the final MS3 exit check, also verify an authenticated admin session with a
real Access JWT:

```sh
ACCESS_JWT=... pnpm access:verify --access-jwt-env ACCESS_JWT --require-authenticated-session
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
into `ACCESS_TEAM_DOMAIN`, or apply them with:

```sh
pnpm access:apply --team-domain <access_team_domain> --audience <access_audience>
```

## Current live status

The MS3 Worker and Pages UI are already deployed:

- Worker: `https://cf-mail-relay-worker.milfred.workers.dev`
- Pages: `https://cf-mail-relay-ui.pages.dev`

The currently available Wrangler OAuth token and the Email Sending API token do
not have Access permissions. Both fail on Access organization read with
Cloudflare API error `10000: Authentication error`. Use an API token with
`Access: Apps and Policies Write`, or create the Access app manually and copy
the resulting values into `worker/wrangler.toml`.
