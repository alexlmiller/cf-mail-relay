import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudflareApiClient, createOrFindD1, createOrFindKv, generateSecrets, lookupCloudflareDomain, main, parseArgs, parseUsersCount, renderRunbook, renderWranglerToml, runApply, writeFileWithMode, writeRecoveryJournalAtomic } from "./setup.mjs";

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

  it("does not accept the removed --dry-run mode", () => {
    assert.throws(() => parseArgs(["--dry-run"], {}), /Unknown option: --dry-run/);
  });

  it("uses an explicit destructive rotation flag and rejects the old ambiguous name", () => {
    const options = parseArgs(["--rotate-all-worker-secrets"], {});
    assert.equal(options.rotateAllWorkerSecrets, true);
    assert.throws(
      () => parseArgs(["--regenerate-secrets"], {}),
      /removed because it understated a destructive operation/,
    );
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

  it("--apply requires a Cloudflare API token", async () => {
    await assert.rejects(
      main([
        "--account-id", "acc_123",
        "--admin-url", "https://mail.example.com",
        "--allow-email", "alex@example.com",
        "--domain", "example.com",
        "--apply",
      ], {}),
      /CLOUDFLARE_API_TOKEN must contain a Cloudflare API token before running --apply/,
    );
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
    assert.ok(result.plan.commands.some((command) => command.includes("--account-id acc_123")));
    assert.ok(result.plan.commands.some((command) => command.includes("--pages-url https://mail.example.com")));
    assert.ok(result.plan.commands.some((command) => command.includes("--allow-email alex@example.com")));
    assert.ok(result.plan.commands.some((command) => command.includes("doctor:local -- --domain example.com --worker-url https://mail.example.com")));
    assert.ok(!result.plan.commands.some((command) => command.includes("BOOTSTRAP_SETUP_TOKEN")));
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

  it("documents explicit recovery behavior in --help", async () => {
    const result = await main(["--help"], {});
    assert.match(result.usage, /--rotate-all-worker-secrets/);
    assert.match(result.usage, /Destructive disaster recovery/);
    assert.match(result.usage, /mode-0600 recovery/);
    assert.match(result.usage, /intermediate Worker version/);
    assert.match(result.usage, /blocked until every required secret name is present/);
    assert.doesNotMatch(result.usage, /--regenerate-secrets/);
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

const managedSecretNames = ["CREDENTIAL_PEPPER", "METADATA_PEPPER", "RELAY_HMAC_SECRET_CURRENT"];
const requiredSecretNames = ["CF_API_TOKEN", ...managedSecretNames];

function recoveryJournalFixture({ pushed = [], operation = "initialize" } = {}) {
  return {
    version: 1,
    account_id: "acc",
    worker_script_name: "cf-mail-relay-worker",
    relay_key_id: "rel_01",
    operation,
    created_at: "2026-08-10T00:00:00.000Z",
    secrets: {
      CREDENTIAL_PEPPER: "A".repeat(43),
      METADATA_PEPPER: "B".repeat(43),
      RELAY_HMAC_SECRET_CURRENT: "C".repeat(43),
    },
    pushed_secret_names: pushed,
  };
}

function createApplyHarness({
  remoteSecrets = [],
  scriptExists = remoteSecrets.length > 0,
  recoveryJournal = null,
  runbook = null,
  pushCfApiToken = true,
  rotateAllWorkerSecrets = false,
  failOnceAt = null,
  initialUsers = 0,
  secretListStatus = null,
  wranglerExists = false,
} = {}) {
  const remoteSecretNames = new Set(remoteSecrets);
  const files = new Map([
    ["/repo/worker/wrangler.toml.example", `name = "cf-mail-relay-worker"
account_id = "REPLACE_WITH_CLOUDFLARE_ACCOUNT_ID"
database_name = "cf-mail-relay"
database_id = "REPLACE_WITH_D1_DATABASE_ID"
id = "REPLACE_WITH_KV_NAMESPACE_ID"
ACCESS_TEAM_DOMAIN = "your-team.cloudflareaccess.com"
ACCESS_AUDIENCE = "REPLACE_WITH_ACCESS_APPLICATION_AUD"
RELAY_HMAC_KEY_ID = "rel_REPLACE_ME"
routes = [{ pattern = "mail.example.com", custom_domain = true }]`],
  ]);
  if (wranglerExists) files.set("/repo/worker/wrangler.toml", "existing");
  if (recoveryJournal !== null) files.set("/repo/.cf-mail-relay-setup-recovery.json", `${JSON.stringify(recoveryJournal)}\n`);
  if (runbook !== null) files.set("/repo/RUNBOOK.md", runbook);

  let workerScriptExists = scriptExists;
  let users = initialUsers;
  let failureConsumed = false;
  const execCalls = [];
  const events = [];
  const progress = [];
  const journalHistory = [];

  const fail = (label) => {
    if (!failureConsumed && failOnceAt === label) {
      failureConsumed = true;
      throw new Error(`injected interruption: ${label}`);
    }
  };

  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    const path = parsed.pathname;
    if (path === "/client/v4/accounts/acc/workers/scripts/cf-mail-relay-worker/secrets") {
      events.push("remote-read:secrets");
      if (secretListStatus !== null) return json({ success: false }, secretListStatus);
      if (!workerScriptExists) return json({ success: false }, 404);
      return json({ success: true, result: [...remoteSecretNames].map((name) => ({ name })) });
    }
    if (path === "/client/v4/accounts/acc/d1/database" && (init.method ?? "GET") === "GET") {
      return json({ success: true, result: [{ name: "cf-mail-relay", uuid: "d1_existing" }] });
    }
    if (path === "/client/v4/accounts/acc/storage/kv/namespaces" && (init.method ?? "GET") === "GET") {
      return json({ success: true, result: [{ id: "kv_existing", title: "cf-mail-relay-hot" }] });
    }
    if (path === "/client/v4/zones" && parsed.searchParams.get("name") === "example.com") {
      return json({ success: true, result: [{ id: "zone_xyz", name: "example.com" }] });
    }
    if (path === "/client/v4/zones/zone_xyz/email/sending/subdomains") {
      return json({ success: true, result: [{ enabled: true, name: "example.com" }] });
    }
    throw new Error(`unexpected ${init.method ?? "GET"} ${url}`);
  };

  const options = parseArgs([
    "--account-id", "acc",
    "--admin-url", "https://mail.example.com",
    "--allow-email", "alex@example.com",
    "--domain", "example.com",
    "--apply",
  ], {});
  options.workerDir = "/repo/worker";
  options.repoRoot = "/repo";
  options.wranglerExamplePath = "/repo/worker/wrangler.toml.example";
  options.wranglerPath = "/repo/worker/wrangler.toml";
  options.runbookPath = "/repo/RUNBOOK.md";
  options.recoveryJournalPath = "/repo/.cf-mail-relay-setup-recovery.json";
  options.pushCfApiToken = pushCfApiToken;
  options.rotateAllWorkerSecrets = rotateAllWorkerSecrets;

  const execImpl = async (command, args, execOptions = {}) => {
    const text = args.join(" ");
    execCalls.push({ command, args: [...args], stdin: execOptions.stdin });
    if (args.includes("secret") && args.includes("bulk")) {
      events.push("remote-mutation:secret-bulk");
      fail("secret-bulk-before-remote");
      workerScriptExists = true;
      const values = JSON.parse(execOptions.stdin);
      for (const name of Object.keys(values)) remoteSecretNames.add(name);
      fail("secret-bulk-after-remote");
      return undefined;
    }
    if (args.includes("secret") && args.includes("put")) {
      const name = args[args.indexOf("put") + 1];
      events.push(`remote-mutation:secret:${name}`);
      fail(`secret:${name}`);
      workerScriptExists = true;
      remoteSecretNames.add(name);
      return undefined;
    }
    if (text.includes("d1 migrations apply")) {
      events.push("remote-mutation:migrations");
      fail("before-push");
      return undefined;
    }
    if (command === "pnpm" && args[0] === "--filter") {
      fail("after-pushes-before-deploy");
      return undefined;
    }
    if (text.includes("wrangler deploy")) {
      events.push("remote-mutation:deploy");
      return undefined;
    }
    if (text.includes("FROM users")) {
      return JSON.stringify([{ results: [{ n: users }] }]);
    }
    if (text.includes("INSERT INTO users")) {
      users += 1;
      events.push("remote-mutation:bootstrap");
      return undefined;
    }
    if (text.includes("INSERT INTO domains")) {
      events.push("remote-mutation:domain");
      fail("before-runbook");
      return undefined;
    }
    if (text.includes("d1 execute")) {
      events.push("remote-mutation:d1");
    }
    return undefined;
  };

  const context = {
    options,
    env: { CLOUDFLARE_API_TOKEN: "setup-token" },
    client: new CloudflareApiClient("https://api.cloudflare.com/client/v4", "setup-token", fetchImpl),
    execImpl,
    readFileImpl: (path) => {
      if (!files.has(path)) throw new Error(`missing injected file: ${path}`);
      return files.get(path);
    },
    writeFileImpl: (path, body) => { files.set(path, body); },
    existsImpl: (path) => files.has(path),
    writeRecoveryJournalImpl: (path, journal) => {
      events.push("local-write:recovery-journal");
      const copy = structuredClone(journal);
      journalHistory.push(copy);
      files.set(path, `${JSON.stringify(copy)}\n`);
    },
    removeRecoveryJournalImpl: (path) => {
      events.push("local-remove:recovery-journal");
      files.delete(path);
    },
    accessAppImpl: async () => {
      events.push("remote-mutation:access");
      return { app_id: "app_xyz", access_team_domain: "team.cloudflareaccess.com", access_audience: "aud_xyz" };
    },
    fetchImpl,
    progressImpl: (message) => progress.push(message),
  };

  return {
    context,
    events,
    execCalls,
    files,
    journalHistory,
    options,
    progress,
    remoteSecretNames,
    run: () => runApply(context),
  };
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

  it("lookupCloudflareDomain requires enabled Email Sending", async () => {
    const fetchImpl = async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/client/v4/zones" && parsed.searchParams.get("name") === "example.com") {
        return json({ success: true, result: [{ id: "zone_123", name: "example.com" }] });
      }
      if (parsed.pathname === "/client/v4/zones/zone_123/email/sending/subdomains") {
        return json({ success: true, result: [{ enabled: true, name: "example.com" }] });
      }
      return json({ success: false }, 404);
    };
    const client = new CloudflareApiClient("https://api.cloudflare.com/client/v4", "token", fetchImpl);
    assert.deepEqual(await lookupCloudflareDomain(client, "example.com"), { zoneId: "zone_123", status: "verified" });
  });

  it("lookupCloudflareDomain rejects domains that are not onboarded for Email Sending", async () => {
    const fetchImpl = async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/client/v4/zones" && parsed.searchParams.get("name") === "example.com") {
        return json({ success: true, result: [{ id: "zone_123", name: "example.com" }] });
      }
      if (parsed.pathname === "/client/v4/zones/zone_123/email/sending/subdomains") {
        return json({ success: true, result: [{ enabled: false, name: "example.com" }] });
      }
      return json({ success: false }, 404);
    };
    const client = new CloudflareApiClient("https://api.cloudflare.com/client/v4", "token", fetchImpl);
    await assert.rejects(
      lookupCloudflareDomain(client, "example.com"),
      /Email Sending is not enabled/,
    );
  });

  it("lookupCloudflareDomain falls back from sending subdomain to parent zone", async () => {
    const zoneLookups = [];
    const fetchImpl = async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/client/v4/zones") {
        zoneLookups.push(parsed.searchParams.get("name"));
        if (parsed.searchParams.get("name") === "news.example.com") {
          return json({ success: true, result: [] });
        }
        if (parsed.searchParams.get("name") === "example.com") {
          return json({ success: true, result: [{ id: "zone_parent", name: "example.com" }] });
        }
      }
      if (parsed.pathname === "/client/v4/zones/zone_parent/email/sending/subdomains") {
        return json({ success: true, result: [{ enabled: true, name: "news.example.com" }] });
      }
      return json({ success: false }, 404);
    };
    const client = new CloudflareApiClient("https://api.cloudflare.com/client/v4", "token", fetchImpl);

    assert.deepEqual(await lookupCloudflareDomain(client, "news.example.com"), { zoneId: "zone_parent", status: "verified" });
    assert.deepEqual(zoneLookups, ["news.example.com", "example.com"]);
  });

  it("generateSecrets returns 3 distinct base64url 32-byte secrets", () => {
    const secrets = generateSecrets();
    const names = Object.keys(secrets);
    // BOOTSTRAP_SETUP_TOKEN is intentionally absent: normal setup bootstraps
    // the first admin directly in D1.
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

  it("writes the recovery journal atomically with owner-only permissions", () => {
    const directory = mkdtempSync(join(tmpdir(), "cf-mail-relay-setup-"));
    const path = join(directory, "recovery.json");
    try {
      const journal = recoveryJournalFixture();
      writeRecoveryJournalAtomic(path, journal);

      assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), journal);

      const updated = recoveryJournalFixture({ pushed: ["CREDENTIAL_PEPPER"] });
      writeRecoveryJournalAtomic(path, updated);
      assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), updated);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("tightens an existing sensitive file to owner-only permissions", () => {
    const directory = mkdtempSync(join(tmpdir(), "cf-mail-relay-runbook-"));
    const path = join(directory, "RUNBOOK.md");
    try {
      writeFileWithMode(path, "old\n", { encoding: "utf8", mode: 0o644 });
      assert.equal(statSync(path).mode & 0o777, 0o644);

      writeFileWithMode(path, "secret\n", { encoding: "utf8", mode: 0o600 });
      assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.equal(readFileSync(path, "utf8"), "secret\n");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("persists generated secrets before the first remote mutation and removes the journal only after success", async () => {
    const harness = createApplyHarness();
    const result = await harness.run();

    const firstJournalWrite = harness.events.indexOf("local-write:recovery-journal");
    const firstRemoteMutation = harness.events.findIndex((event) => event.startsWith("remote-mutation:"));
    assert.ok(firstJournalWrite >= 0);
    assert.ok(firstRemoteMutation > firstJournalWrite, harness.events.join(" | "));
    assert.deepEqual([...harness.remoteSecretNames].sort(), [...requiredSecretNames].sort());
    assert.equal(harness.files.has(harness.options.recoveryJournalPath), false);

    const managedBulks = harness.execCalls.filter(({ args }) => args.includes("secret") && args.includes("bulk"));
    assert.equal(managedBulks.length, 1, "all managed values should use one intermediate-version write");
    assert.deepEqual(JSON.parse(managedBulks[0].stdin), harness.journalHistory[0].secrets);

    const runbook = harness.files.get(harness.options.runbookPath);
    assert.match(runbook, /^RELAY_HMAC_SECRET=[A-Za-z0-9_-]{43}$/mu);
    assert.doesNotMatch(runbook, /<existing>/iu);

    const generatedValues = Object.values(harness.journalHistory[0].secrets);
    const observableOutput = JSON.stringify({
      result,
      progress: harness.progress,
      commands: harness.execCalls.map(({ command, args }) => ({ command, args })),
    });
    for (const value of generatedValues) {
      assert.doesNotMatch(observableOutput, new RegExp(value, "u"));
    }
  });

  it("keeps the recovery journal and refuses deploy until CF_API_TOKEN exists", async () => {
    const harness = createApplyHarness({ pushCfApiToken: false });
    let failure;
    try {
      await harness.run();
    } catch (error) {
      failure = error;
    }

    assert.ok(failure instanceof Error);
    assert.match(failure.message, /required Worker secrets are missing: CF_API_TOKEN/);
    assert.ok(harness.files.has(harness.options.recoveryJournalPath));
    assert.ok(!harness.execCalls.some(({ args }) => args.includes("deploy")));
    assert.equal(harness.execCalls.filter(({ args }) => args.includes("secret") && args.includes("bulk")).length, 1);
    assert.deepEqual([...harness.remoteSecretNames].sort(), [...managedSecretNames].sort());
    const journal = JSON.parse(harness.files.get(harness.options.recoveryJournalPath));
    for (const value of Object.values(journal.secrets)) {
      assert.doesNotMatch(failure.message, new RegExp(value, "u"));
    }
  });

  it("reuses complete remote secrets from a fresh clone without generating or rotating", async () => {
    const harness = createApplyHarness({
      remoteSecrets: requiredSecretNames,
      scriptExists: true,
      pushCfApiToken: false,
    });
    const result = await harness.run();

    assert.equal(harness.journalHistory.length, 0);
    assert.ok(!harness.execCalls.some(({ args }) => args.includes("secret")));
    assert.ok(result.steps.some((step) => step.step === "managed_secrets" && step.source === "remote"));
    assert.ok(result.steps.some((step) => step.step === "runbook_preserved"));
    assert.equal(harness.files.has(harness.options.runbookPath), false);
  });

  it("pushes CF_API_TOKEN independently while preserving the existing relay HMAC value", async () => {
    const existingRelaySecret = "R".repeat(43);
    const harness = createApplyHarness({
      remoteSecrets: managedSecretNames,
      scriptExists: true,
      pushCfApiToken: true,
      runbook: `# existing runbook\nRELAY_HMAC_SECRET=${existingRelaySecret}\n`,
    });
    const result = await harness.run();

    const secretPuts = harness.execCalls.filter(({ args }) => args.includes("secret") && args.includes("put"));
    assert.deepEqual(secretPuts.map(({ args }) => args[args.indexOf("put") + 1]), ["CF_API_TOKEN"]);
    assert.equal(secretPuts[0].stdin, "setup-token");
    assert.equal(harness.journalHistory.length, 0);
    assert.match(harness.files.get(harness.options.runbookPath), new RegExp(`^RELAY_HMAC_SECRET=${existingRelaySecret}$`, "mu"));
    assert.ok(result.steps.some((step) => step.step === "runbook_written" && step.secret_source === "existing_runbook"));
  });

  it("refuses incomplete remote managed-secret state before any mutation when no journal exists", async () => {
    const harness = createApplyHarness({
      remoteSecrets: ["CF_API_TOKEN", "CREDENTIAL_PEPPER"],
      scriptExists: true,
      pushCfApiToken: false,
    });

    await assert.rejects(
      harness.run(),
      /incomplete managed secrets: missing METADATA_PEPPER, RELAY_HMAC_SECRET_CURRENT/,
    );
    assert.equal(harness.journalHistory.length, 0);
    assert.ok(!harness.events.some((event) => event.startsWith("remote-mutation:")), harness.events.join(" | "));
  });

  it("refuses to infer secret state from local wrangler.toml when the remote check fails", async () => {
    const harness = createApplyHarness({
      secretListStatus: 403,
      wranglerExists: true,
    });

    await assert.rejects(
      harness.run(),
      /Could not inspect remote Worker secrets.*HTTP 403.*Refusing to guess from local files/s,
    );
    assert.equal(harness.journalHistory.length, 0);
    assert.ok(!harness.events.some((event) => event.startsWith("remote-mutation:")), harness.events.join(" | "));
  });

  it("refuses a recovery journal bound to another account before any mutation", async () => {
    const journal = recoveryJournalFixture();
    journal.account_id = "another-account";
    const harness = createApplyHarness({
      recoveryJournal: journal,
      remoteSecrets: requiredSecretNames,
      scriptExists: true,
    });

    await assert.rejects(harness.run(), /recovery journal .* does not match account acc/s);
    assert.ok(!harness.events.some((event) => event.startsWith("remote-mutation:")), harness.events.join(" | "));
  });

  it("requires the destructive flag to replace all managed secrets on an existing deployment", async () => {
    const harness = createApplyHarness({
      remoteSecrets: requiredSecretNames,
      scriptExists: true,
      pushCfApiToken: false,
      rotateAllWorkerSecrets: true,
    });
    const result = await harness.run();

    assert.equal(harness.journalHistory[0].operation, "replace_all");
    const managedBulks = harness.execCalls.filter(({ args }) => args.includes("secret") && args.includes("bulk"));
    assert.equal(managedBulks.length, 1);
    assert.deepEqual(JSON.parse(managedBulks[0].stdin), harness.journalHistory[0].secrets);
    assert.ok(!harness.execCalls.some(({ args }) => args.includes("secret") && args.includes("put")));
    assert.equal(harness.files.has(harness.options.recoveryJournalPath), false);
    assert.ok(result.steps.some((step) => step.step === "secret_recovery_journal" && step.source === "replace_all"));
    assert.doesNotMatch(harness.files.get(harness.options.runbookPath), /<existing>/iu);
  });

  it("retries the same bulk values after interruption before the remote bulk commit", async () => {
    const harness = createApplyHarness({ failOnceAt: "secret-bulk-before-remote" });

    await assert.rejects(harness.run(), /injected interruption: secret-bulk-before-remote/);
    const saved = JSON.parse(harness.files.get(harness.options.recoveryJournalPath));
    assert.deepEqual(saved.pushed_secret_names, []);
    assert.deepEqual([...harness.remoteSecretNames], []);
    const firstAttempt = harness.execCalls.find(({ args }) => args.includes("secret") && args.includes("bulk"));
    assert.deepEqual(JSON.parse(firstAttempt.stdin), saved.secrets);

    const result = await harness.run();
    const attempts = harness.execCalls.filter(({ args }) => args.includes("secret") && args.includes("bulk"));
    assert.equal(attempts.length, 2);
    assert.ok(attempts.every(({ stdin }) => JSON.stringify(JSON.parse(stdin)) === JSON.stringify(saved.secrets)));
    assert.ok(result.steps.some((step) => step.step === "secret_recovery_journal" && step.resumed === true));
    assert.equal(harness.files.has(harness.options.recoveryJournalPath), false);
  });

  it("retries the same bulk values when remote completion is ambiguous", async () => {
    const harness = createApplyHarness({ failOnceAt: "secret-bulk-after-remote" });

    await assert.rejects(harness.run(), /injected interruption: secret-bulk-after-remote/);
    const saved = JSON.parse(harness.files.get(harness.options.recoveryJournalPath));
    assert.deepEqual(saved.pushed_secret_names, []);
    assert.deepEqual([...harness.remoteSecretNames].sort(), [...managedSecretNames].sort());

    await harness.run();
    const attempts = harness.execCalls.filter(({ args }) => args.includes("secret") && args.includes("bulk"));
    assert.equal(attempts.length, 2);
    assert.ok(attempts.every(({ stdin }) => JSON.stringify(JSON.parse(stdin)) === JSON.stringify(saved.secrets)));
    assert.equal(harness.files.has(harness.options.recoveryJournalPath), false);
  });

  it("resumes after all secret pushes without changing managed values", async () => {
    const harness = createApplyHarness({ failOnceAt: "after-pushes-before-deploy" });

    await assert.rejects(harness.run(), /injected interruption: after-pushes-before-deploy/);
    const saved = JSON.parse(harness.files.get(harness.options.recoveryJournalPath));
    assert.deepEqual([...saved.pushed_secret_names].sort(), [...managedSecretNames].sort());
    const managedBulkCount = () => harness.execCalls.filter(({ args }) =>
      args.includes("secret") && args.includes("bulk")).length;
    assert.equal(managedBulkCount(), 1);

    await harness.run();
    assert.equal(managedBulkCount(), 1);
    assert.equal(harness.files.has(harness.options.recoveryJournalPath), false);
    assert.match(harness.files.get(harness.options.runbookPath), new RegExp(`^RELAY_HMAC_SECRET=${saved.secrets.RELAY_HMAC_SECRET_CURRENT}$`, "mu"));
  });

  it("retains the journal after deploy and resumes through runbook persistence", async () => {
    const harness = createApplyHarness({ failOnceAt: "before-runbook" });

    await assert.rejects(harness.run(), /injected interruption: before-runbook/);
    const saved = JSON.parse(harness.files.get(harness.options.recoveryJournalPath));
    const managedBulksBeforeRetry = harness.execCalls.filter(({ args }) =>
      args.includes("secret") && args.includes("bulk")).length;
    assert.equal(managedBulksBeforeRetry, 1);
    assert.ok(harness.execCalls.some(({ args }) => args.includes("deploy")));

    await harness.run();
    const managedBulksAfterRetry = harness.execCalls.filter(({ args }) =>
      args.includes("secret") && args.includes("bulk")).length;
    assert.equal(managedBulksAfterRetry, managedBulksBeforeRetry);
    assert.equal(harness.files.has(harness.options.recoveryJournalPath), false);
    assert.match(harness.files.get(harness.options.runbookPath), new RegExp(`^RELAY_HMAC_SECRET=${saved.secrets.RELAY_HMAC_SECRET_CURRENT}$`, "mu"));
  });

  it("runApply orchestrates create-or-reuse, secret push, deploy, bootstrap", async () => {
    const execCalls = [];
    const secretBulkPayloads = [];
    const writes = new Map();
    const exists = new Set();
    const remoteSecrets = new Set();
    let workerScriptExists = false;
    let recoveryJournal = null;
    const fetchImpl = async (url, init = {}) => {
      const path = new URL(url).pathname;
      if (path === "/client/v4/accounts/acc/workers/scripts/cf-mail-relay-worker/secrets") {
        if (!workerScriptExists) return json({ success: false }, 404);
        return json({ success: true, result: [...remoteSecrets].map((name) => ({ name })) });
      }
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
      if (path === "/client/v4/zones") {
        return json({ success: true, result: [{ id: "zone_xyz", name: "example.com" }] });
      }
      if (path === "/client/v4/zones/zone_xyz/email/sending/subdomains") {
        return json({ success: true, result: [{ enabled: true, name: "example.com" }] });
      }
      if (path === "/bootstrap/admin") {
        throw new Error("setup wizard should not POST /bootstrap/admin");
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
    options.recoveryJournalPath = "/repo/.cf-mail-relay-setup-recovery.json";
    options.pushCfApiToken = true;

    const result = await runApply({
      options,
      env: { CLOUDFLARE_API_TOKEN: "token" },
      client: new CloudflareApiClient("https://api.cloudflare.com/client/v4", "token", fetchImpl),
      execImpl: async (command, args, execOptions = {}) => {
        execCalls.push(`${command} ${args.join(" ")}`);
        if (args.includes("secret") && args.includes("bulk")) {
          const payload = JSON.parse(execOptions.stdin);
          secretBulkPayloads.push(payload);
          workerScriptExists = true;
          for (const name of Object.keys(payload)) remoteSecrets.add(name);
        }
        const secretIndex = args.indexOf("put");
        if (args.includes("secret") && secretIndex >= 0) {
          workerScriptExists = true;
          remoteSecrets.add(args[secretIndex + 1]);
        }
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
      existsImpl: (path) => path === options.recoveryJournalPath ? recoveryJournal !== null : exists.has(path),
      writeRecoveryJournalImpl: (_path, journal) => { recoveryJournal = structuredClone(journal); },
      removeRecoveryJournalImpl: () => { recoveryJournal = null; },
      accessAppImpl: async () => ({ app_id: "app_xyz", access_team_domain: "team.cloudflareaccess.com", access_audience: "aud_xyz" }),
      progressImpl: () => {},
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
    const bootstrapStep = result.steps.find((step) => step.step === "bootstrap_admin");
    assert.equal(bootstrapStep.method, "d1");
    assert.match(bootstrapStep.user_id, /^usr_[a-f0-9]{32}$/u);

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
    assert.ok(execCalls.some((call) => call.includes("secret bulk --name cf-mail-relay-worker")));
    assert.ok(execCalls.some((call) => call.includes("wrangler deploy")));
    // Setup bootstraps the first admin directly in D1 and never creates the
    // manual-recovery BOOTSTRAP_SETUP_TOKEN during normal wizard runs.
    assert.ok(execCalls.some((call) => call.includes("INSERT INTO users")));
    assert.ok(execCalls.some((call) => call.includes("alex@example.com")));
    assert.ok(!execCalls.some((call) => call.includes("secret put BOOTSTRAP_SETUP_TOKEN")));
    assert.ok(!execCalls.some((call) => call.includes("secret delete BOOTSTRAP_SETUP_TOKEN")));
    assert.ok(!execCalls.some((call) => call.includes("secret list --format json")));
    assert.equal(secretBulkPayloads.length, 1, "expected one managed-secret bulk write");
    assert.deepEqual(Object.keys(secretBulkPayloads[0]).sort(), [...managedSecretNames].sort());
    // Domains registered: setup INSERTs each --domain into D1 with zone_id + status.
    assert.ok(stepNames.includes("domains_registered"));
    const domainsStep = result.steps.find((step) => step.step === "domains_registered");
    assert.deepEqual(domainsStep.domains, [{ domain: "example.com", zone_id: "zone_xyz", status: "verified" }]);
    const domainInsert = execCalls.find((call) => /d1 execute .* INSERT INTO domains/.test(call));
    assert.ok(domainInsert, `expected domains INSERT; calls = ${execCalls.join(" | ")}`);
    assert.match(domainInsert, /ON CONFLICT\(domain\) DO UPDATE SET/);
    // policy_version was bumped after domain registration.
    assert.ok(execCalls.some((call) => /d1 execute .*'policy_version'/.test(call)));
  });

  it("runApply validates sending domains before mutating resources", async () => {
    const execCalls = [];
    let accessCalled = false;
    const fetchImpl = async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/client/v4/zones" && parsed.searchParams.get("name") === "example.com") {
        return json({ success: true, result: [{ id: "zone_xyz", name: "example.com" }] });
      }
      if (parsed.pathname === "/client/v4/zones/zone_xyz/email/sending/subdomains") {
        return json({ success: true, result: [{ enabled: false, name: "example.com" }] });
      }
      throw new Error(`unexpected lookup after domain validation should have failed: ${url}`);
    };

    const options = parseArgs([
      "--account-id", "acc",
      "--admin-url", "https://mail.milf.red",
      "--allow-email", "alex@example.com",
      "--domain", "example.com",
      "--apply",
    ], {});

    await assert.rejects(
      runApply({
        options,
        env: { CLOUDFLARE_API_TOKEN: "token" },
        client: new CloudflareApiClient("https://api.cloudflare.com/client/v4", "token", fetchImpl),
        execImpl: async (command, args) => {
          execCalls.push(`${command} ${args.join(" ")}`);
        },
        readFileImpl: () => "",
        writeFileImpl: () => {},
        existsImpl: () => false,
        accessAppImpl: async () => {
          accessCalled = true;
          return { app_id: "app_xyz", access_team_domain: "team.cloudflareaccess.com", access_audience: "aud_xyz" };
        },
        progressImpl: () => {},
        fetchImpl,
      }),
      /Email Sending is not enabled/,
    );
    assert.equal(accessCalled, false);
    assert.deepEqual(execCalls, []);
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
      if (path === "/client/v4/accounts/acc/workers/scripts/cf-mail-relay-worker/secrets") {
        return json({ success: true, result: ["CF_API_TOKEN", "CREDENTIAL_PEPPER", "METADATA_PEPPER", "RELAY_HMAC_SECRET_CURRENT"].map((name) => ({ name })) });
      }
      if (path === "/client/v4/accounts/acc/d1/database" && (init.method ?? "GET") === "GET") {
        return json({ success: true, result: [{ name: "cf-mail-relay", uuid: "d1_existing" }] });
      }
      if (path === "/client/v4/accounts/acc/storage/kv/namespaces" && (init.method ?? "GET") === "GET") {
        return json({ success: true, result: [{ id: "kv_existing", title: "cf-mail-relay-hot" }] });
      }
      if (path === "/client/v4/zones") {
        return json({ success: true, result: [{ id: "zone_xyz", name: "example.com" }] });
      }
      if (path === "/client/v4/zones/zone_xyz/email/sending/subdomains") {
        return json({ success: true, result: [{ enabled: true, name: "example.com" }] });
      }
      if (path === "/bootstrap/admin") {
        throw new Error("setup wizard should not POST /bootstrap/admin");
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
      progressImpl: () => {},
      fetchImpl,
    });

    assert.equal(result.ok, true);
    const stepNames = result.steps.map((step) => step.step);
    assert.ok(stepNames.includes("bootstrap_admin"), `expected bootstrap_admin step on retry; got ${stepNames.join(", ")}`);
    assert.ok(execCalls.some((call) => call.includes("INSERT INTO users")));
    assert.ok(!execCalls.some((call) => call.includes("BOOTSTRAP_SETUP_TOKEN")));
  });

  it("runApply emits progress lines via the injected progressImpl", async () => {
    const progressLines = [];
    const remoteSecrets = new Set();
    let workerScriptExists = false;
    let recoveryJournal = null;
    const fetchImpl = async (url, init = {}) => {
      const path = new URL(url).pathname;
      if (path === "/client/v4/accounts/acc/workers/scripts/cf-mail-relay-worker/secrets") {
        if (!workerScriptExists) return json({ success: false }, 404);
        return json({ success: true, result: [...remoteSecrets].map((name) => ({ name })) });
      }
      if (path === "/client/v4/accounts/acc/d1/database" && (init.method ?? "GET") === "GET") return json({ success: true, result: [] });
      if (path === "/client/v4/accounts/acc/d1/database" && init.method === "POST") return json({ success: true, result: { uuid: "d1_new" } });
      if (path === "/client/v4/accounts/acc/storage/kv/namespaces" && (init.method ?? "GET") === "GET") return json({ success: true, result: [] });
      if (path === "/client/v4/accounts/acc/storage/kv/namespaces" && init.method === "POST") return json({ success: true, result: { id: "kv_new" } });
      if (path === "/client/v4/zones") return json({ success: true, result: [{ id: "zone_xyz", name: "example.com" }] });
      if (path === "/client/v4/zones/zone_xyz/email/sending/subdomains") return json({ success: true, result: [{ enabled: true, name: "example.com" }] });
      if (path === "/bootstrap/admin") throw new Error("setup wizard should not POST /bootstrap/admin");
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
    options.recoveryJournalPath = "/repo/.cf-mail-relay-setup-recovery.json";
    options.pushCfApiToken = true;

    await runApply({
      options,
      env: { CLOUDFLARE_API_TOKEN: "token" },
      client: new CloudflareApiClient("https://api.cloudflare.com/client/v4", "token", fetchImpl),
      execImpl: async (_command, args, execOptions = {}) => {
        if (args.includes("secret") && args.includes("bulk")) {
          workerScriptExists = true;
          for (const name of Object.keys(JSON.parse(execOptions.stdin))) remoteSecrets.add(name);
        }
        const secretIndex = args.indexOf("put");
        if (args.includes("secret") && secretIndex >= 0) {
          workerScriptExists = true;
          remoteSecrets.add(args[secretIndex + 1]);
        }
        if (args.join(" ").includes("d1 execute") && args.join(" ").includes("FROM users")) {
          return JSON.stringify([{ results: [{ n: 0 }] }]);
        }
        return undefined;
      },
      readFileImpl: () => "",
      writeFileImpl: () => {},
      existsImpl: (path) => path === options.recoveryJournalPath && recoveryJournal !== null,
      writeRecoveryJournalImpl: (_path, journal) => { recoveryJournal = structuredClone(journal); },
      removeRecoveryJournalImpl: () => { recoveryJournal = null; },
      accessAppImpl: async () => ({ app_id: "app_xyz", access_team_domain: "team.cloudflareaccess.com", access_audience: "aud_xyz" }),
      fetchImpl,
      progressImpl: (message) => progressLines.push(message),
    });

    assert.ok(progressLines.some((line) => line.includes("Validating Cloudflare Email Sending")));
    assert.ok(progressLines.some((line) => line.includes("Ensuring D1 database")), `D1 progress missing: ${progressLines.join("|")}`);
    assert.ok(progressLines.some((line) => line.includes("Ensuring KV namespace")));
    assert.ok(progressLines.some((line) => line.includes("Cloudflare Access app")));
    assert.ok(progressLines.some((line) => line.includes("Applying D1 migrations")));
    assert.ok(progressLines.some((line) => line.includes("Pushing")));
    assert.ok(progressLines.some((line) => line.includes("Building admin UI")));
    assert.ok(progressLines.some((line) => line.includes("Deploying worker")));
    assert.ok(progressLines.some((line) => line.includes("Bootstrapping admin")));
    assert.ok(progressLines.some((line) => line.includes("RUNBOOK")));
  });

  it("runApply skips bootstrap when users table is not empty (idempotent reruns)", async () => {
    const execCalls = [];
    const fetchImpl = async (url, init = {}) => {
      const path = new URL(url).pathname;
      if (path === "/client/v4/accounts/acc/workers/scripts/cf-mail-relay-worker/secrets") {
        return json({ success: true, result: ["CF_API_TOKEN", "CREDENTIAL_PEPPER", "METADATA_PEPPER", "RELAY_HMAC_SECRET_CURRENT"].map((name) => ({ name })) });
      }
      if (path === "/client/v4/accounts/acc/d1/database" && (init.method ?? "GET") === "GET") {
        return json({ success: true, result: [{ name: "cf-mail-relay", uuid: "d1_existing" }] });
      }
      if (path === "/client/v4/accounts/acc/storage/kv/namespaces" && (init.method ?? "GET") === "GET") {
        return json({ success: true, result: [{ id: "kv_existing", title: "cf-mail-relay-hot" }] });
      }
      if (path === "/client/v4/zones") {
        return json({ success: true, result: [{ id: "zone_xyz", name: "example.com" }] });
      }
      if (path === "/client/v4/zones/zone_xyz/email/sending/subdomains") {
        return json({ success: true, result: [{ enabled: true, name: "example.com" }] });
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
        if (args.join(" ").includes("d1 execute") && args.join(" ").includes("FROM users")) {
          return JSON.stringify([{ results: [{ n: 1 }] }]);
        }
        return undefined;
      },
      readFileImpl: () => "",
      writeFileImpl: () => {},
      existsImpl: (path) => path === "/repo/worker/wrangler.toml",
      accessAppImpl: async () => ({ app_id: "app_xyz", access_team_domain: "team.cloudflareaccess.com", access_audience: "aud_xyz" }),
      progressImpl: () => {},
      fetchImpl,
    });

    assert.equal(result.ok, true);
    const bootstrapStep = result.steps.find((step) => step.step === "bootstrap_admin");
    assert.ok(bootstrapStep);
    assert.equal(bootstrapStep.skipped, true);
    assert.equal(bootstrapStep.reason, "users_table_not_empty");
    assert.ok(!execCalls.some((call) => call.includes("INSERT INTO users")));
    assert.ok(!execCalls.some((call) => call.includes("secret put BOOTSTRAP_SETUP_TOKEN")));
    assert.ok(!execCalls.some((call) => call.includes("secret delete BOOTSTRAP_SETUP_TOKEN")));
  });
});
