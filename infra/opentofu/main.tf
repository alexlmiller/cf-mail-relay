// cf-mail-relay reference OpenTofu module.
//
// Declares the Cloudflare resources the relay needs. The Worker script
// itself is deployed via `wrangler deploy` (not as IaC) and secrets are
// always pushed via `wrangler secret put`, never through tfstate.
//
// Two-phase workflow:
//
//   1. tofu init && tofu apply -var "admin_url=https://mail.example.com" -var 'admin_emails=["you@example.com"]'
//   2. pnpm setup --apply \
//        --account-id "$(tofu output -raw account_id)" \
//        --admin-url "$(tofu output -raw admin_url)" \
//        --d1-id "$(tofu output -raw d1_database_id)" \
//        --kv-id "$(tofu output -raw kv_namespace_id)" \
//        --domain example.com \
//        --allow-email you@example.com
//
// The wizard detects the existing D1/KV/Access app and reuses them
// without modification.

terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }
  }
}

provider "cloudflare" {
  // Pass CLOUDFLARE_API_TOKEN via env. The token needs:
  //   Account: D1 Edit, KV Edit, Access: Apps Edit, Workers Scripts Edit
  //   Zone: DNS Edit (only if you let tofu manage the worker route DNS)
}

variable "account_id" {
  description = "Cloudflare account ID."
  type        = string
}

variable "admin_url" {
  description = "Admin host URL, e.g. https://mail.example.com. Must be a Cloudflare-managed zone."
  type        = string
}

variable "admin_emails" {
  description = "Email identities allowed by the Access policy. Add more later in the dashboard or via this module."
  type        = list(string)
  validation {
    condition     = length(var.admin_emails) > 0
    error_message = "Provide at least one admin email."
  }
}

variable "d1_database_name" {
  description = "D1 database name."
  type        = string
  default     = "cf-mail-relay"
}

variable "kv_namespace_title" {
  description = "Workers KV namespace title."
  type        = string
  default     = "cf-mail-relay-hot"
}

variable "access_app_name" {
  description = "Cloudflare Access application name."
  type        = string
  default     = "cf-mail-relay-admin"
}

variable "session_duration" {
  description = "Cloudflare Access session duration."
  type        = string
  default     = "24h"
}

locals {
  admin_host = replace(replace(var.admin_url, "https://", ""), "http://", "")
}

resource "cloudflare_d1_database" "main" {
  account_id = var.account_id
  name       = var.d1_database_name
}

resource "cloudflare_workers_kv_namespace" "hot" {
  account_id = var.account_id
  title      = var.kv_namespace_title
}

resource "cloudflare_access_application" "admin" {
  account_id       = var.account_id
  name             = var.access_app_name
  type             = "self_hosted"
  domain           = local.admin_host
  session_duration = var.session_duration

  destinations {
    type = "public"
    uri  = local.admin_host
  }

  cors_headers {
    allow_credentials = true
    allowed_methods   = ["GET", "POST", "PATCH", "DELETE", "OPTIONS"]
    allowed_headers   = ["content-type"]
    allowed_origins   = [var.admin_url]
    max_age           = 600
  }

  app_launcher_visible = true
}

resource "cloudflare_access_policy" "allow_admins" {
  account_id     = var.account_id
  application_id = cloudflare_access_application.admin.id
  name           = "${var.access_app_name} allow admins"
  precedence     = 1
  decision       = "allow"

  include {
    email = var.admin_emails
  }
}
