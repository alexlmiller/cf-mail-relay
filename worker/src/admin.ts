import { hmacSha256Hex } from "./hmac";
import type { Env } from "./index";

export async function dashboard(env: Env): Promise<Record<string, unknown>> {
  const since = Math.floor(Date.now() / 1000) - 24 * 60 * 60;
  const [sendStats, authStats, lastError, counts, cfApiHealth] = await Promise.all([
    env.D1_MAIN.prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) AS accepted,
         SUM(CASE WHEN status != 'accepted' THEN 1 ELSE 0 END) AS failed
       FROM send_events
       WHERE ts >= ?`,
    )
      .bind(since)
      .first<{ total: number; accepted: number | null; failed: number | null }>(),
    env.D1_MAIN.prepare("SELECT COUNT(*) AS total FROM auth_failures WHERE ts >= ?").bind(since).first<{ total: number }>(),
    env.D1_MAIN.prepare("SELECT ts, status, envelope_from, error_code, cf_error_code FROM send_events WHERE status != 'accepted' ORDER BY ts DESC LIMIT 1").first(),
    Promise.all([
      env.D1_MAIN.prepare("SELECT COUNT(*) AS total FROM users WHERE disabled_at IS NULL").first<{ total: number }>(),
      env.D1_MAIN.prepare("SELECT COUNT(*) AS total FROM domains WHERE enabled = 1").first<{ total: number }>(),
      env.D1_MAIN.prepare("SELECT COUNT(*) AS total FROM allowlisted_senders WHERE enabled = 1").first<{ total: number }>(),
      env.D1_MAIN.prepare("SELECT COUNT(*) AS total FROM smtp_credentials WHERE revoked_at IS NULL").first<{ total: number }>(),
    ]),
    checkCloudflareApiHealth(env),
  ]);

  return {
    window_seconds: 24 * 60 * 60,
    sends_24h: {
      total: sendStats?.total ?? 0,
      accepted: sendStats?.accepted ?? 0,
      failed: sendStats?.failed ?? 0,
    },
    auth_failures_24h: authStats?.total ?? 0,
    last_error: lastError ?? null,
    resource_counts: {
      users: counts[0]?.total ?? 0,
      domains: counts[1]?.total ?? 0,
      senders: counts[2]?.total ?? 0,
      smtp_credentials: counts[3]?.total ?? 0,
    },
    cf_api_health: cfApiHealth,
  };
}

export interface CloudflareApiHealth {
  ok: boolean;
  status: number | null;
  checked_at: number;
  error_code: string | null;
}

export async function checkCloudflareApiHealth(env: Env): Promise<CloudflareApiHealth> {
  const checkedAt = nowSeconds();
  try {
    const response = await fetch("https://api.cloudflare.com/client/v4/user/tokens/verify", {
      method: "GET",
      headers: {
        authorization: `Bearer ${env.CF_API_TOKEN}`,
        accept: "application/json",
      },
    });
    const payload = await readCloudflareJson(response);
    const success = cloudflareSuccess(payload);
    const ok = response.ok && success === true;
    return {
      ok,
      status: response.status,
      checked_at: checkedAt,
      error_code: ok ? null : firstCloudflareErrorCode(payload) ?? (success === null ? "invalid_cloudflare_response" : `http_${response.status}`),
    };
  } catch {
    return {
      ok: false,
      status: null,
      checked_at: checkedAt,
      error_code: "fetch_failed",
    };
  }
}

export async function listUsers(env: Env): Promise<unknown[]> {
  const result = await env.D1_MAIN.prepare(
    "SELECT id, email, display_name, access_subject, role, disabled_at, created_at, updated_at FROM users ORDER BY created_at DESC LIMIT 200",
  ).all();
  return result.results ?? [];
}

export async function createUser(env: Env, body: Record<string, unknown>): Promise<{ id: string }> {
  const email = requireEmail(body.email, "email").toLowerCase();
  const role = requireRole(body.role);
  const id = prefixedId("usr");
  const now = nowSeconds();
  await env.D1_MAIN.prepare(
    "INSERT INTO users (id, email, display_name, access_subject, role, disabled_at, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, NULL, ?, ?)",
  )
    .bind(id, email, optionalString(body.display_name), role, now, now)
    .run();
  await bumpPolicyVersion(env);
  return { id };
}

export async function listDomains(env: Env): Promise<unknown[]> {
  const result = await env.D1_MAIN.prepare(
    "SELECT id, domain, cloudflare_zone_id, status, dkim_status, spf_status, dmarc_status, enabled, created_at, updated_at FROM domains ORDER BY domain LIMIT 200",
  ).all();
  return result.results ?? [];
}

export async function createDomain(env: Env, body: Record<string, unknown>): Promise<{ id: string }> {
  const domain = requireDomain(body.domain);
  const id = prefixedId("dom");
  const now = nowSeconds();
  await env.D1_MAIN.prepare(
    "INSERT INTO domains (id, domain, cloudflare_zone_id, status, dkim_status, spf_status, dmarc_status, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, NULL, NULL, 1, ?, ?)",
  )
    .bind(id, domain, optionalString(body.cloudflare_zone_id), statusOrDefault(body.status), now, now)
    .run();
  await bumpPolicyVersion(env);
  return { id };
}

export async function listSenders(env: Env): Promise<unknown[]> {
  const result = await env.D1_MAIN.prepare(
    `SELECT s.id, s.domain_id, d.domain, s.email, s.user_id, u.email AS user_email, s.enabled, s.created_at, s.updated_at
       FROM allowlisted_senders s
       JOIN domains d ON d.id = s.domain_id
       LEFT JOIN users u ON u.id = s.user_id
      ORDER BY s.created_at DESC
      LIMIT 300`,
  ).all();
  return result.results ?? [];
}

export async function createSender(env: Env, body: Record<string, unknown>): Promise<{ id: string }> {
  const id = prefixedId("snd");
  const now = nowSeconds();
  const domainId = requireString(body.domain_id, "domain_id");
  const domain = await env.D1_MAIN.prepare("SELECT domain FROM domains WHERE id = ? AND enabled = 1").bind(domainId).first<{ domain: string }>();
  if (domain === null) {
    throw new Error("domain_not_found");
  }
  const email = requireEmailOrWildcard(body.email);
  if (!senderBelongsToDomain(email, domain.domain)) {
    throw new Error("sender_domain_mismatch");
  }
  await env.D1_MAIN.prepare(
    "INSERT INTO allowlisted_senders (id, domain_id, email, user_id, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)",
  )
    .bind(id, domainId, email, optionalString(body.user_id), now, now)
    .run();
  await bumpPolicyVersion(env);
  return { id };
}

export async function listSmtpCredentials(env: Env): Promise<unknown[]> {
  const result = await env.D1_MAIN.prepare(
    `SELECT c.id, c.user_id, u.email AS user_email, c.name, c.username, c.hash_version, c.allowed_sender_ids_json, c.created_at, c.last_used_at, c.revoked_at
       FROM smtp_credentials c
       JOIN users u ON u.id = c.user_id
      ORDER BY c.created_at DESC
      LIMIT 300`,
  ).all();
  return result.results ?? [];
}

export async function createSmtpCredential(env: Env, body: Record<string, unknown>): Promise<{ id: string; username: string; secret: string }> {
  const id = prefixedId("cred");
  const username = requireString(body.username, "username").trim().toLowerCase();
  const secret = randomSecret();
  const now = nowSeconds();
  await env.D1_MAIN.prepare(
    "INSERT INTO smtp_credentials (id, user_id, name, username, secret_hash, hash_version, allowed_sender_ids_json, created_at, last_used_at, last_used_ip_hash, revoked_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, NULL, NULL, NULL)",
  )
    .bind(
      id,
      requireString(body.user_id, "user_id"),
      requireString(body.name, "name"),
      username,
      await hmacSha256Hex(env.CREDENTIAL_PEPPER, secret),
      allowedSenderIdsJson(body.allowed_sender_ids),
      now,
    )
    .run();
  await bumpPolicyVersion(env);
  return { id, username, secret };
}

export async function revokeSmtpCredential(env: Env, id: string): Promise<void> {
  await env.D1_MAIN.prepare("UPDATE smtp_credentials SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").bind(nowSeconds(), id).run();
  await bumpPolicyVersion(env);
}

export async function rollSmtpCredential(env: Env, id: string): Promise<{ id: string; username: string; secret: string }> {
  const existing = await env.D1_MAIN.prepare("SELECT id, username FROM smtp_credentials WHERE id = ? AND revoked_at IS NULL")
    .bind(id)
    .first<{ id: string; username: string }>();
  if (!existing) throw new Error("credential_not_found");
  const secret = randomSecret();
  await env.D1_MAIN.prepare(
    "UPDATE smtp_credentials SET secret_hash = ?, hash_version = hash_version + 1, last_used_at = NULL, last_used_ip_hash = NULL WHERE id = ? AND revoked_at IS NULL",
  )
    .bind(await hmacSha256Hex(env.CREDENTIAL_PEPPER, secret), id)
    .run();
  await bumpPolicyVersion(env);
  return { id: existing.id, username: existing.username, secret };
}

export async function listApiKeys(env: Env): Promise<unknown[]> {
  const result = await env.D1_MAIN.prepare(
    `SELECT k.id, k.user_id, u.email AS user_email, k.name, k.key_prefix, k.scopes_json, k.allowed_sender_ids_json, k.created_at, k.last_used_at, k.revoked_at
       FROM api_keys k
       JOIN users u ON u.id = k.user_id
      ORDER BY k.created_at DESC
      LIMIT 300`,
  ).all();
  return result.results ?? [];
}

export async function createApiKey(env: Env, body: Record<string, unknown>): Promise<{ id: string; key_prefix: string; secret: string }> {
  const id = prefixedId("key");
  const now = nowSeconds();
  const userId = requireString(body.user_id, "user_id");
  const name = requireString(body.name, "name");
  const allowedSenderIds = allowedSenderIdsJson(body.allowed_sender_ids);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const secret = randomSecret();
    const keyPrefix = secret.slice(0, 8);
    try {
      await env.D1_MAIN.prepare(
        "INSERT INTO api_keys (id, user_id, name, key_prefix, secret_hash, hash_version, scopes_json, allowed_sender_ids_json, created_at, last_used_at, revoked_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, NULL, NULL)",
      )
        .bind(
          id,
          userId,
          name,
          keyPrefix,
          await hmacSha256Hex(env.CREDENTIAL_PEPPER, secret),
          JSON.stringify(["send"]),
          allowedSenderIds,
          now,
        )
        .run();
      await bumpPolicyVersion(env);
      return { id, key_prefix: keyPrefix, secret };
    } catch (error) {
      if (!String(error instanceof Error ? error.message : error).toLowerCase().includes("unique")) {
        throw error;
      }
    }
  }
  throw new Error("api_key_prefix_collision");
}

export async function revokeApiKey(env: Env, id: string): Promise<void> {
  await env.D1_MAIN.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").bind(nowSeconds(), id).run();
  await bumpPolicyVersion(env);
}

export async function rollApiKey(env: Env, id: string): Promise<{ id: string; key_prefix: string; secret: string }> {
  const existing = await env.D1_MAIN.prepare("SELECT id FROM api_keys WHERE id = ? AND revoked_at IS NULL").bind(id).first<{ id: string }>();
  if (!existing) throw new Error("api_key_not_found");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const secret = randomSecret();
    const keyPrefix = secret.slice(0, 8);
    try {
      await env.D1_MAIN.prepare(
        "UPDATE api_keys SET key_prefix = ?, secret_hash = ?, hash_version = hash_version + 1, last_used_at = NULL WHERE id = ? AND revoked_at IS NULL",
      )
        .bind(keyPrefix, await hmacSha256Hex(env.CREDENTIAL_PEPPER, secret), id)
        .run();
      await bumpPolicyVersion(env);
      return { id, key_prefix: keyPrefix, secret };
    } catch (error) {
      if (!String(error instanceof Error ? error.message : error).toLowerCase().includes("unique")) {
        throw error;
      }
    }
  }
  throw new Error("api_key_prefix_collision");
}

export async function listSendEvents(env: Env): Promise<unknown[]> {
  const result = await env.D1_MAIN.prepare(
    `SELECT id, ts, trace_id, source, user_id, credential_id, api_key_id, domain_id, envelope_from,
            recipient_count, mime_size_bytes, cf_request_id, cf_ray_id, status, smtp_code, error_code, cf_error_code
       FROM send_events
      ORDER BY ts DESC
      LIMIT 200`,
  ).all();
  return result.results ?? [];
}

export async function listAuthFailures(env: Env): Promise<unknown[]> {
  const result = await env.D1_MAIN.prepare(
    "SELECT id, ts, source, attempted_username, reason FROM auth_failures ORDER BY ts DESC LIMIT 200",
  ).all();
  return result.results ?? [];
}

async function bumpPolicyVersion(env: Env): Promise<void> {
  await env.D1_MAIN.prepare("INSERT OR REPLACE INTO settings (key, value_json, updated_at) VALUES ('policy_version', ?, ?)")
    .bind(JSON.stringify(String(nowSeconds())), nowSeconds())
    .run();
}

function allowedSenderIdsJson(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error("invalid_allowed_sender_ids");
  }
  return JSON.stringify(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`invalid_${field}`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function requireRole(value: unknown): "admin" | "sender" {
  if (value === "admin" || value === "sender") {
    return value;
  }
  throw new Error("invalid_role");
}

function requireEmail(value: unknown, field: string): string {
  const email = requireString(value, field);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new Error(`invalid_${field}`);
  }
  return email;
}

function requireEmailOrWildcard(value: unknown): string {
  const email = requireString(value, "email").toLowerCase();
  if (/^\*@[^@\s]+\.[^@\s]+$/.test(email) || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return email;
  }
  throw new Error("invalid_email");
}

function senderBelongsToDomain(email: string, domain: string): boolean {
  const normalizedDomain = domain.toLowerCase();
  const senderDomain = email.split("@").at(-1)?.toLowerCase() ?? "";
  return senderDomain === normalizedDomain;
}

function requireDomain(value: unknown): string {
  const domain = requireString(value, "domain").toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
    throw new Error("invalid_domain");
  }
  return domain;
}

function statusOrDefault(value: unknown): string {
  return value === "pending" || value === "verified" || value === "sandbox" || value === "disabled" ? value : "pending";
}

async function readCloudflareJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

function cloudflareSuccess(value: unknown): boolean | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const success = (value as { success?: unknown }).success;
  return typeof success === "boolean" ? success : null;
}

function firstCloudflareErrorCode(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const errors = (value as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) {
    return null;
  }
  const firstError = errors.find((error): error is { code?: unknown } => typeof error === "object" && error !== null);
  if (typeof firstError?.code === "string" || typeof firstError?.code === "number") {
    return String(firstError.code);
  }
  return null;
}

function randomSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function prefixedId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
