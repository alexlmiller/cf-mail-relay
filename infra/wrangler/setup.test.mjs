import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CloudflareApiClient, createOrFindD1, createOrFindKv, generateSecrets, main, parseArgs, parseUsersCount, renderRunbook, renderWranglerToml, runApply } from "./setup.mjs";

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
    assert.equal(options.relayHost, "smtp.example.com");
  });

  it("parses an explicit SMTP host", () => {
    const options = parseArgs([
      "--account-id",
      "acc_123",
      "--domain",
      "example.com",
      "--smtp-host",
      "https://Mailer.Example.COM/submission",
    ], {});

    assert.equal(options.relayHost, "mailer.example.com");
  });

  it("rejects unknown options", () => {
    assert.throws(() => parseArgs(["--wat"], {}), /Unknown option/);
  });
});

describe("setup main", () => {
  it("returns a plan-only output when no token is set", async () => {
    const result = await main([
      "--account-id", "acc_123",
      "--admin-url", "https://mail.example.com",
      "--allow-email", "alex@example.com",
      "--domain", "example.com",
    ], {});

    assert.equal(result.ok, true);
    assert.equal(result.plan_only, true);
    assert.match(result.note, /CLOUDFLARE_API_TOKEN is not set/);
    assert.equal(result.plan.domains[0].domain, "example.com");
    assert.ok(result.plan.commands.some((command) => command.includes("wrangler d1 create")));
  });

  it("plan commands have no <PLACEHOLDER> stubs — real values from CLI args are substituted", async () => {
    const result = await main([
      "--account-id", "acc_123",
      "--admin-url", "https://mail.example.com",
      "--allow-email", "alex@example.com",
      "--domain", "example.com",
    ], {});

    for (const command of result.plan.commands) {
      assert.doesNotMatch(command, /<D1_DATABASE_NAME>/, `placeholder leaked: ${command}`);
      assert.doesNotMatch(command, /<admin@example\.com>/, `placeholder leaked: ${command}`);
      assert.doesNotMatch(command, /<domain>/, `placeholder leaked: ${command}`);
    }
    assert.ok(result.plan.commands.some((command) => command.includes("d1 migrations apply cf-mail-relay --remote")));
    assert.ok(result.plan.commands.some((command) => command.includes("--allow-email alex@example.com")));
    assert.ok(result.plan.commands.some((command) => command.includes("doctor:local -- --domain example.com")));
  });

  it("requires --admin-url and --allow-email even without --apply", async () => {
    await assert.rejects(
      main(["--account-id", "acc_123", "--domain", "example.com"], {}),
      /--admin-url is required/,
    );
    await assert.rejects(
      main(["--account-id", "acc_123", "--admin-url", "https://mail.example.com", "--domain", "example.com"], {}),
      /--allow-email is required/,
    );
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
      "--account-id", "acc_123",
      "--admin-url", "https://mail.example.com",
      "--allow-email", "alex@example.com",
      "--domain", "example.com",
      "--d1-database-id", "d1_123",
      "--kv-namespace-id", "kv_123",
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

    const result = await main([
      "--account-id", "acc_123",
      "--admin-url", "https://mail.example.com",
      "--allow-email", "alex@example.com",
      "--domain", "example.com",
    ], { CLOUDFLARE_API_TOKEN: "token" }, fetchImpl);

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

describe("setup apply helpers", () => {
  it("createOrFindD1 reuses an existing database by name", async () => {
    const fetchImpl = async (url) => {
      const path = new URL(url).pathname;
      if (path === "/client/v4/accounts/acc/d1/database") {
        return json({ success: true, result: [{ name: "cf-mail-relay", uuid: "d1_existing" }] });
      }
      return json({ success: false }, 404);
    };
    const client = new CloudflareApiClient("https://api.cloudflare.com/client/v4", "token", fetchImpl);
    const result = await createOrFindD1(client, "acc", "cf-mail-relay");
    assert.equal(result.id, "d1_existing");
    assert.equal(result.source, "existing");
  });

  it("createOrFindD1 creates when missing", async () => {
    let posted = false;
    const fetchImpl = async (url, init = {}) => {
      const path = new URL(url).pathname;
      if (path === "/client/v4/accounts/acc/d1/database" && (init.method ?? "GET") === "GET") {
        return json({ success: true, result: [] });
      }
      if (path === "/client/v4/accounts/acc/d1/database" && init.method === "POST") {
        posted = true;
        return json({ success: true, result: { uuid: "d1_new" } });
      }
      return json({ success: false }, 404);
    };
    const client = new CloudflareApiClient("https://api.cloudflare.com/client/v4", "token", fetchImpl);
    const result = await createOrFindD1(client, "acc", "cf-mail-relay");
    assert.equal(result.id, "d1_new");
    assert.equal(result.source, "created");
    assert.equal(posted, true);
  });

  it("createOrFindKv reuses by title", async () => {
    const fetchImpl = async (url) => {
      const path = new URL(url).pathname;
      if (path === "/client/v4/accounts/acc/storage/kv/namespaces") {
        return json({ success: true, result: [{ id: "kv_existing", title: "cf-mail-relay-hot" }] });
      }
      return json({ success: false }, 404);
    };
    const client = new CloudflareApiClient("https://api.cloudflare.com/client/v4", "token", fetchImpl);
    const result = await createOrFindKv(client, "acc", "cf-mail-relay-hot");
    assert.equal(result.id, "kv_existing");
    assert.equal(result.source, "existing");
  });

  it("generateSecrets returns 3 distinct base64url 32-byte secrets", () => {
    const secrets = generateSecrets();
    const names = Object.keys(secrets);
    // BOOTSTRAP_SETUP_TOKEN is intentionally absent: the bootstrap step
    // generates it inline so the secret is fully ephemeral.
    assert.deepEqual(names.sort(), ["CREDENTIAL_PEPPER", "METADATA_PEPPER", "RELAY_HMAC_SECRET_CURRENT"]);
    for (const name of names) {
      assert.equal(secrets[name].length, 43);
      assert.match(secrets[name], /^[A-Za-z0-9_-]+$/);
    }
    // No collisions.
    assert.equal(new Set(Object.values(secrets)).size, 3);
  });

  it("renderWranglerToml substitutes placeholders + mail.example.com route", () => {
    const template = `name = "cf-mail-relay-worker"
account_id = "REPLACE_WITH_CLOUDFLARE_ACCOUNT_ID"
database_name = "cf-mail-relay"
database_id = "REPLACE_WITH_D1_DATABASE_ID"
id = "REPLACE_WITH_KV_NAMESPACE_ID"
ACCESS_TEAM_DOMAIN = "your-team.cloudflareaccess.com"
ACCESS_AUDIENCE = "REPLACE_WITH_ACCESS_APPLICATION_AUD"
RELAY_HMAC_KEY_ID = "rel_REPLACE_ME"
routes = [
  { pattern = "mail.example.com", custom_domain = true },
]`;
    const rendered = renderWranglerToml({
      template,
      accountId: "acc_xyz",
      d1Id: "d1_xyz",
      d1Name: "cf-mail-relay-v1-test",
      kvId: "kv_xyz",
      accessTeamDomain: "team.cloudflareaccess.com",
      accessAudience: "aud_xyz",
      adminUrl: "https://mail.milf.red",
      relayKeyId: "rel_01",
      workerScriptName: "cf-mail-relay-v1-test",
    });
    assert.match(rendered, /name = "cf-mail-relay-v1-test"/);
    assert.match(rendered, /account_id = "acc_xyz"/);
    assert.match(rendered, /database_name = "cf-mail-relay-v1-test"/);
    assert.match(rendered, /database_id = "d1_xyz"/);
    assert.match(rendered, /id = "kv_xyz"/);
    assert.match(rendered, /ACCESS_TEAM_DOMAIN = "team\.cloudflareaccess\.com"/);
    assert.match(rendered, /ACCESS_AUDIENCE = "aud_xyz"/);
    assert.match(rendered, /RELAY_HMAC_KEY_ID = "rel_01"/);
    assert.match(rendered, /pattern = "mail\.milf\.red"/);
  });

  it("renderRunbook includes admin URL, IDs, and DNS records per domain", () => {
    const runbook = renderRunbook({
      adminUrl: "https://mail.milf.red",
      accountId: "acc",
      d1Id: "d1",
      kvId: "kv",
      domains: ["example.com", "other.example.com"],
      relayHmacSecret: "S3CR3T",
      relayKeyId: "rel_01",
      relayHost: "mailer.example.com",
    });
    assert.match(runbook, /https:\/\/mail\.milf\.red/);
    assert.match(runbook, /Cloudflare account: acc/);
    assert.match(runbook, /D1 database id: d1/);
    assert.match(runbook, /KV namespace id: kv/);
    assert.match(runbook, /example\.com/);
    assert.match(runbook, /other\.example\.com/);
    assert.match(runbook, /RELAY_HMAC_SECRET=S3CR3T/);
    assert.match(runbook, /RELAY_DOMAIN=mailer\.example\.com/);
    assert.match(runbook, /relay: `mailer\.example\.com`/);
  });

  it("throws when bootstrap admin returns non-2xx (don't leave a half-bootstrapped relay)", async () => {
    const fetchImpl = async (url, init = {}) => {
      const path = new URL(url).pathname;
      if (path === "/client/v4/accounts/acc/d1/database" && (init.method ?? "GET") === "GET") {
        return json({ success: true, result: [] });
      }
      if (path === "/client/v4/accounts/acc/d1/database" && init.method === "POST") {
        return json({ success: true, result: { uuid: "d1_new" } });
      }
      if (path === "/client/v4/accounts/acc/storage/kv/namespaces" && (init.method ?? "GET") === "GET") {
        return json({ success: true, result: [] });
      }
      if (path === "/client/v4/accounts/acc/storage/kv/namespaces" && init.method === "POST") {
        return json({ success: true, result: { id: "kv_new" } });
      }
      if (path === "/bootstrap/admin") {
        return json({ ok: false, error: "bootstrap_already_completed" }, 409);
      }
      throw new Error(`unexpected ${init.method ?? "GET"} ${url}`);
    };

    const options = parseArgs([
      "--account-id", "acc",
      "--admin-url", "https://mail.milf.red",
      "--allow-email", "alex@example.com",
      "--domain", "example.com",
      "--apply",
    ], {});
    options.workerDir = "/repo/worker";
    options.repoRoot = "/repo";
    options.wranglerExamplePath = "/repo/worker/wrangler.toml.example";
    options.wranglerPath = "/repo/worker/wrangler.toml";
    options.runbookPath = "/repo/RUNBOOK.md";

    await assert.rejects(
      runApply({
        options,
        env: { CLOUDFLARE_API_TOKEN: "token" },
        client: new CloudflareApiClient("https://api.cloudflare.com/client/v4", "token", fetchImpl),
        execImpl: async (_command, args) => {
          if (args.join(" ").includes("d1 execute") && args.join(" ").includes("FROM users")) {
            return JSON.stringify([{ results: [{ n: 0 }] }]);
          }
          return undefined;
        },
        readFileImpl: () => "",
        writeFileImpl: () => {},
        existsImpl: () => false,
        accessAppImpl: async () => ({ app_id: "app_xyz", access_team_domain: "team.cloudflareaccess.com", access_audience: "aud_xyz" }),
        fetchImpl,
      }),
      /Bootstrap admin failed/,
    );
  });

  it("runApply orchestrates create-or-reuse, secret push, deploy, bootstrap", async () => {
    const execCalls = [];
    const writes = new Map();
    const exists = new Set();
    const fetchImpl = async (url, init = {}) => {
      const path = new URL(url).pathname;
      if (path === "/client/v4/accounts/acc/d1/database" && (init.method ?? "GET") === "GET") {
        return json({ success: true, result: [] });
      }
      if (path === "/client/v4/accounts/acc/d1/database" && init.method === "POST") {
        return json({ success: true, result: { uuid: "d1_new" } });
      }
      if (path === "/client/v4/accounts/acc/storage/kv/namespaces" && (init.method ?? "GET") === "GET") {
        return json({ success: true, result: [] });
      }
      if (path === "/client/v4/accounts/acc/storage/kv/namespaces" && init.method === "POST") {
        return json({ success: true, result: { id: "kv_new" } });
      }
      if (path === "/bootstrap/admin") {
        return json({ ok: true, user_id: "usr_admin" });
      }
      throw new Error(`unexpected ${init.method ?? "GET"} ${url}`);
    };

    const options = parseArgs([
      "--account-id", "acc",
      "--admin-url", "https://mail.milf.red",
      "--allow-email", "alex@example.com",
      "--domain", "example.com",
      "--apply",
    ], {});
    options.workerDir = "/repo/worker";
    options.repoRoot = "/repo";
    options.wranglerExamplePath = "/repo/worker/wrangler.toml.example";
    options.wranglerPath = "/repo/worker/wrangler.toml";
    options.runbookPath = "/repo/RUNBOOK.md";

    const result = await runApply({
      options,
      env: { CLOUDFLARE_API_TOKEN: "token" },
      client: new CloudflareApiClient("https://api.cloudflare.com/client/v4", "token", fetchImpl),
      execImpl: async (command, args) => {
        execCalls.push(`${command} ${args.join(" ")}`);
        if (args.join(" ") === "exec wrangler secret list --format json") return JSON.stringify([{ name: "CF_API_TOKEN" }]);
        if (args.join(" ").includes("d1 execute") && args.join(" ").includes("FROM users")) {
          return JSON.stringify([{ results: [{ n: 0 }] }]);
        }
        return undefined;
      },
      readFileImpl: () => `account_id = "REPLACE_WITH_CLOUDFLARE_ACCOUNT_ID"
database_id = "REPLACE_WITH_D1_DATABASE_ID"
id = "REPLACE_WITH_KV_NAMESPACE_ID"
ACCESS_TEAM_DOMAIN = "your-team.cloudflareaccess.com"
ACCESS_AUDIENCE = "REPLACE_WITH_ACCESS_APPLICATION_AUD"
RELAY_HMAC_KEY_ID = "rel_REPLACE_ME"
routes = [
  { pattern = "mail.example.com", custom_domain = true },
]`,
      writeFileImpl: (path, body) => { writes.set(path, body); },
      existsImpl: (path) => exists.has(path),
      accessAppImpl: async () => ({ app_id: "app_xyz", access_team_domain: "team.cloudflareaccess.com", access_audience: "aud_xyz" }),
      fetchImpl,
    });

    assert.equal(result.ok, true);
    const stepNames = result.steps.map((step) => step.step);
    assert.ok(stepNames.includes("d1"));
    assert.ok(stepNames.includes("kv"));
    assert.ok(stepNames.includes("access"));
    assert.ok(stepNames.includes("secrets_pushed"));
    assert.ok(stepNames.includes("deployed"));
    assert.ok(stepNames.includes("bootstrap_admin"));
    assert.ok(stepNames.includes("runbook_written"));

    // Wrangler toml was written with substituted values.
    const toml = writes.get("/repo/worker/wrangler.toml");
    assert.match(toml, /pattern = "mail\.milf\.red"/);
    // The RUNBOOK was written.
    assert.ok(writes.has("/repo/RUNBOOK.md"));
    // Wrangler was invoked for migrations + secrets + deploy.
    assert.ok(execCalls.some((call) => call.includes("d1 migrations apply")));
    const settingsCommand = execCalls.find((call) => call.includes("d1 execute") && call.includes("smtp_host"));
    assert.ok(settingsCommand);
    assert.match(settingsCommand, /VALUES \('smtp_host', '"smtp\.example\.com"', unixepoch\(\)\)/);
    assert.doesNotMatch(settingsCommand, /\\"smtp\.example\.com\\"/);
    assert.ok(execCalls.some((call) => call.includes("secret put RELAY_HMAC_SECRET_CURRENT")));
    assert.ok(execCalls.some((call) => call.includes("wrangler deploy")));
    // Bootstrap step pushes BOOTSTRAP_SETUP_TOKEN, uses it, deletes it.
    assert.ok(execCalls.some((call) => call.includes("secret put BOOTSTRAP_SETUP_TOKEN")));
    assert.ok(execCalls.some((call) => call.includes("secret delete BOOTSTRAP_SETUP_TOKEN")));
    assert.ok(execCalls.some((call) => call.includes("secret list --format json")));
    // Steady-state secrets pushed once should NOT include BOOTSTRAP_SETUP_TOKEN
    // among the generated-secrets batch (it's pushed only inside bootstrap).
    const generatedSecretPuts = execCalls.filter((call) => /secret put (CREDENTIAL_PEPPER|METADATA_PEPPER|RELAY_HMAC_SECRET_CURRENT|BOOTSTRAP_SETUP_TOKEN)$/.test(call));
    assert.equal(generatedSecretPuts.length, 4, "expected 3 generated-secret puts plus 1 bootstrap-token put");
  });

  it("fails apply if the bootstrap token remains after deletion", async () => {
    const fetchImpl = async (url, init = {}) => {
      const path = new URL(url).pathname;
      if (path === "/client/v4/accounts/acc/d1/database" && (init.method ?? "GET") === "GET") return json({ success: true, result: [] });
      if (path === "/client/v4/accounts/acc/d1/database" && init.method === "POST") return json({ success: true, result: { uuid: "d1_new" } });
      if (path === "/client/v4/accounts/acc/storage/kv/namespaces" && (init.method ?? "GET") === "GET") return json({ success: true, result: [] });
      if (path === "/client/v4/accounts/acc/storage/kv/namespaces" && init.method === "POST") return json({ success: true, result: { id: "kv_new" } });
      if (path === "/bootstrap/admin") return json({ ok: true, user_id: "usr_admin" });
      throw new Error(`unexpected ${init.method ?? "GET"} ${url}`);
    };

    const options = parseArgs([
      "--account-id", "acc",
      "--admin-url", "https://mail.milf.red",
      "--allow-email", "alex@example.com",
      "--domain", "example.com",
      "--apply",
    ], {});
    options.workerDir = "/repo/worker";
    options.repoRoot = "/repo";
    options.wranglerExamplePath = "/repo/worker/wrangler.toml.example";
    options.wranglerPath = "/repo/worker/wrangler.toml";
    options.runbookPath = "/repo/RUNBOOK.md";

    await assert.rejects(
      runApply({
        options,
        env: { CLOUDFLARE_API_TOKEN: "token" },
        client: new CloudflareApiClient("https://api.cloudflare.com/client/v4", "token", fetchImpl),
        execImpl: async (_command, args) => {
          if (args.join(" ") === "exec wrangler secret list --format json") {
            return JSON.stringify([{ name: "BOOTSTRAP_SETUP_TOKEN" }]);
          }
          if (args.join(" ").includes("d1 execute") && args.join(" ").includes("FROM users")) {
            return JSON.stringify([{ results: [{ n: 0 }] }]);
          }
          return undefined;
        },
        readFileImpl: () => "",
        writeFileImpl: () => {},
        existsImpl: () => false,
        accessAppImpl: async () => ({ app_id: "app_xyz", access_team_domain: "team.cloudflareaccess.com", access_audience: "aud_xyz" }),
        fetchImpl,
      }),
      /BOOTSTRAP_SETUP_TOKEN is still present/,
    );
  });

  it("parseUsersCount reads the count column from wrangler d1 execute --json", () => {
    assert.equal(parseUsersCount(JSON.stringify([{ results: [{ n: 0 }] }])), 0);
    assert.equal(parseUsersCount(JSON.stringify([{ results: [{ n: 7 }] }])), 7);
    assert.throws(() => parseUsersCount("not json"), /Could not read users count/);
    assert.throws(() => parseUsersCount(JSON.stringify([{ results: [{}] }])), /no `n` column/);
  });

  it("runApply runs bootstrap on retry when users table is empty and wrangler.toml already exists", async () => {
    // Regression test for the silent-skip bug: an earlier --apply created
    // worker/wrangler.toml but failed before bootstrap (e.g., missing Workers
    // Routes permission at deploy). On retry, the script must still attempt
    // bootstrap rather than treating the existing toml as "already done".
    const execCalls = [];
    const fetchImpl = async (url, init = {}) => {
      const path = new URL(url).pathname;
      if (path === "/client/v4/accounts/acc/d1/database" && (init.method ?? "GET") === "GET") {
        return json({ success: true, result: [{ name: "cf-mail-relay", uuid: "d1_existing" }] });
      }
      if (path === "/client/v4/accounts/acc/storage/kv/namespaces" && (init.method ?? "GET") === "GET") {
        return json({ success: true, result: [{ id: "kv_existing", title: "cf-mail-relay-hot" }] });
      }
      if (path === "/bootstrap/admin") {
        return json({ ok: true, user_id: "usr_admin" });
      }
      throw new Error(`unexpected ${init.method ?? "GET"} ${url}`);
    };

    const options = parseArgs([
      "--account-id", "acc",
      "--admin-url", "https://mail.milf.red",
      "--allow-email", "alex@example.com",
      "--domain", "example.com",
      "--apply",
    ], {});
    options.workerDir = "/repo/worker";
    options.repoRoot = "/repo";
    options.wranglerExamplePath = "/repo/worker/wrangler.toml.example";
    options.wranglerPath = "/repo/worker/wrangler.toml";
    options.runbookPath = "/repo/RUNBOOK.md";

    const result = await runApply({
      options,
      env: { CLOUDFLARE_API_TOKEN: "token" },
      client: new CloudflareApiClient("https://api.cloudflare.com/client/v4", "token", fetchImpl),
      execImpl: async (command, args) => {
        execCalls.push(`${command} ${args.join(" ")}`);
        if (args.join(" ") === "exec wrangler secret list --format json") return JSON.stringify([{ name: "CF_API_TOKEN" }]);
        if (args.join(" ").includes("d1 execute") && args.join(" ").includes("FROM users")) {
          return JSON.stringify([{ results: [{ n: 0 }] }]);
        }
        return undefined;
      },
      readFileImpl: () => "",
      // Existing wrangler.toml — the previous --apply attempt created it.
      writeFileImpl: () => {},
      existsImpl: (path) => path === "/repo/worker/wrangler.toml",
      accessAppImpl: async () => ({ app_id: "app_xyz", access_team_domain: "team.cloudflareaccess.com", access_audience: "aud_xyz" }),
      fetchImpl,
    });

    assert.equal(result.ok, true);
    const stepNames = result.steps.map((step) => step.step);
    assert.ok(stepNames.includes("bootstrap_admin"), `expected bootstrap_admin step on retry; got ${stepNames.join(", ")}`);
    assert.ok(execCalls.some((call) => call.includes("secret put BOOTSTRAP_SETUP_TOKEN")));
    assert.ok(execCalls.some((call) => call.includes("secret delete BOOTSTRAP_SETUP_TOKEN")));
  });

  it("runApply skips bootstrap when users table is not empty (idempotent reruns)", async () => {
    const execCalls = [];
    const fetchImpl = async (url, init = {}) => {
      const path = new URL(url).pathname;
      if (path === "/client/v4/accounts/acc/d1/database" && (init.method ?? "GET") === "GET") {
        return json({ success: true, result: [{ name: "cf-mail-relay", uuid: "d1_existing" }] });
      }
      if (path === "/client/v4/accounts/acc/storage/kv/namespaces" && (init.method ?? "GET") === "GET") {
        return json({ success: true, result: [{ id: "kv_existing", title: "cf-mail-relay-hot" }] });
      }
      if (path === "/bootstrap/admin") {
        throw new Error("bootstrap POST should not be made when users table is not empty");
      }
      throw new Error(`unexpected ${init.method ?? "GET"} ${url}`);
    };

    const options = parseArgs([
      "--account-id", "acc",
      "--admin-url", "https://mail.milf.red",
      "--allow-email", "alex@example.com",
      "--domain", "example.com",
      "--apply",
    ], {});
    options.workerDir = "/repo/worker";
    options.repoRoot = "/repo";
    options.wranglerExamplePath = "/repo/worker/wrangler.toml.example";
    options.wranglerPath = "/repo/worker/wrangler.toml";
    options.runbookPath = "/repo/RUNBOOK.md";

    const result = await runApply({
      options,
      env: { CLOUDFLARE_API_TOKEN: "token" },
      client: new CloudflareApiClient("https://api.cloudflare.com/client/v4", "token", fetchImpl),
      execImpl: async (command, args) => {
        execCalls.push(`${command} ${args.join(" ")}`);
        if (args.join(" ") === "exec wrangler secret list --format json") return JSON.stringify([{ name: "CF_API_TOKEN" }]);
        if (args.join(" ").includes("d1 execute") && args.join(" ").includes("FROM users")) {
          return JSON.stringify([{ results: [{ n: 1 }] }]);
        }
        return undefined;
      },
      readFileImpl: () => "",
      writeFileImpl: () => {},
      existsImpl: (path) => path === "/repo/worker/wrangler.toml",
      accessAppImpl: async () => ({ app_id: "app_xyz", access_team_domain: "team.cloudflareaccess.com", access_audience: "aud_xyz" }),
      fetchImpl,
    });

    assert.equal(result.ok, true);
    const bootstrapStep = result.steps.find((step) => step.step === "bootstrap_admin");
    assert.ok(bootstrapStep);
    assert.equal(bootstrapStep.skipped, true);
    assert.equal(bootstrapStep.reason, "users_table_not_empty");
    assert.ok(!execCalls.some((call) => call.includes("secret put BOOTSTRAP_SETUP_TOKEN")));
    assert.ok(!execCalls.some((call) => call.includes("secret delete BOOTSTRAP_SETUP_TOKEN")));
  });
});
