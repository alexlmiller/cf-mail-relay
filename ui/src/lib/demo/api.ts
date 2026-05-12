import type { SelfProfile, SelfSender } from "../api-self";
import type { ApiKey, AuthFailure, DashboardData, Domain, SendEvent, Sender, Session, SmtpCredential, User } from "../types";

const STORAGE_KEY = "cf-mail-relay-demo-state-v2";
const NOW = Math.floor(Date.now() / 1000);
const MIN = 60;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

interface DemoState {
  users: User[];
  domains: Domain[];
  senders: Sender[];
  credentials: SmtpCredential[];
  apiKeys: ApiKey[];
  events: SendEvent[];
  authFailures: AuthFailure[];
}

interface JsonEnvelope<T> {
  ok: true;
  result: T;
}

export function installDemoApi(): void {
  if ((window as typeof window & { __CF_MAIL_RELAY_DEMO__?: boolean }).__CF_MAIL_RELAY_DEMO__) return;
  (window as typeof window & { __CF_MAIL_RELAY_DEMO__?: boolean }).__CF_MAIL_RELAY_DEMO__ = true;
  document.documentElement.dataset.demo = "true";
  installDemoBadge();

  let state = loadState();
  const originalFetch = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : null;
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url, window.location.origin);
    if (!url.pathname.startsWith("/admin/api/") && !url.pathname.startsWith("/self/api/")) {
      return originalFetch(input, init);
    }
    try {
      const body = await readJsonBody(request, init);
      const result = handleDemoRequest(state, method, url.pathname, body);
      state = result.state;
      saveState(state);
      return json(result.payload);
    } catch (error) {
      const code = error instanceof Error ? error.message : "demo_request_failed";
      return json({ ok: false, error: code }, code.endsWith("_not_found") ? 404 : 400);
    }
  };
}

function handleDemoRequest(state: DemoState, method: string, path: string, body: Record<string, unknown>): { state: DemoState; payload: unknown } {
  if (method === "GET" && (path === "/admin/api/session" || path === "/self/api/session")) return ok(state, adminSession(state));
  if (method === "GET" && path === "/admin/api/dashboard") return ok(state, dashboard(state));
  if (method === "GET" && path === "/admin/api/users") return ok(state, state.users);
  if (method === "GET" && path === "/admin/api/domains") return ok(state, state.domains);
  if (method === "GET" && path === "/admin/api/senders") return ok(state, state.senders);
  if (method === "GET" && path === "/admin/api/smtp-credentials") return ok(state, state.credentials);
  if (method === "GET" && path === "/admin/api/api-keys") return ok(state, state.apiKeys);
  if (method === "GET" && path === "/admin/api/send-events") return ok(state, state.events);
  if (method === "GET" && path === "/admin/api/auth-failures") return ok(state, state.authFailures);
  if (method === "GET" && path === "/self/api/profile") return ok(state, selfProfile(state));
  if (method === "GET" && path === "/self/api/senders") return ok(state, selfSenders(state));
  if (method === "GET" && path === "/self/api/smtp-credentials") return ok(state, state.credentials.filter((credential) => credential.user_id === adminUser(state).id));
  if (method === "GET" && path === "/self/api/api-keys") return ok(state, state.apiKeys.filter((key) => key.user_id === adminUser(state).id));
  if (method === "GET" && path === "/self/api/send-events") return ok(state, state.events.filter((event) => event.user_id === adminUser(state).id));
  if (method === "POST" && path === "/admin/api/domains") return createDomain(state, body);
  if (method === "POST" && path.match(/^\/admin\/api\/domains\/[^/]+\/refresh$/u)) return refreshDomain(state, idFrom(path, 4));
  if (method === "PATCH" && path.match(/^\/admin\/api\/domains\/[^/]+$/u)) return patchDomain(state, idFrom(path, 4), body);
  if (method === "POST" && path === "/admin/api/users") return createUser(state, body);
  if (method === "PATCH" && path.match(/^\/admin\/api\/users\/[^/]+$/u)) return patchUser(state, idFrom(path, 4), body);
  if (method === "POST" && path === "/admin/api/senders") return createSender(state, body);
  if (method === "PATCH" && path.match(/^\/admin\/api\/senders\/[^/]+$/u)) return patchSender(state, idFrom(path, 4), body);
  if (method === "DELETE" && path.match(/^\/admin\/api\/senders\/[^/]+$/u)) return deleteSender(state, idFrom(path, 4));
  if (method === "POST" && path === "/admin/api/smtp-credentials") return createCredential(state, body);
  if (method === "POST" && path.match(/^\/admin\/api\/smtp-credentials\/[^/]+\/revoke$/u)) return revokeCredential(state, idFrom(path, 4));
  if (method === "POST" && path.match(/^\/admin\/api\/smtp-credentials\/[^/]+\/roll$/u)) return rollCredential(state, idFrom(path, 4));
  if (method === "PATCH" && path.match(/^\/admin\/api\/smtp-credentials\/[^/]+$/u)) return patchCredential(state, idFrom(path, 4), body);
  if (method === "POST" && path === "/self/api/smtp-credentials") return createCredential(state, { ...body, user_id: adminUser(state).id });
  if (method === "POST" && path.match(/^\/self\/api\/smtp-credentials\/[^/]+\/revoke$/u)) return revokeCredential(state, idFrom(path, 4));
  if (method === "POST" && path.match(/^\/self\/api\/smtp-credentials\/[^/]+\/roll$/u)) return rollCredential(state, idFrom(path, 4));
  if (method === "POST" && path === "/admin/api/api-keys") return createApiKey(state, body);
  if (method === "POST" && path.match(/^\/admin\/api\/api-keys\/[^/]+\/revoke$/u)) return revokeApiKey(state, idFrom(path, 4));
  if (method === "POST" && path.match(/^\/admin\/api\/api-keys\/[^/]+\/roll$/u)) return rollApiKey(state, idFrom(path, 4));
  if (method === "PATCH" && path.match(/^\/admin\/api\/api-keys\/[^/]+$/u)) return patchApiKey(state, idFrom(path, 4), body);
  if (method === "POST" && path === "/self/api/api-keys") return createApiKey(state, { ...body, user_id: adminUser(state).id });
  if (method === "POST" && path.match(/^\/self\/api\/api-keys\/[^/]+\/revoke$/u)) return revokeApiKey(state, idFrom(path, 4));
  if (method === "POST" && path.match(/^\/self\/api\/api-keys\/[^/]+\/roll$/u)) return rollApiKey(state, idFrom(path, 4));
  if (method === "POST" && path === "/admin/api/ops/bump-policy-version") return ok(state, { policy_version: String(now()) });
  if (method === "POST" && path === "/admin/api/ops/flush-caches") return ok(state, { deleted: 14, prefixes: ["cred:", "apikey:", "domain:", "sender:", "idem:"] });
  throw new Error("demo_endpoint_not_found");
}

function createDomain(state: DemoState, body: Record<string, unknown>) {
  const domain = String(body.domain ?? "").trim().toLowerCase();
  if (!domain.includes(".")) throw new Error("invalid_domain");
  const id = demoId("dom");
  const next: Domain = {
    id,
    domain,
    cloudflare_zone_id: "demo_zone_" + Math.random().toString(16).slice(2, 10),
    status: "verified",
    dkim_status: "verified",
    spf_status: "verified",
    dmarc_status: "verified",
    enabled: 1,
    created_at: now(),
    updated_at: now(),
  };
  return ok({ ...state, domains: [next, ...state.domains] }, { id });
}

function refreshDomain(state: DemoState, id: string) {
  const domains = state.domains.map((domain) => domain.id === id ? { ...domain, status: "verified", updated_at: now() } : domain);
  const refreshed = domains.find((domain) => domain.id === id);
  if (!refreshed) throw new Error("domain_not_found");
  return ok({ ...state, domains }, { id, cloudflare_zone_id: refreshed.cloudflare_zone_id, status: refreshed.status });
}

function patchDomain(state: DemoState, id: string, body: Record<string, unknown>) {
  const domains = state.domains.map((domain) => domain.id === id ? {
    ...domain,
    enabled: typeof body.enabled === "boolean" ? (body.enabled ? 1 : 0) : domain.enabled,
    status: typeof body.status === "string" ? body.status : domain.status,
    cloudflare_zone_id: typeof body.cloudflare_zone_id === "string" ? body.cloudflare_zone_id : body.cloudflare_zone_id === null ? null : domain.cloudflare_zone_id,
    updated_at: now(),
  } : domain);
  if (!domains.some((domain) => domain.id === id)) throw new Error("domain_not_found");
  return ok({ ...state, domains }, { id });
}

function createUser(state: DemoState, body: Record<string, unknown>) {
  const email = String(body.email ?? "").trim().toLowerCase();
  const role = body.role === "sender" ? "sender" : "admin";
  const id = demoId("usr");
  const user: User = { id, email, display_name: optionalString(body.display_name), access_subject: `demo:${email}`, role, disabled_at: null, created_at: now(), updated_at: now() };
  return ok({ ...state, users: [user, ...state.users] }, { id });
}

function patchUser(state: DemoState, id: string, body: Record<string, unknown>) {
  const users = state.users.map((user) => user.id === id ? {
    ...user,
    display_name: "display_name" in body ? optionalString(body.display_name) : user.display_name,
    role: body.role === "sender" || body.role === "admin" ? body.role : user.role,
    disabled_at: body.disabled_at === null ? null : body.disabled_at === "now" || body.disabled_at === true ? now() : typeof body.disabled_at === "number" ? body.disabled_at : user.disabled_at,
    updated_at: now(),
  } : user);
  if (!users.some((user) => user.id === id)) throw new Error("user_not_found");
  return ok({ ...state, users }, { id });
}

function createSender(state: DemoState, body: Record<string, unknown>) {
  const domain = state.domains.find((candidate) => candidate.id === body.domain_id);
  if (!domain) throw new Error("domain_not_found");
  const user = state.users.find((candidate) => candidate.id === body.user_id) ?? null;
  const id = demoId("snd");
  const sender: Sender = {
    id,
    domain_id: domain.id,
    domain: domain.domain,
    email: String(body.email ?? "").trim().toLowerCase(),
    user_id: user?.id ?? null,
    user_email: user?.email ?? null,
    enabled: 1,
    created_at: now(),
    updated_at: now(),
  };
  return ok({ ...state, senders: [sender, ...state.senders] }, { id });
}

function patchSender(state: DemoState, id: string, body: Record<string, unknown>) {
  const senders = state.senders.map((sender) => sender.id === id ? { ...sender, enabled: typeof body.enabled === "boolean" ? (body.enabled ? 1 : 0) : sender.enabled, updated_at: now() } : sender);
  if (!senders.some((sender) => sender.id === id)) throw new Error("sender_not_found");
  return ok({ ...state, senders }, { id });
}

function deleteSender(state: DemoState, id: string) {
  return ok({ ...state, senders: state.senders.filter((sender) => sender.id !== id) }, { deleted: true });
}

function createCredential(state: DemoState, body: Record<string, unknown>) {
  const user = state.users.find((candidate) => candidate.id === body.user_id) ?? adminUser(state);
  const id = demoId("cred");
  const username = String(body.username ?? `demo-${Math.random().toString(36).slice(2, 7)}`).trim();
  const credential: SmtpCredential = {
    id,
    user_id: user.id,
    user_email: user.email,
    name: String(body.name ?? "Demo SMTP credential"),
    username,
    hash_version: 1,
    allowed_sender_ids_json: Array.isArray(body.allowed_sender_ids) ? JSON.stringify(body.allowed_sender_ids) : null,
    created_at: now(),
    last_used_at: null,
    revoked_at: null,
  };
  return ok({ ...state, credentials: [credential, ...state.credentials] }, { id, username, secret: demoSecret("smtp") });
}

function revokeCredential(state: DemoState, id: string) {
  return ok({ ...state, credentials: state.credentials.map((credential) => credential.id === id ? { ...credential, revoked_at: now() } : credential) }, { revoked: true });
}

function rollCredential(state: DemoState, id: string) {
  const credential = state.credentials.find((candidate) => candidate.id === id);
  if (!credential) throw new Error("credential_not_found");
  return ok(state, { id, username: credential.username, secret: demoSecret("smtp") });
}

function patchCredential(state: DemoState, id: string, body: Record<string, unknown>) {
  const credentials = state.credentials.map((credential) => credential.id === id ? {
    ...credential,
    name: typeof body.name === "string" ? body.name : credential.name,
    allowed_sender_ids_json: Array.isArray(body.allowed_sender_ids) ? JSON.stringify(body.allowed_sender_ids) : body.allowed_sender_ids === null ? null : credential.allowed_sender_ids_json,
  } : credential);
  if (!credentials.some((credential) => credential.id === id)) throw new Error("credential_not_found");
  return ok({ ...state, credentials }, { id });
}

function createApiKey(state: DemoState, body: Record<string, unknown>) {
  const user = state.users.find((candidate) => candidate.id === body.user_id) ?? adminUser(state);
  const id = demoId("key");
  const prefix = "cfmr_demo_" + Math.random().toString(36).slice(2, 6);
  const key: ApiKey = {
    id,
    user_id: user.id,
    user_email: user.email,
    name: String(body.name ?? "Demo API key"),
    key_prefix: prefix,
    scopes_json: null,
    allowed_sender_ids_json: Array.isArray(body.allowed_sender_ids) ? JSON.stringify(body.allowed_sender_ids) : null,
    created_at: now(),
    last_used_at: null,
    revoked_at: null,
  };
  return ok({ ...state, apiKeys: [key, ...state.apiKeys] }, { id, key_prefix: prefix, secret: `${prefix}_${demoSecret("api")}` });
}

function revokeApiKey(state: DemoState, id: string) {
  return ok({ ...state, apiKeys: state.apiKeys.map((key) => key.id === id ? { ...key, revoked_at: now() } : key) }, { revoked: true });
}

function rollApiKey(state: DemoState, id: string) {
  const key = state.apiKeys.find((candidate) => candidate.id === id);
  if (!key) throw new Error("api_key_not_found");
  return ok(state, { id, key_prefix: key.key_prefix, secret: `${key.key_prefix}_${demoSecret("api")}` });
}

function patchApiKey(state: DemoState, id: string, body: Record<string, unknown>) {
  const apiKeys = state.apiKeys.map((key) => key.id === id ? {
    ...key,
    name: typeof body.name === "string" ? body.name : key.name,
    allowed_sender_ids_json: Array.isArray(body.allowed_sender_ids) ? JSON.stringify(body.allowed_sender_ids) : body.allowed_sender_ids === null ? null : key.allowed_sender_ids_json,
  } : key);
  if (!apiKeys.some((key) => key.id === id)) throw new Error("api_key_not_found");
  return ok({ ...state, apiKeys }, { id });
}

function dashboard(state: DemoState): DashboardData {
  const failed = state.events.filter((event) => event.status !== "accepted").length;
  return {
    window_seconds: 86_400,
    sends_24h: { total: state.events.length, accepted: state.events.length - failed, failed },
    auth_failures_24h: state.authFailures.length,
    last_error: state.events.find((event) => event.status !== "accepted") ?? null,
    resource_counts: {
      users: state.users.filter((user) => user.disabled_at === null).length,
      domains: state.domains.filter((domain) => domain.enabled === 1).length,
      senders: state.senders.filter((sender) => sender.enabled === 1).length,
      smtp_credentials: state.credentials.filter((credential) => credential.revoked_at === null).length,
    },
    cf_api_health: { ok: true, status: 200, checked_at: now() - 11, error_code: null },
    system_health: [
      { name: "cloudflare_api", ok: true, status: 200, error_code: null, detail: "Demo token verifies", checked_at: now() - 11 },
      { name: "d1_schema", ok: true, status: 200, error_code: null, detail: "Schema v3", checked_at: now() - 11 },
      { name: "kv", ok: true, status: 200, error_code: null, detail: "Demo cache", checked_at: now() - 11 },
      { name: "access_jwks", ok: true, status: 200, error_code: null, detail: "Access simulated", checked_at: now() - 11 },
      { name: "recent_relay_send", ok: true, status: null, error_code: null, detail: "Last accepted send 45s ago", checked_at: now() - 11 },
      { name: "bootstrap_failures_24h", ok: true, status: null, error_code: null, detail: "0 in window", checked_at: now() - 11 },
    ],
  };
}

function defaultState(): DemoState {
  const users = demoUsers();
  const domains = demoDomains();
  const senders = demoSenders(users, domains);
  const credentials = demoCredentials(users, senders);
  const apiKeys = demoApiKeys(users, senders);
  return { users, domains, senders, credentials, apiKeys, events: demoEvents(users, domains, credentials, apiKeys), authFailures: demoAuthFailures() };
}

function demoUsers(): User[] {
  return [
    { id: "usr_alex", email: "alex@acme.example", display_name: "Alex Rivera", access_subject: "demo:alex", role: "admin", disabled_at: null, created_at: t(45 * DAY), updated_at: t(2 * DAY) },
    { id: "usr_app", email: "app-mailer@acme.example", display_name: "Product mailer", access_subject: "demo:app-mailer", role: "sender", disabled_at: null, created_at: t(31 * DAY), updated_at: t(4 * HOUR) },
    { id: "usr_alerts", email: "oncall-automation@acme.example", display_name: "On-call automation", access_subject: "demo:oncall-automation", role: "sender", disabled_at: null, created_at: t(20 * DAY), updated_at: t(2 * HOUR) },
    { id: "usr_billing", email: "billing-automation@acme.example", display_name: "Billing automation", access_subject: "demo:billing-automation", role: "sender", disabled_at: t(7 * DAY), created_at: t(60 * DAY), updated_at: t(7 * DAY) },
  ];
}

function demoDomains(): Domain[] {
  return [
    { id: "dom_mail", domain: "mail.acme.example", cloudflare_zone_id: "demo_zone_9c3a2f0e", status: "verified", dkim_status: "verified", spf_status: "verified", dmarc_status: "verified", enabled: 1, created_at: t(38 * DAY), updated_at: t(38 * DAY) },
    { id: "dom_status", domain: "status.acme.example", cloudflare_zone_id: "demo_zone_9c3a2f0e", status: "verified", dkim_status: "verified", spf_status: "verified", dmarc_status: "pending", enabled: 1, created_at: t(20 * DAY), updated_at: t(20 * DAY) },
    { id: "dom_marketing", domain: "mktg.acme.example", cloudflare_zone_id: "demo_zone_9c3a2f0e", status: "pending", dkim_status: "pending", spf_status: null, dmarc_status: null, enabled: 0, created_at: t(3 * DAY), updated_at: t(3 * DAY) },
  ];
}

function demoSenders(users: User[], domains: Domain[]): Sender[] {
  return [
    sender("snd_notifications", domains[0]!, "notifications@mail.acme.example", users[1]!),
    sender("snd_receipts", domains[0]!, "receipts@mail.acme.example", users[1]!),
    sender("snd_alerts", domains[1]!, "alerts@status.acme.example", users[2]!),
    sender("snd_incidents", domains[1]!, "incidents@status.acme.example", users[2]!),
    { ...sender("snd_invoices", domains[0]!, "invoices@mail.acme.example", users[3]!), enabled: 0, updated_at: t(7 * DAY) },
    sender("snd_support", domains[0]!, "support@mail.acme.example", users[0]!),
  ];
}

function demoCredentials(users: User[], senders: Sender[]): SmtpCredential[] {
  return [
    credential("cred_prod", users[1]!, "Rails app · production", "smtp-relay-prod", null, t(2 * MIN), null),
    credential("cred_staging", users[1]!, "Postfix relay · staging", "smtp-staging", [senders[0]!.id], t(38 * MIN), null),
    credential("cred_pd", users[2]!, "PagerDuty webhook bridge", "smtp-pd", null, t(17 * MIN), null),
    credential("cred_old", users[0]!, "Old laptop client", "smtp-alex-laptop", null, t(22 * DAY), t(8 * DAY)),
  ];
}

function demoApiKeys(users: User[], senders: Sender[]): ApiKey[] {
  return [
    apiKey("key_stripe", users[1]!, "Stripe webhook to mail", "cfmr_live_8t2j", [senders[0]!.id, senders[1]!.id], t(45), null),
    apiKey("key_grafana", users[2]!, "Grafana alert dispatcher", "cfmr_live_w91k", [senders[2]!.id], t(6 * MIN), null),
    apiKey("key_dev", users[0]!, "Local dev", "cfmr_test_4qpz", null, null, null),
  ];
}

function demoEvents(users: User[], domains: Domain[], credentials: SmtpCredential[], apiKeys: ApiKey[]): SendEvent[] {
  return [
    event("evt_accepted_1", "accepted", "notifications@mail.acme.example", users[1]!, domains[0]!, credentials[0]!, null, t(45), 1, 8412, "250"),
    event("evt_accepted_2", "accepted", "alerts@status.acme.example", users[2]!, domains[1]!, credentials[2]!, null, t(2 * MIN), 3, 22140, "250"),
    event("evt_bounce", "all_bounced", "receipts@mail.acme.example", users[1]!, domains[0]!, credentials[0]!, null, t(6 * MIN), 1, 11220, "550", "550-5.1.1"),
    event("evt_policy", "policy_rejected", "alerts@status.acme.example", users[2]!, domains[1]!, credentials[2]!, null, t(17 * MIN), 1, 9810, "550", null, "sender_not_allowed"),
    event("evt_http", "accepted", "support@mail.acme.example", users[0]!, domains[0]!, null, apiKeys[2]!, t(74 * MIN), 1, 6240, "250"),
    event("evt_size", "rejected_size", "notifications@mail.acme.example", users[1]!, domains[0]!, credentials[0]!, null, t(2 * HOUR), 1, 26_214_400, "552", null, "mime_too_large"),
  ];
}

function demoAuthFailures(): AuthFailure[] {
  return [
    { id: "af_bad_password", ts: t(3 * MIN), source: "smtp", attempted_username: "smtp-relay-prod", reason: "bad_password" },
    { id: "af_api_key", ts: t(28 * MIN), source: "http", attempted_username: "cfmr_live_unknown", reason: "invalid_api_key_prefix" },
    { id: "af_nonce", ts: t(2 * HOUR), source: "relay", attempted_username: null, reason: "nonce_replay" },
  ];
}

function sender(id: string, domain: Domain, email: string, user: User): Sender {
  return { id, domain_id: domain.id, domain: domain.domain, email, user_id: user.id, user_email: user.email, enabled: 1, created_at: t(20 * DAY), updated_at: t(20 * DAY) };
}

function credential(id: string, user: User, name: string, username: string, allowed: string[] | null, lastUsed: number | null, revoked: number | null): SmtpCredential {
  return { id, user_id: user.id, user_email: user.email, name, username, hash_version: 1, allowed_sender_ids_json: allowed === null ? null : JSON.stringify(allowed), created_at: t(31 * DAY), last_used_at: lastUsed, revoked_at: revoked };
}

function apiKey(id: string, user: User, name: string, prefix: string, allowed: string[] | null, lastUsed: number | null, revoked: number | null): ApiKey {
  return { id, user_id: user.id, user_email: user.email, name, key_prefix: prefix, scopes_json: null, allowed_sender_ids_json: allowed === null ? null : JSON.stringify(allowed), created_at: t(18 * DAY), last_used_at: lastUsed, revoked_at: revoked };
}

function event(id: string, status: string, from: string, user: User, domain: Domain, credential: SmtpCredential | null, key: ApiKey | null, ts: number, recipients: number, bytes: number, smtpCode: string | null, cfError: string | null = null, error: string | null = null): SendEvent {
  return {
    id,
    ts,
    trace_id: "tr_" + id,
    source: key === null ? "smtp" : "http",
    user_id: user.id,
    credential_id: credential?.id ?? null,
    api_key_id: key?.id ?? null,
    domain_id: domain.id,
    envelope_from: from,
    recipient_count: recipients,
    mime_size_bytes: bytes,
    cf_request_id: status === "accepted" ? demoId("req") : null,
    cf_ray_id: status === "accepted" ? "demo-ray-" + id.slice(-4) : null,
    status,
    smtp_code: smtpCode,
    error_code: error,
    cf_error_code: cfError,
  };
}

function adminUser(state: DemoState): User {
  return state.users.find((user) => user.role === "admin" && user.disabled_at === null) ?? state.users[0]!;
}

function adminSession(state: DemoState): Session {
  const user = adminUser(state);
  return { user: { id: user.id, email: user.email, display_name: user.display_name, access_subject: user.access_subject, role: user.role }, access: { sub: user.access_subject ?? "demo:admin", email: user.email } };
}

function selfProfile(state: DemoState): SelfProfile {
  const user = adminUser(state);
  return {
    ...user,
    counts: {
      senders: state.senders.filter((sender) => sender.user_id === user.id).length,
      smtp_credentials: state.credentials.filter((credential) => credential.user_id === user.id && credential.revoked_at === null).length,
      api_keys: state.apiKeys.filter((key) => key.user_id === user.id && key.revoked_at === null).length,
    },
  };
}

function selfSenders(state: DemoState): SelfSender[] {
  const user = adminUser(state);
  return state.senders.filter((sender) => sender.user_id === user.id).map((sender) => ({
    id: sender.id,
    domain_id: sender.domain_id,
    domain: sender.domain,
    email: sender.email,
    enabled: sender.enabled,
    created_at: sender.created_at,
    updated_at: sender.updated_at,
  }));
}

function ok<T>(state: DemoState, result: T): { state: DemoState; payload: JsonEnvelope<T> } {
  return { state, payload: { ok: true, result } };
}

async function readJsonBody(request: Request | null, init?: RequestInit): Promise<Record<string, unknown>> {
  const raw = init?.body ?? request?.body;
  if (raw === undefined || raw === null) return {};
  const text = typeof raw === "string" ? raw : raw instanceof URLSearchParams ? raw.toString() : "";
  if (text.length === 0) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function loadState(): DemoState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as DemoState;
  } catch {
    // localStorage can be unavailable in hardened browser contexts.
  }
  return defaultState();
}

function saveState(state: DemoState): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Demo still works for the current page session if storage is blocked.
  }
}

function installDemoBadge(): void {
  if (document.querySelector("[data-demo-badge]")) return;
  const badge = document.createElement("div");
  badge.dataset.demoBadge = "true";
  badge.textContent = "Demo";
  badge.style.cssText = "position:fixed;z-index:1000;right:16px;bottom:16px;padding:6px 10px;border-radius:6px;background:#111;color:white;font:600 12px/1 system-ui;box-shadow:0 8px 24px rgba(0,0,0,.18);";
  document.body.appendChild(badge);
}

function idFrom(path: string, index: number): string {
  return decodeURIComponent(path.split("/")[index] ?? "");
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function demoId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function demoSecret(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}`;
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function t(secondsAgo: number): number {
  return NOW - secondsAgo;
}
