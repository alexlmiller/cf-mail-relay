# Screenshot harness

Generates the marketing/docs screenshots of the admin UI from typed mock data.
Run `pnpm screenshots` from the repo root.

## How it works

1. Builds the UI (`pnpm --filter @cf-mail-relay/ui build`) into `worker/public/`
   if it isn't already built.
2. Boots a tiny Node static server on `http://127.0.0.1:5181` with SPA fallback,
   mirroring what Workers Static Assets serves in production.
3. Launches Playwright Chromium at 1440×900 @ 2× device scale.
4. For each entry in `shots.config.ts`:
   - Injects `intercept.js` + the shot's `fixtures` map before the page boots,
     so every `/admin/api/*` and `/self/api/*` call resolves locally.
   - Navigates to the shot's `route`, runs optional pre-shot actions
     (open palette, click row, fill form), and screenshots into
     `infra/screenshots/out/<slug>.png`.

The fixtures (`fixtures.ts`) are typed against `ui/src/lib/types.ts` and
`ui/src/lib/api-self.ts`. If the API shape changes, fixtures fail to compile
before producing stale screenshots.

## Output

- `infra/screenshots/out/` — staging directory, gitignored. Every run overwrites
  the files here.
- `docs/images/` — curated, committed subset embedded in README/docs.

Promote a fresh shot from staging to docs with a plain `cp`:

```
cp infra/screenshots/out/01-dashboard.png docs/images/
```

## Commands

```sh
# Generate all 12 shots
pnpm screenshots

# Generate one shot (prefix match against shot.name)
pnpm screenshots dashboard
```

## Adding a shot

1. Add the fixture rows you need to `fixtures.ts` (or a new `xxxFixtures()`
   helper if the dataset is meaningfully different).
2. Add a `Shot` entry in `shots.config.ts`. The `setup` hook receives a
   Playwright `Page` — fill forms, press shortcuts, click rows.
3. `pnpm screenshots <new-name-prefix>` to iterate quickly.

## Why this and not Storybook / a server-rendered fixture page

The production bundle runs unmodified — no demo build flags, no `if (demoMode)`
branches, no separate component library. The fetch monkey-patch is the only
thing inserted, and it lives in a single 30-line file.
