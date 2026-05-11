// Shared types. MS2 fleshes these out to match D1 row shapes.
// See IMPLEMENTATION_PLAN.md § D1 Schema.

export type UserRole = "admin" | "sender";
export type DomainStatus = "pending" | "verified" | "sandbox" | "disabled";
export type SendSource = "smtp" | "http";
export type SendStatus =
  | "accepted"
  | "rejected_auth"
  | "rejected_allowlist"
  | "rejected_size"
  | "rejected_rcpt_cap"
  | "rejected_8bit"
  | "cf_error"
  | "rate_limited"
  | "all_bounced";
