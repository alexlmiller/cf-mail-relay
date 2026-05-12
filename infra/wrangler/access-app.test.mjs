import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { buildBodies, defaults, parseArgs, run } from "./access-app.mjs";

describe("access-app helper", () => {
  it("parses repeatable admin email flags", () => {
    assert.deepEqual(
      parseArgs(["--account-id", "acc", "--allow-email", "one@example.com,two@example.com", "--allow-email", "three@example.com", "--apply-config", "worker.toml", "--allow-platform-hostnames"]),
      {
        allowPlatformHostnames: true,
        applyConfig: "worker.toml",
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

    // Path-scoped: only the UI + admin/self API are gated. /relay/*, /send,
    // /bootstrap/admin, /healthz are deliberately NOT in destinations so the
    // worker's own auth (HMAC, bearer, bootstrap token) sees the request.
    assert.deepEqual(bodies.app.destinations, [
      { type: "public", uri: "admin.example.com/" },
      { type: "public", uri: "admin.example.com/_astro/*" },
      { type: "public", uri: "admin.example.com/admin/api/*" },
      { type: "public", uri: "admin.example.com/self/api/*" },
    ]);
    assert.equal(bodies.app.domain, "admin.example.com");
    assert.deepEqual(bodies.app.cors_headers.allowed_origins, ["https://admin.example.com/"]);
    assert.deepEqual(bodies.policy.include, [{ email: { email: "admin@example.com" } }]);
  });

  it("returns dry-run payload without requiring a token", async () => {
    const result = await run(["--account-id", "acc", "--allow-email", "admin@example.com", "--dry-run", "--allow-platform-hostnames"], {}, async () => {
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

    const result = await run(["--account-id", "acc", "--allow-email", "admin@example.com", "--allow-platform-hostnames"], { CLOUDFLARE_API_TOKEN: "token" }, fetchImpl);

    assert.equal(result.access_team_domain, "team.cloudflareaccess.com");
    assert.equal(result.access_audience, "aud_123");
    assert.deepEqual(calls.map((call) => call.init.method), ["GET", "GET", "POST", "GET", "POST", "GET"]);
  });

  it("can apply returned Access values to wrangler config", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cf-mail-relay-access-app-"));
    const config = path.join(dir, "wrangler.toml");
    await writeFile(
      config,
      `[vars]
ACCESS_TEAM_DOMAIN = "your-team.cloudflareaccess.com"
ACCESS_AUDIENCE = "REPLACE_WITH_ACCESS_APPLICATION_AUD"
`,
    );

    const result = await run(["--account-id", "acc", "--allow-email", "admin@example.com", "--apply-config", config, "--allow-platform-hostnames"], { CLOUDFLARE_API_TOKEN: "token" }, accessFetch);
    const written = await readFile(config, "utf8");

    assert.equal(result.applied_config.changed, true);
    assert.match(written, /ACCESS_TEAM_DOMAIN = "team\.cloudflareaccess\.com"/);
    assert.match(written, /ACCESS_AUDIENCE = "aud_123"/);
    // Same-origin mode does not set ADMIN_CORS_ORIGIN — the Worker defaults to its own URL.
    assert.doesNotMatch(written, /ADMIN_CORS_ORIGIN/);
  });

  it("uses an explicit team domain without reading the Access organization", async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith("/access/organizations")) {
        throw new Error("organization endpoint should not be called");
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

    const result = await run(
      ["--account-id", "acc", "--allow-email", "admin@example.com", "--team-domain", "https://team.cloudflareaccess.com/", "--allow-platform-hostnames"],
      { CLOUDFLARE_API_TOKEN: "token" },
      fetchImpl,
    );

    assert.equal(result.access_team_domain, "team.cloudflareaccess.com");
    assert.equal(result.access_audience, "aud_123");
    assert.deepEqual(calls.map((call) => call.init.method), ["GET", "POST", "GET", "POST", "GET"]);
  });

  it("rejects platform hostnames unless explicitly allowed", async () => {
    await assert.rejects(
      () => run(["--account-id", "acc", "--allow-email", "admin@example.com", "--dry-run"], {}, async () => {
        throw new Error("fetch should not be called");
      }, throwingFail),
      /Platform hostnames require Workers & Pages Access controls/,
    );
  });

  it("allows custom-domain payloads without the platform hostname override", async () => {
    const result = await run(
      [
        "--account-id",
        "acc",
        "--allow-email",
        "admin@example.com",
        "--pages-url",
        "https://admin.example.com",
        "--worker-url",
        "https://mail-api.example.com",
        "--dry-run",
      ],
      {},
      async () => {
        throw new Error("fetch should not be called");
      },
    );

    assert.equal(result.app.domain, "admin.example.com");
  });
});

function throwingFail(message) {
  throw new Error(message);
}

async function accessFetch(url, init) {
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
}

function json(payload) {
  return new Response(JSON.stringify({ success: true, ...payload }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
