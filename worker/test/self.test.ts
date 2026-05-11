import { describe, expect, it } from "vitest";
import {
  selfCreateApiKey,
  selfCreateSmtpCredential,
  selfRevokeApiKey,
  selfRevokeSmtpCredential,
  selfSendEvents,
  selfSenders,
  selfSmtpCredentials,
} from "../src/self";
import type { Env } from "../src/index";

interface Insert {
  sql: string;
  params: unknown[];
}

interface Update {
  sql: string;
  params: unknown[];
  changes: number;
}

function makeD1(opts: { changesOnRevoke?: number; rows?: Record<string, unknown[]> }): { db: D1Database; inserts: Insert[]; updates: Update[]; queries: Insert[] } {
  const inserts: Insert[] = [];
  const updates: Update[] = [];
  const queries: Insert[] = [];

  const makeStatement = (sql: string) => {
    const statement = {
      bound: [] as unknown[],
      bind(...values: unknown[]) {
        this.bound = values;
        return this;
      },
      async first() {
        queries.push({ sql, params: this.bound });
        const upper = sql.trim().toUpperCase();
        if (upper.startsWith("SELECT")) {
          const rows = (opts.rows ?? {})[matchRowKey(sql)];
          return rows?.[0] ?? null;
        }
        return null;
      },
      async all() {
        queries.push({ sql, params: this.bound });
        const rows = (opts.rows ?? {})[matchRowKey(sql)];
        return { results: rows ?? [] };
      },
      async run() {
        const upper = sql.trim().toUpperCase();
        if (upper.startsWith("INSERT")) {
          inserts.push({ sql, params: this.bound });
          return { meta: { changes: 1 } };
        }
        if (upper.startsWith("UPDATE")) {
          const changes = opts.changesOnRevoke ?? 1;
          updates.push({ sql, params: this.bound, changes });
          return { meta: { changes } };
        }
        return { meta: { changes: 0 } };
      },
    };
    return statement;
  };

  return {
    db: { prepare: (sql: string) => makeStatement(sql) } as unknown as D1Database,
    inserts,
    updates,
    queries,
  };
}

function matchRowKey(sql: string): string {
  if (sql.includes("FROM allowlisted_senders")) return "senders";
  if (sql.includes("FROM smtp_credentials")) return "credentials";
  if (sql.includes("FROM api_keys")) return "api_keys";
  if (sql.includes("FROM send_events")) return "send_events";
  if (sql.includes("FROM users")) return "users";
  return sql;
}

function makeEnv(d1: D1Database): Env {
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
    REQUIRED_D1_SCHEMA_VERSION: "1",
  };
}

describe("self-service endpoints", () => {
  it("scopes sender list to the calling user", async () => {
    const { db, queries } = makeD1({
      rows: {
        senders: [
          { id: "snd_a", domain: "example.com", email: "alex@example.com", enabled: 1 },
          { id: "snd_b", domain: "example.com", email: "*@example.com", enabled: 1 },
        ],
      },
    });
    const senders = await selfSenders(makeEnv(db), "usr_self");
    expect(senders).toHaveLength(2);
    const sendersQuery = queries.find((q) => q.sql.includes("FROM allowlisted_senders"));
    expect(sendersQuery?.params).toContain("usr_self");
    expect(sendersQuery?.sql).toMatch(/WHERE s\.user_id = \?/);
  });

  it("scopes credential list to the calling user", async () => {
    const { db, queries } = makeD1({ rows: { credentials: [] } });
    await selfSmtpCredentials(makeEnv(db), "usr_alice");
    const q = queries.find((row) => row.sql.includes("FROM smtp_credentials"));
    expect(q?.params).toEqual(["usr_alice"]);
    expect(q?.sql).toMatch(/WHERE user_id = \?/);
  });

  it("forces user_id on credential creation regardless of body", async () => {
    const { db, inserts } = makeD1({});
    const result = await selfCreateSmtpCredential(makeEnv(db), "usr_self", {
      name: "laptop",
      username: "gmail-relay",
      user_id: "usr_someone_else", // attacker tries to forge user_id
    });
    expect(result.secret.length).toBeGreaterThan(20);
    expect(result.username).toBe("gmail-relay");
    const credInsert = inserts.find((i) => i.sql.includes("INSERT INTO smtp_credentials"));
    expect(credInsert).toBeDefined();
    expect(credInsert!.params[1]).toBe("usr_self");
    expect(credInsert!.params).not.toContain("usr_someone_else");
  });

  it("forces user_id on api key creation regardless of body", async () => {
    const { db, inserts } = makeD1({});
    const result = await selfCreateApiKey(makeEnv(db), "usr_self", { name: "billing-app", user_id: "attacker" });
    expect(result.secret.length).toBeGreaterThan(20);
    expect(result.key_prefix.length).toBe(8);
    const keyInsert = inserts.find((i) => i.sql.includes("INSERT INTO api_keys"));
    expect(keyInsert).toBeDefined();
    expect(keyInsert!.params[1]).toBe("usr_self");
    expect(keyInsert!.params).not.toContain("attacker");
  });

  it("refuses to revoke a credential owned by a different user", async () => {
    const { db } = makeD1({ changesOnRevoke: 0 });
    await expect(selfRevokeSmtpCredential(makeEnv(db), "usr_self", "cred_other")).rejects.toThrow("credential_not_found");
  });

  it("refuses to revoke an api key owned by a different user", async () => {
    const { db } = makeD1({ changesOnRevoke: 0 });
    await expect(selfRevokeApiKey(makeEnv(db), "usr_self", "key_other")).rejects.toThrow("api_key_not_found");
  });

  it("revokes a credential when the row belongs to the user", async () => {
    const { db, updates } = makeD1({ changesOnRevoke: 1 });
    const result = await selfRevokeSmtpCredential(makeEnv(db), "usr_self", "cred_mine");
    expect(result).toEqual({ revoked: true });
    const revokeUpdate = updates.find((u) => u.sql.includes("UPDATE smtp_credentials"));
    expect(revokeUpdate?.params).toContain("usr_self");
    expect(revokeUpdate?.params).toContain("cred_mine");
    expect(revokeUpdate?.sql).toMatch(/WHERE id = \? AND user_id = \?/);
  });

  it("scopes send-events to the calling user", async () => {
    const { db, queries } = makeD1({ rows: { send_events: [] } });
    await selfSendEvents(makeEnv(db), "usr_self");
    const q = queries.find((row) => row.sql.includes("FROM send_events"));
    expect(q?.params).toEqual(["usr_self"]);
    expect(q?.sql).toMatch(/WHERE user_id = \?/);
  });
});
