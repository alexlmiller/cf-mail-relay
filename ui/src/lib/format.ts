// Formatters for timestamps, byte sizes, durations.
// Timestamps from the API are Unix seconds (integers).

const dtFormatters = new Map<string, Intl.DateTimeFormat>();
function dtf(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = JSON.stringify(options);
  const existing = dtFormatters.get(key);
  if (existing) return existing;
  const formatter = new Intl.DateTimeFormat(undefined, options);
  dtFormatters.set(key, formatter);
  return formatter;
}

export function tsToDate(ts: number | null | undefined): Date | null {
  if (ts === null || ts === undefined || Number.isNaN(ts)) return null;
  return new Date(Number(ts) * 1000);
}

export function formatAbsolute(ts: number | null | undefined): string {
  const date = tsToDate(ts);
  if (!date) return "—";
  return dtf({ year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(date);
}

export function formatShort(ts: number | null | undefined): string {
  const date = tsToDate(ts);
  if (!date) return "—";
  const today = new Date();
  const isSameDay = date.toDateString() === today.toDateString();
  if (isSameDay) {
    return dtf({ hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(date);
  }
  return dtf({ month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

export function formatDayOnly(ts: number | null | undefined): string {
  const date = tsToDate(ts);
  if (!date) return "—";
  return dtf({ year: "numeric", month: "short", day: "2-digit" }).format(date);
}

export function formatRelative(ts: number | null | undefined): string {
  const date = tsToDate(ts);
  if (!date) return "—";
  const diff = Math.round((date.getTime() - Date.now()) / 1000);
  const abs = Math.abs(diff);
  if (abs < 5) return "just now";
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const steps: Array<[number, Intl.RelativeTimeFormatUnit]> = [
    [60, "second"],
    [60, "minute"],
    [24, "hour"],
    [7, "day"],
    [4.34524, "week"],
    [12, "month"],
    [Infinity, "year"],
  ];
  let unit: Intl.RelativeTimeFormatUnit = "second";
  let value = diff;
  for (const [scale, name] of steps) {
    if (Math.abs(value) < scale) {
      unit = name;
      break;
    }
    value = Math.round(value / scale);
  }
  return rtf.format(value, unit);
}

const KB = 1024;
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return "—";
  const n = Number(bytes);
  if (n < KB) return `${n} B`;
  if (n < KB * KB) return `${(n / KB).toFixed(n < 10 * KB ? 1 : 0)} KB`;
  if (n < KB * KB * KB) return `${(n / KB / KB).toFixed(n < 10 * KB * KB ? 1 : 0)} MB`;
  return `${(n / KB / KB / KB).toFixed(1)} GB`;
}

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return new Intl.NumberFormat().format(Number(value));
}

export function truncateMiddle(value: string, head = 8, tail = 4): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export function initialsFor(email: string): string {
  const name = email.split("@")[0] ?? email;
  const parts = name.split(/[._-]/).filter(Boolean);
  if (parts.length === 0) return email.slice(0, 2).toUpperCase();
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase();
}

const errorMessages: Record<string, string> = {
  sender_not_allowed: "Sender address is not on the allowlist for this credential or API key.",
  cloudflare_send_raw_rejected: "Cloudflare Email Sending rejected the request.",
  all_recipients_bounced: "Every recipient permanently bounced.",
  mime_not_utf8_json_safe: "MIME message is not UTF-8 safe.",
  message_too_large: "Message exceeded the 6 MiB Worker cap.",
  too_many_recipients: "Too many recipients (cap is 50).",
  missing_envelope_from: "Envelope From was missing on the relay request.",
  missing_recipients: "Recipients were missing on the relay request.",
  credential_not_found: "Credential not found.",
  credential_disabled: "Credential is revoked or its owner is disabled.",
  idempotency_pending: "Duplicate request still in-flight upstream.",
  invalid_credentials: "SMTP authentication failed.",
  invalid_api_key: "API key invalid or revoked.",
  invalid_body_hash: "HMAC body hash mismatch — relay/worker out of sync.",
  invalid_signature: "HMAC signature mismatch — secret may be wrong or rotated.",
  timestamp_out_of_window: "Relay clock skew exceeded ±60 seconds.",
  replay_nonce: "Replay-protection nonce already seen.",
  unsupported_relay_version: "Worker rejected this relay version.",
  bad_creds: "Wrong username or password.",
  disabled: "Credential or user is disabled.",
  not_found: "No matching credential.",
  tls_required: "AUTH attempted before STARTTLS.",
  throttled: "Throttled by the relay's auth-failure window.",

  // Security audit additions
  invalid_envelope_from: "SMTP envelope From was malformed.",
  invalid_recipients: "Recipient list was malformed.",
  invalid_from: "From address was malformed.",
  missing_from: "From address missing on the request body.",
  from_header_mismatch: "MIME From: header doesn't match the authorized sender.",
  sender_header_not_allowed: "MIME Sender: header isn't on the allowed-senders list.",
  duplicate_from_header: "MIME message had multiple From: headers.",
  duplicate_sender_header: "MIME message had multiple Sender: headers.",
  duplicate_message_id_header: "MIME message had multiple Message-ID: headers.",
  multiple_from_addresses: "MIME From: header contained multiple addresses; exactly one is required.",
  idempotency_key_conflict: "Idempotency key reused with a different request body.",
  missing_signed_headers: "Relay HMAC missing the X-Relay-Signed-Headers list.",
  missing_required_signed_header: "Relay HMAC didn't sign a required header.",
  invalid_access_jwt_type: "Cloudflare Access JWT was not an app token.",
  sender_domain_mismatch: "Sender email's domain doesn't match the granted zone.",
  domain_not_found: "Granted domain not found or disabled.",
  invalid_role: "User role must be 'admin' or 'sender'.",
  user_not_found: "User not found.",
  user_disabled: "User is disabled — re-enable from the user detail page.",
  user_not_provisioned: "Your Cloudflare Access identity isn't provisioned as a user in this relay yet.",
  no_fields_to_update: "PATCH body had no recognised fields.",
  invalid_enabled: "`enabled` must be a JSON boolean (true or false), not a string.",
  invalid_status: "Status must be one of: pending, verified, sandbox, disabled.",
  rate_limited: "Send quota exceeded for this scope.",

  // Bootstrap-specific
  invalid_bootstrap_token: "Bootstrap token didn't match.",
  bootstrap_already_completed: "Bootstrap already completed — additional admins are added via the UI.",
  bootstrap_not_configured: "BOOTSTRAP_SETUP_TOKEN secret is not set on the worker.",
  invalid_email: "Email is malformed.",
};

export function explainError(code: string | null | undefined): string {
  if (!code) return "—";
  return errorMessages[code] ?? code;
}
