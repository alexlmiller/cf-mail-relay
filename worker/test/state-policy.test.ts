import { afterEach, describe, expect, it, vi } from "vitest";
import { hmacSha256Hex } from "../src/hmac";
import { authenticateApiKey, authenticateSmtpCredential, bumpPolicyVersion, senderAllowedForApiKey } from "../src/state";
import type { Env } from "../src/index";

describe("sender policy matching", () => {
  it("does not let domain wildcards match subdomains or trailing-dot variants", () => {
    const allowed = ["*@alexmiller.net"];

    expect(senderAllowedForApiKey("alex@alexmiller.net", allowed)).toBe(true);
    expect(senderAllowedForApiKey("alex@evil.alexmiller.net", allowed)).toBe(false);
    expect(senderAllowedForApiKey("alex@alexmiller.net.", allowed)).toBe(false);
    expect(senderAllowedForApiKey("alex@foo.alexmiller.net", ["*@.alexmiller.net"])).toBe(false);
  });

  it.each(["", "not-json", JSON.stringify({ inherited: true }), JSON.stringify(["snd_1", 2])])(
    "fails closed for malformed SMTP credential sender policy %j",
    async (allowedSenderIdsJson) => {
      const fixture = makeAuthenticationEnv({
        credential: {
          id: "cred_1",
          user_id: "usr_1",
          username: "gmail-relay",
          secret_hash: await hmacSha256Hex("credential-pepper", "secret"),
          hash_version: 1,
          allowed_sender_ids_json: allowedSenderIdsJson,
          revoked_at: null,
          user_disabled_at: null,
        },
      });

      await expect(authenticateSmtpCredential(fixture.env, "gmail-relay", "secret", undefined)).rejects.toThrow(
        "invalid_allowed_sender_ids_config",
      );
      expect(fixture.senderQueries).toBe(0);
    },
  );

  it.each(["", "not-json", JSON.stringify({ inherited: true }), JSON.stringify(["snd_1", 2])])(
    "fails closed for malformed API key sender policy %j",
    async (allowedSenderIdsJson) => {
      const secret = "api-secret-123456789";
      const fixture = makeAuthenticationEnv({
        apiKey: {
          id: "key_1",
          user_id: "usr_1",
          key_prefix: secret.slice(0, 8),
          secret_hash: await hmacSha256Hex("credential-pepper", secret),
          hash_version: 1,
          scopes_json: JSON.stringify(["send"]),
          allowed_sender_ids_json: allowedSenderIdsJson,
          revoked_at: null,
          user_disabled_at: null,
        },
      });

      await expect(authenticateApiKey(fixture.env, secret)).rejects.toThrow("invalid_allowed_sender_ids_config");
      expect(fixture.senderQueries).toBe(0);
    },
  );

  it("stores a deterministic HMAC token instead of an unknown SMTP username", async () => {
    const fixture = makeAuthenticationEnv({});
    const rawUsername = "Attacker.Supplied@example.invalid";

    await expect(authenticateSmtpCredential(fixture.env, rawUsername, "wrong", undefined)).resolves.toEqual({
      ok: false,
      reason: "not_found",
    });

    const attemptedUsername = String(fixture.authFailures[0]?.[3]);
    expect(attemptedUsername).toBe(`hmac:${await hmacSha256Hex("metadata-pepper", rawUsername.toLowerCase())}`);
    expect(JSON.stringify(fixture.authFailures)).not.toContain(rawUsername);
    expect(attemptedUsername).not.toContain("attacker");
  });

  it("stores the canonical bounded username for a known credential failure", async () => {
    const fixture = makeAuthenticationEnv({
      credential: {
        id: "cred_1",
        user_id: "usr_1",
        username: `  ${"A".repeat(300)}  `,
        secret_hash: await hmacSha256Hex("credential-pepper", "secret"),
        hash_version: 1,
        allowed_sender_ids_json: null,
        revoked_at: null,
        user_disabled_at: null,
      },
    });

    await authenticateSmtpCredential(fixture.env, "known", "wrong", undefined);
    expect(fixture.authFailures[0]?.[3]).toBe("a".repeat(254));
  });
});

describe("policy version generation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(["1000", JSON.stringify("1000")])("atomically increments raw and JSON-string generations from %s", async (initial) => {
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const state = { value: initial, statements: [] as string[] };
    const env = makePolicyEnv(state);

    const versions = await Promise.all([bumpPolicyVersion(env), bumpPolicyVersion(env)]);

    expect(versions.map(Number).every((version) => version >= 1001)).toBe(true);
    expect(JSON.parse(state.value)).toBe("1002");
    expect(state.statements.filter((sql) => sql.includes("ON CONFLICT(key) DO UPDATE"))).toHaveLength(2);
    expect(state.statements.every((sql) => sql.includes("AS INTEGER) + 1"))).toBe(true);
  });
});

interface CredentialFixture {
  id: string;
  user_id: string;
  username: string;
  secret_hash: string;
  hash_version: number;
  allowed_sender_ids_json: string | null;
  revoked_at: number | null;
  user_disabled_at: number | null;
}

interface ApiKeyFixture {
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

function makeAuthenticationEnv(options: { credential?: CredentialFixture; apiKey?: ApiKeyFixture }): {
  env: Env;
  authFailures: unknown[][];
  senderQueries: number;
} {
  const authFailures: unknown[][] = [];
  const result = { senderQueries: 0 };
  const prepare = (sql: string) => {
    let params: unknown[] = [];
    const statement = {
      bind(...values: unknown[]) {
        params = values;
        return statement;
      },
      async first() {
        if (sql.includes("policy_version")) return { value_json: "7" };
        if (sql.includes("WHERE lower(c.username) = ?")) return options.credential ?? null;
        if (sql.includes("FROM api_keys k")) return options.apiKey ?? null;
        return null;
      },
      async all() {
        if (sql.includes("FROM allowlisted_senders")) result.senderQueries += 1;
        return { results: [] };
      },
      async run() {
        if (sql.includes("INSERT INTO auth_failures")) authFailures.push(params);
        return { meta: { changes: 1 } };
      },
    };
    return statement;
  };
  const env = {
    D1_MAIN: { prepare } as unknown as D1Database,
    KV_HOT: {
      get: vi.fn(async () => null),
      put: vi.fn(async () => undefined),
    } as unknown as KVNamespace,
    CREDENTIAL_PEPPER: "credential-pepper",
    METADATA_PEPPER: "metadata-pepper",
  } as Env;
  return Object.assign(result, { env, authFailures });
}

function makePolicyEnv(state: { value: string; statements: string[] }): Env {
  return {
    D1_MAIN: {
      prepare(sql: string) {
        let params: unknown[] = [];
        const statement = {
          bind(...values: unknown[]) {
            params = values;
            return statement;
          },
          async run() {
            state.statements.push(sql);
            const parsed = parsePolicyFixture(state.value);
            const next = Math.max(parsed + 1, Number(params[2]));
            state.value = JSON.stringify(String(next));
            return { meta: { changes: 1 } };
          },
          async first() {
            return { value_json: state.value };
          },
        };
        return statement;
      },
    } as unknown as D1Database,
  } as Env;
}

function parsePolicyFixture(raw: string): number {
  try {
    return Number(JSON.parse(raw));
  } catch {
    return Number(raw);
  }
}
