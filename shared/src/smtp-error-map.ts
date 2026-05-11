// Canonical mapping from internal error categories to SMTP enhanced status codes.
// Used by worker/ to map CF Email Sending responses; mirrored by relay/ for
// fallback paths when the Worker is unreachable.

export type ErrorCategory =
  | "rejected_auth"
  | "rejected_allowlist"
  | "rejected_size"
  | "rejected_rcpt_cap"
  | "rejected_8bit"
  | "rate_limited"
  | "cf_4xx"
  | "cf_5xx"
  | "cf_token_invalid"
  | "all_bounced"
  | "accepted";

export const smtpCodeFor: Record<ErrorCategory, string> = {
  accepted:           "250 2.0.0 Ok",
  rejected_auth:      "535 5.7.8 Authentication failed",
  rejected_allowlist: "553 5.7.1 Sender address not allowed",
  rejected_size:      "552 5.3.4 Message size exceeds limit",
  rejected_rcpt_cap:  "452 4.5.3 Too many recipients",
  rejected_8bit:      "554 5.6.0 8-bit content not supported; use base64 or quoted-printable",
  rate_limited:       "451 4.7.1 Rate limit exceeded; try again later",
  cf_4xx:             "451 4.7.1 Upstream rejected; try again later",
  cf_5xx:             "554 5.3.0 Upstream error",
  cf_token_invalid:   "451 4.7.0 Server configuration error",
  all_bounced:        "550 5.1.1 No valid recipients accepted",
};
