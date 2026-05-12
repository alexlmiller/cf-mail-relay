# ui/

Source for the admin UI. [Astro](https://astro.build) builds it to a static
bundle that the Worker serves via Workers Static Assets — there is no
separate Cloudflare Pages project.

## Where the build lands

`astro build` outputs into `../worker/public/` (configured in
`astro.config.mjs`). The Worker's `wrangler.toml` declares that directory
as the `[assets]` source, so `wrangler deploy` ships HTML + JS + CSS
alongside the worker code.

`worker/public/` is gitignored. The source-controlled `ui/public/_headers`
file (security headers including the CSP) is copied during build.

## Surfaces

- `/` — dashboard, domains, allowed senders, SMTP credentials, users, API
  keys, send events, and auth failures. All admin actions on `/admin/api/*`.
- `/#/me` — same-origin self-service for any signed-in user (admins + sender
  role). Calls `/self/api/*`.

The admin/self API live at the same hostname as the UI; `apiBase` is `""`
and the browser issues relative-URL fetches.

## Auth

Cloudflare Access protects the UI paths (`/`, `/_astro/*`) and the
admin/self API paths (`/admin/api/*`, `/self/api/*`) via path-scoped
destinations. The Worker validates the `Cf-Access-Jwt-Assertion` header
against the team's JWKS, audience, issuer, and `type === "app"`. The
`Cf-Access-Authenticated-User-Email` header is display-only.

Browser POSTs/PATCHes/DELETEs additionally pass an Origin check on the
Worker. Same-origin satisfies this trivially without `ADMIN_CORS_ORIGIN`.

## Local development

`pnpm --filter @cf-mail-relay/ui dev` runs Astro on `:4321`. The dev server
proxies `/admin/api/*`, `/self/api/*`, `/relay/*`, `/send`, `/healthz`,
`/bootstrap/*` to a local `wrangler dev` worker on `:8787` so the
same-origin contract holds in dev too.

```sh
# Terminal 1
cd worker && pnpm exec wrangler dev

# Terminal 2
cd ui && pnpm dev
```
