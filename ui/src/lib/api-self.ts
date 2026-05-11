// Typed client for /self/api/*. Every endpoint scopes to the calling user.

import { ApiError } from "./api";
import type { ApiKey, CreateSecretResult, SendEvent, Session, SmtpCredential, User } from "./types";

export interface SelfProfile extends User {
  counts: {
    senders: number;
    smtp_credentials: number;
    api_keys: number;
  };
}

export interface SelfSender {
  id: string;
  domain_id: string;
  domain: string;
  email: string;
  enabled: number;
  created_at: number;
  updated_at: number;
}

interface Envelope<T> {
  ok?: boolean;
  result?: T;
  error?: string;
}

let base = "";
export function setSelfApiBase(value: string) {
  base = value.replace(/\/$/, "");
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers ?? {});
  if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");

  const response = await fetch(`${base}${path}`, { ...init, headers, credentials: "include" });
  if (response.status === 401 || response.status === 403) {
    const text = await response.text().catch(() => "");
    throw new ApiError(parseError(text) ?? "access_denied", response.status, "access");
  }

  let payload: Envelope<T> | null = null;
  const text = await response.text();
  if (text.length > 0) {
    try {
      payload = JSON.parse(text) as Envelope<T>;
    } catch {
      throw new ApiError("invalid_json_response", response.status, "bad_response");
    }
  }

  if (!response.ok) {
    const code = payload?.error ?? `http_${response.status}`;
    throw new ApiError(code, response.status, code);
  }
  if (payload?.ok === false) {
    throw new ApiError(payload.error ?? "unknown_error", response.status, payload.error ?? "unknown_error");
  }
  if (payload && "result" in payload && payload.ok) {
    return payload.result as T;
  }
  return payload as T;
}

function parseError(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as { error?: unknown };
    return typeof parsed.error === "string" ? parsed.error : null;
  } catch {
    return null;
  }
}

export const selfApi = {
  session: () => request<Session>("/self/api/session"),
  profile: () => request<SelfProfile>("/self/api/profile"),
  senders: () => request<SelfSender[]>("/self/api/senders"),
  smtpCredentials: () => request<SmtpCredential[]>("/self/api/smtp-credentials"),
  createSmtpCredential: (body: { name: string; username: string }) =>
    request<CreateSecretResult>("/self/api/smtp-credentials", { method: "POST", body: JSON.stringify(body) }),
  revokeSmtpCredential: (id: string) =>
    request<{ revoked: true }>(`/self/api/smtp-credentials/${encodeURIComponent(id)}/revoke`, { method: "POST", body: "{}" }),
  apiKeys: () => request<ApiKey[]>("/self/api/api-keys"),
  createApiKey: (body: { name: string }) =>
    request<CreateSecretResult>("/self/api/api-keys", { method: "POST", body: JSON.stringify(body) }),
  revokeApiKey: (id: string) =>
    request<{ revoked: true }>(`/self/api/api-keys/${encodeURIComponent(id)}/revoke`, { method: "POST", body: "{}" }),
  sendEvents: () => request<SendEvent[]>("/self/api/send-events"),
};
