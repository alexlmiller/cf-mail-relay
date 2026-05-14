# OpenTofu reference module

Declarative provisioning of the Cloudflare resources cf-mail-relay needs.
Optional — the `pnpm run setup --apply` wizard creates the same resources
imperatively if you don't want IaC.

## What this module creates

| Resource | Purpose |
|---|---|
| `cloudflare_d1_database.main` | The `cf-mail-relay` D1 database (state of truth) |
| `cloudflare_workers_kv_namespace.hot` | `cf-mail-relay-hot` KV cache namespace |
| `cloudflare_access_application.admin` | Cloudflare Access app gating the admin/self API paths |
| `cloudflare_access_policy.allow_admins` | Email-allowlist policy on the Access app |

What this module **deliberately does not** create:

- The Worker script itself. Deploy it via `wrangler deploy`.
- Worker secrets (peppers, HMAC, bootstrap token). Always set via
  `wrangler secret put`. Secrets in tfstate is a footgun.
- Worker custom-domain DNS. The wizard's `wrangler deploy` step + the `routes`
  block in `worker/wrangler.toml` handle this. You can manage records
  separately with `cloudflare_record` if you prefer.

## Two-phase workflow

```sh
# Phase 1 — declarative infra
cd infra/opentofu
tofu init -lockfile=readonly
tofu apply \
  -var "account_id=fa774a1ed55e467890d48394f4409bdd" \
  -var "admin_url=https://mail.example.com" \
  -var 'admin_emails=["you@example.com"]'

# Phase 2 — pnpm run setup detects the existing resources and just does
# secrets + migrations + deploy + bootstrap on top.
cd ../..
CLOUDFLARE_API_TOKEN=... pnpm run setup --apply \
  --account-id "$(cd infra/opentofu && tofu output -raw account_id)" \
  --admin-url "$(cd infra/opentofu && tofu output -raw admin_url)" \
  --d1-id    "$(cd infra/opentofu && tofu output -raw d1_database_id)" \
  --kv-id    "$(cd infra/opentofu && tofu output -raw kv_namespace_id)" \
  --domain example.com \
  --allow-email you@example.com
```

The wizard's Access step (which calls `infra/wrangler/access-app.mjs`) is
idempotent on its own — it looks up the Access app by name and PUTs an
update rather than creating a duplicate. Passing the OpenTofu-managed Access
app's ID isn't required.

## Drift detection

CI runs `tofu fmt -check`, `tofu init -backend=false -lockfile=readonly`, and
`tofu validate` for this directory. The provider lockfile is committed with
darwin/arm64, linux/amd64, and linux/arm64 checksums so local development and
GitHub Actions resolve the same Cloudflare provider package.

After Phase 2, `tofu plan` should show **no drift** — the wizard reuses
the existing Access app rather than re-creating it. If it shows drift,
something diverged (most commonly the destinations list — the wizard
protects only `/admin/api/*` and `/self/api/*`; if your tf module is on an
older revision that also gated `/` or `/_astro/*`, update the tf to match).

## Token scopes

The CF API token the OpenTofu provider uses needs:

- Account · D1 · Edit
- Account · Workers KV Storage · Edit
- Account · Access: Apps · Edit
- Account · Access: Policies · Edit
- (Add Account · Workers Scripts · Edit if you decide to push the
  Worker via terraform; not needed for the recommended split.)

The token the wizard uses (`CLOUDFLARE_API_TOKEN`) needs the same scopes
plus **Account · Email Sending · Edit**, **Account · Account Settings · Read**,
**Account · Access: Organizations · Read**, **Account · Workers Scripts ·
Edit**, **Account · Workers Tail · Read**, **Zone · Zone · Read**, **Zone ·
DNS · Edit**, and **Zone · Zone DNS Settings · Edit**. You can use one token
for both if it has all the scopes; the wizard never writes the token into
tfstate.

## Alternatives

- Pulumi / Terraform CDK — the resource model is identical; port the
  module verbatim.
- The wizard — `pnpm run setup --apply` covers everything imperatively if
  you don't want an IaC tool in the loop.
