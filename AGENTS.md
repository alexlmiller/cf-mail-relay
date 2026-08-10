# Agent guidelines

Read [docs/architecture.md](docs/architecture.md) before substantive work.

## Repository map

| Path | Purpose |
|---|---|
| `relay/` | Go SMTP relay and container build |
| `worker/` | Cloudflare policy/delivery API and static UI host |
| `ui/` | Astro admin and sender UI source |
| `demo/` | Isolated public demo with a mock API |
| `shared/` | Cross-runtime HMAC vectors |
| `infra/` | Setup, operations, OpenTofu, and relay deployment |

## Invariants

- Send-only raw MIME. Do not add inbound mail, composition, templates,
  scheduling, mailing lists, multi-tenant SaaS, or body storage without an
  explicit scope decision.
- One deployment serves one Cloudflare account and may serve many domains.
- The Worker serves the UI and API from one origin. Cloudflare Access protects
  only `/admin/api/*` and `/self/api/*`; do not gate the static shell,
  `/relay/*`, `/send`, `/bootstrap/admin`, or `/healthz`.
- D1 is authoritative. KV is a cache.
- Relay requests use HMAC; `/send` uses API keys; admin/self APIs use validated
  Access JWTs and browser Origin checks.
- Credential hashes and identifying audit hashes use separate secret peppers.
- The Worker runtime Cloudflare token is limited to Email Sending Edit and Zone
  Read. Do not push the broader setup token unless the user explicitly accepts
  immediate replacement.
- Keep demo bindings, routes, and mock behavior out of the production Worker.

## Workflow

- Use `.worktrees/<feature>` for substantive changes.
- `dev` is the development branch; `main` is the protected release branch.
  Release-please targets `main`.
- Prefer updating existing docs over adding new ones.
- Use Conventional Commits.
- Never commit secrets. Use Worker secrets and gitignored local files.
- Cloudflare mutation, GitHub push, image publication, and deployment require
  explicit user approval.
- Preserve unrelated worktree changes.

## Checks

Run focused checks for narrow changes. For broad changes:

```sh
pnpm test
pnpm typecheck
pnpm build

cd relay
go vet ./...
go test ./...
```

CI also validates OpenTofu, Docker packaging, migrations, and Wrangler dry-runs.
