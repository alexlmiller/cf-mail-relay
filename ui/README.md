# ui/

Admin UI on Cloudflare Pages. [Astro](https://astro.build).

Behind a Cloudflare Access application that fronts both the Pages origin and the Worker `/admin/api/*` route.

## Pages

- `/` — dashboard, domains, allowed senders, SMTP credentials, users, API keys,
  send events, and auth failures.
- The API base defaults to same-origin. Set `PUBLIC_CF_MAIL_RELAY_API_BASE`
  when the Pages host calls a separate Worker host.

## Auth

Cloudflare Access in front of the Pages origin. Worker validates `Cf-Access-Jwt-Assertion` against the team's JWKS + audience claim. The `Cf-Access-Authenticated-User-Email` header is display-only.

## Local development

```sh
cd ui
pnpm install
pnpm dev
```
