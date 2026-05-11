# ADR-001: Three-Component Architecture

**Status**: Accepted.
**Date**: 2026-05-11.
**Source**: Reconciled from a dual-agent swarm investigation (Claude Code + Codex) of `alexlmiller/infra#746`. See `IMPLEMENTATION_PLAN.md`.

## Context

We need to send mail through Cloudflare Email Sending from clients that speak SMTP (e.g., Gmail's "Send mail as") and from applications that speak HTTP. Cloudflare exposes only the HTTP `send_raw` API; an SMTP-speaking bridge is required for Gmail. We want a turnkey, open-source package that drops into any Cloudflare account, supports multiple sending domains in one account, and stays inside Cloudflare's primitives where possible.

## Decision

Three components:

1. **Docker SMTP relay (Go)** — runs on any BYO Docker host. Accepts `587 STARTTLS + AUTH PLAIN/LOGIN`. Forwards raw RFC 5322 MIME to the Worker over HTTPS, HMAC-signed. Pass-through MIME, no parsing.
2. **Cloudflare Worker (TypeScript, Hono)** — single Worker in the adopter's Cloudflare account. Verifies credentials, enforces policy, calls `send_raw`, writes metadata-only audit log. Exposes `/relay/*` (relay's egress), `/send` (HTTP API), `/admin/api/*` (UI).
3. **Cloudflare Pages admin UI (Astro)** — static site, behind Cloudflare Access. Talks to the Worker `/admin/api/*` only.

Storage: D1 (source of truth) + KV (cache). Multi-domain is first-class — one Worker handles many domains in the same Cloudflare account.

## Alternatives considered

- **Single Cloudflare Worker without a relay**, exposing only HTTP. Rejected: Gmail "Send mail as" requires a real SMTP submission server and cannot run `cloudflared access tcp`.
- **Worker via Cloudflare Tunnel for SMTP**. Rejected: tunnels for non-HTTP TCP require `cloudflared access tcp` on the client; Gmail does not run this. Also adds latency.
- **Relay-only architecture (no Worker)**, with the relay calling `send_raw` directly. Rejected: putting CF API tokens, credential hashes, peppers, and the audit DB on a BYO host increases blast radius and complicates rotation. Centralising on the Worker side is materially safer.
- **Per-domain Worker**. Rejected: the Cloudflare API endpoint is account-scoped and routes by `from`. One Worker per account scales fine for the target adopter (small team / family / org).
- **Per-component repos (polyrepo)**. Rejected: the Worker, UI, and shared types must move in lockstep. Versioning, releases, and contract drift detection are much cheaper in a monorepo.
- **Cloudflare Access service token for relay → Worker auth**. Rejected: forces every adopter through Zero Trust setup before the relay can work. HMAC with timestamp + nonce + body hash is sufficient.
- **In-process ACME on the relay**. Rejected: requires a second Cloudflare DNS-edit token on the relay host, increasing blast radius. Mounted cert files + external ACME sidecar is the default.

## Consequences

- Adopters need:
  - A Cloudflare account on the **Workers Paid** plan (Email Sending requirement).
  - DNS managed on Cloudflare for sending domains.
  - A BYO Docker host that allows inbound `587`.
- Worker holds long-lived secrets; rotation is documented (see `docs/security.md`).
- D1 backups via Time Travel (always-on, ~30 day window).
- Multi-domain works without code changes; setup wizard makes the "Add domain" step repeatable.
- Cross-Cloudflare-account multi-domain requires one Worker per account; documented as a non-recommended path.

## Implications for future ADRs

- ADR-002 (planned): credential hashing choice — HMAC-SHA256-with-pepper for SMTP credentials and API keys; argon2id reserved for a future human-password admin fallback.
- ADR-003 (planned): idempotency arbitration on D1, not KV, with derivation rules that exclude session-id.
- ADR-004 (planned): adopter auth — Cloudflare Access default; built-in password+TOTP deferred behind an adapter boundary.
