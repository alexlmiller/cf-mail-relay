# ADR-002: Admin Access Hostnames

**Status**: Accepted.
**Date**: 2026-05-11.

## Context

MS3 requires Cloudflare Access in front of both the Pages admin UI and the
Worker `/admin/api/*` routes. The current live MS3 deployment uses Cloudflare
platform hostnames:

- `cf-mail-relay-ui.pages.dev`
- `cf-mail-relay-worker.milfred.workers.dev/admin/api/*`

Cloudflare documents one-click Access flows for both platform hostname families:

- Workers can enable Access for `workers.dev` and preview URLs from Workers &
  Pages > Worker > Settings > Domains & Routes.
- Pages preview deployments can be protected from Pages project settings; to
  protect the project `*.pages.dev` hostname, Cloudflare documents an extra
  dashboard flow that edits the generated Access application public hostname.

Cloudflare's generic self-hosted public application setup is documented for
public hostnames on active Cloudflare zones. That is the right model for custom
domains such as `admin.example.com` or `api.example.com`, but it is not enough
evidence by itself that a hand-created self-hosted Access application will
protect `pages.dev` and `workers.dev` platform hostnames.

## Decision

MS3 remains a Cloudflare Access gate, but the accepted setup paths are:

1. **Platform-hostname path for the current live deployment.**
   Enable Access through the Workers & Pages dashboard controls for
   `cf-mail-relay-ui.pages.dev` and
   `cf-mail-relay-worker.milfred.workers.dev`, then copy the resulting Access
   team domain and audience into `worker/wrangler.toml`.
2. **Custom-domain path for distribution.**
   Put the UI and Worker API on hostnames inside an active Cloudflare zone, then
   use the generic self-hosted Access application helper (`pnpm access:setup`).

The MS3 exit gate is not the existence of an Access app record. It is the strict
live verifier:

```sh
ACCESS_JWT=... pnpm access:verify --access-jwt-env ACCESS_JWT --require-authenticated-session
```

This verifier must prove that:

- local Worker Access config is non-placeholder,
- the Access JWKS is reachable,
- the Pages artifact points at the Worker URL,
- unauthenticated admin API requests do not reach the Worker directly, and
- an authenticated Access JWT returns an admin session from `/admin/api/session`.

## Consequences

- The current `pnpm access:setup` helper is still useful, but it should be used
  for custom-domain deployments or only after confirming Cloudflare accepts the
  intended platform hostnames for the account.
- For the live `pages.dev` / `workers.dev` deployment, manual dashboard
  configuration may be the shortest path to unblock MS3.
- MS4 remains blocked until the strict verifier passes.
