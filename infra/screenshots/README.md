# Screenshot harness

Generates UI screenshots from local fixture data.

```sh
pnpm screenshots             # every configured shot
pnpm screenshots dashboard   # names containing "dashboard"
```

The harness builds the production UI when needed, serves it locally, injects
mock API responses, and captures each entry in `shots.config.ts` with Playwright.
No Cloudflare resources are used.

Outputs go to the gitignored `infra/screenshots/out/`. `docs/images/` contains
only the curated images referenced by documentation. Promote one explicitly:

```sh
cp infra/screenshots/out/01-dashboard.png docs/images/
```

To add a shot, add fixture data in `fixtures.ts`, add an entry to
`shots.config.ts`, then run a unique substring of its name. Fixtures import the
UI API types, but the screenshot command transpiles without a separate static
typecheck; review fixture changes with the UI types in the same change.
