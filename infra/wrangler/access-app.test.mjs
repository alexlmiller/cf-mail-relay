import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildBodies, defaults, parseArgs, run } from "./access-app.mjs";

describe("access-app helper", () => {
  it("parses repeatable admin email flags", () => {
    assert.deepEqual(
      parseArgs(["--account-id", "acc", "--allow-email", "one@example.com,two@example.com", "--allow-email", "three@example.com"]),
      {
        accountId: "acc",
        email: ["one@example.com", "two@example.com", "three@example.com"],
      },
    );
  });

  it("builds a self-hosted Access app for Pages and Worker admin API", () => {
    const bodies = buildBodies({
      ...defaults,
      name: "relay-admin",
      pagesUrl: "https://admin.example.com/",
      workerUrl: "https://worker.example.com/",
      email: ["admin@example.com"],
    });

    assert.deepEqual(bodies.app.destinations, [
      { type: "public", uri: "admin.example.com" },
      { type: "public", uri: "worker.example.com/admin/api/*" },
    ]);
    assert.equal(bodies.app.domain, "admin.example.com");
    assert.deepEqual(bodies.app.cors_headers.allowed_origins, ["https://admin.example.com/"]);
    assert.deepEqual(bodies.policy.include, [{ email: { email: "admin@example.com" } }]);
  });

  it("returns dry-run payload without requiring a token", async () => {
    const result = await run(["--account-id", "acc", "--allow-email", "admin@example.com", "--dry-run"], {}, async () => {
      throw new Error("fetch should not be called");
    });

    assert.equal(result.app.name, "cf-mail-relay-admin");
    assert.equal(result.policy.decision, "allow");
  });

  it("creates the app and policy when no app exists", async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith("/access/organizations")) {
        return json({ result: { auth_domain: "team.cloudflareaccess.com" } });
      }
      if (url.endsWith("/access/apps?name=cf-mail-relay-admin")) {
        return json({ result: [] });
      }
      if (init.method === "POST" && url.endsWith("/access/apps")) {
        return json({ result: { id: "app_1" } });
      }
      if (url.endsWith("/access/apps/app_1/policies") && init.method === "GET") {
        return json({ result: [] });
      }
      if (url.endsWith("/access/apps/app_1/policies") && init.method === "POST") {
        return json({ result: { id: "policy_1" } });
      }
      if (url.endsWith("/access/apps/app_1")) {
        return json({ result: { id: "app_1", aud: "aud_123" } });
      }
      throw new Error(`unexpected request ${init.method} ${url}`);
    };

    const result = await run(["--account-id", "acc", "--allow-email", "admin@example.com"], { CLOUDFLARE_API_TOKEN: "token" }, fetchImpl);

    assert.equal(result.access_team_domain, "team.cloudflareaccess.com");
    assert.equal(result.access_audience, "aud_123");
    assert.deepEqual(calls.map((call) => call.init.method), ["GET", "GET", "POST", "GET", "POST", "GET"]);
  });
});

function json(payload) {
  return new Response(JSON.stringify({ success: true, ...payload }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
