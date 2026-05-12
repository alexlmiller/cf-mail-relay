import { afterEach, describe, expect, it, vi } from "vitest";
import app, { stripCaptureHopHeaders } from "../src/index";
import { hmacSha256Hex, sha256Hex, signRelayRequest } from "../src/hmac";

const hmacSecret = "relay-secret";
const keyId = "rel_test";
const apiSecret = "api-secret-123456789";

function makeKv(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
  } as unknown as KVNamespace;
}

interface FakeD1State {
  idempotency: Map<string, { status: string; request_hash: string; source: string; response_json: string | null }>;
  relayNonces: Set<string>;
  settings: Map<string, string>;
  rates: Map<string, number>;
  sendEvents: unknown[][];
  authFailures: unknown[][];
}

function makeD1(): D1Database & { state: FakeD1State } {
  const state: FakeD1State = {
    idempotency: new Map(),
    relayNonces: new Set(),
    settings: new Map([
      ["policy_version", "7"],
      ["schema_version", "3"],
    ]),
    rates: new Map(),
    sendEvents: [],
    authFailures: [],
  };
  const credential = {
    id: "cred_1",
    user_id: "usr_1",
    username: "gmail",
    secret_hash: "",
    hash_version: 1,
    allowed_sender_ids_json: null,
    revoked_at: null,
    user_disabled_at: null,
  };
  const sender = { id: "sender_1", email: "gmail@alexmiller.net" };

  const makeStatement = (sql: string) => {
    let args: unknown[] = [];
    return {
      bind: (...bound: unknown[]) => {
        args = bound;
        return makeStatementWithArgs(sql, args);
      },
      first: async () => makeFirst(sql, args),
      all: async () => makeAll(sql, args),
      run: async () => makeRun(sql, args),
    };
  };
  const makeStatementWithArgs = (sql: string, args: unknown[]) => ({
    bind: (...bound: unknown[]) => makeStatementWithArgs(sql, bound),
    first: async () => makeFirst(sql, args),
    all: async () => makeAll(sql, args),
    run: async () => makeRun(sql, args),
  });

  const makeFirst = async (sql: string, args: unknown[]) => {
    if (sql.includes("WHERE lower(c.username) = ?")) {
      return args[0] === "gmail" ? { ...credential, secret_hash: await hmacSha256Hex("credential-pepper", "secret") } : null;
    }
    if (sql.includes("WHERE c.id = ?")) {
      return args[0] === "cred_1" ? { ...credential, secret_hash: await hmacSha256Hex("credential-pepper", "secret") } : null;
    }
    if (sql.includes("FROM api_keys k") && sql.includes("WHERE k.key_prefix = ?")) {
      return args[0] === apiSecret.slice(0, 8)
        ? {
            id: "key_1",
            user_id: "usr_1",
            key_prefix: apiSecret.slice(0, 8),
            secret_hash: await hmacSha256Hex("credential-pepper", apiSecret),
            hash_version: 1,
            scopes_json: JSON.stringify(["send"]),
            allowed_sender_ids_json: null,
            revoked_at: null,
            user_disabled_at: null,
          }
        : null;
    }
    if (sql.includes("FROM settings WHERE key = 'policy_version'")) {
      return { value_json: "7" };
    }
    if (sql.includes("FROM settings WHERE key = ?")) {
      const value = state.settings.get(String(args[0]));
      return value === undefined ? null : { value_json: value };
    }
    if (sql.includes("FROM idempotency_keys WHERE idempotency_key = ?")) {
      return state.idempotency.get(String(args[0])) ?? null;
    }
    if (sql.includes("SELECT count FROM rate_reservations")) {
      return { count: state.rates.get(rateKey(args)) ?? 0 };
    }
    if (sql.includes("SELECT id FROM users LIMIT 1")) {
      return null;
    }
    return null;
  };

  const makeAll = async (sql: string) => {
    if (sql.includes("FROM allowlisted_senders")) {
      return { results: [sender] };
    }
    return { results: [] };
  };

  const makeRun = async (sql: string, args: unknown[]) => {
    if (sql.includes("INSERT OR IGNORE INTO idempotency_keys")) {
      const key = String(args[0]);
      if (state.idempotency.has(key)) {
        return { meta: { changes: 0 } };
      }
      state.idempotency.set(key, { status: "pending", request_hash: String(args[1]), source: String(args[2]), response_json: null });
      return { meta: { changes: 1 } };
    }
    if (sql.includes("INSERT OR IGNORE INTO relay_nonces")) {
      const key = `${String(args[0])}:${String(args[1])}`;
      if (state.relayNonces.has(key)) {
        return { meta: { changes: 0 } };
      }
      state.relayNonces.add(key);
      return { meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE idempotency_keys SET status = ?")) {
      const existing = state.idempotency.get(String(args[3]));
      state.idempotency.set(String(args[3]), {
        status: String(args[0]),
        request_hash: existing?.request_hash ?? "",
        source: existing?.source ?? "smtp",
        response_json: String(args[1]),
      });
      return { meta: { changes: 1 } };
    }
    if (sql.includes("INSERT INTO send_events")) {
      state.sendEvents.push(args);
      return { meta: { changes: 1 } };
    }
    if (sql.includes("INSERT INTO auth_failures")) {
      state.authFailures.push(args);
      return { meta: { changes: 1 } };
    }
    if (sql.includes("INSERT OR IGNORE INTO rate_reservations")) {
      const key = `${String(args[1])}:${String(args[2])}:${String(args[3])}`;
      if (!state.rates.has(key)) {
        state.rates.set(key, 0);
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    }
    if (sql.includes("UPDATE rate_reservations SET count = count + 1")) {
      const key = rateKey(args.slice(1));
      state.rates.set(key, (state.rates.get(key) ?? 0) + 1);
      return { meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE rate_reservations SET count = MAX")) {
      const key = rateKey(args.slice(1));
      state.rates.set(key, Math.max((state.rates.get(key) ?? 0) - 1, 0));
      return { meta: { changes: 1 } };
    }
    return { meta: { changes: 1 } };
  };

  const d1 = {
    state,
    prepare: (sql: string) => makeStatement(sql),
    batch: async (statements: Array<{ run: () => Promise<unknown> }>) => {
      return Promise.all(statements.map((statement) => statement.run()));
    },
  };
  return d1 as unknown as D1Database & { state: FakeD1State };
}

function rateKey(args: unknown[]): string {
  return `${String(args[0])}:${String(args[1])}:${String(args[2])}`;
}

function makeEnv(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    D1_MAIN: makeD1(),
    KV_HOT: makeKv(),
    CF_ACCOUNT_ID: "account_123",
    CF_API_TOKEN: "cf_token",
    CREDENTIAL_PEPPER: "credential-pepper",
    METADATA_PEPPER: "metadata-pepper",
    RELAY_HMAC_SECRET_CURRENT: hmacSecret,
    RELAY_HMAC_KEY_ID: keyId,
    ...overrides,
  };
}

async function signedHeaders(path: string, body: Uint8Array, nonce: string): Promise<Record<string, string>> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const bodySha256 = await sha256Hex(body);
  const signature = await signRelayRequest(
    {
      method: "POST",
      path,
      timestamp,
      nonce,
      bodySha256,
      keyId,
      signedHeaders: { "x-relay-version": "0.1.0-ms7" },
    },
    hmacSecret,
  );

  return {
    "x-relay-key-id": keyId,
    "x-relay-timestamp": timestamp,
    "x-relay-nonce": nonce,
    "x-relay-body-sha256": bodySha256,
    "x-relay-version": "0.1.0-ms7",
    "x-relay-signed-headers": "x-relay-version",
    "x-relay-signature": signature,
  };
}

async function signedSendHeaders(body: Uint8Array, nonce: string, headers: Record<string, string>): Promise<Record<string, string>> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const bodySha256 = await sha256Hex(body);
  const signedHeaders = {
    "x-relay-credential-id": headers["x-relay-credential-id"] ?? "",
    "x-relay-envelope-from": headers["x-relay-envelope-from"] ?? "",
    "x-relay-recipients": headers["x-relay-recipients"] ?? "",
    "x-relay-version": "0.1.0-ms7",
  };
  const signature = await signRelayRequest(
    {
      method: "POST",
      path: "/relay/send",
      timestamp,
      nonce,
      bodySha256,
      keyId,
      signedHeaders,
    },
    hmacSecret,
  );

  return {
    ...headers,
    "x-relay-key-id": keyId,
    "x-relay-timestamp": timestamp,
    "x-relay-nonce": nonce,
    "x-relay-body-sha256": bodySha256,
    "x-relay-version": "0.1.0-ms7",
    "x-relay-signed-headers": "x-relay-credential-id;x-relay-envelope-from;x-relay-recipients;x-relay-version",
    "x-relay-signature": signature,
  };
}

describe("relay endpoints", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates the first bootstrap admin with the one-time token", async () => {
    const response = await app.request(
      "/bootstrap/admin",
      {
        method: "POST",
        headers: {
          authorization: "Bearer setup-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ email: "alex@example.net", display_name: "Alex" }),
      },
      makeEnv({ BOOTSTRAP_SETUP_TOKEN: "setup-token" }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, user_id: expect.stringMatching(/^usr_/) });
  });

  it("reports D1 schema mismatch on /healthz", async () => {
    const response = await app.request("/healthz", { method: "GET" }, makeEnv({ REQUIRED_D1_SCHEMA_VERSION: "4" }));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: "schema_version_mismatch",
      required_schema_version: "4",
      actual_schema_version: "3",
    });
  });

  it("reports healthy schema on /healthz", async () => {
    const response = await app.request("/healthz", { method: "GET" }, makeEnv({ REQUIRED_D1_SCHEMA_VERSION: "3" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, version: "0.1.0-ms7", schema_version: "3" });
  });

  it("authenticates SMTP credentials with HMAC-protected /relay/auth", async () => {
    const body = new TextEncoder().encode(JSON.stringify({ username: "gmail", password: "secret" }));
    const response = await app.request(
      "/relay/auth",
      {
        method: "POST",
        headers: await signedHeaders("/relay/auth", body, "auth-nonce"),
        body,
      },
      makeEnv(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      ttl_seconds: 5,
      policy_version: "7",
      credential_id: "cred_1",
      allowed_senders: ["gmail@alexmiller.net"],
    });
  });

  it("rejects replayed relay nonces", async () => {
    const env = makeEnv();
    const body = new TextEncoder().encode(JSON.stringify({ username: "gmail", password: "secret" }));
    const headers = await signedHeaders("/relay/auth", body, "replay-nonce");

    expect((await app.request("/relay/auth", { method: "POST", headers, body }, env)).status).toBe(200);
    const replay = await app.request("/relay/auth", { method: "POST", headers, body }, env);

    expect(replay.status).toBe(401);
    await expect(replay.json()).resolves.toMatchObject({ ok: false, error: "replay_nonce" });
  });

  it("strips capture-hop trace headers before sending raw MIME", async () => {
    const cfFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        from: "gmail@alexmiller.net",
        recipients: ["alex@example.net"],
        mime_message: "From: Alex <gmail@alexmiller.net>\r\nSubject: Hi\r\n\r\nBody\r\n",
      });
      return new Response(JSON.stringify({ success: true, errors: [], messages: [], result: { delivered: [], queued: [], permanent_bounces: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", cfFetch);

    const body = new TextEncoder().encode(
      "Received: by mail.example with SMTP id abc\r\nX-Received: by mx.example\r\nX-Gm-Message-State: folded\r\n\tcontinued\r\nFrom: Alex <gmail@alexmiller.net>\r\nSubject: Hi\r\n\r\nBody\r\n",
    );
    const response = await app.request(
      "/relay/send",
      {
        method: "POST",
        headers: await signedSendHeaders(body, "send-nonce", {
          "x-relay-envelope-from": "gmail@alexmiller.net",
          "x-relay-recipients": "alex@example.net",
          "x-relay-credential-id": "cred_1",
        }),
        body,
      },
      makeEnv(),
    );

    expect(response.status).toBe(200);
    expect(cfFetch).toHaveBeenCalledOnce();
    await expect(response.json()).resolves.toMatchObject({ ok: true, cf_status: 200, idempotency_key: expect.any(String) });
  });

  it("re-checks sender allowlist on /relay/send", async () => {
    const body = new TextEncoder().encode("From: Alex <blocked@example.net>\r\n\r\nBody\r\n");
    const response = await app.request(
      "/relay/send",
      {
        method: "POST",
        headers: await signedSendHeaders(body, "blocked-sender-nonce", {
          "x-relay-envelope-from": "blocked@example.net",
          "x-relay-recipients": "alex@example.net",
          "x-relay-credential-id": "cred_1",
        }),
        body,
      },
      makeEnv(),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: "sender_not_allowed" });
  });

  it("rejects SMTP sends when the MIME From header differs from the authorized envelope", async () => {
    const body = new TextEncoder().encode("From: CEO <ceo@alexmiller.net>\r\n\r\nBody\r\n");
    const response = await app.request(
      "/relay/send",
      {
        method: "POST",
        headers: await signedSendHeaders(body, "spoofed-from-nonce", {
          "x-relay-envelope-from": "gmail@alexmiller.net",
          "x-relay-recipients": "alex@example.net",
          "x-relay-credential-id": "cred_1",
        }),
        body,
      },
      makeEnv(),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: "from_header_mismatch" });
  });

  it("rejects duplicate MIME From headers before sending", async () => {
    const body = new TextEncoder().encode("From: Alex <gmail@alexmiller.net>\r\nFrom: CEO <ceo@example.net>\r\n\r\nBody\r\n");
    const response = await app.request(
      "/relay/send",
      {
        method: "POST",
        headers: await signedSendHeaders(body, "duplicate-from-nonce", {
          "x-relay-envelope-from": "gmail@alexmiller.net",
          "x-relay-recipients": "alex@example.net",
          "x-relay-credential-id": "cred_1",
        }),
        body,
      },
      makeEnv(),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: "duplicate_from_header" });
  });

  it("rejects oversized relay requests before reading the body", async () => {
    const response = await app.request(
      "/relay/send",
      {
        method: "POST",
        headers: {
          "content-length": String(6 * 1024 * 1024 + 1),
        },
        body: "x",
      },
      makeEnv(),
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: "message_too_large" });
  });

  it("rejects oversized relay auth requests before HMAC verification", async () => {
    const response = await app.request(
      "/relay/auth",
      {
        method: "POST",
        headers: {
          "content-length": String(16 * 1024 + 1),
        },
        body: "x",
      },
      makeEnv(),
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: "message_too_large" });
  });

  it("replays completed idempotency responses from D1", async () => {
    const env = makeEnv();
    const cfFetch = vi.fn(async () => {
      return new Response(JSON.stringify({ success: true, errors: [], messages: [], result: { delivered: [], queued: [], permanent_bounces: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", cfFetch);

    const body = new TextEncoder().encode("From: Alex <gmail@alexmiller.net>\r\nMessage-ID: <same@example.net>\r\n\r\nBody\r\n");
    const first = await app.request(
      "/relay/send",
      {
        method: "POST",
        headers: await signedSendHeaders(body, "idem-nonce-1", {
          "x-relay-envelope-from": "gmail@alexmiller.net",
          "x-relay-recipients": "alex@example.net",
          "x-relay-credential-id": "cred_1",
        }),
        body,
      },
      env,
    );
    const firstJson = await first.json();
    const second = await app.request(
      "/relay/send",
      {
        method: "POST",
        headers: await signedSendHeaders(body, "idem-nonce-2", {
          "x-relay-envelope-from": "gmail@alexmiller.net",
          "x-relay-recipients": "alex@example.net",
          "x-relay-credential-id": "cred_1",
        }),
        body,
      },
      env,
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.headers.get("x-relay-idempotency-replay")).toBe("1");
    await expect(second.json()).resolves.toMatchObject(firstJson as Record<string, unknown>);
    expect(cfFetch).toHaveBeenCalledOnce();
  });

  it("sanitizes Cloudflare response data before replay storage on SMTP sends", async () => {
    const env = makeEnv();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            success: true,
            errors: [],
            messages: [],
            result: {
              delivered: [{ email: "alex@example.net", status: "delivered" }],
              queued: ["queue@example.net"],
              permanent_bounces: [],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    const body = new TextEncoder().encode("From: Alex <gmail@alexmiller.net>\r\nMessage-ID: <smtp-safe@example.net>\r\n\r\nBody\r\n");
    const response = await app.request(
      "/relay/send",
      {
        method: "POST",
        headers: await signedSendHeaders(body, "smtp-safe-nonce", {
          "x-relay-envelope-from": "gmail@alexmiller.net",
          "x-relay-recipients": "alex@example.net",
          "x-relay-credential-id": "cred_1",
        }),
        body,
      },
      env,
    );

    expect(response.status).toBe(200);
    const responseJson = await response.json();
    expect(responseJson).toMatchObject({
      cf_response: {
        result: {
          delivered: { count: 1, categories: ["delivered"] },
          queued: { count: 1 },
          permanent_bounces: { count: 0 },
        },
      },
    });
    expect(JSON.stringify((env.D1_MAIN as D1Database & { state: FakeD1State }).state.idempotency)).not.toContain("alex@example.net");
    expect(JSON.stringify((env.D1_MAIN as D1Database & { state: FakeD1State }).state.idempotency)).not.toContain("queue@example.net");
  });

  it("sends raw base64 MIME through the HTTP /send API", async () => {
    const env = makeEnv();
    const cfFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        from: "gmail@alexmiller.net",
        recipients: ["alex@example.net", "copy@example.net", "hidden@example.net"],
        mime_message:
          "From: Alex <gmail@alexmiller.net>\r\nTo: alex@example.net\r\nCc: Copy <copy@example.net>\r\nSubject: API\r\n\r\nBody\r\n",
      });
      return new Response(
        JSON.stringify({
          success: true,
          errors: [],
          messages: [],
          result: { delivered: [{ email: "alex@example.net", status: "delivered" }], queued: [], permanent_bounces: [] },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json", "cf-ray": "ray-1", "cf-request-id": "req-1" },
        },
      );
    });
    vi.stubGlobal("fetch", cfFetch);

    const mime =
      "From: Alex <gmail@alexmiller.net>\r\nTo: alex@example.net\r\nCc: Copy <copy@example.net>\r\nBcc: hidden@example.net\r\nSubject: API\r\n\r\nBody\r\n";
    const response = await app.request(
      "/send",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiSecret}`,
          "content-type": "application/json",
          "idempotency-key": "http-idem-1",
        },
        body: JSON.stringify({
          from: "gmail@alexmiller.net",
          recipients: ["alex@example.net", "copy@example.net", "hidden@example.net"],
          raw: Buffer.from(mime, "utf8").toString("base64"),
        }),
      },
      env,
    );

    expect(response.status).toBe(200);
    expect(cfFetch).toHaveBeenCalledOnce();
    expect((env.D1_MAIN as D1Database & { state: FakeD1State }).state.sendEvents[0]?.[3]).toBe("http");
    expect((env.D1_MAIN as D1Database & { state: FakeD1State }).state.sendEvents[0]?.[6]).toBe("key_1");
    expect(JSON.parse(String((env.D1_MAIN as D1Database & { state: FakeD1State }).state.sendEvents[0]?.[15]))).toEqual({
      count: 1,
      categories: ["delivered"],
    });
    const responseJson = await response.json();
    expect(responseJson).toMatchObject({
      ok: true,
      from: "gmail@alexmiller.net",
      recipient_count: 3,
      idempotency_key: "http:key_1:http-idem-1",
      cf_status: 200,
      cf_ray_id: "ray-1",
      cf_request_id: "req-1",
    });
    expect(responseJson).toMatchObject({
      cf_response: {
        success: true,
        result: {
          delivered: { count: 1, categories: ["delivered"] },
          queued: { count: 0 },
          permanent_bounces: { count: 0 },
        },
      },
    });
    expect(JSON.stringify(responseJson.cf_response)).not.toContain("alex@example.net");
    const idempotencyRows = [...(env.D1_MAIN as D1Database & { state: FakeD1State }).state.idempotency.values()];
    expect(JSON.stringify(idempotencyRows)).not.toContain("alex@example.net");
  });

  it("marks permanent Cloudflare API failures as non-retryable without leaking provider text", async () => {
    const env = makeEnv();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            success: false,
            errors: [{ code: 10000, message: "bad recipient alex@example.net" }],
            messages: [],
          }),
          { status: 403, headers: { "content-type": "application/json", "cf-ray": "ray-perm" } },
        );
      }),
    );

    const mime = "From: gmail@alexmiller.net\r\nTo: alex@example.net\r\nSubject: API\r\n\r\nBody\r\n";
    const response = await app.request(
      "/send",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiSecret}`,
          "content-type": "application/json",
          "idempotency-key": "http-permanent-cf",
        },
        body: JSON.stringify({ from: "gmail@alexmiller.net", recipients: ["alex@example.net"], raw: Buffer.from(mime, "utf8").toString("base64") }),
      },
      env,
    );

    expect(response.status).toBe(422);
    const responseJson = await response.json();
    expect(responseJson).toMatchObject({
      ok: false,
      error_code: "cloudflare_send_raw_permanent_failure",
      cf_error_code: "10000",
      cf_response: { success: false, errors: [{ code: 10000 }], messages: [] },
    });
    expect(JSON.stringify(responseJson.cf_response)).not.toContain("alex@example.net");
    expect(JSON.stringify([...(env.D1_MAIN as D1Database & { state: FakeD1State }).state.idempotency.values()])).not.toContain("alex@example.net");
  });

  it("rejects malformed HTTP envelope recipients", async () => {
    const mime = "From: gmail@alexmiller.net\r\nTo: alex@example.net\r\nSubject: API\r\n\r\nBody\r\n";
    const response = await app.request(
      "/send",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiSecret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ from: "gmail@alexmiller.net", recipients: ["not a mailbox"], raw: Buffer.from(mime, "utf8").toString("base64") }),
      },
      makeEnv(),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: "invalid_recipients" });
  });

  it("rejects HTTP idempotency key reuse for a different request", async () => {
    const env = makeEnv();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ success: true, errors: [], messages: [], result: { delivered: [], queued: [], permanent_bounces: [] } }), { status: 200 })),
    );
    const request = (subject: string) => {
      const mime = `From: gmail@alexmiller.net\r\nTo: alex@example.net\r\nSubject: ${subject}\r\n\r\nBody\r\n`;
      return app.request(
        "/send",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiSecret}`,
            "content-type": "application/json",
            "idempotency-key": "same-client-key",
          },
          body: JSON.stringify({ from: "gmail@alexmiller.net", recipients: ["alex@example.net"], raw: Buffer.from(mime, "utf8").toString("base64") }),
        },
        env,
      );
    };

    expect((await request("One")).status).toBe(200);
    const conflict = await request("Two");

    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({ ok: false, error: "idempotency_key_conflict" });
  });

  it("requires a bearer API key on /send", async () => {
    const response = await app.request(
      "/send",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: "gmail@alexmiller.net", recipients: ["alex@example.net"], raw: "RnJvbTogZ21haWxAYWxleG1pbGxlci5uZXQNCg0K" }),
      },
      makeEnv(),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: "missing_api_key" });
  });

  it("enforces sender allowlist on /send", async () => {
    const mime = "From: blocked@example.net\r\nTo: alex@example.net\r\nSubject: API\r\n\r\nBody\r\n";
    const response = await app.request(
      "/send",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiSecret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ from: "blocked@example.net", recipients: ["alex@example.net"], raw: Buffer.from(mime, "utf8").toString("base64") }),
      },
      makeEnv(),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: "sender_not_allowed" });
  });

  it("rate limits HTTP sends using D1 daily reservations", async () => {
    const env = makeEnv();
    const d1 = env.D1_MAIN as D1Database & { state: FakeD1State };
    d1.state.settings.set("daily_cap_global", "1");
    const cfFetch = vi.fn(async () => {
      return new Response(JSON.stringify({ success: true, errors: [], messages: [], result: { delivered: [], queued: [], permanent_bounces: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", cfFetch);
    const mime = "From: gmail@alexmiller.net\r\nTo: alex@example.net\r\nSubject: API\r\n\r\nBody\r\n";
    const request = (idempotencyKey: string) =>
      app.request(
        "/send",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiSecret}`,
            "content-type": "application/json",
            "idempotency-key": idempotencyKey,
          },
          body: JSON.stringify({ from: "gmail@alexmiller.net", recipients: ["alex@example.net"], raw: Buffer.from(mime, "utf8").toString("base64") }),
        },
        env,
      );

    expect((await request("quota-1")).status).toBe(200);
    const limited = await request("quota-2");

    expect(limited.status).toBe(429);
    await expect(limited.json()).resolves.toMatchObject({ ok: false, error: "rate_limited", scope: "global_day", limit: 1 });
    expect(cfFetch).toHaveBeenCalledOnce();
  });

  it("rejects cross-origin admin POSTs before Access authorization", async () => {
    const response = await app.request(
      "/admin/api/users",
      {
        method: "POST",
        headers: { origin: "https://evil.example", "content-type": "text/plain" },
        body: JSON.stringify({ email: "next@example.net", role: "sender" }),
      },
      makeEnv({ ADMIN_CORS_ORIGIN: "https://cf-mail-relay-ui.pages.dev" }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: "csrf_origin_denied" });
  });

  it("allows non-browser admin scripts without Origin to reach Access authorization", async () => {
    const response = await app.request(
      "/admin/api/users",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "next@example.net", role: "sender" }),
      },
      makeEnv({ ADMIN_CORS_ORIGIN: "https://cf-mail-relay-ui.pages.dev" }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: "missing_access_jwt" });
  });
});

describe("stripCaptureHopHeaders", () => {
  it("removes capture-hop and Bcc headers while preserving user-authored headers and body", () => {
    expect(stripCaptureHopHeaders("Received: x\r\nFrom: a@example.com\r\nBcc: hidden@example.net\r\nSubject: Test\r\n\r\nHello\r\n")).toBe(
      "From: a@example.com\r\nSubject: Test\r\n\r\nHello\r\n",
    );
  });

  it("removes folded and mixed-case authentication trace headers", () => {
    expect(
      stripCaptureHopHeaders(
        "Authentication-Results: mx.example; pass\r\n" +
          "DKIM-Signature: v=1;\r\n\tb=abc\r\n" +
          "aRc-Seal: i=1\r\n" +
          "Received-SPF: pass\r\n" +
          "X-Originating-IP: [192.0.2.10]\r\n" +
          "From: a@example.com\r\n\r\nHello\r\n",
      ),
    ).toBe("From: a@example.com\r\n\r\nHello\r\n");
  });
});
