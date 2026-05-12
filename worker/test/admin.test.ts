import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkCloudflareApiHealth,
  createApiKey,
  createUser,
  dashboard,
  deleteSender,
  revokeApiKey,
  updateApiKey,
  updateDomain,
  updateSender,
  updateSmtpCredential,
  updateUser,
} from "../src/admin";
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

// ───────────────────────── PATCH/DELETE ─────────────────────────

interface Capture {
  inserts: Array<{ sql: string; params: unknown[] }>;
  updates: Array<{ sql: string; params: unknown[] }>;
  deletes: Array<{ sql: string; params: unknown[] }>;
}

function makeRecordingD1(changes: number = 1): { db: D1Database; capture: Capture } {
  const capture: Capture = { inserts: [], updates: [], deletes: [] };
  const makeStatement = (sql: string) => {
    const statement = {
      bound: [] as unknown[],
      bind(...params: unknown[]) {
        this.bound = params;
        return this;
      },
      async first() {
        return null;
      },
      async all() {
        return { results: [] };
      },
      async run() {
        const upper = sql.trim().toUpperCase();
        if (upper.startsWith("UPDATE")) capture.updates.push({ sql, params: this.bound });
        else if (upper.startsWith("DELETE")) capture.deletes.push({ sql, params: this.bound });
        else if (upper.startsWith("INSERT")) capture.inserts.push({ sql, params: this.bound });
        return { meta: { changes } };
      },
    };
    return statement;
  };
  const db = { prepare: (sql: string) => makeStatement(sql) } as unknown as D1Database;
  return { db, capture };
}

function envWith(d1: D1Database): Env {
  return {
    D1_MAIN: d1,
    KV_HOT: {} as KVNamespace,
    CF_ACCOUNT_ID: "account",
    CF_API_TOKEN: "token",
    CREDENTIAL_PEPPER: "credential-pepper",
    METADATA_PEPPER: "metadata-pepper",
    RELAY_HMAC_SECRET_CURRENT: "relay-secret",
    ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
    ACCESS_AUDIENCE: "aud-123",
    REQUIRED_D1_SCHEMA_VERSION: "3",
  };
}

describe("admin PATCH/DELETE endpoints", () => {
  it("updates a user's display name and role (sparse PATCH)", async () => {
    const { db, capture } = makeRecordingD1();
    await updateUser(envWith(db), "usr_1", { display_name: "Alex", role: "admin" });
    const userUpdate = capture.updates.find((u) => u.sql.includes("UPDATE users"));
    expect(userUpdate?.sql).toMatch(/display_name = \?/);
    expect(userUpdate?.sql).toMatch(/role = \?/);
    expect(userUpdate?.params.slice(0, 2)).toEqual(["Alex", "admin"]);
  });

  it("disables a user with disabled_at='now'", async () => {
    const { db, capture } = makeRecordingD1();
    await updateUser(envWith(db), "usr_1", { disabled_at: "now" });
    const userUpdate = capture.updates.find((u) => u.sql.includes("UPDATE users"));
    expect(userUpdate?.sql).toMatch(/disabled_at = \?/);
    expect(typeof userUpdate?.params[0]).toBe("number");
  });

  it("clears disabled_at when null is passed", async () => {
    const { db, capture } = makeRecordingD1();
    await updateUser(envWith(db), "usr_1", { disabled_at: null });
    const userUpdate = capture.updates.find((u) => u.sql.includes("UPDATE users"));
    expect(userUpdate?.sql).toMatch(/disabled_at = NULL/);
  });

  it("rejects an unrecognised role on PATCH", async () => {
    const { db } = makeRecordingD1();
    await expect(updateUser(envWith(db), "usr_1", { role: "superuser" })).rejects.toThrow("invalid_role");
  });

  it("rejects an empty body with no_fields_to_update", async () => {
    const { db } = makeRecordingD1();
    await expect(updateUser(envWith(db), "usr_1", {})).rejects.toThrow("no_fields_to_update");
  });

  it("returns user_not_found when the row is missing", async () => {
    const { db } = makeRecordingD1(0);
    await expect(updateUser(envWith(db), "usr_missing", { display_name: "x" })).rejects.toThrow("user_not_found");
  });

  it("disables a domain via enabled=false", async () => {
    const { db, capture } = makeRecordingD1();
    await updateDomain(envWith(db), "dom_1", { enabled: false });
    const dom = capture.updates.find((u) => u.sql.includes("UPDATE domains"));
    expect(dom?.params[0]).toBe(0);
  });

  it("disables a sender via enabled=false", async () => {
    const { db, capture } = makeRecordingD1();
    await updateSender(envWith(db), "snd_1", { enabled: false });
    const snd = capture.updates.find((u) => u.sql.includes("UPDATE allowlisted_senders"));
    expect(snd?.params[0]).toBe(0);
  });

  it("hard-deletes a sender by id", async () => {
    const { db, capture } = makeRecordingD1();
    const result = await deleteSender(envWith(db), "snd_1");
    expect(result).toEqual({ deleted: true });
    const del = capture.deletes.find((d) => d.sql.includes("DELETE FROM allowlisted_senders"));
    expect(del?.params).toEqual(["snd_1"]);
  });

  it("returns sender_not_found when the row is missing", async () => {
    const { db } = makeRecordingD1(0);
    await expect(deleteSender(envWith(db), "snd_missing")).rejects.toThrow("sender_not_found");
  });

  it("renames an SMTP credential", async () => {
    const { db, capture } = makeRecordingD1();
    await updateSmtpCredential(envWith(db), "cred_1", { name: "Gmail · laptop" });
    const upd = capture.updates.find((u) => u.sql.includes("UPDATE smtp_credentials"));
    expect(upd?.params[0]).toBe("Gmail · laptop");
  });

  it("restricts an API key's allowed senders by passing the array", async () => {
    const { db, capture } = makeRecordingD1();
    await updateApiKey(envWith(db), "key_1", { allowed_sender_ids: ["snd_a", "snd_b"] });
    const upd = capture.updates.find((u) => u.sql.includes("UPDATE api_keys"));
    expect(upd?.params[0]).toBe(JSON.stringify(["snd_a", "snd_b"]));
  });
});
