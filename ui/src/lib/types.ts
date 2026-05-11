// Shared TS types matching the Worker admin API responses.
// Source of truth lives in worker/src/admin.ts and worker/src/state.ts.

export type Role = "admin" | "sender";

export interface Session {
  user: {
    id: string;
    email: string;
    display_name: string | null;
    access_subject: string | null;
    role: Role;
  };
  access: {
    sub: string;
    email: string | null;
  };
}

export interface User {
  id: string;
  email: string;
  display_name: string | null;
  access_subject: string | null;
  role: Role;
  disabled_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface Domain {
  id: string;
  domain: string;
  cloudflare_zone_id: string | null;
  status: "pending" | "verified" | "sandbox" | "disabled" | string;
  dkim_status: string | null;
  spf_status: string | null;
  dmarc_status: string | null;
  enabled: number;
  created_at: number;
  updated_at: number;
}

export interface Sender {
  id: string;
  domain_id: string;
  domain: string;
  email: string;
  user_id: string | null;
  user_email: string | null;
  enabled: number;
  created_at: number;
  updated_at: number;
}

export interface SmtpCredential {
  id: string;
  user_id: string;
  user_email: string;
  name: string;
  username: string;
  hash_version: number;
  allowed_sender_ids_json: string | null;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

export interface ApiKey {
  id: string;
  user_id: string;
  user_email: string;
  name: string;
  key_prefix: string;
  scopes_json: string | null;
  allowed_sender_ids_json: string | null;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

export type SendEventStatus =
  | "accepted"
  | "all_bounced"
  | "cf_error"
  | "policy_rejected"
  | "rejected_8bit"
  | "rejected_size"
  | "rejected_auth"
  | "rejected_allowlist"
  | "rejected_rcpt_cap"
  | "rate_limited"
  | string;

export interface SendEvent {
  id: string;
  ts: number;
  trace_id: string;
  source: "smtp" | "http";
  user_id: string | null;
  credential_id: string | null;
  api_key_id: string | null;
  domain_id: string | null;
  envelope_from: string;
  recipient_count: number;
  mime_size_bytes: number;
  cf_request_id: string | null;
  cf_ray_id: string | null;
  status: SendEventStatus;
  smtp_code: string | null;
  error_code: string | null;
  cf_error_code: string | null;
}

export interface AuthFailure {
  id: string;
  ts: number;
  source: string;
  attempted_username: string | null;
  reason: string | null;
}

export interface CfApiHealth {
  ok: boolean;
  status: number | null;
  checked_at: number;
  error_code: string | null;
}

export interface DashboardData {
  window_seconds: number;
  sends_24h: { total: number; accepted: number | null; failed: number | null };
  auth_failures_24h: number;
  last_error: unknown;
  resource_counts: {
    users: number;
    domains: number;
    senders: number;
    smtp_credentials: number;
  };
  cf_api_health: CfApiHealth;
}

export interface CreateSecretResult {
  id: string;
  username?: string;
  key_prefix?: string;
  secret: string;
}
