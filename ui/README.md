# UI

Astro source for the admin and sender self-service UI. `astro build` writes to
the gitignored `worker/public/`; the Worker serves that bundle from the same
origin as the API. There is no production Pages project.

The shell is public. Cloudflare Access protects `/admin/api/*` and
`/self/api/*`; the Worker validates the Access JWT and checks `Origin` on unsafe
browser methods. Admin routes use hash navigation such as `#/events`; sender
self-service is `#/me`.

For local development, run both processes:

```sh
# once, before starting the Worker
pnpm --dir ui build

# terminal 1
pnpm --dir worker exec wrangler dev

# terminal 2
pnpm --dir ui dev
```

The Astro dev server proxies API routes to the Worker on `:8787`. The public
demo is a separate workspace under `demo/` and must not add mock behavior or its
hostname to production builds.
