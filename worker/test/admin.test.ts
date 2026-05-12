import { afterEach, describe, expect, it, vi } from "vitest";
import { checkCloudflareApiHealth, createApiKey, createUser, dashboard, revokeApiKey } from "../src/admin";
import type { Env } from "../src/index";

function makeD1(): D1Database {
  const makeStatement = (sql: string) => ({
    bind: () => makeStatement(sql),
    first: async () => {
      if (sql.includes("FROM send_events") && sql.includes("COUNT(*) AS total")) {
        return { total: 3, accepted: 2, failed: 1 };
      }
      if (sql.includes("FROM auth_failures")) {
        return { total: 4 };
      }
      if (sql.includes("FROM send_events") && sql.includes("ORDER BY ts DESC")) {
        return { ts: 1778516772, status: "cf_error", envelope_from: "gmail@alexmiller.net", error_code: "cloudflare_send_raw_rejected" };
      }
      if (sql.includes("FROM users")) {
        return { total: 1 };
      }
      if (sql.includes("FROM domains")) {
        return { total: 1 };
      }
      if (sql.includes("FROM allowlisted_senders")) {
        return { total: 2 };
      }
      if (sql.includes("FROM smtp_credentials")) {
        return { total: 3 };
      }
      return null;
    },
    all: async () => ({ results: [] }),
    run: async () => ({ meta: { changes: 1 } }),
  });

  return {
    prepare: (sql: string) => makeStatement(sql),
  } as unknown as D1Database;
}

function makeEnv(): Env {
  return {
    D1_MAIN: makeD1(),
    KV_HOT: {} as KVNamespace,
    CF_ACCOUNT_ID: "account",
    CF_API_TOKEN: "token",
    CREDENTIAL_PEPPER: "credential-pepper",
    METADATA_PEPPER: "metadata-pepper",
    RELAY_HMAC_SECRET_CURRENT: "relay-secret",
    ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
    ACCESS_AUDIENCE: "aud-123",
    REQUIRED_D1_SCHEMA_VERSION: "1",
  };
}

describe("admin dashboard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("checks Cloudflare API token health without exposing token details", async () => {
    const cfFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({
        authorization: "Bearer token",
        accept: "application/json",
      });
      return new Response(JSON.stringify({ success: true, errors: [], messages: [], result: { status: "active" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", cfFetch);

    await expect(checkCloudflareApiHealth(makeEnv())).resolves.toMatchObject({
      ok: true,
      status: 200,
      error_code: null,
      checked_at: expect.any(Number),
    });
    expect(cfFetch).toHaveBeenCalledWith("https://api.cloudflare.com/client/v4/user/tokens/verify", expect.any(Object));
  });

  it("returns the first Cloudflare API error code when token verification fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: "Authentication error" }], messages: [] }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(checkCloudflareApiHealth(makeEnv())).resolves.toMatchObject({
      ok: false,
      status: 403,
      error_code: "10000",
    });
  });

  it("keeps dashboard loading when Cloudflare API health fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network unavailable");
      }),
    );

    await expect(dashboard(makeEnv())).resolves.toMatchObject({
      sends_24h: { total: 3, accepted: 2, failed: 1 },
      auth_failures_24h: 4,
      resource_counts: {
        users: 1,
        domains: 1,
        senders: 2,
        smtp_credentials: 3,
      },
      cf_api_health: {
        ok: false,
        status: null,
        error_code: "fetch_failed",
        checked_at: expect.any(Number),
      },
    });
  });

  it("creates and revokes HTTP API keys without returning stored hashes", async () => {
    const created = await createApiKey(makeEnv(), { user_id: "usr_1", name: "Automation" });

    expect(created.id).toMatch(/^key_/);
    expect(created.secret).toHaveLength(43);
    expect(created.key_prefix).toBe(created.secret.slice(0, 8));
    expect(created).not.toHaveProperty("secret_hash");

    await expect(revokeApiKey(makeEnv(), created.id)).resolves.toBeUndefined();
  });

  it("rejects missing user role instead of defaulting to admin", async () => {
    await expect(createUser(makeEnv(), { email: "next@example.net" })).rejects.toThrow("invalid_role");
  });
});
