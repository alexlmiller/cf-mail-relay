import { afterEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { verifyAccessJwt } from "../src/access";

function makeKv(): KVNamespace {
  return {
    get: vi.fn(async () => null),
    put: vi.fn(async () => undefined),
  } as unknown as KVNamespace;
}

function makeD1(sub: string): D1Database {
  return {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        first: async () => {
          if (sql.includes("WHERE access_subject = ?") && args[0] === sub) {
            return {
              id: "usr_1",
              email: "alex@example.net",
              display_name: "Alex",
              access_subject: sub,
              role: "admin",
              disabled_at: null,
            };
          }
          return null;
        },
        run: async () => ({ meta: { changes: 1 } }),
      }),
      first: async () => null,
      run: async () => ({ meta: { changes: 1 } }),
    }),
  } as unknown as D1Database;
}

async function makeJwtFixture(kid: string = "test-key") {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  publicJwk.kid = kid;
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";

  const sign = async (claims: Record<string, unknown>) => {
    const header = base64Url(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }));
    const payload = base64Url(JSON.stringify(claims));
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      keyPair.privateKey,
      new TextEncoder().encode(`${header}.${payload}`),
    );
    return `${header}.${payload}.${base64Url(new Uint8Array(signature))}`;
  };

  return { jwks: JSON.stringify({ keys: [publicJwk] }), sign };
}

function makeEnv(jwks: string): Record<string, unknown> {
  return {
    D1_MAIN: makeD1("access-subject"),
    KV_HOT: makeKv(),
    ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
    ACCESS_AUDIENCE: "aud-123",
    ACCESS_JWKS_JSON: jwks,
    CF_ACCOUNT_ID: "account",
    CF_API_TOKEN: "token",
    CREDENTIAL_PEPPER: "credential-pepper",
    METADATA_PEPPER: "metadata-pepper",
    RELAY_HMAC_SECRET_CURRENT: "relay-secret",
  };
}

describe("Cloudflare Access JWT validation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("accepts a signed JWT with the configured audience", async () => {
    const fixture = await makeJwtFixture();
    const token = await fixture.sign({
      sub: "access-subject",
      aud: "aud-123",
      iss: "https://team.cloudflareaccess.com",
      type: "app",
      exp: Math.floor(Date.now() / 1000) + 300,
      email: "alex@example.net",
    });

    await expect(verifyAccessJwt(token, makeEnv(fixture.jwks) as never)).resolves.toMatchObject({
      ok: true,
      claims: { sub: "access-subject" },
    });
  });

  it("rejects a bad audience", async () => {
    const fixture = await makeJwtFixture();
    const token = await fixture.sign({
      sub: "access-subject",
      aud: "wrong-aud",
      iss: "https://team.cloudflareaccess.com",
      type: "app",
      exp: Math.floor(Date.now() / 1000) + 300,
    });

    await expect(verifyAccessJwt(token, makeEnv(fixture.jwks) as never)).resolves.toMatchObject({
      ok: false,
      error: "invalid_access_jwt_audience",
    });
  });

  it("rejects an expired token", async () => {
    const fixture = await makeJwtFixture();
    const token = await fixture.sign({
      sub: "access-subject",
      aud: "aud-123",
      iss: "https://team.cloudflareaccess.com",
      type: "app",
      exp: Math.floor(Date.now() / 1000) - 1,
    });

    await expect(verifyAccessJwt(token, makeEnv(fixture.jwks) as never)).resolves.toMatchObject({
      ok: false,
      error: "expired_access_jwt",
    });
  });

  it("rejects tokens without Cloudflare Access issuer and app type", async () => {
    const fixture = await makeJwtFixture();
    const token = await fixture.sign({
      sub: "access-subject",
      aud: "aud-123",
      exp: Math.floor(Date.now() / 1000) + 300,
    });

    await expect(verifyAccessJwt(token, makeEnv(fixture.jwks) as never)).resolves.toMatchObject({
      ok: false,
      error: "invalid_access_jwt_type",
    });
  });

  it("refreshes a cached JWKS once when Access rotates to an unknown kid", async () => {
    const stale = await makeJwtFixture("old-key");
    const rotated = await makeJwtFixture("rotated-key");
    const token = await rotated.sign({
      sub: "access-subject",
      aud: "aud-123",
      iss: "https://team.cloudflareaccess.com",
      type: "app",
      exp: Math.floor(Date.now() / 1000) + 300,
    });
    const kv = {
      get: vi.fn(async () => stale.jwks),
      put: vi.fn(async () => undefined),
    } as unknown as KVNamespace;
    const env = makeEnv(stale.jwks);
    delete env.ACCESS_JWKS_JSON;
    env.KV_HOT = kv;
    const accessFetch = vi.fn(async () => new Response(rotated.jwks, { status: 200 }));
    vi.stubGlobal("fetch", accessFetch);

    await expect(verifyAccessJwt(token, env as never)).resolves.toMatchObject({ ok: true });
    expect(accessFetch).toHaveBeenCalledOnce();
    expect(kv.put).toHaveBeenCalledWith(
      "access:jwks:team.cloudflareaccess.com",
      rotated.jwks,
      { expirationTtl: 3600 },
    );
  });

  it("does not fetch a network JWKS twice when its kid is unknown", async () => {
    const available = await makeJwtFixture("available-key");
    const unknown = await makeJwtFixture("unknown-key");
    const token = await unknown.sign(validClaims());
    const env = makeEnv(available.jwks);
    delete env.ACCESS_JWKS_JSON;
    const accessFetch = vi.fn(async () => new Response(available.jwks, { status: 200 }));
    vi.stubGlobal("fetch", accessFetch);

    await expect(verifyAccessJwt(token, env as never)).resolves.toMatchObject({
      ok: false,
      status: 401,
      error: "unknown_access_jwt_key",
    });
    expect(accessFetch).toHaveBeenCalledOnce();
  });

  it("treats ACCESS_JWKS_JSON as authoritative during a kid miss", async () => {
    const configured = await makeJwtFixture("configured-key");
    const rotated = await makeJwtFixture("rotated-key");
    const token = await rotated.sign({
      sub: "access-subject",
      aud: "aud-123",
      iss: "https://team.cloudflareaccess.com",
      type: "app",
      exp: Math.floor(Date.now() / 1000) + 300,
    });
    const accessFetch = vi.fn();
    vi.stubGlobal("fetch", accessFetch);

    await expect(verifyAccessJwt(token, makeEnv(configured.jwks) as never)).resolves.toMatchObject({
      ok: false,
      status: 401,
      error: "unknown_access_jwt_key",
    });
    expect(accessFetch).not.toHaveBeenCalled();
  });

  it("rejects malformed JWKS configuration as unavailable instead of trusting its shape", async () => {
    const fixture = await makeJwtFixture();
    const token = await fixture.sign(validClaims());

    await expect(verifyAccessJwt(token, makeEnv(JSON.stringify({ keys: [{}] })) as never)).resolves.toMatchObject({
      ok: false,
      status: 503,
      error: "access_unavailable",
    });
  });

  it("fails closed with a structured 503 when the JWKS fetch is unavailable", async () => {
    const fixture = await makeJwtFixture();
    const token = await fixture.sign(validClaims());
    const env = makeEnv(fixture.jwks);
    delete env.ACCESS_JWKS_JSON;
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("backend secret should not reach the response");
    }));

    const response = await app.request("/admin/api/session", { headers: { "cf-access-jwt-assertion": token } }, env);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, error: "access_unavailable" });
  });

  it("fails closed with a structured 503 when the Access JWKS cache is unavailable", async () => {
    const fixture = await makeJwtFixture();
    const token = await fixture.sign(validClaims());
    const env = makeEnv(fixture.jwks);
    delete env.ACCESS_JWKS_JSON;
    env.KV_HOT = {
      get: vi.fn(async () => {
        throw new Error("kv internal detail");
      }),
      put: vi.fn(async () => undefined),
    } as unknown as KVNamespace;
    const accessFetch = vi.fn();
    vi.stubGlobal("fetch", accessFetch);

    const response = await app.request("/self/api/session", { headers: { "cf-access-jwt-assertion": token } }, env);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, error: "access_unavailable" });
    expect(accessFetch).not.toHaveBeenCalled();
  });

  it("fails closed with a structured 503 when the authorized-user lookup is unavailable", async () => {
    const fixture = await makeJwtFixture();
    const token = await fixture.sign(validClaims());
    const env = makeEnv(fixture.jwks);
    env.D1_MAIN = {
      prepare: () => ({
        bind: () => ({ first: async () => { throw new Error("d1 internal detail"); } }),
      }),
    } as unknown as D1Database;

    const response = await app.request("/admin/api/session", { headers: { "cf-access-jwt-assertion": token } }, env);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, error: "access_unavailable" });
  });

  it("sanitizes D1 and provider failures from authenticated admin endpoints", async () => {
    const fixture = await makeJwtFixture();
    const token = await fixture.sign(validClaims());
    const d1FailureEnv = makeEnv(fixture.jwks);
    const authD1 = makeD1("access-subject");
    d1FailureEnv.D1_MAIN = {
      prepare(sql: string) {
        if (sql.includes("WHERE access_subject = ?")) return authD1.prepare(sql);
        return { all: async () => { throw new Error("sensitive d1 detail"); } };
      },
    } as unknown as D1Database;

    const d1Response = await app.request("/admin/api/users", { headers: { "cf-access-jwt-assertion": token } }, d1FailureEnv);
    expect(d1Response.status).toBe(503);
    expect(await d1Response.json()).toEqual({ ok: false, error: "service_unavailable" });

    const providerEnv = makeEnv(fixture.jwks);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("provider secret detail"); }));
    const providerResponse = await app.request(
      "/admin/api/domains",
      {
        method: "POST",
        headers: { "cf-access-jwt-assertion": token, "content-type": "application/json" },
        body: JSON.stringify({ domain: "example.com" }),
      },
      providerEnv,
    );
    expect(providerResponse.status).toBe(503);
    expect(await providerResponse.json()).toEqual({ ok: false, error: "service_unavailable" });
  });

  it("bounds admin and self JSON request bodies while preserving validation errors", async () => {
    const fixture = await makeJwtFixture();
    const token = await fixture.sign(validClaims());
    const headers = { "cf-access-jwt-assertion": token, "content-type": "application/json" };
    const oversized = JSON.stringify({ name: "x".repeat(64 * 1024), username: "gmail-relay" });

    const tooLarge = await app.request("/self/api/smtp-credentials", { method: "POST", headers, body: oversized }, makeEnv(fixture.jwks));
    expect(tooLarge.status).toBe(413);
    expect(await tooLarge.json()).toEqual({ ok: false, error: "request_body_too_large" });

    const invalid = await app.request("/admin/api/users", { method: "POST", headers, body: "{" }, makeEnv(fixture.jwks));
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ ok: false, error: "invalid_json" });
  });

  it("preserves structured 404 responses for missing self-service resources", async () => {
    const fixture = await makeJwtFixture();
    const token = await fixture.sign(validClaims());
    const env = makeEnv(fixture.jwks);
    const authD1 = makeD1("access-subject");
    env.D1_MAIN = {
      prepare(sql: string) {
        if (sql.includes("WHERE access_subject = ?")) return authD1.prepare(sql);
        return {
          bind: () => ({ run: async () => ({ meta: { changes: 0 } }) }),
        };
      },
    } as unknown as D1Database;

    const response = await app.request(
      "/self/api/smtp-credentials/cred_missing/revoke",
      { method: "POST", headers: { "cf-access-jwt-assertion": token } },
      env,
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ ok: false, error: "credential_not_found" });
  });

  it("serves admin session for an authorized admin", async () => {
    const fixture = await makeJwtFixture();
    const token = await fixture.sign({
      sub: "access-subject",
      aud: "aud-123",
      iss: "https://team.cloudflareaccess.com",
      type: "app",
      exp: Math.floor(Date.now() / 1000) + 300,
      email: "alex@example.net",
    });

    const response = await app.request(
      "/admin/api/session",
      { headers: { "cf-access-jwt-assertion": token } },
      makeEnv(fixture.jwks),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, user: { id: "usr_1", role: "admin" } });
  });

  it("redirects authenticated Access login bounces back to the UI", async () => {
    const fixture = await makeJwtFixture();
    const token = await fixture.sign({
      sub: "access-subject",
      aud: "aud-123",
      iss: "https://team.cloudflareaccess.com",
      type: "app",
      exp: Math.floor(Date.now() / 1000) + 300,
      email: "alex@example.net",
    });

    const response = await app.request(
      "/self/api/login?return_to=%2F%23%2Fcredentials",
      { headers: { "cf-access-jwt-assertion": token }, redirect: "manual" },
      makeEnv(fixture.jwks),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/#/credentials");
  });

  it.each([
    "https%3A%2F%2Fevil.example",
    "%2F%2Fevil.example",
    "%2F%5Cevil.example",
    "%2F%250d%250aSet-Cookie%3A%2520x%3Dy",
  ])("does not allow login bounce open redirects for %s", async (returnTo) => {
    const fixture = await makeJwtFixture();
    const token = await fixture.sign({
      sub: "access-subject",
      aud: "aud-123",
      iss: "https://team.cloudflareaccess.com",
      type: "app",
      exp: Math.floor(Date.now() / 1000) + 300,
      email: "alex@example.net",
    });

    const response = await app.request(
      `/self/api/login?return_to=${returnTo}`,
      { headers: { "cf-access-jwt-assertion": token }, redirect: "manual" },
      makeEnv(fixture.jwks),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/");
  });
});

function validClaims(): Record<string, unknown> {
  return {
    sub: "access-subject",
    aud: "aud-123",
    iss: "https://team.cloudflareaccess.com",
    type: "app",
    exp: Math.floor(Date.now() / 1000) + 300,
    email: "alex@example.net",
  };
}

function base64Url(value: string | Uint8Array): string {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
