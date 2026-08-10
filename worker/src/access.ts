import type { Env } from "./index";

export interface AccessClaims {
  sub: string;
  aud: string | string[];
  exp: number;
  nbf?: number;
  iss?: string;
  type?: string;
  email?: string;
  name?: string;
}

export interface AdminUser {
  id: string;
  email: string;
  display_name: string | null;
  access_subject: string | null;
  role: "admin" | "sender";
}

interface JwtHeader {
  alg?: string;
  kid?: string;
  typ?: string;
}

interface Jwks {
  keys: Array<JsonWebKey & { kid?: string }>;
}

interface LoadedJwks {
  jwks: Jwks;
  source: "override" | "cache" | "network";
}

type AccessFailure = { ok: false; status: 401 | 403 | 503; error: string };
const maxJwksBodyBytes = 64 * 1024;

export async function requireAdmin(request: Request, env: Env): Promise<{ ok: true; claims: AccessClaims; user: AdminUser } | AccessFailure> {
  const result = await requireAuthenticated(request, env);
  if (!result.ok) return result;
  if (result.user.role !== "admin") {
    return { ok: false, status: 403, error: "admin_not_allowed" };
  }
  return result;
}

export async function requireAuthenticated(request: Request, env: Env): Promise<{ ok: true; claims: AccessClaims; user: AdminUser } | AccessFailure> {
  const token = request.headers.get("cf-access-jwt-assertion") ?? "";
  if (token.length === 0) {
    return { ok: false, status: 401, error: "missing_access_jwt" };
  }

  let verified: Awaited<ReturnType<typeof verifyAccessJwt>>;
  try {
    verified = await verifyAccessJwt(token, env);
  } catch (error) {
    logAccessAvailabilityFailure("access_verification_failed", error);
    return { ok: false, status: 503, error: "access_unavailable" };
  }
  if (!verified.ok) {
    return verified;
  }

  let user: (AdminUser & { disabled_at: number | null }) | null;
  try {
    user = await resolveAccessUser(env, verified.claims);
  } catch (error) {
    logAccessAvailabilityFailure("access_user_lookup_failed", error);
    return { ok: false, status: 503, error: "access_unavailable" };
  }
  if (user === null) {
    return { ok: false, status: 403, error: "user_not_provisioned" };
  }
  if (user.disabled_at !== null) {
    return { ok: false, status: 403, error: "user_disabled" };
  }

  return {
    ok: true,
    claims: verified.claims,
    user: {
      id: user.id,
      email: user.email,
      display_name: user.display_name,
      access_subject: user.access_subject,
      role: user.role,
    },
  };
}

export async function verifyAccessJwt(token: string, env: Env): Promise<{ ok: true; claims: AccessClaims } | { ok: false; status: 401 | 503; error: string }> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return { ok: false, status: 401, error: "invalid_access_jwt_shape" };
  }

  let header: JwtHeader;
  let claims: AccessClaims;
  const [encodedHeader, encodedClaims, encodedSignature] = parts as [string, string, string];
  try {
    header = JSON.parse(base64UrlDecodeToString(encodedHeader)) as JwtHeader;
    claims = JSON.parse(base64UrlDecodeToString(encodedClaims)) as AccessClaims;
  } catch {
    return { ok: false, status: 401, error: "invalid_access_jwt_json" };
  }

  if (header.alg !== "RS256" || typeof header.kid !== "string") {
    return { ok: false, status: 401, error: "unsupported_access_jwt_alg" };
  }
  if (typeof claims.sub !== "string" || typeof claims.exp !== "number") {
    return { ok: false, status: 401, error: "invalid_access_jwt_claims" };
  }
  if (claims.type !== "app") {
    return { ok: false, status: 401, error: "invalid_access_jwt_type" };
  }
  if (!audienceMatches(claims.aud, env.ACCESS_AUDIENCE)) {
    return { ok: false, status: 401, error: "invalid_access_jwt_audience" };
  }
  const now = Math.floor(Date.now() / 1000);
  if (claims.exp <= now || (typeof claims.nbf === "number" && claims.nbf > now + 60)) {
    return { ok: false, status: 401, error: "expired_access_jwt" };
  }
  if (claims.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) {
    return { ok: false, status: 401, error: "invalid_access_jwt_issuer" };
  }

  let loaded: LoadedJwks;
  try {
    loaded = await loadJwks(env);
  } catch (error) {
    logAccessAvailabilityFailure("access_jwks_load_failed", error);
    return { ok: false, status: 503, error: "access_unavailable" };
  }

  let jwk = loaded.jwks.keys.find((key) => key.kid === header.kid);
  if (jwk === undefined && loaded.source === "cache") {
    try {
      loaded = await loadJwks(env, true);
      jwk = loaded.jwks.keys.find((key) => key.kid === header.kid);
    } catch (error) {
      logAccessAvailabilityFailure("access_jwks_refresh_failed", error);
      return { ok: false, status: 503, error: "access_unavailable" };
    }
  }
  if (jwk === undefined) {
    return { ok: false, status: 401, error: "unknown_access_jwt_key" };
  }

  let signature: Uint8Array;
  try {
    signature = base64UrlDecode(encodedSignature);
  } catch {
    return { ok: false, status: 401, error: "invalid_access_jwt_signature" };
  }

  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  } catch (error) {
    logAccessAvailabilityFailure("access_jwks_key_import_failed", error);
    return { ok: false, status: 503, error: "access_unavailable" };
  }
  let verified: boolean;
  try {
    verified = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, new TextEncoder().encode(`${encodedHeader}.${encodedClaims}`));
  } catch {
    return { ok: false, status: 401, error: "invalid_access_jwt_signature" };
  }
  if (!verified) {
    return { ok: false, status: 401, error: "invalid_access_jwt_signature" };
  }

  return { ok: true, claims };
}

async function resolveAccessUser(env: Env, claims: AccessClaims): Promise<(AdminUser & { disabled_at: number | null }) | null> {
  const bySubject = await env.D1_MAIN.prepare(
    "SELECT id, email, display_name, access_subject, role, disabled_at FROM users WHERE access_subject = ?",
  )
    .bind(claims.sub)
    .first<AdminUser & { disabled_at: number | null }>();
  if (bySubject !== null) {
    return bySubject;
  }

  if (typeof claims.email !== "string") {
    return null;
  }
  const byEmail = await env.D1_MAIN.prepare(
    "SELECT id, email, display_name, access_subject, role, disabled_at FROM users WHERE lower(email) = ?",
  )
    .bind(claims.email.toLowerCase())
    .first<AdminUser & { disabled_at: number | null }>();
  if (byEmail === null || byEmail.access_subject !== null) {
    return null;
  }
  await env.D1_MAIN.prepare("UPDATE users SET access_subject = ?, updated_at = ? WHERE id = ?").bind(claims.sub, nowSeconds(), byEmail.id).run();
  return { ...byEmail, access_subject: claims.sub };
}

async function loadJwks(env: Env, bypassCache: boolean = false): Promise<LoadedJwks> {
  if (env.ACCESS_JWKS_JSON !== undefined && env.ACCESS_JWKS_JSON.length > 0) {
    return { jwks: parseJwks(env.ACCESS_JWKS_JSON), source: "override" };
  }

  const cacheKey = `access:jwks:${env.ACCESS_TEAM_DOMAIN}`;
  if (!bypassCache) {
    const cached = await env.KV_HOT.get(cacheKey);
    if (cached !== null) {
      try {
        return { jwks: parseJwks(cached), source: "cache" };
      } catch {
        // A corrupt or obsolete cache entry should not lock out valid tokens;
        // fetch the authoritative Access key set once below.
      }
    }
  }

  const response = await fetch(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`);
  if (!response.ok) {
    throw new Error("access_jwks_fetch_failed");
  }
  const body = await readTextBounded(response.body, maxJwksBodyBytes);
  if (body === null) {
    throw new Error("access_jwks_response_too_large");
  }
  const jwks = parseJwks(body);
  await env.KV_HOT.put(cacheKey, JSON.stringify(jwks), { expirationTtl: 3600 });
  return { jwks, source: "network" };
}

function parseJwks(raw: string): Jwks {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("invalid_access_jwks");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("invalid_access_jwks");
  }
  const keys = (parsed as { keys?: unknown }).keys;
  if (!Array.isArray(keys) || keys.length === 0 || !keys.every(isAccessJwk)) {
    throw new Error("invalid_access_jwks");
  }
  return { keys };
}

function isAccessJwk(value: unknown): value is JsonWebKey & { kid: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const key = value as { kid?: unknown; kty?: unknown; n?: unknown; e?: unknown };
  return key.kty === "RSA" &&
    typeof key.kid === "string" &&
    key.kid.length > 0 &&
    typeof key.n === "string" &&
    key.n.length > 0 &&
    typeof key.e === "string" &&
    key.e.length > 0;
}

async function readTextBounded(stream: ReadableStream<Uint8Array> | null, limit: number): Promise<string | null> {
  if (stream === null) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        try {
          await reader.cancel();
        } catch {
          // The size decision is final even if cancellation fails.
        }
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function logAccessAvailabilityFailure(event: string, error: unknown): void {
  console.error(JSON.stringify({ event, error: error instanceof Error ? error.message : "unknown" }));
}

function audienceMatches(aud: string | string[], expected: string): boolean {
  return Array.isArray(aud) ? aud.includes(expected) : aud === expected;
}

function base64UrlDecodeToString(value: string): string {
  return new TextDecoder().decode(base64UrlDecode(value));
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.padEnd(value.length + ((4 - (value.length % 4)) % 4), "=").replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
