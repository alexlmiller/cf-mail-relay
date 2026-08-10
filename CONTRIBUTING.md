# Contributing

Read [AGENTS.md](AGENTS.md) and [docs/architecture.md](docs/architecture.md).
Open an issue before changing scope or an auth/security boundary.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/). Release-please
derives versions and changelogs from them. Common prefixes are `feat:`, `fix:`,
`docs:`, `chore:`, `refactor:`, `test:`, and `ci:`.

## Branches

`dev` is the development branch. `main` is the protected release branch.
Release PRs and tags come from `main` only. Keep substantive work in
`.worktrees/<feature>` and preserve unrelated changes.

When syncing `dev` to `main`, prefer a rebase merge for a single-commit sync PR.
If it is squash merged, realign `dev` to `main` before more work.

## Release recovery

The release workflow publishes immutable `linux/amd64` and `linux/arm64` relay
images, then promotes only the latest published release to `latest`. If image
publication fails after a stable GitHub release exists, rerun recovery from
`main`:

```sh
gh workflow run release.yml --ref main -f tag=vX.Y.Z
```

Recovery rejects unpublished, mutable, non-semver, or non-`main` tags. See
[GitHub's manual workflow guide](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow).

## Checks

```sh
pnpm test
pnpm typecheck
pnpm build

cd relay
go vet ./...
go test ./...
```

Run focused checks for narrow changes. Report vulnerabilities privately as
described in [SECURITY.md](SECURITY.md).
