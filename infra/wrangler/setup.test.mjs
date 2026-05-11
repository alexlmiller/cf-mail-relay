import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { main, parseArgs } from "./setup.mjs";

describe("setup parseArgs", () => {
  it("parses repeatable domains and core options", () => {
    const options = parseArgs([
      "--account-id",
      "acc_123",
      "--domain",
      "Example.COM.",
      "--domain",
      "other.example.com",
      "--d1-database-id",
      "d1_123",
      "--kv-namespace-id",
      "kv_123",
    ], {});

    assert.equal(options.accountId, "acc_123");
    assert.deepEqual(options.domains, ["example.com", "other.example.com"]);
    assert.equal(options.d1DatabaseId, "d1_123");
    assert.equal(options.kvNamespaceId, "kv_123");
  });

  it("rejects unknown options", () => {
    assert.throws(() => parseArgs(["--wat"], {}), /Unknown option/);
  });
});

describe("setup main", () => {
  it("returns a dry-run plan without requiring a token", async () => {
    const result = await main(["--account-id", "acc_123", "--domain", "example.com", "--dry-run"], {});

    assert.equal(result.ok, true);
    assert.equal(result.dry_run, true);
    assert.equal(result.plan.domains[0].domain, "example.com");
    assert.ok(result.plan.commands.some((command) => command.includes("wrangler d1 create")));
  });

  it("passes preflight checks when Cloudflare resources are visible", async () => {
    const fetchImpl = async (url) => {
      const path = new URL(url).pathname;
      const search = new URL(url).searchParams;
      if (path === "/client/v4/user/tokens/verify") return json({ success: true, result: { status: "active" } });
      if (path === "/client/v4/accounts/acc_123") return json({ success: true, result: { name: "Example" } });
      if (path === "/client/v4/accounts/acc_123/subscriptions") {
        return json({ success: true, result: [{ rate_plan: { name: "Workers Paid" } }] });
      }
      if (path === "/client/v4/accounts/acc_123/d1/database/d1_123") {
        return json({ success: true, result: { name: "cf-mail-relay" } });
      }
      if (path === "/client/v4/accounts/acc_123/storage/kv/namespaces") {
        return json({ success: true, result: [{ id: "kv_123", title: "cf-mail-relay-hot" }] });
      }
      if (path === "/client/v4/accounts/acc_123/access/apps") {
        return json({ success: true, result: [{ id: "app_123", name: "cf-mail-relay-admin" }] });
      }
      if (path === "/client/v4/accounts/acc_123/workers/scripts/cf-mail-relay-worker/secrets") {
        return json({ success: true, result: ["CF_API_TOKEN", "CREDENTIAL_PEPPER", "METADATA_PEPPER", "RELAY_HMAC_SECRET_CURRENT", "BOOTSTRAP_SETUP_TOKEN"].map((name) => ({ name })) });
      }
      if (path === "/client/v4/zones" && search.get("name") === "example.com") {
        return json({ success: true, result: [{ id: "zone_123", name: "example.com" }] });
      }
      if (path === "/client/v4/zones/zone_123/email/sending/subdomains") {
        return json({ success: true, result: [{ enabled: true, name: "example.com", tag: "sub_123", return_path_domain: "cf-bounce.example.com" }] });
      }
      if (path === "/client/v4/zones/zone_123/email/sending/subdomains/sub_123/dns") {
        return json({ success: true, result: [{ type: "TXT", name: "cf-bounce.example.com" }] });
      }
      return json({ success: false, errors: [{ code: 1000, message: `unexpected ${path}` }] }, 404);
    };

    const result = await main([
      "--account-id",
      "acc_123",
      "--domain",
      "example.com",
      "--d1-database-id",
      "d1_123",
      "--kv-namespace-id",
      "kv_123",
    ], { CLOUDFLARE_API_TOKEN: "token" }, fetchImpl);

    assert.equal(result.ok, true);
    assert.equal(result.checks.find((check) => check.name === "worker_secrets").status, "pass");
    assert.equal(result.checks.find((check) => check.name === "domain:example.com:email_sending").status, "pass");
  });

  it("fails when required Worker secrets are missing", async () => {
    const fetchImpl = async (url) => {
      const path = new URL(url).pathname;
      const search = new URL(url).searchParams;
      if (path === "/client/v4/user/tokens/verify") return json({ success: true });
      if (path === "/client/v4/accounts/acc_123") return json({ success: true, result: {} });
      if (path === "/client/v4/accounts/acc_123/subscriptions") return json({ success: true, result: [] });
      if (path === "/client/v4/accounts/acc_123/storage/kv/namespaces") return json({ success: true, result: [] });
      if (path === "/client/v4/accounts/acc_123/access/apps") return json({ success: true, result: [] });
      if (path === "/client/v4/accounts/acc_123/workers/scripts/cf-mail-relay-worker/secrets") {
        return json({ success: true, result: [{ name: "CF_API_TOKEN" }] });
      }
      if (path === "/client/v4/zones" && search.get("name") === "example.com") return json({ success: true, result: [{ id: "zone_123" }] });
      if (path === "/client/v4/zones/zone_123/email/sending/subdomains") return json({ success: true, result: [] });
      return json({ success: false }, 404);
    };

    const result = await main(["--account-id", "acc_123", "--domain", "example.com"], { CLOUDFLARE_API_TOKEN: "token" }, fetchImpl);

    assert.equal(result.ok, false);
    assert.equal(result.checks.find((check) => check.name === "worker_secrets").status, "fail");
  });
});

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
