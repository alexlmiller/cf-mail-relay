import { describe, expect, it, vi } from "vitest";
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

async function makeJwtFixture() {
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
  publicJwk.kid = "test-key";
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";

  const sign = async (claims: Record<string, unknown>) => {
    const header = base64Url(JSON.stringify({ alg: "RS256", kid: "test-key", typ: "JWT" }));
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
  it("accepts a signed JWT with the configured audience", async () => {
    const fixture = await makeJwtFixture();
    const token = await fixture.sign({
      sub: "access-subject",
      aud: "aud-123",
      iss: "https://team.cloudflareaccess.com",
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
      exp: Math.floor(Date.now() / 1000) - 1,
    });

    await expect(verifyAccessJwt(token, makeEnv(fixture.jwks) as never)).resolves.toMatchObject({
      ok: false,
      error: "expired_access_jwt",
    });
  });

  it("serves admin session for an authorized admin", async () => {
    const fixture = await makeJwtFixture();
    const token = await fixture.sign({
      sub: "access-subject",
      aud: "aud-123",
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
});

function base64Url(value: string | Uint8Array): string {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
