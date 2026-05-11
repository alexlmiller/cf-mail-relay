# Contributing

Thanks for your interest. The project is in early pre-MVP. Please read [`AGENTS.md`](./AGENTS.md) and [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) before opening a PR.

## Scope discipline

The plan locks several design decisions and an out-of-scope list. Before opening a PR that adds new features or deviates from the plan, **open an issue or an ADR proposal first**. PRs that quietly expand scope will be asked to rebase against an ADR.

The non-negotiable out-of-scope list for v0.1:

- Inbound mail handling.
- Mailing lists, templates, scheduled sends.
- Multi-tenant SaaS abstractions.
- Message-body storage.
- Cloudflare products beyond Workers, Pages, D1, KV, Access, Email Sending.

## Commit style

[Conventional Commits](https://www.conventionalcommits.org/). `release-please` derives the changelog and version from your commits, so the prefix matters:

- `feat:` — new user-facing feature
- `fix:` — bug fix
- `docs:` — documentation only
- `chore:` — tooling, deps, cleanup
- `refactor:` — no behaviour change
- `test:` — tests only
- `ci:` — CI/build only

Example:

```
feat(relay): enforce sender allowlist before DATA

Reject MAIL FROM with 553 5.7.1 when the envelope sender is not in
the credential's allowed_sender_ids set.
```

## Branching and worktrees

Use worktrees under `.worktrees/` for substantive work:

```sh
git worktree add .worktrees/feat-relay-hmac feat/relay-hmac
```

Direct edits to `main` are only acceptable for typos and one-line fixes.

## Tests

Each milestone's PR must include the tests called out in the plan's "Test Plan" for that milestone. CI must be green before review.

## Security disclosures

Do **not** open a public issue for vulnerabilities. See [`SECURITY.md`](./SECURITY.md).

## Code of conduct

This project follows the [Contributor Covenant](https://www.contributor-covenant.org/version/2/1/code_of_conduct/). See [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md).
