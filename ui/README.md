# ui/

Admin UI on Cloudflare Pages. [Astro](https://astro.build).

Behind a Cloudflare Access application that fronts both the Pages origin and the Worker `/admin/api/*` route.

## Status

Scaffold only. Implementation lands in MS3 per `IMPLEMENTATION_PLAN.md`.

## Pages (planned)

- `/` — dashboard (24 h sends, failures, last error, CF API health).
- `/domains` — list / add / configure sending domains.
- `/senders` — allowlisted sender addresses per domain.
- `/credentials` — SMTP credentials.
- `/api-keys` — HTTP API keys.
- `/events` — send_events with filters.
- `/auth-failures` — auth_failures with filters.
- `/settings` — retention, daily caps, policy version.

## Auth

Cloudflare Access in front of the Pages origin. Worker validates `Cf-Access-Jwt-Assertion` against the team's JWKS + audience claim. The `Cf-Access-Authenticated-User-Email` header is display-only.

## Local development

```sh
cd ui
pnpm install
pnpm dev
```
