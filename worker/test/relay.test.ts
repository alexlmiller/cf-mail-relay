import { afterEach, describe, expect, it, vi } from "vitest";
import app, { stripCaptureHopHeaders } from "../src/index";
import { sha256Hex, signRelayRequest } from "../src/hmac";

const hmacSecret = "relay-secret";
const keyId = "rel_test";

function makeKv(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
  } as unknown as KVNamespace;
}

function makeEnv(): Record<string, unknown> {
  return {
    KV_HOT: makeKv(),
    CF_ACCOUNT_ID: "account_123",
    CF_API_TOKEN: "cf_token",
    RELAY_HMAC_SECRET_CURRENT: hmacSecret,
    RELAY_HMAC_KEY_ID: keyId,
    RELAY_AUTH_USERNAME: "gmail",
    RELAY_AUTH_PASSWORD: "secret",
    RELAY_ALLOWED_SENDERS: "gmail@alexmiller.net",
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
    },
    hmacSecret,
  );

  return {
    "x-relay-key-id": keyId,
    "x-relay-timestamp": timestamp,
    "x-relay-nonce": nonce,
    "x-relay-body-sha256": bodySha256,
    "x-relay-version": "0.1.0-ms1",
    "x-relay-signature": signature,
  };
}

describe("relay endpoints", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
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
      ttl_seconds: 60,
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
        headers: {
          ...(await signedHeaders("/relay/send", body, "send-nonce")),
          "x-relay-envelope-from": "gmail@alexmiller.net",
          "x-relay-recipients": "alex@example.net",
        },
        body,
      },
      makeEnv(),
    );

    expect(response.status).toBe(200);
    expect(cfFetch).toHaveBeenCalledOnce();
    await expect(response.json()).resolves.toMatchObject({ ok: true, cf_status: 200 });
  });
});

describe("stripCaptureHopHeaders", () => {
  it("preserves user-authored headers and body", () => {
    expect(stripCaptureHopHeaders("Received: x\r\nFrom: a@example.com\r\nSubject: Test\r\n\r\nHello\r\n")).toBe(
      "From: a@example.com\r\nSubject: Test\r\n\r\nHello\r\n",
    );
  });
});
