// Self-service endpoints for any authenticated user (admin or sender).
// Every query is scoped by user_id from the session — the client cannot
// supply user_id on creates, and reads/revokes refuse to cross user lines.

import { hmacSha256Hex } from "./hmac";
import type { Env } from "./index";

export interface SelfProfile {
  id: string;
  email: string;
  display_name: string | null;
  access_subject: string | null;
  role: "admin" | "sender";
  created_at: number;
  counts: {
    senders: number;
    smtp_credentials: number;
    api_keys: number;
  };
}

export async function selfProfile(env: Env, userId: string): Promise<SelfProfile | null> {
  const user = await env.D1_MAIN.prepare(
    "SELECT id, email, display_name, access_subject, role, created_at FROM users WHERE id = ?",
  )
    .bind(userId)
    .first<{ id: string; email: string; display_name: string | null; access_subject: string | null; role: "admin" | "sender"; created_at: number }>();
  if (user === null) return null;

  const counts = await Promise.all([
    env.D1_MAIN.prepare("SELECT COUNT(*) AS n FROM allowlisted_senders WHERE user_id = ? AND enabled = 1").bind(userId).first<{ n: number }>(),
    env.D1_MAIN.prepare("SELECT COUNT(*) AS n FROM smtp_credentials WHERE user_id = ? AND revoked_at IS NULL").bind(userId).first<{ n: number }>(),
    env.D1_MAIN.prepare("SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ? AND revoked_at IS NULL").bind(userId).first<{ n: number }>(),
  ]);

  return {
    ...user,
    counts: {
      senders: counts[0]?.n ?? 0,
      smtp_credentials: counts[1]?.n ?? 0,
      api_keys: counts[2]?.n ?? 0,
    },
  };
}

export async function selfSenders(env: Env, userId: string): Promise<unknown[]> {
  const result = await env.D1_MAIN.prepare(
    `SELECT s.id, s.domain_id, d.domain, s.email, s.enabled, s.created_at, s.updated_at
       FROM allowlisted_senders s
       JOIN domains d ON d.id = s.domain_id
      WHERE s.user_id = ?
      ORDER BY s.created_at DESC`,
  )
    .bind(userId)
    .all();
  return result.results ?? [];
}

export async function selfSmtpCredentials(env: Env, userId: string): Promise<unknown[]> {
  const result = await env.D1_MAIN.prepare(
    `SELECT id, name, username, hash_version, created_at, last_used_at, revoked_at
       FROM smtp_credentials
      WHERE user_id = ?
      ORDER BY created_at DESC`,
  )
    .bind(userId)
    .all();
  return result.results ?? [];
}

export async function selfCreateSmtpCredential(env: Env, userId: string, body: Record<string, unknown>): Promise<{ id: string; username: string; secret: string }> {
  const name = requireString(body.name, "name");
  const username = requireString(body.username, "username").trim().toLowerCase();
  const id = prefixedId("cred");
  const secret = randomSecret();
  const now = nowSeconds();
  await env.D1_MAIN.prepare(
    "INSERT INTO smtp_credentials (id, user_id, name, username, secret_hash, hash_version, allowed_sender_ids_json, created_at, last_used_at, last_used_ip_hash, revoked_at) VALUES (?, ?, ?, ?, ?, 1, NULL, ?, NULL, NULL, NULL)",
  )
    .bind(id, userId, name, username, await hmacSha256Hex(env.CREDENTIAL_PEPPER, secret), now)
    .run();
  await bumpPolicyVersion(env);
  return { id, username, secret };
}

export async function selfRevokeSmtpCredential(env: Env, userId: string, credentialId: string): Promise<{ revoked: boolean }> {
  const result = await env.D1_MAIN.prepare(
    "UPDATE smtp_credentials SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL",
  )
    .bind(nowSeconds(), credentialId, userId)
    .run();
  if (result.meta.changes === 0) {
    throw new Error("credential_not_found");
  }
  await bumpPolicyVersion(env);
  return { revoked: true };
}

export async function selfApiKeys(env: Env, userId: string): Promise<unknown[]> {
  const result = await env.D1_MAIN.prepare(
    `SELECT id, name, key_prefix, scopes_json, created_at, last_used_at, revoked_at
       FROM api_keys
      WHERE user_id = ?
      ORDER BY created_at DESC`,
  )
    .bind(userId)
    .all();
  return result.results ?? [];
}

export async function selfCreateApiKey(env: Env, userId: string, body: Record<string, unknown>): Promise<{ id: string; key_prefix: string; secret: string }> {
  const name = requireString(body.name, "name");
  const id = prefixedId("key");
  const now = nowSeconds();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const secret = randomSecret();
    const keyPrefix = secret.slice(0, 8);
    try {
      await env.D1_MAIN.prepare(
        "INSERT INTO api_keys (id, user_id, name, key_prefix, secret_hash, hash_version, scopes_json, allowed_sender_ids_json, created_at, last_used_at, revoked_at) VALUES (?, ?, ?, ?, ?, 1, ?, NULL, ?, NULL, NULL)",
      )
        .bind(id, userId, name, keyPrefix, await hmacSha256Hex(env.CREDENTIAL_PEPPER, secret), JSON.stringify(["send"]), now)
        .run();
      await bumpPolicyVersion(env);
      return { id, key_prefix: keyPrefix, secret };
    } catch (error) {
      if (!String(error instanceof Error ? error.message : error).toLowerCase().includes("unique")) throw error;
    }
  }
  throw new Error("api_key_prefix_collision");
}

export async function selfRevokeApiKey(env: Env, userId: string, keyId: string): Promise<{ revoked: boolean }> {
  const result = await env.D1_MAIN.prepare(
    "UPDATE api_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL",
  )
    .bind(nowSeconds(), keyId, userId)
    .run();
  if (result.meta.changes === 0) {
    throw new Error("api_key_not_found");
  }
  await bumpPolicyVersion(env);
  return { revoked: true };
}

export async function selfSendEvents(env: Env, userId: string): Promise<unknown[]> {
  const result = await env.D1_MAIN.prepare(
    `SELECT id, ts, trace_id, source, credential_id, api_key_id, envelope_from,
            recipient_count, mime_size_bytes, cf_request_id, cf_ray_id,
            status, smtp_code, error_code, cf_error_code
       FROM send_events
      WHERE user_id = ?
      ORDER BY ts DESC
      LIMIT 200`,
  )
    .bind(userId)
    .all();
  return result.results ?? [];
}

async function bumpPolicyVersion(env: Env): Promise<void> {
  await env.D1_MAIN.prepare("INSERT OR REPLACE INTO settings (key, value_json, updated_at) VALUES ('policy_version', ?, ?)")
    .bind(JSON.stringify(String(nowSeconds())), nowSeconds())
    .run();
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`invalid_${field}`);
  }
  return value.trim();
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
