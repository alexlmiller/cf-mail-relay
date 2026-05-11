import { describe, expect, it } from "vitest";
import app, { authorizeSpike, buildSendRawBody, decodeMimeMessage, parseRecipients } from "../src/spike";

const env = {
  CF_ACCOUNT_ID: "account_123",
  CF_API_TOKEN: "cf_token",
  MS0_SPIKE_TOKEN: "spike_token",
};

describe("MS0 spike helpers", () => {
  it("builds the documented send_raw JSON body shape", () => {
    expect(buildSendRawBody("alex@example.com", ["one@example.net"], "From: alex@example.com\r\n\r\nHello")).toEqual({
      from: "alex@example.com",
      recipients: ["one@example.net"],
      mime_message: "From: alex@example.com\r\n\r\nHello",
    });
  });

  it("accepts MIME bytes that round-trip through UTF-8 unchanged", () => {
    const input = new TextEncoder().encode("Subject: snowman \u2603\r\n\r\nBody\r\n");
    const decoded = decodeMimeMessage(input);

    expect(decoded).toEqual({ ok: true, mimeMessage: "Subject: snowman \u2603\r\n\r\nBody\r\n" });
  });

  it("rejects MIME bytes that cannot be represented as UTF-8 JSON safely", () => {
    const decoded = decodeMimeMessage(new Uint8Array([0x53, 0x75, 0x62, 0xff, 0x0d, 0x0a]));

    expect(decoded).toEqual({ ok: false });
  });

  it("parses comma-separated recipients with whitespace", () => {
    expect(parseRecipients(" one@example.net, two@example.org ,,three@example.com ")).toEqual([
      "one@example.net",
      "two@example.org",
      "three@example.com",
    ]);
  });

  it("requires the configured spike token", () => {
    expect(authorizeSpike("Bearer spike_token", undefined, "spike_token")).toBeNull();
    expect(authorizeSpike(undefined, "spike_token", "spike_token")).toBeNull();
    expect(authorizeSpike("Bearer wrong", undefined, "spike_token")).toBe("unauthorized");
    expect(authorizeSpike("Bearer spike_token", undefined, undefined)).toBe("ms0_spike_token_not_configured");
  });
});

describe("POST /spike", () => {
  it("returns metadata without calling Cloudflare in dry-run mode", async () => {
    const response = await app.request(
      "/spike?from=alex@example.com&recipients=one@example.net&dry_run=1",
      {
        method: "POST",
        headers: {
          authorization: "Bearer spike_token",
          "content-type": "message/rfc822",
        },
        body: "From: alex@example.com\r\nTo: one@example.net\r\n\r\nHello\r\n",
      },
      env,
    );

    expect(response.status).toBe(200);
    const json = (await response.json()) as Record<string, unknown>;
    expect(json["ok"]).toBe(true);
    expect(json["dry_run"]).toBe(true);
    expect(json["mime_size_bytes"]).toBe(54);
    expect(json["mime_round_trip_verified"]).toBe(true);
    expect(json["cf_status"]).toBeNull();
  });

  it("rejects invalid UTF-8 MIME before attempting send_raw", async () => {
    const response = await app.request(
      "/spike?from=alex@example.com&recipients=one@example.net",
      {
        method: "POST",
        headers: {
          authorization: "Bearer spike_token",
          "content-type": "message/rfc822",
        },
        body: new Uint8Array([0xff]),
      },
      env,
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: "mime_not_utf8_json_safe" });
  });
});
