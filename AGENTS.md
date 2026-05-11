# Agent Guidelines — Cloudflare Mail Relay

Read this first. Then read [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md). Then start.

## The plan is the spec

[`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) is the canonical, locked implementation specification. It is the output of a dual-agent (Claude Code + Codex) investigation with cross-critique and reconciliation. **Treat its decisions as load-bearing.** If you believe a decision is wrong, open an ADR proposing the change before deviating — do not silently re-litigate.

The plan resolves these design questions definitively:
- Relay language (Go), Worker framework (Hono), UI framework (Astro on Pages).
- Relay → Worker auth (HMAC only — see `docs/security.md` for the contract).
- Credential hashing (HMAC-SHA256 keyed-with-pepper, not argon2id).
- `send_raw` JSON shape and 8-bit handling.
- D1 schema (in `worker/migrations/0001_init.sql`).
- KV usage (cache only — D1 is source of truth).
- Idempotency storage (D1-backed, key derivation explicitly excludes session-id).
- Multi-domain: one Worker handles many domains in one CF account; no per-domain Worker required.

## Build order

**Strict milestone gates. Do not start MS<N+1> until MS<N> passes its exit criterion.**

| Milestone | Goal | Status |
|---|---|---|
| MS0 | `send_raw` spike — prove Gmail-originated MIME delivers with DKIM+DMARC pass | Complete |
| MS1 | End-to-end relay (Gmail → relay → Worker → `send_raw`) | Complete |
| MS2 | D1-backed state, audit log, idempotency | Complete |
| MS3 | Admin UI on Pages with CF Access | Complete |
| MS4 | HTTP `/send` API (raw MIME only — structured JSON is roadmap) | Complete |
| MS5 | Hardening (rate limits, doctor scripts, threat model, partial-recipient policy) | Complete |
| MS6 | Distribution polish (setup wizard, releases, full docs) | Not started |

Each milestone has explicit deliverables and exit criteria in the plan. Don't skip ahead.

## Scope discipline

**Locked-out scope for v0.1**:
- Inbound mail handling.
- Mailing lists, templates, scheduled sends.
- Multi-tenant SaaS abstractions.
- Message-body storage.
- Any Cloudflare product beyond Workers + Pages + D1 + KV + Access + Email Sending.
- Built-in password+TOTP auth (deferred; CF Access is the default).
- Structured-JSON `/send` (raw MIME only in MVP — JSON assembly is roadmap).

If the user asks you to add something here, push back with the scope-gate language and propose an ADR if they still want it.

## Operating model

- **Worktrees are the default** for substantive edits. Use `.worktrees/<feature>` within the repo.
- **Conventional Commits** (`feat:`, `fix:`, `docs:`, `chore:`). `release-please` will derive semver from these across all three components together.
- **Apache-2.0** license. Don't introduce code under conflicting licenses without an ADR.
- **No secrets in the repo.** Use `wrangler secret put`, `.env`, or examples ending in `.example`.
- **Read-only checks are unattended-safe.** `gh`, `git status`, `git log`, `wrangler whoami`, `wrangler tail` are fine without approval. Anything that deploys, publishes, pushes, mutates Cloudflare account state, or runs `wrangler deploy` against a real account needs explicit user approval.
- **MS0 may need user help**: the adopter (currently the repo owner) must configure a domain for Email Sending in their CF account. Coordinate before doing the spike.

## Tooling conventions

- Built-in tools (Read/Edit/Write/Glob/Grep) over Bash equivalents (cat/sed/awk/find/rg).
- Multi-arch Docker via `docker buildx` / `docker bake` (config in `relay/docker-bake.hcl`).
- Go: `gofmt`, `go vet`, `golangci-lint`. Module path `github.com/<owner>/cf-mail-relay/relay`.
- TypeScript: strict mode, `tsc --noEmit` in CI, Vitest for tests, zod for schemas in `shared/`.
- Astro: stay framework-light. Reach for islands only where interactivity is unavoidable.
- pnpm workspaces; do not introduce npm or yarn.

## What to do first if you're a fresh agent picking this up

1. Read this file.
2. Read [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) end-to-end. Yes, all of it.
3. Skim [`docs/architecture.md`](./docs/architecture.md), [`docs/security.md`](./docs/security.md), [`docs/cloudflare-email-sending.md`](./docs/cloudflare-email-sending.md).
4. Confirm with the user that MS0 is ready to start (they need to have Email Sending verified on at least one domain in their Cloudflare account).
5. Build the MS0 spike Worker. Capture real Gmail MIME. Send to three recipients. Document MIME quirks.
6. Only after MS0 passes: scaffold MS1.

## Where state lives across sessions

- `IMPLEMENTATION_PLAN.md` — the locked spec.
- `ADR/` — architecture decision records. One file per decision. New decisions or scope changes start here.
- `docs/` — adopter-facing documentation. Stays in sync with the code as milestones land.
- `.ai-runs/` (if you create it) — agent working artifacts; do not commit (gitignored).

Good luck.
