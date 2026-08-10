# OpenTofu module

Optional declarative provisioning for D1, KV, and Cloudflare Access. Use the
setup wizard alone if you do not need IaC.

## Managed resources

- `cloudflare_d1_database.main`
- `cloudflare_workers_kv_namespace.hot`
- `cloudflare_access_application.admin`
- `cloudflare_access_policy.allow_admins`

The module does not deploy the Worker, write secrets, or manage its custom
domain. Wrangler owns those steps so secrets stay out of tfstate.

## Provision

```sh
cd infra/opentofu
tofu init -lockfile=readonly
tofu apply \
  -var "account_id=<cloudflare-account-id>" \
  -var "admin_url=https://mail.example.com" \
  -var 'admin_emails=["you@example.com"]'

cd ../..
pnpm run setup --apply \
  --account-id "$(tofu -chdir=infra/opentofu output -raw account_id)" \
  --admin-url "$(tofu -chdir=infra/opentofu output -raw admin_url)" \
  --d1-id "$(tofu -chdir=infra/opentofu output -raw d1_database_id)" \
  --d1-database-name "$(tofu -chdir=infra/opentofu output -raw d1_database_name)" \
  --kv-id "$(tofu -chdir=infra/opentofu output -raw kv_namespace_id)" \
  --access-app-name "$(tofu -chdir=infra/opentofu output -raw access_application_name)" \
  --domain example.com \
  --allow-email you@example.com
```

On a new install without the runtime `CF_API_TOKEN`, setup intentionally stops
before its final deploy. Set the least-privilege runtime token and rerun the
same command as described in [the main setup guide](../../README.md#apply).

Setup finds the named Access app and updates its app and policy. Keep the same
`24h` session duration and email allowlist if you want both tools to converge.
Otherwise, expect `tofu plan` to show the deliberate difference after setup.

## Tokens

The OpenTofu token needs Account D1 Edit, Workers KV Storage Edit, Access Apps
Edit, and Access Policies Edit. Pass it as `CLOUDFLARE_API_TOKEN`.

The setup token needs additional permissions listed in
[README.md](../../README.md#install). One token can perform both jobs, but the
Worker runtime token should remain separate and least-privilege.

## Validate

```sh
tofu -chdir=infra/opentofu fmt -check -recursive
tofu -chdir=infra/opentofu init -backend=false -lockfile=readonly
tofu -chdir=infra/opentofu validate
```

The committed lockfile includes checksums for common macOS, Linux, and Windows
platforms. The module remains on Cloudflare provider 4.x until its deprecated
Access resources are migrated. Follow Cloudflare's
[provider v5 migration guide](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/guides/version-5-migration)
rather than mechanically translating resource names.
