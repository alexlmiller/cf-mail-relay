// Worker admin API client. All requests carry the Cloudflare Access cookie.

import type {
  ApiKey,
  AuthFailure,
  CreateSecretResult,
  DashboardData,
  Domain,
  SendEvent,
  Sender,
  Session,
  SmtpCredential,
  User,
} from "./types";

interface EnvelopeOk<T> {
  ok: true;
  result: T;
}
interface EnvelopeErr {
  ok: false;
  error: string;
}
type Envelope<T> = EnvelopeOk<T> | EnvelopeErr;

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(message: string, status: number, code: string) {
    super(message);
    // Restore prototype so `instanceof ApiError` works under any TS target.
    Object.setPrototypeOf(this, ApiError.prototype);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

/** Human-readable error message for any thrown value. */
export function describeError(error: unknown, fallback = "Request failed"): string {
  if (error instanceof Error) return error.message || fallback;
  if (typeof error === "string") return error;
  return fallback;
}

let apiBase = "";
export function setApiBase(base: string) {
  apiBase = base.replace(/\/$/, "");
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers ?? {});
  if (init.body !== undefined && !headers.has("content-type")) {
    // text/plain keeps the request CORS-"simple", so the browser doesn't issue
    // an OPTIONS preflight that Cloudflare Access would challenge with a 403.
    // The Worker's c.req.json() parses any text body, so the content-type
    // doesn't matter to the server. See docs/security.md for the broader CORS
    // and Access interaction.
    headers.set("content-type", "text/plain;charset=UTF-8");
  }
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers,
    credentials: "include",
  });

  // 401 / 403 — most likely the Cloudflare Access cookie expired.
  if (response.status === 401 || response.status === 403) {
    const text = await response.text().catch(() => "");
    throw new ApiError(parseErr(text) ?? "access_denied", response.status, "access");
  }

  let payload: unknown = null;
  const text = await response.text();
  if (text.length > 0) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new ApiError(`invalid_json_response`, response.status, "bad_response");
    }
  }

  if (!response.ok) {
    const code = (payload as EnvelopeErr | null)?.error ?? `http_${response.status}`;
    throw new ApiError(code, response.status, code);
  }

  const env = payload as Envelope<T> | (T & { ok?: boolean });
  if (env && typeof env === "object" && "ok" in env && env.ok === false) {
    const code = (env as EnvelopeErr).error;
    throw new ApiError(code, response.status, code);
  }
  if (env && typeof env === "object" && "result" in env && (env as EnvelopeOk<T>).ok) {
    return (env as EnvelopeOk<T>).result;
  }
  return env as T;
}

function parseErr(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as { error?: unknown };
    return typeof parsed.error === "string" ? parsed.error : null;
  } catch {
    return null;
  }
}

// ───────────────────────── Endpoints ─────────────────────────

export const api = {
  session: () => request<Session>("/admin/api/session"),
  dashboard: () => request<DashboardData>("/admin/api/dashboard"),

  listUsers: () => request<User[]>("/admin/api/users"),
  createUser: (body: { email: string; display_name?: string; role: "admin" | "sender" }) =>
    request<{ id: string }>("/admin/api/users", { method: "POST", body: JSON.stringify(body) }),

  listDomains: () => request<Domain[]>("/admin/api/domains"),
  createDomain: (body: { domain: string; cloudflare_zone_id?: string; status?: string }) =>
    request<{ id: string }>("/admin/api/domains", { method: "POST", body: JSON.stringify(body) }),

  listSenders: () => request<Sender[]>("/admin/api/senders"),
  createSender: (body: { domain_id: string; email: string; user_id?: string }) =>
    request<{ id: string }>("/admin/api/senders", { method: "POST", body: JSON.stringify(body) }),

  listSmtpCredentials: () => request<SmtpCredential[]>("/admin/api/smtp-credentials"),
  createSmtpCredential: (body: { user_id: string; name: string; username: string; allowed_sender_ids?: string[] }) =>
    request<CreateSecretResult>("/admin/api/smtp-credentials", { method: "POST", body: JSON.stringify(body) }),
  revokeSmtpCredential: (id: string) =>
    request<{ revoked: true }>(`/admin/api/smtp-credentials/${encodeURIComponent(id)}/revoke`, {
      method: "POST",
      body: "{}",
    }),
  rollSmtpCredential: (id: string) =>
    request<CreateSecretResult>(`/admin/api/smtp-credentials/${encodeURIComponent(id)}/roll`, {
      method: "POST",
      body: "{}",
    }),

  listApiKeys: () => request<ApiKey[]>("/admin/api/api-keys"),
  createApiKey: (body: { user_id: string; name: string; allowed_sender_ids?: string[] }) =>
    request<CreateSecretResult>("/admin/api/api-keys", { method: "POST", body: JSON.stringify(body) }),
  revokeApiKey: (id: string) =>
    request<{ revoked: true }>(`/admin/api/api-keys/${encodeURIComponent(id)}/revoke`, {
      method: "POST",
      body: "{}",
    }),
  rollApiKey: (id: string) =>
    request<CreateSecretResult>(`/admin/api/api-keys/${encodeURIComponent(id)}/roll`, {
      method: "POST",
      body: "{}",
    }),

  listSendEvents: () => request<SendEvent[]>("/admin/api/send-events"),
  listAuthFailures: () => request<AuthFailure[]>("/admin/api/auth-failures"),
};
