output "account_id" {
  description = "Echoed for convenience so the wizard call can use $(tofu output)."
  value       = var.account_id
}

output "admin_url" {
  description = "Echoed so the wizard call mirrors the tf input."
  value       = var.admin_url
}

output "d1_database_id" {
  description = "Pass to `pnpm run setup --apply --d1-id`."
  value       = cloudflare_d1_database.main.id
}

output "kv_namespace_id" {
  description = "Pass to `pnpm run setup --apply --kv-id`."
  value       = cloudflare_workers_kv_namespace.hot.id
}

output "access_application_id" {
  description = "Cloudflare Access app id. The wizard's `pnpm access:setup` is idempotent on name, so passing this isn't strictly required, but it's exported for visibility."
  value       = cloudflare_access_application.admin.id
}

output "access_application_aud" {
  description = "Used by the Worker as ACCESS_AUDIENCE. Already in worker/wrangler.toml after `pnpm run setup --apply`."
  value       = cloudflare_access_application.admin.aud
  sensitive   = false
}
