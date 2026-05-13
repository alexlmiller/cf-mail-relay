# Agent Guidelines — Cloudflare Mail Relay

Read this first, then read [docs/architecture.md](./docs/architecture.md).

## Project Shape

This is a release-ready SMTP-to-Cloudflare-Email-Sending bridge:

- `relay/`: Go SMTP relay in Docker.
- `worker/`: Cloudflare Worker that enforces policy, calls Email Sending
  `send_raw`, AND serves the admin UI bundle (Workers Static Assets at
  `worker/public/`). Same-origin admin — no separate Pages project.
- `ui/`: Astro source for the admin UI. Builds into `worker/public/`.
- `demo/`: standalone static Worker for the public click-through demo. It
  imports the UI shell, installs the mock API, and must not be deployed with
  production D1/KV/secrets or the production Worker route list.
- `shared/`: shared TypeScript contracts.
- `infra/`: setup wizard (`pnpm run setup --apply`), OpenTofu reference module,
  Cloudflare Access helpers, HMAC rotation, doctor scripts, and Docker
  relay deployment templates.

## Design Constraints

- Send-only. No inbound mail handling.
- Raw MIME only. Do not add structured JSON composition without an explicit
  roadmap decision.
- No message body storage.
- One deployment serves one Cloudflare account, with many sending domains.
- Single-origin admin: the Worker serves the UI + admin/self API on one
  host (default `mail.<adopter-zone>`). Cloudflare Access is path-scoped
  only to `/admin/api/*` and `/self/api/*`. Do not protect `/` or
  `/_astro/*`: Access treats a root destination as the whole hostname, which
  breaks `/relay/*`, `/send`, `/bootstrap/admin`, and `/healthz`.
- D1 is source of truth. KV is cache only.
- Relay-to-Worker auth is HMAC. The canonical string commits both the
  body hash and a sorted `signedHeaders` block.
- Admin auth is Cloudflare Access. Worker validates JWT (issuer + aud +
  `type === "app"`) and the Origin on browser POSTs.
- Credential/API-key hashes use HMAC-SHA256 keyed with a secret pepper.
- The worker runtime needs a least-privilege `CF_API_TOKEN` with Account Email
  Sending Edit plus Zone Read for the sending zones. The setup wizard does NOT
  auto-push the operator's broader setup token; the runbook covers the manual
  step.
- The app stores the SMTP relay hostname in D1 `settings.smtp_host`. The setup
  wizard initializes it from `--smtp-host` or `smtp.<first-domain>`; admins can
  later edit it from the Settings screen.
- Keep the public demo separate. Do not add `relay-demo.alexmiller.net` or demo
  mode back to the production Worker; deploy the demo with `demo/wrangler.toml`.

## Working Rules

- Use worktrees for substantive edits: `.worktrees/<feature>`.
- `dev` is the default development branch; `main` is the protected release
  branch. Release-please must target `main`, and release PRs/tags come from
  `main` only.
- Keep release-facing docs small. Prefer updating `README.md` or
  `docs/architecture.md` over adding a new doc.
- Use Conventional Commits.
- Do not commit secrets. Use `wrangler secret put`, local `.env`, or `.example`
  files.
- Anything that mutates Cloudflare, pushes to GitHub, publishes images, or
  deploys requires explicit user approval.
- Preserve unrelated dirty worktree changes.

## Checks

Run the narrow check for your change, and for broad changes run:

```sh
pnpm test
pnpm typecheck
pnpm build

cd relay
go vet ./...
go test ./...
```

Docker release packaging is defined in `relay/docker-bake.hcl` and validated in
CI.
