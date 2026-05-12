# demo/

Standalone public click-through demo for the admin UI.

This is intentionally separate from the production Worker. It has no D1, KV,
Cloudflare Access, Email Sending token, relay HMAC secrets, bootstrap token, or
send endpoints. It serves a static UI bundle and installs an in-browser mock API
with sample data.

Build locally:

```sh
pnpm --filter @cf-mail-relay/demo build
```

Deploy the demo Worker:

```sh
pnpm demo:deploy
```

Production deployments should not include the demo hostname in
`worker/wrangler.toml`.
