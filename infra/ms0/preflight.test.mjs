import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { main, parseArgs } from "./preflight.mjs";

describe("parseArgs", () => {
  it("parses required preflight options", () => {
    const options = parseArgs([
      "--account-id",
      "acc_123",
      "--zone-id",
      "zone_123",
      "--domain",
      "Mail.Example.COM.",
      "--token-env",
      "CF_TOKEN",
    ]);

    assert.equal(options.accountId, "acc_123");
    assert.equal(options.zoneId, "zone_123");
    assert.equal(options.domain, "mail.example.com");
    assert.equal(options.tokenEnv, "CF_TOKEN");
  });

  it("rejects unknown options", () => {
    assert.throws(() => parseArgs(["--wat"]), /Unknown option/);
  });
});

describe("main", () => {
  it("passes when account, zone, sending subdomain, and DNS records are visible", async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      const parsed = new URL(url);
      if (parsed.pathname === "/client/v4/user/tokens/verify") {
        return jsonResponse({ success: true, result: { status: "active" } });
      }
      if (parsed.pathname === "/client/v4/accounts/acc_123") {
        return jsonResponse({ success: true, result: { name: "Example Account" } });
      }
      if (parsed.pathname === "/client/v4/zones/zone_123") {
        return jsonResponse({ success: true, result: { name: "example.com" } });
      }
      if (parsed.pathname === "/client/v4/zones/zone_123/email/sending/subdomains") {
        return jsonResponse({
          success: true,
          result: [
            {
              enabled: true,
              name: "example.com",
              tag: "subdomain_123",
              dkim_selector: "cf2026",
              return_path_domain: "cf-bounce.example.com",
            },
          ],
        });
      }
      if (parsed.pathname === "/client/v4/zones/zone_123/email/sending/subdomains/subdomain_123/dns") {
        return jsonResponse({ success: true, result: [{ type: "TXT", name: "cf-bounce.example.com" }] });
      }
      return jsonResponse({ success: false }, 404);
    };

    const result = await main(
      ["--account-id", "acc_123", "--zone-id", "zone_123", "--domain", "mail.example.com", "--api-base", "https://api.cloudflare.com/client/v4"],
      { CLOUDFLARE_API_TOKEN: "token" },
      fetchImpl,
    );

    assert.equal(result.ok, true);
    assert.deepEqual(
      result.checks.map((check) => [check.name, check.status]),
      [
        ["api_token", "pass"],
        ["account_access", "pass"],
        ["zone_access", "pass"],
        ["sending_subdomain", "pass"],
        ["sending_dns_records", "pass"],
        ["sandbox_status", "warn"],
      ],
    );
    assert.equal(calls[0].init.headers.authorization, "Bearer token");
  });

  it("fails when no enabled sending subdomain matches", async () => {
    const fetchImpl = async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/client/v4/user/tokens/verify") {
        return jsonResponse({ success: true, result: { status: "active" } });
      }
      if (parsed.pathname === "/client/v4/accounts/acc_123") {
        return jsonResponse({ success: true, result: { name: "Example Account" } });
      }
      if (parsed.pathname === "/client/v4/zones/zone_123") {
        return jsonResponse({ success: true, result: { name: "example.com" } });
      }
      if (parsed.pathname === "/client/v4/zones/zone_123/email/sending/subdomains") {
        return jsonResponse({ success: true, result: [{ enabled: false, name: "other.example.com", tag: "other" }] });
      }
      return jsonResponse({ success: false }, 404);
    };

    const result = await main(
      ["--account-id", "acc_123", "--zone-id", "zone_123", "--domain", "mail.example.com"],
      { CLOUDFLARE_API_TOKEN: "token" },
      fetchImpl,
    );

    assert.equal(result.ok, false);
    assert.equal(result.checks.find((check) => check.name === "sending_subdomain").status, "fail");
    assert.equal(result.checks.find((check) => check.name === "sending_dns_records").status, "skip");
  });
});

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}
