// Mock dataset for screenshot generation. Typed against the live API contracts
// so a UI/Worker type change forces this file to compile-fail before producing
// stale screenshots.
//
// All timestamps are computed relative to "now" at call time so "2 minutes ago"
// reads honestly on every regeneration.

import type {
  ApiKey,
  AuthFailure,
  DashboardData,
  Domain,
  SendEvent,
  Sender,
  Session,
  SmtpCredential,
  User,
} from "../../ui/src/lib/types";
import type { SelfProfile, SelfSender } from "../../ui/src/lib/api-self";

const NOW = Math.floor(Date.now() / 1000);
const MIN = 60;
const HOUR = 60 * 60;
const DAY = 24 * HOUR;

function t(secondsAgo: number): number {
  return NOW - secondsAgo;
}

// ─────────────────────── Identities ───────────────────────

const USERS: User[] = [
  {
    id: "usr_01HQA7XJYRZP9KQ4DM2N8VBC3T",
    email: "alex@acme.example",
    display_name: "Alex (admin)",
    access_subject: "access:alex@acme.example",
    role: "admin",
    disabled_at: null,
    created_at: t(38 * DAY),
    updated_at: t(2 * DAY),
  },
  {
    id: "usr_01HQA8KQ2J7Z4F1E6XBVT0NPRD",
    email: "app-mailer@acme.example",
    display_name: "Product mailer",
    access_subject: "access:app-mailer@acme.example",
    role: "sender",
    disabled_at: null,
    created_at: t(31 * DAY),
    updated_at: t(11 * HOUR),
  },
  {
    id: "usr_01HQA9PWE6N3GZSV2X4M7YCB05",
    email: "oncall-automation@acme.example",
    display_name: "On-call automation",
    access_subject: "access:oncall-automation@acme.example",
    role: "sender",
    disabled_at: null,
    created_at: t(20 * DAY),
    updated_at: t(4 * HOUR),
  },
  {
    id: "usr_01HQAB42TXG8WPK35MZNVRHL6Q",
    email: "billing-automation@acme.example",
    display_name: "Billing automation",
    access_subject: "access:billing-automation@acme.example",
    role: "sender",
    disabled_at: t(6 * DAY),
    created_at: t(45 * DAY),
    updated_at: t(6 * DAY),
  },
];

const DOMAINS: Domain[] = [
  {
    id: "dom_01HQA6V3JZP5NXKR7T4MWQDB28",
    domain: "mail.acme.example",
    cloudflare_zone_id: "9c3a2f0e88a4421aa9d4cf81c0a8e1d2",
    status: "verified",
    dkim_status: "verified",
    spf_status: "verified",
    dmarc_status: "verified",
    enabled: 1,
    created_at: t(38 * DAY),
    updated_at: t(38 * DAY),
  },
  {
    id: "dom_01HQA7BKMS9D2NZF34W8YQHV6R",
    domain: "status.acme.example",
    cloudflare_zone_id: "9c3a2f0e88a4421aa9d4cf81c0a8e1d2",
    status: "verified",
    dkim_status: "verified",
    spf_status: "verified",
    dmarc_status: "pending",
    enabled: 1,
    created_at: t(20 * DAY),
    updated_at: t(20 * DAY),
  },
  {
    id: "dom_01HQA8NYTC6L4WX1B2KH7VRSE5",
    domain: "mktg.acme.example",
    cloudflare_zone_id: "9c3a2f0e88a4421aa9d4cf81c0a8e1d2",
    status: "pending",
    dkim_status: "pending",
    spf_status: null,
    dmarc_status: null,
    enabled: 0,
    created_at: t(3 * DAY),
    updated_at: t(3 * DAY),
  },
];

const SENDERS: Sender[] = [
  {
    id: "snd_01HQA9KZ4M2WPB7X3RV6FHQTND",
    domain_id: DOMAINS[0]!.id,
    domain: DOMAINS[0]!.domain,
    email: "notifications@mail.acme.example",
    user_id: USERS[1]!.id,
    user_email: USERS[1]!.email,
    enabled: 1,
    created_at: t(31 * DAY),
    updated_at: t(31 * DAY),
  },
  {
    id: "snd_01HQAA6JBQVH8K2WMXN4ZD3T1P",
    domain_id: DOMAINS[0]!.id,
    domain: DOMAINS[0]!.domain,
    email: "receipts@mail.acme.example",
    user_id: USERS[1]!.id,
    user_email: USERS[1]!.email,
    enabled: 1,
    created_at: t(28 * DAY),
    updated_at: t(28 * DAY),
  },
  {
    id: "snd_01HQABCTM7NZPF6L1HJVR4QDX2",
    domain_id: DOMAINS[1]!.id,
    domain: DOMAINS[1]!.domain,
    email: "alerts@status.acme.example",
    user_id: USERS[2]!.id,
    user_email: USERS[2]!.email,
    enabled: 1,
    created_at: t(20 * DAY),
    updated_at: t(20 * DAY),
  },
  {
    id: "snd_01HQACQF3JZ6BLKW5RX8MN2HD7",
    domain_id: DOMAINS[1]!.id,
    domain: DOMAINS[1]!.domain,
    email: "incidents@status.acme.example",
    user_id: USERS[2]!.id,
    user_email: USERS[2]!.email,
    enabled: 1,
    created_at: t(14 * DAY),
    updated_at: t(14 * DAY),
  },
  {
    id: "snd_01HQAD2HNXRC9P4VTBKM6FJW3L",
    domain_id: DOMAINS[0]!.id,
    domain: DOMAINS[0]!.domain,
    email: "invoices@mail.acme.example",
    user_id: USERS[3]!.id,
    user_email: USERS[3]!.email,
    enabled: 0,
    created_at: t(45 * DAY),
    updated_at: t(6 * DAY),
  },
  {
    id: "snd_01HQADBKPM8WFXTNL2JH5VR6Z9",
    domain_id: DOMAINS[0]!.id,
    domain: DOMAINS[0]!.domain,
    email: "support@mail.acme.example",
    user_id: USERS[0]!.id,
    user_email: USERS[0]!.email,
    enabled: 1,
    created_at: t(38 * DAY),
    updated_at: t(38 * DAY),
  },
];

const SMTP_CREDENTIALS: SmtpCredential[] = [
  {
    id: "cred_01HQB1KMT9XJ6WP4N3VFRQ7HZD",
    user_id: USERS[1]!.id,
    user_email: USERS[1]!.email,
    name: "Rails app · production",
    username: "smtp-relay-prod",
    hash_version: 1,
    allowed_sender_ids_json: null,
    created_at: t(31 * DAY),
    last_used_at: t(2 * MIN),
    revoked_at: null,
  },
  {
    id: "cred_01HQB28YFNR4LWXK7JV2HMQDP6",
    user_id: USERS[1]!.id,
    user_email: USERS[1]!.email,
    name: "Postfix relay · staging",
    username: "smtp-staging",
    hash_version: 1,
    allowed_sender_ids_json: JSON.stringify([SENDERS[0]!.id]),
    created_at: t(11 * DAY),
    last_used_at: t(38 * MIN),
    revoked_at: null,
  },
  {
    id: "cred_01HQB3HWLBQ6VPNM4XF8KJZR05",
    user_id: USERS[2]!.id,
    user_email: USERS[2]!.email,
    name: "PagerDuty webhook bridge",
    username: "smtp-pd",
    hash_version: 1,
    allowed_sender_ids_json: null,
    created_at: t(14 * DAY),
    last_used_at: t(17 * MIN),
    revoked_at: null,
  },
  {
    id: "cred_01HQB4VC7DZLXQHJ2BR9NF5KP8",
    user_id: USERS[0]!.id,
    user_email: USERS[0]!.email,
    name: "Old laptop client",
    username: "smtp-alex-laptop",
    hash_version: 1,
    allowed_sender_ids_json: null,
    created_at: t(60 * DAY),
    last_used_at: t(22 * DAY),
    revoked_at: t(8 * DAY),
  },
];

const API_KEYS: ApiKey[] = [
  {
    id: "ak_01HQC1RQFL7M2NWX9V3JKDPBZ4",
    user_id: USERS[1]!.id,
    user_email: USERS[1]!.email,
    name: "Stripe webhook → mail",
    key_prefix: "cfmr_live_8t2j",
    scopes_json: null,
    allowed_sender_ids_json: JSON.stringify([SENDERS[0]!.id, SENDERS[1]!.id]),
    created_at: t(18 * DAY),
    last_used_at: t(45),
    revoked_at: null,
  },
  {
    id: "ak_01HQC2BVHJW4LP3X6FKZ8R5NTM",
    user_id: USERS[2]!.id,
    user_email: USERS[2]!.email,
    name: "Grafana alert dispatcher",
    key_prefix: "cfmr_live_w91k",
    scopes_json: null,
    allowed_sender_ids_json: JSON.stringify([SENDERS[2]!.id]),
    created_at: t(14 * DAY),
    last_used_at: t(6 * MIN),
    revoked_at: null,
  },
  {
    id: "ak_01HQC3MFK9NTV7P1Q4BD2WHLRX",
    user_id: USERS[0]!.id,
    user_email: USERS[0]!.email,
    name: "Local dev",
    key_prefix: "cfmr_test_4qpz",
    scopes_json: null,
    allowed_sender_ids_json: null,
    created_at: t(40 * DAY),
    last_used_at: null,
    revoked_at: null,
  },
];

// ─────────────────────── Events ───────────────────────

function mkSend(
  partial: Partial<SendEvent> & Pick<SendEvent, "id" | "ts" | "status" | "envelope_from">,
): SendEvent {
  return {
    trace_id: "tr_" + partial.id.slice(-12),
    source: "smtp",
    user_id: USERS[1]!.id,
    credential_id: SMTP_CREDENTIALS[0]!.id,
    api_key_id: null,
    domain_id: DOMAINS[0]!.id,
    recipient_count: 1,
    mime_size_bytes: 12_384,
    cf_request_id: null,
    cf_ray_id: null,
    smtp_code: null,
    error_code: null,
    cf_error_code: null,
    ...partial,
  };
}

const SEND_EVENTS: SendEvent[] = [
  mkSend({
    id: "evt_01HQF1KX7NPZ5R4QBM9JVWDH8L",
    ts: t(45),
    status: "accepted",
    envelope_from: "notifications@mail.acme.example",
    recipient_count: 1,
    mime_size_bytes: 8_412,
    cf_request_id: "5e6b8a40-bb71-4c44-9ad1-2c8a1ff7d913",
    cf_ray_id: "8f9c2a3b4d5e6f70",
    smtp_code: "250",
  }),
  mkSend({
    id: "evt_01HQF1MNVDRT3F4LP2BK7WJZ9X",
    ts: t(2 * MIN),
    status: "accepted",
    envelope_from: "alerts@status.acme.example",
    user_id: USERS[2]!.id,
    credential_id: SMTP_CREDENTIALS[2]!.id,
    domain_id: DOMAINS[1]!.id,
    recipient_count: 3,
    mime_size_bytes: 22_140,
    cf_request_id: "1f0a4d62-9c11-44dd-95ee-7a4d5b9e2f01",
    cf_ray_id: "9a1c2b3d4e5f6071",
    smtp_code: "250",
  }),
  mkSend({
    id: "evt_01HQF1PT6QJZNLR3VKW2HF8BD4",
    ts: t(6 * MIN),
    status: "all_bounced",
    envelope_from: "receipts@mail.acme.example",
    credential_id: SMTP_CREDENTIALS[0]!.id,
    recipient_count: 1,
    mime_size_bytes: 11_220,
    cf_request_id: "8c7d6e5f-4a3b-2c1d-0e9f-8a7b6c5d4e3f",
    cf_ray_id: "a1b2c3d4e5f60718",
    smtp_code: "550",
    cf_error_code: "550-5.1.1",
  }),
  mkSend({
    id: "evt_01HQF1RHKM7BVDC4FXP8LW2ZQ9",
    ts: t(17 * MIN),
    status: "policy_rejected",
    envelope_from: "alerts@status.acme.example",
    user_id: USERS[2]!.id,
    credential_id: SMTP_CREDENTIALS[2]!.id,
    domain_id: DOMAINS[1]!.id,
    recipient_count: 1,
    mime_size_bytes: 9_810,
    error_code: "sender_not_allowed",
    smtp_code: "550",
  }),
  mkSend({
    id: "evt_01HQF1SLVDXTM2J3CFNWP6BHQ4",
    ts: t(38 * MIN),
    status: "accepted",
    envelope_from: "notifications@mail.acme.example",
    recipient_count: 2,
    mime_size_bytes: 14_320,
    cf_request_id: "a3e9c811-5d22-4677-91dd-4f5e6a7b8c90",
    cf_ray_id: "b2c3d4e5f6071829",
    smtp_code: "250",
  }),
  mkSend({
    id: "evt_01HQF1T8YBQ6JNPRZ4VKWFLM3D",
    ts: t(52 * MIN),
    status: "rejected_size",
    envelope_from: "notifications@mail.acme.example",
    recipient_count: 1,
    mime_size_bytes: 26_214_400,
    error_code: "mime_too_large",
    smtp_code: "552",
  }),
  mkSend({
    id: "evt_01HQF1VNJW8M3FXRP4HQDLCBK7",
    ts: t(74 * MIN),
    status: "rate_limited",
    envelope_from: "notifications@mail.acme.example",
    recipient_count: 4,
    mime_size_bytes: 7_140,
    error_code: "rate_limited",
    smtp_code: "421",
  }),
  mkSend({
    id: "evt_01HQF1XQRTM9P3LFBKWN4HJZD5",
    ts: t(2 * HOUR + 14 * MIN),
    status: "accepted",
    envelope_from: "alerts@status.acme.example",
    user_id: USERS[2]!.id,
    credential_id: SMTP_CREDENTIALS[2]!.id,
    domain_id: DOMAINS[1]!.id,
    recipient_count: 6,
    mime_size_bytes: 19_842,
    cf_request_id: "c44d2a90-7e8f-4011-92be-3a4b5c6d7e8f",
    cf_ray_id: "c3d4e5f607182930",
    smtp_code: "250",
  }),
  mkSend({
    id: "evt_01HQF1ZRBPLM4XNHTJ6WVDQ8K5",
    ts: t(3 * HOUR + 41 * MIN),
    status: "cf_error",
    envelope_from: "notifications@mail.acme.example",
    recipient_count: 1,
    mime_size_bytes: 10_410,
    error_code: "cf_email_sending_unavailable",
    cf_error_code: "10013",
    cf_request_id: "ddbeef10-1234-4567-8910-abcdef012345",
    cf_ray_id: "d4e5f60718293a4b",
  }),
  mkSend({
    id: "evt_01HQF205NJK7HBPRTLCWMVD2X9",
    ts: t(5 * HOUR + 12 * MIN),
    status: "accepted",
    envelope_from: "receipts@mail.acme.example",
    source: "http",
    api_key_id: API_KEYS[0]!.id,
    credential_id: null,
    recipient_count: 1,
    mime_size_bytes: 13_870,
    cf_request_id: "f10aef99-c123-4dde-b321-0a0b0c0d0e0f",
    cf_ray_id: "e5f60718293a4b5c",
    smtp_code: "250",
  }),
  mkSend({
    id: "evt_01HQF21FMRLD7BTPJK4WHN2ZX6",
    ts: t(8 * HOUR + 27 * MIN),
    status: "rejected_auth",
    envelope_from: "invoices@mail.acme.example",
    user_id: USERS[3]!.id,
    credential_id: null,
    recipient_count: 1,
    mime_size_bytes: 5_120,
    error_code: "credential_revoked",
    smtp_code: "535",
  }),
  mkSend({
    id: "evt_01HQF23JTCXM7HBKL2PNWFDZR9",
    ts: t(14 * HOUR + 3 * MIN),
    status: "accepted",
    envelope_from: "support@mail.acme.example",
    user_id: USERS[0]!.id,
    credential_id: null,
    source: "http",
    api_key_id: API_KEYS[2]!.id,
    recipient_count: 1,
    mime_size_bytes: 6_240,
    cf_request_id: "20ffaa11-bb22-cc33-dd44-eeff00112233",
    cf_ray_id: "f60718293a4b5c6d",
    smtp_code: "250",
  }),
];

const AUTH_FAILURES: AuthFailure[] = [
  {
    id: "af_01HQH3VWPM4JKR7BXNLD2FCQ8Z",
    ts: t(3 * MIN),
    source: "smtp",
    attempted_username: "smtp-relay-prod",
    reason: "bad_password",
  },
  {
    id: "af_01HQH4LXQNTR2HBP6WMK8VFCJ5",
    ts: t(28 * MIN),
    source: "http",
    attempted_username: "cfmr_live_unknown",
    reason: "invalid_api_key_prefix",
  },
  {
    id: "af_01HQH5BMKTLV4XJN9P2RHDC7QF",
    ts: t(2 * HOUR + 14 * MIN),
    source: "bootstrap",
    attempted_username: null,
    reason: "invalid_bootstrap_token",
  },
  {
    id: "af_01HQH62DNJPM7KBR4XLVHCFQ8T",
    ts: t(4 * HOUR + 11 * MIN),
    source: "relay",
    attempted_username: null,
    reason: "signature_mismatch",
  },
  {
    id: "af_01HQH7TLPRJMBHXKDC4WVFNZQ2",
    ts: t(9 * HOUR + 47 * MIN),
    source: "relay",
    attempted_username: null,
    reason: "nonce_replay",
  },
  {
    id: "af_01HQH8FKNQVRX2WMJ6LBPDCZH7",
    ts: t(13 * HOUR + 22 * MIN),
    source: "bootstrap",
    attempted_username: null,
    reason: "bootstrap_token_revoked",
  },
];

// ─────────────────────── Dashboard ───────────────────────

const DASHBOARD: DashboardData = {
  window_seconds: 86_400,
  sends_24h: { total: 1284, accepted: 1247, failed: 37 },
  auth_failures_24h: AUTH_FAILURES.length,
  last_error: null,
  resource_counts: {
    users: USERS.length,
    domains: DOMAINS.length,
    senders: SENDERS.length,
    smtp_credentials: SMTP_CREDENTIALS.filter((c) => c.revoked_at === null).length,
  },
  cf_api_health: {
    ok: true,
    status: 200,
    checked_at: t(11),
    error_code: null,
  },
  system_health: [
    { name: "cloudflare_api", ok: true, status: 200, error_code: null, detail: "Email Sending API responsive", checked_at: t(11) },
    { name: "d1_schema", ok: true, status: 200, error_code: null, detail: "Schema v3 matches REQUIRED_D1_SCHEMA_VERSION", checked_at: t(11) },
    { name: "kv", ok: false, status: 200, error_code: "slow", detail: "Sentinel round-trip 412ms (>250ms threshold)", checked_at: t(11) },
    { name: "access_jwks", ok: true, status: 200, error_code: null, detail: "JWKS cached · 3 keys", checked_at: t(11) },
    { name: "recent_relay_send", ok: true, status: null, error_code: null, detail: "Last send 45s ago", checked_at: t(11) },
    { name: "bootstrap_failures_24h", ok: true, status: null, error_code: null, detail: "2 in window (expected — bootstrap token still active)", checked_at: t(11) },
  ],
};

// Empty-dashboard variant — drives the first-run checklist into view.
const DASHBOARD_EMPTY: DashboardData = {
  window_seconds: 86_400,
  sends_24h: { total: 0, accepted: 0, failed: 0 },
  auth_failures_24h: 0,
  last_error: null,
  resource_counts: { users: 1, domains: 0, senders: 0, smtp_credentials: 0 },
  cf_api_health: { ok: true, status: 200, checked_at: t(11), error_code: null },
  system_health: [
    { name: "cloudflare_api", ok: true, status: 200, error_code: null, detail: "Email Sending API responsive", checked_at: t(11) },
    { name: "d1_schema", ok: true, status: 200, error_code: null, detail: "Schema v3 matches REQUIRED_D1_SCHEMA_VERSION", checked_at: t(11) },
    { name: "kv", ok: true, status: 200, error_code: null, detail: "Sentinel round-trip 38ms", checked_at: t(11) },
    { name: "access_jwks", ok: true, status: 200, error_code: null, detail: "JWKS cached · 3 keys", checked_at: t(11) },
    { name: "recent_relay_send", ok: false, status: null, error_code: "no_sends_24h", detail: "No accepted relay sends in the last 24h", checked_at: t(11) },
    { name: "bootstrap_failures_24h", ok: true, status: null, error_code: null, detail: "0 in window", checked_at: t(11) },
  ],
};

// ─────────────────────── Sessions ───────────────────────

const ADMIN_SESSION: Session = {
  user: {
    id: USERS[0]!.id,
    email: USERS[0]!.email,
    display_name: USERS[0]!.display_name,
    access_subject: USERS[0]!.access_subject,
    role: "admin",
  },
  access: { sub: "access:alex@acme.example", email: USERS[0]!.email },
};

const SENDER_SESSION: Session = {
  user: {
    id: USERS[2]!.id,
    email: USERS[2]!.email,
    display_name: USERS[2]!.display_name,
    access_subject: USERS[2]!.access_subject,
    role: "sender",
  },
  access: { sub: "access:oncall-automation@acme.example", email: USERS[2]!.email },
};

const SELF_PROFILE: SelfProfile = {
  ...USERS[2]!,
  counts: {
    senders: SENDERS.filter((s) => s.user_id === USERS[2]!.id).length,
    smtp_credentials: SMTP_CREDENTIALS.filter((c) => c.user_id === USERS[2]!.id && c.revoked_at === null).length,
    api_keys: API_KEYS.filter((k) => k.user_id === USERS[2]!.id && k.revoked_at === null).length,
  },
};

const SELF_SENDERS: SelfSender[] = SENDERS.filter((s) => s.user_id === USERS[2]!.id).map((s) => ({
  id: s.id,
  domain_id: s.domain_id,
  domain: s.domain,
  email: s.email,
  enabled: s.enabled,
  created_at: s.created_at,
  updated_at: s.updated_at,
}));

// ─────────────────────── Bundles ───────────────────────

/** Wire-shape envelope the production UI expects. */
export function envelope<T>(result: T): { ok: true; result: T } {
  return { ok: true, result };
}

/** Fixture map: "METHOD /path" → JSON envelope (without ok/result wrapper). */
export type FixtureMap = Record<string, unknown>;

const APP_SETTINGS = {
  smtp_host: "smtp.acme.example",
  smtp_port: 587,
  smtp_security: "STARTTLS",
};

/** Admin / populated dashboard. */
export function adminFixtures(): FixtureMap {
  return {
    "GET /admin/api/session": envelope(ADMIN_SESSION),
    "GET /self/api/session": envelope(ADMIN_SESSION),
    "GET /admin/api/dashboard": envelope(DASHBOARD),
    "GET /admin/api/settings": envelope(APP_SETTINGS),
    "GET /self/api/settings": envelope(APP_SETTINGS),
    "GET /admin/api/users": envelope(USERS),
    "GET /admin/api/domains": envelope(DOMAINS),
    "GET /admin/api/senders": envelope(SENDERS),
    "GET /admin/api/smtp-credentials": envelope(SMTP_CREDENTIALS),
    "GET /admin/api/api-keys": envelope(API_KEYS),
    "GET /admin/api/send-events": envelope(SEND_EVENTS),
    "GET /admin/api/auth-failures": envelope(AUTH_FAILURES),
    // Secret-reveal panel fixture for the create-credential shot:
    "POST /admin/api/smtp-credentials": envelope({
      id: "cred_01HQDEMOPREVIEW9X3VBKMFNQ7Z",
      username: "smtp-prod-app",
      secret: "S3cret-Demo-9pX2-vQ8w-N4mR-tK7L-jH3D-bC5F-zM1v",
    }),
    "POST /admin/api/api-keys": envelope({
      id: "ak_01HQDEMOPREVIEW7VBLMCJNXKQF",
      key_prefix: "cfmr_live_8t2j",
      secret: "cfmr_live_8t2j_4qPzNvBsR9KdMx7CtWfHyJ2LgQ3VeAbU6oZmTn8DcEr5Ix",
    }),
  };
}

/** First-run / empty dashboard. */
export function emptyFixtures(): FixtureMap {
  return {
    "GET /admin/api/session": envelope(ADMIN_SESSION),
    "GET /self/api/session": envelope(ADMIN_SESSION),
    "GET /admin/api/dashboard": envelope(DASHBOARD_EMPTY),
    "GET /admin/api/settings": envelope({ smtp_host: null, smtp_port: 587, smtp_security: "STARTTLS" }),
    "GET /self/api/settings": envelope({ smtp_host: null, smtp_port: 587, smtp_security: "STARTTLS" }),
    "GET /admin/api/users": envelope([USERS[0]!]),
    "GET /admin/api/domains": envelope([]),
    "GET /admin/api/senders": envelope([]),
    "GET /admin/api/smtp-credentials": envelope([]),
    "GET /admin/api/api-keys": envelope([]),
    "GET /admin/api/send-events": envelope([]),
    "GET /admin/api/auth-failures": envelope([]),
  };
}

/** Sender self-service. */
export function senderFixtures(): FixtureMap {
  const myCreds = SMTP_CREDENTIALS.filter((c) => c.user_id === USERS[2]!.id);
  const myKeys = API_KEYS.filter((k) => k.user_id === USERS[2]!.id);
  const myEvents = SEND_EVENTS.filter((e) => e.user_id === USERS[2]!.id);
  return {
    "GET /admin/api/session": envelope(SENDER_SESSION),
    "GET /self/api/session": envelope(SENDER_SESSION),
    "GET /self/api/settings": envelope(APP_SETTINGS),
    "GET /self/api/profile": envelope(SELF_PROFILE),
    "GET /self/api/senders": envelope(SELF_SENDERS),
    "GET /self/api/smtp-credentials": envelope(myCreds),
    "GET /self/api/api-keys": envelope(myKeys),
    "GET /self/api/send-events": envelope(myEvents),
  };
}
