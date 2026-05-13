# Contributing

Thanks for your interest. Read [AGENTS.md](./AGENTS.md) and
[docs/architecture.md](./docs/architecture.md) before opening a substantive PR.

## Scope

Keep the project focused:

- Send-only SMTP and raw-MIME HTTP submission.
- No inbound mail handling.
- No templates, mailing lists, scheduling, or message body storage.
- No multi-tenant SaaS layer.
- Cloudflare Workers, D1, KV, Access, and Email Sending only. The admin UI
  ships inside the Worker via Workers Static Assets — no separate Pages
  project.

Open an issue before adding a new product surface or changing an auth/security
boundary.

## Commit Style

Use [Conventional Commits](https://www.conventionalcommits.org/). `release-please`
derives versions and changelogs from commit prefixes.

- `feat:` user-facing feature
- `fix:` bug fix
- `docs:` documentation only
- `chore:` cleanup or tooling
- `refactor:` behavior-preserving code change
- `test:` tests only
- `ci:` CI/build only

## Branches and Releases

`dev` is the default development branch. `main` is the protected release branch.
Release PRs and tags are created from `main` only; the release workflow sets
`release-please` `target-branch: main` explicitly.

When syncing `dev` into `main` for a release, prefer rebase merge for a
single-commit sync PR so the branches stay aligned. If a sync PR is squash
merged, realign `dev` to `main` before continuing development.

## Worktrees

Use worktrees under `.worktrees/` for substantive work:

```sh
git worktree add .worktrees/feat-name -b feat/name
```

Preserve unrelated dirty files.

## Checks

Run the narrow checks for your change. For broad changes:

```sh
pnpm test
pnpm typecheck
pnpm build

cd relay
go vet ./...
go test ./...
```

## Security

Do not open public issues for vulnerabilities. See [SECURITY.md](./SECURITY.md).
