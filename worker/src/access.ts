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

export async function requireAdmin(request: Request, env: Env): Promise<{ ok: true; claims: AccessClaims; user: AdminUser } | { ok: false; status: 401 | 403; error: string }> {
  const result = await requireAuthenticated(request, env);
  if (!result.ok) return result;
  if (result.user.role !== "admin") {
    return { ok: false, status: 403, error: "admin_not_allowed" };
  }
  return result;
}

export async function requireAuthenticated(request: Request, env: Env): Promise<{ ok: true; claims: AccessClaims; user: AdminUser } | { ok: false; status: 401 | 403; error: string }> {
  const token = request.headers.get("cf-access-jwt-assertion") ?? "";
  if (token.length === 0) {
    return { ok: false, status: 401, error: "missing_access_jwt" };
  }

  const verified = await verifyAccessJwt(token, env);
  if (!verified.ok) {
    return verified;
  }

  const user = await resolveAccessUser(env, verified.claims);
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

export async function verifyAccessJwt(token: string, env: Env): Promise<{ ok: true; claims: AccessClaims } | { ok: false; status: 401; error: string }> {
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

  const jwks = await loadJwks(env);
  const jwk = jwks.keys.find((key) => key.kid === header.kid);
  if (jwk === undefined) {
    return { ok: false, status: 401, error: "unknown_access_jwt_key" };
  }

  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const verified = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    base64UrlDecode(encodedSignature),
    new TextEncoder().encode(`${encodedHeader}.${encodedClaims}`),
  );
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

async function loadJwks(env: Env): Promise<Jwks> {
  if (env.ACCESS_JWKS_JSON !== undefined && env.ACCESS_JWKS_JSON.length > 0) {
    return JSON.parse(env.ACCESS_JWKS_JSON) as Jwks;
  }

  const cacheKey = `access:jwks:${env.ACCESS_TEAM_DOMAIN}`;
  const cached = await env.KV_HOT.get(cacheKey);
  if (cached !== null) {
    return JSON.parse(cached) as Jwks;
  }

  const response = await fetch(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`);
  if (!response.ok) {
    throw new Error("access_jwks_fetch_failed");
  }
  const jwks = (await response.json()) as Jwks;
  await env.KV_HOT.put(cacheKey, JSON.stringify(jwks), { expirationTtl: 3600 });
  return jwks;
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
