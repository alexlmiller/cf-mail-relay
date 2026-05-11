# Agent Guidelines — Cloudflare Mail Relay

Read this first, then read [docs/architecture.md](./docs/architecture.md).

## Project Shape

This is a release-ready SMTP-to-Cloudflare-Email-Sending bridge:

- `relay/`: Go SMTP relay in Docker.
- `worker/`: Cloudflare Worker policy and delivery API.
- `ui/`: Astro admin UI on Cloudflare Pages.
- `shared/`: shared TypeScript contracts.
- `infra/`: setup, Cloudflare Access helpers, doctor scripts, and deployment
  examples.

## Design Constraints

- Send-only. No inbound mail handling.
- Raw MIME only. Do not add structured JSON composition without an explicit
  roadmap decision.
- No message body storage.
- One deployment serves one Cloudflare account, with many sending domains.
- D1 is source of truth. KV is cache only.
- Relay-to-Worker auth is HMAC.
- Admin auth is Cloudflare Access.
- Credential/API-key hashes use HMAC-SHA256 keyed with a secret pepper.

## Working Rules

- Use worktrees for substantive edits: `.worktrees/<feature>`.
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
