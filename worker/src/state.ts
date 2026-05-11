import { hmacSha256Hex, sha256Hex, timingSafeEqualString } from "./hmac";
import type { Env } from "./index";

export interface AuthDecision {
  ok: true;
  ttl_seconds: number;
  policy_version: string;
  user_id: string;
  credential_id: string;
  allowed_senders: string[];
}

export type AuthFailureReason = "bad_creds" | "disabled" | "not_found";

interface CredentialRow {
  id: string;
  user_id: string;
  username: string;
  secret_hash: string;
  hash_version: number;
  allowed_sender_ids_json: string | null;
  revoked_at: number | null;
  user_disabled_at: number | null;
}

interface ApiKeyRow {
  id: string;
  user_id: string;
  key_prefix: string;
  secret_hash: string;
  hash_version: number;
  scopes_json: string | null;
  allowed_sender_ids_json: string | null;
  revoked_at: number | null;
  user_disabled_at: number | null;
}

interface SenderRow {
  id: string;
  email: string;
}

interface IdempotencyRow {
  status: string;
  response_json: string | null;
}

export interface SendEventInput {
  traceId: string;
  source: "smtp" | "http";
  userId?: string;
  credentialId?: string;
  apiKeyId?: string;
  domainId?: string;
  envelopeFrom: string;
  recipients: string[];
  mimeSizeBytes: number;
  messageIdHeader: string;
  cfRequestId?: string | null;
  cfRayId?: string | null;
  cfDeliveredJson?: string | null;
  cfQueuedJson?: string | null;
  cfBouncedJson?: string | null;
  status: string;
  smtpCode?: string | undefined;
  errorCode?: string | undefined;
  cfErrorCode?: string | null;
}

export interface ReplayResponse {
  ok: boolean;
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const authDecisionTtlSeconds = 60;
const credentialCacheTtlSeconds = 300;
const idempotencyTtlSeconds = 24 * 60 * 60;

export async function authenticateSmtpCredential(
  env: Env,
  username: string,
  password: string,
  remoteIp: string | undefined,
): Promise<AuthDecision | { ok: false; reason: AuthFailureReason }> {
  const policyVersion = await policyVersionFromD1(env);
  const credential = await lookupCredential(env, username, policyVersion);
  if (credential === null) {
    await recordAuthFailure(env, username, "not_found", remoteIp);
    return { ok: false, reason: "not_found" };
  }
  if (credential.revoked_at !== null || credential.user_disabled_at !== null) {
    await recordAuthFailure(env, username, "disabled", remoteIp);
    return { ok: false, reason: "disabled" };
  }

  const candidateHash = await credentialHash(env, password);
  if (!timingSafeEqualString(candidateHash, credential.secret_hash)) {
    await recordAuthFailure(env, username, "bad_creds", remoteIp);
    return { ok: false, reason: "bad_creds" };
  }

  const allowedSenders = await allowedSendersForCredential(env, credential);
  await updateCredentialLastUsed(env, credential.id, remoteIp);

  return {
    ok: true,
    ttl_seconds: authDecisionTtlSeconds,
    policy_version: policyVersion,
    user_id: credential.user_id,
    credential_id: credential.id,
    allowed_senders: allowedSenders,
  };
}

export async function authenticateApiKey(
  env: Env,
  secret: string,
): Promise<
  | { ok: true; policy_version: string; user_id: string; api_key_id: string; allowed_senders: string[] }
  | { ok: false; reason: "not_found" | "disabled" | "bad_creds" | "invalid_scope" }
> {
  const trimmedSecret = secret.trim();
  if (trimmedSecret.length < 8) {
    return { ok: false, reason: "not_found" };
  }
  const policyVersion = await policyVersionFromD1(env);
  const key = await lookupApiKey(env, trimmedSecret.slice(0, 8), policyVersion);
  if (key === null) {
    return { ok: false, reason: "not_found" };
  }
  if (key.revoked_at !== null || key.user_disabled_at !== null) {
    return { ok: false, reason: "disabled" };
  }
  if (!apiKeyHasScope(key.scopes_json, "send")) {
    return { ok: false, reason: "invalid_scope" };
  }
  const candidateHash = await credentialHash(env, trimmedSecret);
  if (!timingSafeEqualString(candidateHash, key.secret_hash)) {
    return { ok: false, reason: "bad_creds" };
  }

  const allowedSenders = await allowedSendersForApiKey(env, key);
  await updateApiKeyLastUsed(env, key.id);
  return {
    ok: true,
    policy_version: policyVersion,
    user_id: key.user_id,
    api_key_id: key.id,
    allowed_senders: allowedSenders,
  };
}

export async function senderAllowedForCredential(
  env: Env,
  credentialId: string,
  sender: string,
): Promise<{ ok: true; userId: string; allowedSenders: string[] } | { ok: false; reason: "credential_not_found" | "credential_disabled" | "sender_not_allowed" }> {
  const credential = await lookupCredentialById(env, credentialId);
  if (credential === null) {
    return { ok: false, reason: "credential_not_found" };
  }
  if (credential.revoked_at !== null || credential.user_disabled_at !== null) {
    return { ok: false, reason: "credential_disabled" };
  }
  const allowedSenders = await allowedSendersForCredential(env, credential);
  if (!senderAllowed(sender, allowedSenders)) {
    return { ok: false, reason: "sender_not_allowed" };
  }
  return { ok: true, userId: credential.user_id, allowedSenders };
}

export function senderAllowedForApiKey(sender: string, allowedSenders: string[]): boolean {
  return senderAllowed(sender, allowedSenders);
}

export async function bootstrapAdmin(
  env: Env,
  token: string,
  body: { email?: unknown; display_name?: unknown },
): Promise<{ ok: true; user_id: string } | { ok: false; status: 400 | 401 | 409 | 500; error: string }> {
  if (env.BOOTSTRAP_SETUP_TOKEN === undefined || env.BOOTSTRAP_SETUP_TOKEN.length === 0) {
    return { ok: false, status: 500, error: "bootstrap_not_configured" };
  }
  if (!timingSafeEqualString(token, env.BOOTSTRAP_SETUP_TOKEN)) {
    return { ok: false, status: 401, error: "invalid_bootstrap_token" };
  }
  if (typeof body.email !== "string" || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.email)) {
    return { ok: false, status: 400, error: "invalid_email" };
  }
  const existing = await env.D1_MAIN.prepare("SELECT id FROM users LIMIT 1").first<{ id: string }>();
  if (existing !== null) {
    return { ok: false, status: 409, error: "bootstrap_already_completed" };
  }

  const now = nowSeconds();
  const userId = prefixedId("usr");
  await env.D1_MAIN.batch([
    env.D1_MAIN.prepare(
      "INSERT INTO users (id, email, display_name, access_subject, role, disabled_at, created_at, updated_at) VALUES (?, ?, ?, NULL, 'admin', NULL, ?, ?)",
    ).bind(userId, body.email.toLowerCase(), typeof body.display_name === "string" ? body.display_name : null, now, now),
    env.D1_MAIN.prepare("INSERT OR REPLACE INTO settings (key, value_json, updated_at) VALUES ('bootstrap_completed_at', ?, ?)").bind(
      JSON.stringify(now),
      now,
    ),
  ]);
  return { ok: true, user_id: userId };
}

export async function policyVersionFromD1(env: Env): Promise<string> {
  const row = await env.D1_MAIN.prepare("SELECT value_json FROM settings WHERE key = 'policy_version'").first<{ value_json: string }>();
  if (row === null) {
    return "1";
  }
  try {
    const parsed = JSON.parse(row.value_json) as unknown;
    return typeof parsed === "string" || typeof parsed === "number" ? String(parsed) : "1";
  } catch {
    return row.value_json;
  }
}

export async function computeSmtpIdempotencyKey(input: {
  envelopeFrom: string;
  recipients: string[];
  messageIdHeader: string;
  mimeSha256: string;
}): Promise<string> {
  const normalized = [
    "smtp",
    normalizeAddress(input.envelopeFrom),
    [...input.recipients].map(normalizeAddress).sort().join(","),
    input.messageIdHeader.trim(),
    input.mimeSha256.toLowerCase(),
  ].join("\n");
  return sha256Hex(new TextEncoder().encode(normalized));
}

export async function computeHttpIdempotencyKey(input: {
  envelopeFrom: string;
  recipients: string[];
  messageIdHeader: string;
  mimeSha256: string;
}): Promise<string> {
  const normalized = [
    "http",
    normalizeAddress(input.envelopeFrom),
    [...input.recipients].map(normalizeAddress).sort().join(","),
    input.messageIdHeader.trim(),
    input.mimeSha256.toLowerCase(),
  ].join("\n");
  return sha256Hex(new TextEncoder().encode(normalized));
}

export async function beginIdempotentRequest(
  env: Env,
  key: string,
  requestHash: string,
  source: "smtp" | "http" = "smtp",
): Promise<{ status: "new" } | { status: "pending" } | { status: "replay"; response: ReplayResponse }> {
  const cached = await env.KV_HOT.get(`idem:${key}`);
  if (cached !== null) {
    return { status: "replay", response: parseReplayResponse(cached) };
  }

  const now = nowSeconds();
  const result = await env.D1_MAIN.prepare(
    "INSERT OR IGNORE INTO idempotency_keys (idempotency_key, request_hash, source, status, response_json, created_at, updated_at, expires_at) VALUES (?, ?, ?, 'pending', NULL, ?, ?, ?)",
  )
    .bind(key, requestHash, source, now, now, now + idempotencyTtlSeconds)
    .run();
  if (result.meta.changes > 0) {
    return { status: "new" };
  }

  const existing = await env.D1_MAIN.prepare("SELECT status, response_json FROM idempotency_keys WHERE idempotency_key = ?").bind(key).first<IdempotencyRow>();
  if (existing === null || existing.status === "pending" || existing.response_json === null) {
    return { status: "pending" };
  }
  return { status: "replay", response: parseReplayResponse(existing.response_json) };
}

export async function completeIdempotentRequest(env: Env, key: string, success: boolean, response: ReplayResponse): Promise<void> {
  const now = nowSeconds();
  const responseJson = JSON.stringify(response);
  await env.D1_MAIN.prepare("UPDATE idempotency_keys SET status = ?, response_json = ?, updated_at = ? WHERE idempotency_key = ?")
    .bind(success ? "completed" : "failed", responseJson, now, key)
    .run();
  if (success) {
    await env.KV_HOT.put(`idem:${key}`, responseJson, { expirationTtl: idempotencyTtlSeconds });
  }
}

export async function recordSendEvent(env: Env, event: SendEventInput): Promise<void> {
  const now = nowSeconds();
  await env.D1_MAIN.prepare(
    `INSERT INTO send_events (
      id, ts, trace_id, source, user_id, credential_id, api_key_id, domain_id,
      envelope_from, recipient_count, recipient_domains_hash, mime_size_bytes, message_id_hash,
      cf_request_id, cf_ray_id, cf_delivered_json, cf_queued_json, cf_bounced_json,
      status, smtp_code, error_code, cf_error_code
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      prefixedId("evt"),
      now,
      event.traceId,
      event.source,
      event.userId ?? null,
      event.credentialId ?? null,
      event.apiKeyId ?? null,
      event.domainId ?? null,
      event.envelopeFrom,
      event.recipients.length,
      await recipientDomainsHash(env, event.recipients),
      event.mimeSizeBytes,
      event.messageIdHeader.length > 0 ? await hmacSha256Hex(env.METADATA_PEPPER, event.messageIdHeader.trim()) : null,
      event.cfRequestId ?? null,
      event.cfRayId ?? null,
      event.cfDeliveredJson ?? null,
      event.cfQueuedJson ?? null,
      event.cfBouncedJson ?? null,
      event.status,
      event.smtpCode ?? null,
      event.errorCode ?? null,
      event.cfErrorCode ?? null,
    )
    .run();
}

export function extractHeader(mimeMessage: string, headerName: string): string {
  const normalized = mimeMessage.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const headerEnd = normalized.indexOf("\n\n");
  if (headerEnd === -1) {
    return "";
  }
  const target = headerName.toLowerCase();
  const unfolded: string[] = [];
  for (const line of normalized.slice(0, headerEnd).split("\n")) {
    if (/^[ \t]/.test(line) && unfolded.length > 0) {
      unfolded[unfolded.length - 1] += line.replace(/^[ \t]+/, " ");
    } else {
      unfolded.push(line);
    }
  }
  const found = unfolded.find((line) => {
    const separator = line.indexOf(":");
    return separator > 0 && line.slice(0, separator).toLowerCase() === target;
  });
  return found?.slice(found.indexOf(":") + 1).trim() ?? "";
}

export async function credentialHash(env: Env, password: string): Promise<string> {
  return hmacSha256Hex(env.CREDENTIAL_PEPPER, password);
}

async function lookupCredential(env: Env, username: string, policyVersion: string): Promise<CredentialRow | null> {
  const normalizedUsername = username.trim().toLowerCase();
  const cacheKey = `cred:${policyVersion}:${normalizedUsername}`;
  const cached = await env.KV_HOT.get(cacheKey);
  if (cached !== null) {
    return JSON.parse(cached) as CredentialRow;
  }
  const row = await env.D1_MAIN.prepare(
    `SELECT c.id, c.user_id, c.username, c.secret_hash, c.hash_version, c.allowed_sender_ids_json, c.revoked_at, u.disabled_at AS user_disabled_at
       FROM smtp_credentials c
       JOIN users u ON u.id = c.user_id
      WHERE lower(c.username) = ?`,
  )
    .bind(normalizedUsername)
    .first<CredentialRow>();
  if (row !== null) {
    await env.KV_HOT.put(cacheKey, JSON.stringify(row), { expirationTtl: credentialCacheTtlSeconds });
  }
  return row;
}

async function lookupCredentialById(env: Env, credentialId: string): Promise<CredentialRow | null> {
  return env.D1_MAIN.prepare(
    `SELECT c.id, c.user_id, c.username, c.secret_hash, c.hash_version, c.allowed_sender_ids_json, c.revoked_at, u.disabled_at AS user_disabled_at
       FROM smtp_credentials c
       JOIN users u ON u.id = c.user_id
      WHERE c.id = ?`,
  )
    .bind(credentialId)
    .first<CredentialRow>();
}

async function lookupApiKey(env: Env, keyPrefix: string, policyVersion: string): Promise<ApiKeyRow | null> {
  const normalizedPrefix = keyPrefix.trim();
  const cacheKey = `apikey:${policyVersion}:${normalizedPrefix}`;
  const cached = await env.KV_HOT.get(cacheKey);
  if (cached !== null) {
    return JSON.parse(cached) as ApiKeyRow;
  }
  const row = await env.D1_MAIN.prepare(
    `SELECT k.id, k.user_id, k.key_prefix, k.secret_hash, k.hash_version, k.scopes_json, k.allowed_sender_ids_json, k.revoked_at, u.disabled_at AS user_disabled_at
       FROM api_keys k
       JOIN users u ON u.id = k.user_id
      WHERE k.key_prefix = ?`,
  )
    .bind(normalizedPrefix)
    .first<ApiKeyRow>();
  if (row !== null) {
    await env.KV_HOT.put(cacheKey, JSON.stringify(row), { expirationTtl: credentialCacheTtlSeconds });
  }
  return row;
}

async function allowedSendersForCredential(env: Env, credential: CredentialRow): Promise<string[]> {
  const senderIds = parseAllowedSenderIds(credential.allowed_sender_ids_json);
  if (senderIds !== null) {
    if (senderIds.length === 0) {
      return [];
    }
    const placeholders = senderIds.map(() => "?").join(", ");
    const result = await env.D1_MAIN.prepare(
      `SELECT s.id, s.email
         FROM allowlisted_senders s
         JOIN domains d ON d.id = s.domain_id
        WHERE s.id IN (${placeholders})
          AND s.enabled = 1
          AND d.enabled = 1
          AND d.status != 'disabled'`,
    )
      .bind(...senderIds)
      .all<SenderRow>();
    return result.results?.map((row) => row.email) ?? [];
  }

  const result = await env.D1_MAIN.prepare(
    `SELECT s.id, s.email
       FROM allowlisted_senders s
       JOIN domains d ON d.id = s.domain_id
      WHERE s.user_id = ?
        AND s.enabled = 1
        AND d.enabled = 1
        AND d.status != 'disabled'`,
  )
    .bind(credential.user_id)
    .all<SenderRow>();
  return result.results?.map((row) => row.email) ?? [];
}

async function allowedSendersForApiKey(env: Env, key: ApiKeyRow): Promise<string[]> {
  const senderIds = parseAllowedSenderIds(key.allowed_sender_ids_json);
  if (senderIds !== null) {
    if (senderIds.length === 0) {
      return [];
    }
    const placeholders = senderIds.map(() => "?").join(", ");
    const result = await env.D1_MAIN.prepare(
      `SELECT s.id, s.email
         FROM allowlisted_senders s
         JOIN domains d ON d.id = s.domain_id
        WHERE s.id IN (${placeholders})
          AND s.enabled = 1
          AND d.enabled = 1
          AND d.status != 'disabled'`,
    )
      .bind(...senderIds)
      .all<SenderRow>();
    return result.results?.map((row) => row.email) ?? [];
  }

  const result = await env.D1_MAIN.prepare(
    `SELECT s.id, s.email
       FROM allowlisted_senders s
       JOIN domains d ON d.id = s.domain_id
      WHERE s.user_id = ?
        AND s.enabled = 1
        AND d.enabled = 1
        AND d.status != 'disabled'`,
  )
    .bind(key.user_id)
    .all<SenderRow>();
  return result.results?.map((row) => row.email) ?? [];
}

function parseAllowedSenderIds(raw: string | null): string[] | null {
  if (raw === null || raw.trim().length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) && parsed.every((value) => typeof value === "string") ? parsed : null;
  } catch {
    return null;
  }
}

async function recordAuthFailure(env: Env, username: string, reason: AuthFailureReason, remoteIp: string | undefined): Promise<void> {
  await env.D1_MAIN.prepare("INSERT INTO auth_failures (id, ts, source, remote_ip_hash, attempted_username, reason) VALUES (?, ?, 'smtp', ?, ?, ?)")
    .bind(prefixedId("authfail"), nowSeconds(), remoteIp === undefined ? null : await hmacSha256Hex(env.METADATA_PEPPER, remoteIp), username, reason)
    .run();
}

async function updateCredentialLastUsed(env: Env, credentialId: string, remoteIp: string | undefined): Promise<void> {
  await env.D1_MAIN.prepare("UPDATE smtp_credentials SET last_used_at = ?, last_used_ip_hash = ? WHERE id = ?")
    .bind(nowSeconds(), remoteIp === undefined ? null : await hmacSha256Hex(env.METADATA_PEPPER, remoteIp), credentialId)
    .run();
}

async function updateApiKeyLastUsed(env: Env, apiKeyId: string): Promise<void> {
  await env.D1_MAIN.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").bind(nowSeconds(), apiKeyId).run();
}

function apiKeyHasScope(rawScopes: string | null, expected: string): boolean {
  if (rawScopes === null || rawScopes.trim().length === 0) {
    return true;
  }
  try {
    const parsed = JSON.parse(rawScopes) as unknown;
    return Array.isArray(parsed) && parsed.includes(expected);
  } catch {
    return false;
  }
}

async function recipientDomainsHash(env: Env, recipients: string[]): Promise<string> {
  const domains = [...new Set(recipients.map((recipient) => normalizeAddress(recipient).split("@").at(-1) ?? "").filter(Boolean))].sort();
  return hmacSha256Hex(env.METADATA_PEPPER, domains.join(","));
}

function senderAllowed(sender: string, allowed: string[]): boolean {
  const normalizedSender = normalizeAddress(sender);
  return allowed.some((entry) => {
    const normalizedEntry = normalizeAddress(entry);
    if (normalizedEntry === normalizedSender) {
      return true;
    }
    return normalizedEntry.startsWith("*@") && normalizedSender.endsWith(normalizedEntry.slice(1));
  });
}

function normalizeAddress(value: string): string {
  return value.toLowerCase().replace(/^<|>$/g, "").trim();
}

function parseReplayResponse(raw: string): ReplayResponse {
  const parsed = JSON.parse(raw) as ReplayResponse;
  return { ...parsed, status: parsed.status ?? (parsed.ok ? 200 : 502) };
}

function prefixedId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
