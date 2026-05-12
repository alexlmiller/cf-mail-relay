import { describe, expect, it } from "vitest";
import { cloudflareResponseCategories, safeCloudflareArraySummary, sanitizeCloudflareResponse } from "../src/cf-response";

describe("Cloudflare response sanitization", () => {
  it("keeps only safe counts, codes, and bounded categorical data", () => {
    expect(
      sanitizeCloudflareResponse({
        success: true,
        errors: [{ code: 1000, message: "bad recipient alex@example.net" }, { code: "E2", message: "Provider unavailable" }],
        messages: [{ code: "note", message: "x".repeat(300) }],
        result: {
          delivered: [{ email: "alex@example.net", status: "Delivered", error_code: "smtp:250" }],
          queued: ["queued@example.net"],
          permanent_bounces: [{ reason: "user_unknown" }, { reason: "bad user@example.net" }],
        },
      }),
    ).toEqual({
      success: true,
      errors: [{ code: 1000 }, { code: "e2", message: "Provider unavailable" }],
      messages: [{ code: "note", message: "x".repeat(256) }],
      result: {
        delivered: { count: 1, categories: ["delivered", "smtp:250"] },
        queued: { count: 1 },
        permanent_bounces: { count: 2, categories: ["user_unknown"] },
      },
    });
  });

  it("does not pass through non-object provider payloads", () => {
    expect(sanitizeCloudflareResponse("alex@example.net failed")).toEqual({ non_object_response: true });
  });

  it("drops unsafe string codes", () => {
    expect(sanitizeCloudflareResponse({ errors: [{ code: "bad alex@example.net" }, { code: "SAFE_CODE" }] })).toEqual({
      errors: [{}, { code: "safe_code" }],
    });
  });

  it("uses the strict category filter for audit summaries too", () => {
    expect(
      JSON.parse(
        safeCloudflareArraySummary(
          JSON.stringify([{ reason: "User_Unknown" }, { status: "bad user@example.net" }, { errorCode: "TEMP-FAIL" }]),
        ),
      ),
    ).toEqual({ count: 3, categories: ["temp-fail", "user_unknown"] });
  });

  it("ignores primitive array entries and unsafe category text", () => {
    expect(cloudflareResponseCategories(["address@example.net", { reason: "OK" }, { status: "a".repeat(65) }])).toEqual(["ok"]);
  });
});
