import { afterEach, describe, expect, it, vi } from "vitest";
import app, { anchorClientMessageIdInReferences, stripCaptureHopHeaders } from "../src/index";
import { hmacSha256Hex, sha256Hex, signRelayRequest } from "../src/hmac";

const hmacSecret = "relay-secret";
const keyId = "rel_test";
const apiSecret = "api-secret-123456789";

function makeKv(): KVNamespace & { state: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    state: store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
  } as unknown as KVNamespace & { state: Map<string, string> };
}

interface FakeD1State {
  idempotency: Map<
    string,
    {
      status: string;
      request_hash: string;
      source: string;
      response_json: string | null;
      created_at: number;
      updated_at: number;
      expires_at: number;
    }
  >;
  relayNonces: Set<string>;
  settings: Map<string, string>;
  rates: Map<string, number>;
  sendEvents: unknown[][];
  authFailures: unknown[][];
  failSendEvents: boolean;
  failInFlightTransition: boolean;
  failIdempotencyCompletion: boolean;
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
    failSendEvents: false,
    failInFlightTransition: false,
    failIdempotencyCompletion: false,
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
  const sender = { id: "sender_1", email: "gmail@alexmiller.net", user_id: null };

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
      if (sql.includes("s.id IN")) {
        return { results: [sender] };
      }
      return { results: sql.includes("s.user_id IS NULL") ? [sender] : [] };
    }
    return { results: [] };
  };

  const makeRun = async (sql: string, args: unknown[]) => {
    if (sql.includes("INSERT OR IGNORE INTO idempotency_keys")) {
      const key = String(args[0]);
      if (state.idempotency.has(key)) {
        return { meta: { changes: 0 } };
      }
      state.idempotency.set(key, {
        status: "pending",
        request_hash: String(args[1]),
        source: String(args[2]),
        response_json: null,
        created_at: Number(args[3]),
        updated_at: Number(args[4]),
        expires_at: Number(args[5]),
      });
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
    if (sql.includes("UPDATE idempotency_keys SET status = 'in_flight'")) {
      if (state.failInFlightTransition) return { meta: { changes: 0 } };
      const key = String(args[1]);
      const existing = state.idempotency.get(key);
      if (
        existing === undefined ||
        existing.status !== "pending" ||
        existing.request_hash !== String(args[2]) ||
        existing.source !== String(args[3]) ||
        existing.expires_at <= Number(args[4])
      ) {
        return { meta: { changes: 0 } };
      }
      state.idempotency.set(key, { ...existing, status: "in_flight", updated_at: Number(args[0]) });
      return { meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE idempotency_keys SET status = 'completed'")) {
      if (state.failIdempotencyCompletion) throw new Error("simulated idempotency completion failure");
      const key = String(args[3]);
      const existing = state.idempotency.get(key);
      if (existing === undefined || existing.status !== "in_flight" || existing.request_hash !== String(args[4]) || existing.source !== String(args[5])) {
        return { meta: { changes: 0 } };
      }
      state.idempotency.set(key, {
        ...existing,
        status: "completed",
        response_json: String(args[0]),
        updated_at: Number(args[1]),
        expires_at: Number(args[2]),
      });
      return { meta: { changes: 1 } };
    }
    if (sql.includes("DELETE FROM idempotency_keys WHERE idempotency_key = ?")) {
      const key = String(args[0]);
      const existing = state.idempotency.get(key);
      if ((existing?.status === "pending" || existing?.status === "in_flight") && existing.request_hash === String(args[1]) && existing.source === String(args[2])) {
        state.idempotency.delete(key);
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    }
    if (sql.includes("SET request_hash = ?, source = ?, status = 'pending'")) {
      const key = String(args[5]);
      const existing = state.idempotency.get(key);
      if (existing === undefined || existing.expires_at > Number(args[6])) return { meta: { changes: 0 } };
      state.idempotency.set(key, {
        status: "pending",
        request_hash: String(args[0]),
        source: String(args[1]),
        response_json: null,
        created_at: Number(args[2]),
        updated_at: Number(args[3]),
        expires_at: Number(args[4]),
      });
      return { meta: { changes: 1 } };
    }
    if (sql.includes("SET status = 'pending', response_json = NULL")) {
      const key = String(args[3]);
      const existing = state.idempotency.get(key);
      if (existing === undefined || existing.status !== "failed" || existing.request_hash !== String(args[4]) || existing.source !== String(args[5])) {
        return { meta: { changes: 0 } };
      }
      state.idempotency.set(key, {
        ...existing,
        status: "pending",
        response_json: null,
        created_at: Number(args[0]),
        updated_at: Number(args[1]),
        expires_at: Number(args[2]),
      });
      return { meta: { changes: 1 } };
    }
    if (sql.includes("SET response_json = NULL, created_at = ?")) {
      const key = String(args[3]);
      const existing = state.idempotency.get(key);
      if (
        existing === undefined ||
        existing.status !== "pending" ||
        existing.request_hash !== String(args[4]) ||
        existing.source !== String(args[5]) ||
        existing.updated_at > Number(args[6]) ||
        existing.expires_at <= Number(args[7])
      ) {
        return { meta: { changes: 0 } };
      }
      state.idempotency.set(key, {
        ...existing,
        response_json: null,
        created_at: Number(args[0]),
        updated_at: Number(args[1]),
        expires_at: Number(args[2]),
      });
      return { meta: { changes: 1 } };
    }
    if (sql.includes("INSERT INTO send_events")) {
      if (state.failSendEvents) throw new Error("simulated send event failure");
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

function httpSendRequest(
  env: Record<string, unknown>,
  idempotencyKey: string,
  subject = "API",
): Promise<Response> {
  const mime = `From: gmail@alexmiller.net\r\nTo: alex@example.net\r\nSubject: ${subject}\r\n\r\nBody\r\n`;
  return app.request(
    "/send",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiSecret}`,
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify({
        from: "gmail@alexmiller.net",
        recipients: ["alex@example.net"],
        raw: Buffer.from(mime, "utf8").toString("base64"),
      }),
    },
    env,
  );
}

function cloudflareSuccess(result: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      success: true,
      errors: [],
      messages: [],
      result: { delivered: [], queued: [], permanent_bounces: [], ...result },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("relay endpoints", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
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

  it("authenticates SMTP credentials with domain-wide senders inherited through /relay/auth", async () => {
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

  it("preserves the v1.0 SMTP idempotency key while sending the Message-ID anchor", async () => {
    const cfFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        from: "gmail@alexmiller.net",
        recipients: ["alex@example.net"],
        mime_message:
          "From: Alex <gmail@alexmiller.net>\r\n" +
          "Message-ID: <gmail-original@mail.gmail.com>\r\n" +
          "Subject: Thread anchor\r\n" +
          "References: <gmail-original@mail.gmail.com>\r\n\r\n" +
          "Body\r\n",
      });
      return new Response(JSON.stringify({ success: true, errors: [], messages: [], result: { delivered: [], queued: [], permanent_bounces: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", cfFetch);

    const body = new TextEncoder().encode(
      "Received: by mail.example with SMTP id anchor\r\n" +
        "From: Alex <gmail@alexmiller.net>\r\n" +
        "Message-ID: <gmail-original@mail.gmail.com>\r\n" +
        "Subject: Thread anchor\r\n\r\n" +
        "Body\r\n",
    );
    const response = await app.request(
      "/relay/send",
      {
        method: "POST",
        headers: await signedSendHeaders(body, "message-id-anchor-nonce", {
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
    // Frozen from v1.0, which hashed the capture-hop-stripped MIME before any
    // delivery-only transformation.
    await expect(response.json()).resolves.toMatchObject({
      idempotency_key: "0ba3578145d1f91b0e2407bc93e89ac3c243ca0b5343bc2dabbf09dbb1bbfe7b",
      stripped_mime_sha256: "17eb540820202f7b4cb522c6d2189e5003aa4e1e3f5816618f71f9accb2d8d50",
      stripped_mime_size_bytes: 112,
    });
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

  it("bounds streamed relay request bodies without relying on Content-Length", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(16 * 1024));
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    });
    const request = new Request("http://localhost/relay/auth", {
      method: "POST",
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    const response = await app.request(request, undefined, makeEnv());

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: "auth_body_too_large" });
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
          "From: Alex <gmail@alexmiller.net>\r\nTo: alex@example.net\r\nCc: Copy <copy@example.net>\r\nMessage-ID: <http-client@example.net>\r\nSubject: API\r\n\r\nBody\r\n",
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
      "From: Alex <gmail@alexmiller.net>\r\nTo: alex@example.net\r\nCc: Copy <copy@example.net>\r\nBcc: hidden@example.net\r\nMessage-ID: <http-client@example.net>\r\nSubject: API\r\n\r\nBody\r\n";
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

  it("treats Cloudflare auth/configuration failures as retryable without leaking provider text", async () => {
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

    expect(response.status).toBe(502);
    const responseJson = await response.json();
    expect(responseJson).toMatchObject({
      ok: false,
      error_code: "cloudflare_send_raw_rejected",
      cf_error_code: "10000",
      cf_response: { success: false, errors: [{ code: 10000 }], messages: [] },
    });
    expect(JSON.stringify(responseJson.cf_response)).not.toContain("alex@example.net");
    expect((env.D1_MAIN as D1Database & { state: FakeD1State }).state.idempotency.size).toBe(0);
  });

  it.each([401, 404, 429, 500, 503])("releases idempotency after a known retryable Cloudflare %i response", async (status) => {
    const env = makeEnv();
    const cfFetch = vi.fn(async () =>
      new Response(JSON.stringify({ success: false, errors: [{ code: 10000 }], messages: [] }), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", cfFetch);

    expect((await httpSendRequest(env, `retryable-${status}`)).status).toBe(502);
    expect((env.D1_MAIN as D1Database & { state: FakeD1State }).state.idempotency.size).toBe(0);
    expect((await httpSendRequest(env, `retryable-${status}`)).status).toBe(502);
    expect(cfFetch).toHaveBeenCalledTimes(2);
  });

  it("replays an all-recipient permanent bounce without resending", async () => {
    const env = makeEnv();
    const cfFetch = vi.fn(async () => cloudflareSuccess({ permanent_bounces: ["alex@example.net"] }));
    vi.stubGlobal("fetch", cfFetch);

    const first = await httpSendRequest(env, "permanent-bounce");
    const second = await httpSendRequest(env, "permanent-bounce");

    expect(first.status).toBe(422);
    await expect(first.json()).resolves.toMatchObject({ ok: false, error_code: "all_recipients_bounced" });
    expect(second.status).toBe(422);
    expect(second.headers.get("x-relay-idempotency-replay")).toBe("1");
    expect(cfFetch).toHaveBeenCalledOnce();
  });

  it.each([400, 422])("treats a documented HTTP %i validation rejection as permanent without source metadata", async (status) => {
    const env = makeEnv();
    const cfFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          success: false,
          errors: [{ code: 1000, message: "invalid MIME" }],
          messages: [],
        }),
        { status, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", cfFetch);

    const first = await httpSendRequest(env, "mime-validation");
    const second = await httpSendRequest(env, "mime-validation");

    expect(first.status).toBe(422);
    await expect(first.json()).resolves.toMatchObject({ ok: false, error_code: "cloudflare_send_raw_permanent_failure" });
    expect(second.status).toBe(422);
    expect(second.headers.get("x-relay-idempotency-replay")).toBe("1");
    expect(cfFetch).toHaveBeenCalledOnce();
  });

  it.each([400, 422])("keeps an unstructured HTTP %i provider response retryable", async (status) => {
    const env = makeEnv();
    const cfFetch = vi.fn(async () => new Response("not-json", { status }));
    vi.stubGlobal("fetch", cfFetch);

    expect((await httpSendRequest(env, `unknown-${status}`)).status).toBe(502);
    expect((await httpSendRequest(env, `unknown-${status}`)).status).toBe(502);
    expect(cfFetch).toHaveBeenCalledTimes(2);
  });

  it("holds an in-flight reservation when the provider transport outcome is ambiguous", async () => {
    const env = makeEnv();
    const cfFetch = vi.fn(async () => {
      throw new TypeError("simulated network failure");
    });
    vi.stubGlobal("fetch", cfFetch);

    const first = await httpSendRequest(env, "ambiguous-fetch");
    const second = await httpSendRequest(env, "ambiguous-fetch");

    expect(first.status).toBe(502);
    await expect(first.json()).resolves.toMatchObject({ ok: false, error_code: "cloudflare_send_raw_ambiguous" });
    expect(second.status).toBe(409);
    await expect(second.json()).resolves.toMatchObject({ ok: false, error: "idempotency_pending" });
    const row = (env.D1_MAIN as D1Database & { state: FakeD1State }).state.idempotency.get("http:key_1:ambiguous-fetch");
    expect(row?.status).toBe("in_flight");
    if (row !== undefined) row.updated_at -= 301;
    expect((await httpSendRequest(env, "ambiguous-fetch")).status).toBe(409);
    expect(cfFetch).toHaveBeenCalledOnce();
  });

  it("holds an idempotency reservation for a malformed successful provider response", async () => {
    const env = makeEnv();
    const cfFetch = vi.fn(async () => new Response("not-json", { status: 200 }));
    vi.stubGlobal("fetch", cfFetch);

    expect((await httpSendRequest(env, "ambiguous-body")).status).toBe(502);
    expect((await httpSendRequest(env, "ambiguous-body")).status).toBe(409);
    expect(cfFetch).toHaveBeenCalledOnce();
  });

  it("bounds provider response bodies and treats oversized success responses as ambiguous", async () => {
    const env = makeEnv();
    const cfFetch = vi.fn(async () => new Response("x".repeat(256 * 1024 + 1), { status: 200 }));
    vi.stubGlobal("fetch", cfFetch);

    expect((await httpSendRequest(env, "oversized-provider-body")).status).toBe(502);
    expect((await httpSendRequest(env, "oversized-provider-body")).status).toBe(409);
    expect(cfFetch).toHaveBeenCalledOnce();
  });

  it("requires an in-flight claim before provider I/O and recovers a stale pending reservation", async () => {
    const env = makeEnv();
    const d1 = env.D1_MAIN as D1Database & { state: FakeD1State };
    d1.state.failInFlightTransition = true;
    const cfFetch = vi.fn(async () => cloudflareSuccess());
    vi.stubGlobal("fetch", cfFetch);

    expect((await httpSendRequest(env, "stale-pending")).status).toBe(409);
    expect(cfFetch).not.toHaveBeenCalled();
    const row = d1.state.idempotency.get("http:key_1:stale-pending");
    expect(row).toBeDefined();
    if (row !== undefined) row.updated_at -= 301;
    d1.state.failInFlightTransition = false;

    expect((await httpSendRequest(env, "stale-pending")).status).toBe(200);
    expect(cfFetch).toHaveBeenCalledOnce();
  });

  it("retries legacy failed rows that cached a transient response", async () => {
    const env = makeEnv();
    const cfFetch = vi
      .fn<() => Promise<Response>>()
      .mockRejectedValueOnce(new TypeError("simulated network failure"))
      .mockResolvedValueOnce(cloudflareSuccess());
    vi.stubGlobal("fetch", cfFetch);

    expect((await httpSendRequest(env, "legacy-transient")).status).toBe(502);
    const row = (env.D1_MAIN as D1Database & { state: FakeD1State }).state.idempotency.get("http:key_1:legacy-transient");
    expect(row).toBeDefined();
    if (row !== undefined) {
      row.status = "failed";
      row.response_json = JSON.stringify({ ok: false, status: 502, body: { ok: false, error: "legacy_transient" } });
    }

    expect((await httpSendRequest(env, "legacy-transient")).status).toBe(200);
    expect(cfFetch).toHaveBeenCalledTimes(2);
  });

  it("replays legacy failed rows that cached a permanent response", async () => {
    const env = makeEnv();
    const cfFetch = vi.fn(async () => {
      throw new TypeError("simulated network failure");
    });
    vi.stubGlobal("fetch", cfFetch);

    expect((await httpSendRequest(env, "legacy-permanent")).status).toBe(502);
    const row = (env.D1_MAIN as D1Database & { state: FakeD1State }).state.idempotency.get("http:key_1:legacy-permanent");
    expect(row).toBeDefined();
    if (row !== undefined) {
      row.status = "failed";
      row.response_json = JSON.stringify({ ok: false, status: 422, body: { ok: false, error_code: "all_recipients_bounced" } });
    }

    const replay = await httpSendRequest(env, "legacy-permanent");
    expect(replay.status).toBe(422);
    expect(replay.headers.get("x-relay-idempotency-replay")).toBe("1");
    expect(cfFetch).toHaveBeenCalledOnce();
  });

  it("atomically reuses an expired idempotency key for a different request", async () => {
    const env = makeEnv();
    const cfFetch = vi
      .fn<() => Promise<Response>>()
      .mockRejectedValueOnce(new TypeError("simulated network failure"))
      .mockResolvedValueOnce(cloudflareSuccess());
    vi.stubGlobal("fetch", cfFetch);

    expect((await httpSendRequest(env, "expired-key", "First")).status).toBe(502);
    const d1 = env.D1_MAIN as D1Database & { state: FakeD1State };
    const row = d1.state.idempotency.get("http:key_1:expired-key");
    expect(row).toBeDefined();
    if (row !== undefined) row.expires_at = Math.floor(Date.now() / 1000) - 1;

    expect((await httpSendRequest(env, "expired-key", "Second")).status).toBe(200);
    expect(cfFetch).toHaveBeenCalledTimes(2);
  });

  it("does not let the KV fast path replay an expired terminal response", async () => {
    const env = makeEnv();
    const cfFetch = vi.fn(async () => cloudflareSuccess());
    vi.stubGlobal("fetch", cfFetch);

    expect((await httpSendRequest(env, "expired-terminal")).status).toBe(200);
    const d1 = env.D1_MAIN as D1Database & { state: FakeD1State };
    const row = d1.state.idempotency.get("http:key_1:expired-terminal");
    expect(row).toBeDefined();
    if (row !== undefined) row.expires_at = Math.floor(Date.now() / 1000) - 1;

    const kv = env.KV_HOT as KVNamespace & { state: Map<string, string> };
    const cachedKey = "idem:http:key_1:expired-terminal";
    const cached = JSON.parse(kv.state.get(cachedKey) ?? "{}") as Record<string, unknown>;
    cached.expires_at = Math.floor(Date.now() / 1000) - 1;
    kv.state.set(cachedKey, JSON.stringify(cached));

    expect((await httpSendRequest(env, "expired-terminal")).status).toBe(200);
    expect(cfFetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    { name: "success", response: cloudflareSuccess(), status: 200 },
    { name: "permanent bounce", response: cloudflareSuccess({ permanent_bounces: ["alex@example.net"] }), status: 422 },
  ])("returns a known $name and fences retries when audit and completion persistence fail", async ({ response, status }) => {
    const env = makeEnv();
    const d1 = env.D1_MAIN as D1Database & { state: FakeD1State };
    d1.state.failSendEvents = true;
    d1.state.failIdempotencyCompletion = true;
    const cfFetch = vi.fn(async () => response.clone());
    vi.stubGlobal("fetch", cfFetch);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const idempotencyKey = `persistence-${status}`;
    expect((await httpSendRequest(env, idempotencyKey)).status).toBe(status);
    const row = d1.state.idempotency.get(`http:key_1:${idempotencyKey}`);
    expect(row?.status).toBe("in_flight");
    if (row !== undefined) row.updated_at -= 301;
    expect((await httpSendRequest(env, idempotencyKey)).status).toBe(409);
    expect(cfFetch).toHaveBeenCalledOnce();
  });

  it("does not overturn provider success when KV replay caching fails", async () => {
    const kv = makeKv();
    const originalPut = kv.put.bind(kv);
    kv.put = vi.fn(async (key: string, value: string, options?: KVNamespacePutOptions) => {
      if (key.startsWith("idem:")) throw new Error("simulated KV failure");
      await originalPut(key, value, options);
    });
    const env = makeEnv({ KV_HOT: kv });
    vi.stubGlobal("fetch", vi.fn(async () => cloudflareSuccess()));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect((await httpSendRequest(env, "kv-failure")).status).toBe(200);
    const row = (env.D1_MAIN as D1Database & { state: FakeD1State }).state.idempotency.get("http:key_1:kv-failure");
    expect(row?.status).toBe("completed");
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

  it("rejects oversized or non-printable HTTP idempotency keys", async () => {
    const oversized = await httpSendRequest(makeEnv(), "x".repeat(256));
    expect(oversized.status).toBe(400);
    await expect(oversized.json()).resolves.toMatchObject({ ok: false, error: "invalid_idempotency_key" });

    const spaced = await httpSendRequest(makeEnv(), "not clean");
    expect(spaced.status).toBe(400);
    await expect(spaced.json()).resolves.toMatchObject({ ok: false, error: "invalid_idempotency_key" });
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
    expect(d1.state.idempotency.has("http:key_1:quota-2")).toBe(false);
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

describe("anchorClientMessageIdInReferences", () => {
  it("appends the client Message-ID to an existing folded References chain", () => {
    expect(
      anchorClientMessageIdInReferences(
        "From: a@example.com\r\n" +
          "Message-ID: <current@example.com>\r\n" +
          "References: <root@example.com>\r\n\t<parent@example.com>\r\n\r\n" +
          "Hello\r\n",
      ),
    ).toBe(
      "From: a@example.com\r\n" +
        "Message-ID: <current@example.com>\r\n" +
        "References: <root@example.com> <parent@example.com> <current@example.com>\r\n\r\n" +
        "Hello\r\n",
    );
  });

  it("inherits In-Reply-To when References is absent", () => {
    expect(
      anchorClientMessageIdInReferences(
        "From: a@example.com\r\nMessage-ID: <current@example.com>\r\nIn-Reply-To: <parent@example.com>\r\n\r\nHello\r\n",
      ),
    ).toContain("References: <parent@example.com> <current@example.com>\r\n");
  });

  it("folds generated References lines at message-ID boundaries", () => {
    const references = Array.from({ length: 8 }, (_, index) => `<thread-${index}@example.com>`).join(" ");
    const output = anchorClientMessageIdInReferences(
      `From: a@example.com\r\nSubject: A folded\r\n subject\r\nMessage-ID: <current@example.com>\r\nReferences: ${references}\r\n\r\nHello\r\n`,
    );
    const headerLines = output.slice(0, output.indexOf("\r\n\r\n")).split("\r\n");
    const referencesIndex = headerLines.findIndex((line) => line.startsWith("References:"));
    const referenceLines = headerLines.slice(referencesIndex);

    expect(referencesIndex).toBeGreaterThanOrEqual(0);
    expect(referenceLines.length).toBeGreaterThan(1);
    expect(referenceLines.every((line) => new TextEncoder().encode(line).byteLength <= 78)).toBe(true);
    expect(output).toContain("\r\n <thread-");
    expect(output.replaceAll("\r\n", "")).not.toContain("\n");
    expect(anchorClientMessageIdInReferences(output)).toBe(output);
  });

  it("never generates a References line beyond the RFC hard limit", () => {
    const longLocalPart = "a".repeat(970);
    const output = anchorClientMessageIdInReferences(
      `From: a@example.com\r\nMessage-ID: <current@example.com>\r\nReferences: <${longLocalPart}@example.com>\r\n\r\nHello\r\n`,
    );
    const headerLines = output.slice(0, output.indexOf("\r\n\r\n")).split("\r\n");

    expect(headerLines.every((line) => new TextEncoder().encode(line).byteLength <= 998)).toBe(true);
    expect(output).toContain("\r\n <current@example.com>\r\n");
  });

  it("moves a first token to a continuation line when the field name would push it beyond 78 bytes", () => {
    const firstReference = `<${"a".repeat(54)}@example.com>`;
    const output = anchorClientMessageIdInReferences(
      `From: a@example.com\r\nMessage-ID: <current@example.com>\r\nReferences: ${firstReference}\r\n\r\nHello\r\n`,
    );
    const referenceLines = output
      .slice(output.indexOf("References:"), output.indexOf("\r\n\r\n"))
      .split("\r\n");

    expect(referenceLines[0]).toBe("References:");
    expect(referenceLines.every((line) => new TextEncoder().encode(line).byteLength <= 78)).toBe(true);
  });

  it("leaves MIME unchanged when a References token cannot fit within the RFC hard limit", () => {
    const mime =
      `From: a@example.com\r\nMessage-ID: <current@example.com>\r\nReferences: <${"a".repeat(990)}@example.com>\r\n\r\nHello\r\n`;

    expect(anchorClientMessageIdInReferences(mime)).toBe(mime);
  });

  it("does not duplicate an existing client Message-ID anchor", () => {
    const mime =
      "From: a@example.com\r\nMessage-ID: <current@example.com>\r\nReferences: <root@example.com> <current@example.com>\r\n\r\nHello\r\n";
    expect(anchorClientMessageIdInReferences(mime)).toBe(mime);
  });

  it("leaves MIME without a common, valid Message-ID unchanged", () => {
    const missing = "From: a@example.com\r\nSubject: Missing\r\n\r\nHello\r\n";
    const malformed = "From: a@example.com\r\nMessage-ID: not-a-message-id\r\n\r\nHello\r\n";
    expect(anchorClientMessageIdInReferences(missing)).toBe(missing);
    expect(anchorClientMessageIdInReferences(malformed)).toBe(malformed);
  });
});
