#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const defaultApiBase = "https://api.cloudflare.com/client/v4";
const requiredSecrets = [
  "CF_API_TOKEN",
  "CREDENTIAL_PEPPER",
  "METADATA_PEPPER",
  "RELAY_HMAC_SECRET_CURRENT",
  "BOOTSTRAP_SETUP_TOKEN",
];

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await main(process.argv.slice(2), process.env);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

export async function main(argv, env, depsOrFetch = {}) {
  // Backward compat: tests pass a bare fetchImpl as the third arg.
  const deps = typeof depsOrFetch === "function" ? { fetchImpl: depsOrFetch } : (depsOrFetch ?? {});
  const options = parseArgs(argv, env);
  if (options.help) {
    return { ok: true, usage: usage() };
  }
  if (options.domains.length === 0) {
    throw new Error(`At least one --domain is required.\n\n${usage()}`);
  }
  if (!options.accountId) {
    throw new Error(`--account-id or CLOUDFLARE_ACCOUNT_ID is required.\n\n${usage()}`);
  }
  if (options.apply && !options.adminUrl) {
    throw new Error(`--apply requires --admin-url (e.g. https://mail.example.com).\n\n${usage()}`);
  }
  if (options.apply && !options.allowEmails.length) {
    throw new Error(`--apply requires at least one --allow-email so Access policies are created.`);
  }

  const plan = buildPlan(options);
  if (options.dryRun) {
    return { ok: true, checked_at: new Date().toISOString(), dry_run: true, plan };
  }

  const token = env[options.tokenEnv];
  if (!token) {
    throw new Error(`${options.tokenEnv} must contain a Cloudflare API token, or pass --dry-run for a plan only.`);
  }

  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const execImpl = deps.execImpl ?? runCommand;
  const readFileImpl = deps.readFileImpl ?? ((path) => readFileSync(path, "utf8"));
  const writeFileImpl = deps.writeFileImpl ?? ((path, body) => writeFileSync(path, body));
  const existsImpl = deps.existsImpl ?? existsSync;
  const accessAppImpl = deps.accessAppImpl ?? null;
  const client = new CloudflareApiClient(options.apiBase, token, fetchImpl);

  if (options.apply) {
    return runApply({
      options,
      env,
      client,
      execImpl,
      readFileImpl,
      writeFileImpl,
      existsImpl,
      accessAppImpl,
      fetchImpl,
    });
  }

  const checks = [];
  checks.push(await checkToken(client));
  checks.push(await checkAccount(client, options.accountId));
  checks.push(await checkWorkersPaid(client, options.accountId));
  checks.push(await checkD1(client, options.accountId, options.d1DatabaseId, options.d1DatabaseName));
  checks.push(await checkKv(client, options.accountId, options.kvNamespaceId, options.kvNamespaceTitle));
  checks.push(await checkAccess(client, options.accountId, options.accessAppName, options.adminUrl));
  checks.push(await checkWorkerSecrets(client, options.accountId, options.workerScriptName));
  for (const domain of options.domains) {
    checks.push(...await checkDomain(client, options.accountId, domain));
  }

  return {
    ok: checks.every((check) => check.status !== "fail"),
    checked_at: new Date().toISOString(),
    account_id: options.accountId,
    plan,
    checks,
  };
}

// ───────────────────────── Apply orchestrator ─────────────────────────

export async function runApply(ctx) {
  const { options, env, client, execImpl, readFileImpl, writeFileImpl, existsImpl, accessAppImpl, fetchImpl } = ctx;
  const steps = [];

  // 1. Resource creation (skip-if-exists). Honors --d1-id / --kv-id flags from caller.
  const d1 = options.d1DatabaseId
    ? { id: options.d1DatabaseId, name: options.d1DatabaseName, source: "provided" }
    : await createOrFindD1(client, options.accountId, options.d1DatabaseName);
  steps.push({ step: "d1", source: d1.source, id: d1.id, name: d1.name });

  const kv = options.kvNamespaceId
    ? { id: options.kvNamespaceId, title: options.kvNamespaceTitle, source: "provided" }
    : await createOrFindKv(client, options.accountId, options.kvNamespaceTitle);
  steps.push({ step: "kv", source: kv.source, id: kv.id, title: kv.title });

  // 2. Access app via access-app.mjs (programmatic call, so the destinations
  //    contract stays in one place).
  const accessRun = accessAppImpl ?? (await import("./access-app.mjs")).run;
  const accessArgs = [
    "--account-id", options.accountId,
    "--token-env", options.tokenEnv,
    "--name", options.accessAppName,
    "--pages-url", options.adminUrl,
    "--worker-url", options.adminUrl,
    ...options.allowEmails.flatMap((email) => ["--allow-email", email]),
  ];
  if (options.allowPlatformHostnames) {
    accessArgs.push("--allow-platform-hostnames");
  }
  const access = await accessRun(accessArgs, env, fetchImpl);
  steps.push({ step: "access", app_id: access.app_id, audience: access.access_audience, team_domain: access.access_team_domain });

  // 3. Generate secrets and (next step) write them to wrangler.toml + push via wrangler.
  const secrets = options.regenerateSecrets || !existsImpl(options.wranglerPath)
    ? generateSecrets()
    : null;
  if (secrets !== null) {
    steps.push({ step: "secrets_generated", names: Object.keys(secrets) });
  }

  // 4. Write worker/wrangler.toml from the example template.
  const wranglerToml = renderWranglerToml({
    template: readFileImpl(options.wranglerExamplePath),
    accountId: options.accountId,
    d1Id: d1.id,
    d1Name: d1.name,
    kvId: kv.id,
    accessTeamDomain: access.access_team_domain,
    accessAudience: access.access_audience,
    adminUrl: options.adminUrl,
    relayKeyId: options.relayKeyId,
  });
  if (!existsImpl(options.wranglerPath) || options.force) {
    writeFileImpl(options.wranglerPath, wranglerToml);
    steps.push({ step: "wrangler_toml", path: options.wranglerPath, written: true });
  } else {
    steps.push({ step: "wrangler_toml", path: options.wranglerPath, written: false, reason: "exists; pass --force to overwrite" });
  }

  // 5. Apply D1 migrations.
  if (!options.skipMigrations) {
    await execImpl("wrangler", ["d1", "migrations", "apply", d1.name, "--remote"], { cwd: options.workerDir });
    steps.push({ step: "migrations_applied" });
  }

  // 6. Push the generated secrets via wrangler. CF_API_TOKEN is NOT pushed
  //    automatically: the operator's setup token has D1/KV/Access scopes,
  //    but the worker's runtime token should be least-privilege (Email
  //    Sending Edit only). The runbook documents the manual step.
  //    Opt-in: --push-cf-api-token reuses the setup token (with a warning).
  if (secrets !== null) {
    for (const [name, value] of Object.entries(secrets)) {
      await execImpl("wrangler", ["secret", "put", name], { cwd: options.workerDir, stdin: value });
    }
    let cfTokenPushed = false;
    if (options.pushCfApiToken && env[options.tokenEnv]) {
      process.stderr.write(
        "warning: --push-cf-api-token reuses your setup token as the worker's runtime CF_API_TOKEN.\n" +
        "         Create a least-privilege Email-Sending-Edit-only token and rotate this after first send.\n",
      );
      await execImpl("wrangler", ["secret", "put", "CF_API_TOKEN"], { cwd: options.workerDir, stdin: env[options.tokenEnv] ?? "" });
      cfTokenPushed = true;
    }
    steps.push({ step: "secrets_pushed", count: Object.keys(secrets).length + (cfTokenPushed ? 1 : 0), cf_api_token_pushed: cfTokenPushed });
  }

  // 7. Build UI (outputs into worker/public/) and deploy worker.
  if (!options.skipBuildDeploy) {
    await execImpl("pnpm", ["--filter", "@cf-mail-relay/ui", "build"], { cwd: options.repoRoot });
    await execImpl("wrangler", ["deploy"], { cwd: options.workerDir });
    steps.push({ step: "deployed", admin_url: options.adminUrl });
  }

  // 8. Bootstrap the first admin and delete the bootstrap token. If the
  //    bootstrap fails the whole wizard fails — leaving an unbootstrapped
  //    relay with a live BOOTSTRAP_SETUP_TOKEN is a worse state to be in
  //    than partial setup with a clear error.
  if (secrets !== null && !options.skipBootstrap) {
    const adminEmail = options.allowEmails[0];
    const bootstrapResponse = await fetchImpl(`${options.adminUrl}/bootstrap/admin`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${secrets.BOOTSTRAP_SETUP_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ email: adminEmail }),
    });
    if (!bootstrapResponse.ok) {
      const bodyText = await bootstrapResponse.text().catch(() => "");
      throw new Error(
        `Bootstrap admin failed: HTTP ${bootstrapResponse.status} ${bodyText}\n` +
        `The relay is deployed but no admin user was created.\n` +
        `BOOTSTRAP_SETUP_TOKEN is still active — delete it once you've manually bootstrapped:\n` +
        `  pnpm --dir worker exec wrangler secret delete BOOTSTRAP_SETUP_TOKEN --force`,
      );
    }
    steps.push({ step: "bootstrap_admin", email: adminEmail });
    await execImpl("wrangler", ["secret", "delete", "BOOTSTRAP_SETUP_TOKEN", "--force"], { cwd: options.workerDir });
    steps.push({ step: "bootstrap_token_cleared" });
  }

  // 9. Emit per-adopter RUNBOOK.md so the operator has a single source of
  //    truth with every value (DNS records, relay env, admin URL, IDs).
  const runbook = renderRunbook({
    adminUrl: options.adminUrl,
    accountId: options.accountId,
    d1Id: d1.id,
    kvId: kv.id,
    domains: options.domains,
    relayHmacSecret: secrets?.RELAY_HMAC_SECRET_CURRENT ?? "<existing>",
    relayKeyId: options.relayKeyId,
  });
  writeFileImpl(options.runbookPath, runbook);
  steps.push({ step: "runbook_written", path: options.runbookPath });

  return {
    ok: true,
    apply: true,
    admin_url: options.adminUrl,
    steps,
  };
}

// ───────────────────────── Resource helpers ─────────────────────────

export async function createOrFindD1(client, accountId, name) {
  const list = await client.get(`/accounts/${encodeURIComponent(accountId)}/d1/database`);
  if (list.ok) {
    const databases = Array.isArray(list.body?.result) ? list.body.result : [];
    const existing = databases.find((db) => db.name === name);
    if (existing !== undefined) {
      return { id: existing.uuid ?? existing.id, name, source: "existing" };
    }
  }
  const created = await client.post(`/accounts/${encodeURIComponent(accountId)}/d1/database`, { name });
  if (!created.ok) throw new Error(`D1 create failed: HTTP ${created.status}`);
  const id = created.body?.result?.uuid ?? created.body?.result?.id;
  if (typeof id !== "string") throw new Error(`D1 create response missing id`);
  return { id, name, source: "created" };
}

export async function createOrFindKv(client, accountId, title) {
  const list = await client.get(`/accounts/${encodeURIComponent(accountId)}/storage/kv/namespaces?per_page=100`);
  if (list.ok) {
    const namespaces = Array.isArray(list.body?.result) ? list.body.result : [];
    const existing = namespaces.find((ns) => ns.title === title);
    if (existing !== undefined) {
      return { id: existing.id, title, source: "existing" };
    }
  }
  const created = await client.post(`/accounts/${encodeURIComponent(accountId)}/storage/kv/namespaces`, { title });
  if (!created.ok) throw new Error(`KV create failed: HTTP ${created.status}`);
  const id = created.body?.result?.id;
  if (typeof id !== "string") throw new Error(`KV create response missing id`);
  return { id, title, source: "created" };
}

export function generateSecrets() {
  return {
    CREDENTIAL_PEPPER: base64url(32),
    METADATA_PEPPER: base64url(32),
    RELAY_HMAC_SECRET_CURRENT: base64url(32),
    BOOTSTRAP_SETUP_TOKEN: base64url(32),
  };
}

export function renderWranglerToml(input) {
  let body = input.template;
  body = body.replaceAll("REPLACE_WITH_CLOUDFLARE_ACCOUNT_ID", input.accountId);
  body = body.replaceAll("REPLACE_WITH_D1_DATABASE_ID", input.d1Id);
  body = body.replaceAll("REPLACE_WITH_KV_NAMESPACE_ID", input.kvId);
  body = body.replaceAll("REPLACE_WITH_ACCESS_APPLICATION_AUD", input.accessAudience);
  body = body.replaceAll("your-team.cloudflareaccess.com", input.accessTeamDomain);
  body = body.replaceAll("rel_REPLACE_ME", input.relayKeyId);
  body = body.replace(/pattern = "mail\.example\.com"/g, `pattern = "${withoutScheme(input.adminUrl)}"`);
  return body;
}

export function renderRunbook(input) {
  const lines = [
    `# cf-mail-relay — adopter runbook`,
    ``,
    `Generated ${new Date().toISOString()} by \`pnpm run setup --apply\`.`,
    ``,
    `## Live admin`,
    ``,
    `- Admin URL: ${input.adminUrl}`,
    `- Cloudflare account: ${input.accountId}`,
    `- D1 database id: ${input.d1Id}`,
    `- KV namespace id: ${input.kvId}`,
    `- Relay HMAC key id: ${input.relayKeyId}`,
    ``,
    `## Relay container env`,
    ``,
    `\`\`\`env`,
    `RELAY_WORKER_URL=${input.adminUrl}`,
    `RELAY_KEY_ID=${input.relayKeyId}`,
    `RELAY_HMAC_SECRET=${input.relayHmacSecret}`,
    `RELAY_DOMAIN=smtp.${input.domains[0]}`,
    `RELAY_TLS_CERT_FILE=/tls/fullchain.pem`,
    `RELAY_TLS_KEY_FILE=/tls/privkey.pem`,
    `\`\`\``,
    ``,
    `## DNS records to publish per sending domain`,
    ``,
    ...input.domains.flatMap((domain) => [
      `### ${domain}`,
      ``,
      ...dnsRecordPlan(domain).map((record) => `- \`${record.type}  ${record.name}\` — ${record.value}`),
      ``,
      `Plus a DNS-only A record for the relay: \`smtp.${input.domains[0]}\` -> your relay host IP.`,
      ``,
    ]),
    `## Set the runtime CF_API_TOKEN (do this once, with a least-privilege token)`,
    ``,
    `The wizard's setup token has D1/KV/Access scopes — too broad for the`,
    `worker's runtime needs. Create a least-privilege Cloudflare API token`,
    `with only **Account · Email Sending · Edit**, then push it as the`,
    `worker secret:`,
    ``,
    `    pnpm --dir worker exec wrangler secret put CF_API_TOKEN`,
    ``,
    `Until you do this the worker's dashboard will show CF API health as`,
    `unhealthy and \`send_raw\` calls will fail. The wizard does NOT auto-set`,
    `this secret on purpose; pass \`--push-cf-api-token\` to override (you'll`,
    `get a warning).`,
    ``,
    `## Day-2`,
    ``,
    `See \`docs/operations.md\` for secret rotation, ops actions, and idempotency semantics.`,
    ``,
  ];
  return lines.join("\n");
}

// ───────────────────────── CLI ─────────────────────────

export function parseArgs(argv, env = process.env) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const workerDir = join(repoRoot, "worker");
  const options = {
    accountId: env.CLOUDFLARE_ACCOUNT_ID ?? "",
    accessAppName: "cf-mail-relay-admin",
    allowPlatformHostnames: false,
    adminUrl: "",
    apiBase: defaultApiBase,
    apply: false,
    allowEmails: [],
    d1DatabaseId: "",
    d1DatabaseName: "cf-mail-relay",
    domains: [],
    dryRun: false,
    force: false,
    help: false,
    kvNamespaceId: "",
    kvNamespaceTitle: "cf-mail-relay-hot",
    pushCfApiToken: false,
    regenerateSecrets: false,
    relayKeyId: "rel_01",
    repoRoot,
    runbookPath: join(repoRoot, "RUNBOOK.md"),
    skipBuildDeploy: false,
    skipBootstrap: false,
    skipMigrations: false,
    tokenEnv: "CLOUDFLARE_API_TOKEN",
    workerDir,
    workerScriptName: "cf-mail-relay-worker",
    wranglerExamplePath: join(workerDir, "wrangler.toml.example"),
    wranglerPath: join(workerDir, "wrangler.toml"),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--account-id": options.accountId = readValue(argv, index, arg); index += 1; break;
      case "--access-app-name": options.accessAppName = readValue(argv, index, arg); index += 1; break;
      case "--admin-url": options.adminUrl = trimTrailingSlash(readValue(argv, index, arg)); index += 1; break;
      case "--allow-email": options.allowEmails.push(readValue(argv, index, arg)); index += 1; break;
      case "--allow-platform-hostnames": options.allowPlatformHostnames = true; break;
      case "--api-base": options.apiBase = readValue(argv, index, arg); index += 1; break;
      case "--apply": options.apply = true; break;
      case "--d1-database-id":
      case "--d1-id":
        options.d1DatabaseId = readValue(argv, index, arg); index += 1; break;
      case "--d1-database-name": options.d1DatabaseName = readValue(argv, index, arg); index += 1; break;
      case "--domain": options.domains.push(normalizeDomain(readValue(argv, index, arg))); index += 1; break;
      case "--dry-run": options.dryRun = true; break;
      case "--force": options.force = true; break;
      case "--kv-namespace-id":
      case "--kv-id":
        options.kvNamespaceId = readValue(argv, index, arg); index += 1; break;
      case "--kv-namespace-title": options.kvNamespaceTitle = readValue(argv, index, arg); index += 1; break;
      case "--push-cf-api-token": options.pushCfApiToken = true; break;
      case "--regenerate-secrets": options.regenerateSecrets = true; break;
      case "--relay-key-id": options.relayKeyId = readValue(argv, index, arg); index += 1; break;
      case "--skip-bootstrap": options.skipBootstrap = true; break;
      case "--skip-build-deploy": options.skipBuildDeploy = true; break;
      case "--skip-migrations": options.skipMigrations = true; break;
      case "--token-env": options.tokenEnv = readValue(argv, index, arg); index += 1; break;
      case "--worker-script-name": options.workerScriptName = readValue(argv, index, arg); index += 1; break;
      case "--help":
      case "-h":
        options.help = true; break;
      default:
        throw new Error(`Unknown option: ${arg}\n\n${usage()}`);
    }
  }
  options.domains = [...new Set(options.domains)];
  return options;
}

export class CloudflareApiClient {
  constructor(apiBase, token, fetchImpl) {
    this.apiBase = apiBase.replace(/\/+$/u, "");
    this.token = token;
    this.fetchImpl = fetchImpl;
  }
  async get(path) {
    const response = await this.fetchImpl(`${this.apiBase}${path}`, {
      method: "GET",
      headers: { authorization: `Bearer ${this.token}`, accept: "application/json" },
    });
    const body = parseJsonOrText(await response.text());
    return { status: response.status, ok: response.ok, body };
  }
  async post(path, payload) {
    const response = await this.fetchImpl(`${this.apiBase}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = parseJsonOrText(await response.text());
    return { status: response.status, ok: response.ok, body };
  }
}

function buildPlan(options) {
  return {
    admin_url: options.adminUrl,
    domains: options.domains.map((domain) => ({
      domain,
      relay_hostname: `smtp.${options.domains[0]}`,
      dns_records: dnsRecordPlan(domain),
      verification: `pnpm doctor:delivery -- --domain ${domain}`,
    })),
    // High-level steps performed by --apply.
    apply_steps: [
      `Create or reuse D1 database (${options.d1DatabaseName})`,
      `Create or reuse KV namespace (${options.kvNamespaceTitle})`,
      `Create or reuse Cloudflare Access app on ${options.adminUrl}`,
      `Generate 4 worker secrets`,
      `Write worker/wrangler.toml`,
      `Apply D1 migrations`,
      `Push secrets via wrangler`,
      `Build UI into worker/public/`,
      `Deploy worker`,
      `POST /bootstrap/admin and delete BOOTSTRAP_SETUP_TOKEN`,
      `Write RUNBOOK.md`,
    ],
    // Verbatim commands an operator can run if they prefer the manual flow.
    commands: [
      `pnpm --dir worker exec wrangler d1 create ${options.d1DatabaseName}`,
      `pnpm --dir worker exec wrangler kv namespace create ${options.kvNamespaceTitle}`,
      "pnpm --dir worker exec wrangler d1 migrations apply <D1_DATABASE_NAME> --remote",
      ...requiredSecrets.map((secret) => `pnpm --dir worker exec wrangler secret put ${secret}`),
      "pnpm access:setup --allow-email <admin@example.com> --apply-config worker/wrangler.toml",
      "pnpm --filter @cf-mail-relay/ui build",
      "pnpm --dir worker exec wrangler deploy",
      "pnpm doctor:local -- --domain <domain>",
    ],
  };
}

async function checkToken(client) {
  const response = await client.get("/user/tokens/verify");
  return response.ok ? passCheck("api_token", "Cloudflare API token verified.") : failCheck("api_token", `Token verification failed with HTTP ${response.status}.`, response.body);
}

async function checkAccount(client, accountId) {
  const response = await client.get(`/accounts/${encodeURIComponent(accountId)}`);
  return response.ok ? passCheck("account_access", "Cloudflare account is accessible.", { name: response.body?.result?.name }) : failCheck("account_access", `Account lookup failed with HTTP ${response.status}.`, response.body);
}

async function checkWorkersPaid(client, accountId) {
  const response = await client.get(`/accounts/${encodeURIComponent(accountId)}/subscriptions`);
  if (!response.ok) {
    return warnCheck("workers_paid_plan", "Could not verify Workers Paid subscription through the API; confirm in the Cloudflare dashboard.", response.body);
  }
  const subscriptions = Array.isArray(response.body?.result) ? response.body.result : [];
  const hasWorkersPaid = subscriptions.some((subscription) => {
    const text = JSON.stringify(subscription).toLowerCase();
    return text.includes("workers paid") || text.includes("workers_paid") || text.includes("workers:paid");
  });
  return hasWorkersPaid ? passCheck("workers_paid_plan", "Workers Paid subscription appears active.") : warnCheck("workers_paid_plan", "No Workers Paid subscription was detected; Email Sending requires Workers Paid.", { subscription_count: subscriptions.length });
}

async function checkD1(client, accountId, databaseId, databaseName) {
  if (!databaseId) {
    return warnCheck("d1_database", "No --d1-id provided. `pnpm run setup --apply` will create one.", { database_name: databaseName });
  }
  const response = await client.get(`/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}`);
  return response.ok ? passCheck("d1_database", "D1 database is accessible.", { name: response.body?.result?.name }) : failCheck("d1_database", `D1 lookup failed with HTTP ${response.status}.`, response.body);
}

async function checkKv(client, accountId, namespaceId, namespaceTitle) {
  const response = await client.get(`/accounts/${encodeURIComponent(accountId)}/storage/kv/namespaces`);
  if (!response.ok) {
    return failCheck("kv_namespace", `KV namespace lookup failed with HTTP ${response.status}.`, response.body);
  }
  const namespaces = Array.isArray(response.body?.result) ? response.body.result : [];
  const match = namespaces.find((namespace) => namespace.id === namespaceId || namespace.title === namespaceTitle);
  return match ? passCheck("kv_namespace", "KV namespace is accessible.", { id: match.id, title: match.title }) : warnCheck("kv_namespace", "KV namespace not found; `pnpm run setup --apply` will create one.", { expected_title: namespaceTitle });
}

async function checkAccess(client, accountId, appName, adminUrl) {
  const response = await client.get(`/accounts/${encodeURIComponent(accountId)}/access/apps?name=${encodeURIComponent(appName)}`);
  if (!response.ok) {
    return warnCheck("access_app", "Could not read Access apps; create or verify the Access app separately.", response.body);
  }
  const apps = Array.isArray(response.body?.result) ? response.body.result : [];
  const app = apps.find((candidate) => candidate.name === appName);
  if (app === undefined) {
    return warnCheck("access_app", "Access app not found. `pnpm run setup --apply` will create it.", { app_name: appName });
  }
  return passCheck("access_app", "Access app exists.", { app_id: app.id, expected_destination: withoutScheme(adminUrl) });
}

async function checkWorkerSecrets(client, accountId, scriptName) {
  const response = await client.get(`/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(scriptName)}/secrets`);
  if (!response.ok) {
    return warnCheck("worker_secrets", "Could not list Worker secrets; deploy and set secrets before production use.", response.body);
  }
  const found = new Set((Array.isArray(response.body?.result) ? response.body.result : []).map((secret) => secret.name));
  const missing = requiredSecrets.filter((secret) => !found.has(secret));
  return missing.length === 0 ? passCheck("worker_secrets", "All required Worker secrets are present.") : failCheck("worker_secrets", "Required Worker secrets are missing.", { missing });
}

async function checkDomain(client, accountId, domain) {
  const zoneResponse = await client.get(`/zones?name=${encodeURIComponent(domain)}`);
  const checks = [];
  let zoneId = "";
  if (zoneResponse.ok && Array.isArray(zoneResponse.body?.result) && zoneResponse.body.result.length > 0) {
    zoneId = zoneResponse.body.result[0].id;
    checks.push(passCheck(`domain:${domain}:zone`, "Cloudflare zone is accessible.", { zone_id: zoneId }));
  } else {
    checks.push(failCheck(`domain:${domain}:zone`, "Cloudflare zone was not found or is inaccessible.", zoneResponse.body));
    return checks;
  }
  const sendingResponse = await client.get(`/zones/${encodeURIComponent(zoneId)}/email/sending/subdomains`);
  if (!sendingResponse.ok) {
    checks.push(failCheck(`domain:${domain}:email_sending`, `Email Sending lookup failed with HTTP ${sendingResponse.status}.`, sendingResponse.body));
    return checks;
  }
  const subdomains = Array.isArray(sendingResponse.body?.result) ? sendingResponse.body.result : [];
  const match = subdomains.find((subdomain) => normalizeDomain(subdomain.name ?? "") === domain);
  if (match?.enabled === true) {
    checks.push(passCheck(`domain:${domain}:email_sending`, "Email Sending is enabled for this domain.", { tag: match.tag, return_path_domain: match.return_path_domain }));
  } else {
    checks.push(failCheck(`domain:${domain}:email_sending`, "Email Sending is not enabled for this domain.", { available: subdomains.map((subdomain) => ({ name: subdomain.name, enabled: subdomain.enabled })) }));
  }
  return checks;
}

function dnsRecordPlan(domain) {
  return [
    { type: "MX", name: `cf-bounce.${domain}`, value: "Cloudflare-generated bounce MX" },
    { type: "TXT", name: `cf-bounce.${domain}`, value: "Cloudflare-generated SPF" },
    { type: "TXT", name: `cf-bounce._domainkey.${domain}`, value: "Cloudflare-generated DKIM" },
    { type: "TXT", name: `_dmarc.${domain}`, value: "v=DMARC1; p=none; rua=mailto:dmarc@" + domain },
  ];
}

function base64url(bytes) {
  return randomBytes(bytes).toString("base64url");
}

function passCheck(name, message, details = {}) { return { name, status: "pass", message, details }; }
function failCheck(name, message, details = {}) { return { name, status: "fail", message, details }; }
function warnCheck(name, message, details = {}) { return { name, status: "warn", message, details }; }

function readValue(argv, index, optionName) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${optionName} requires a value.`);
  }
  return value;
}

function normalizeDomain(raw) {
  return String(raw).trim().replace(/\.$/u, "").toLowerCase();
}

function parseJsonOrText(text) {
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/u, "");
}

function withoutScheme(url) {
  return trimTrailingSlash(url).replace(/^https?:\/\//u, "");
}

function runCommand(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? process.cwd(),
      env: process.env,
      stdio: options.stdin === undefined ? ["ignore", "inherit", "inherit"] : ["pipe", "inherit", "inherit"],
    });
    if (options.stdin !== undefined && child.stdin !== null) {
      child.stdin.write(options.stdin);
      child.stdin.end();
    }
    child.on("close", (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
    child.on("error", rejectPromise);
  });
}

function usage() {
  return `Usage:
  pnpm run setup --account-id <id> --domain <domain> --admin-url https://mail.example.com [--dry-run]
  pnpm run setup --apply --admin-url https://mail.example.com --allow-email you@example.com --domain example.com

Required:
  --account-id              Cloudflare account ID, or CLOUDFLARE_ACCOUNT_ID.
  --admin-url               URL where the admin UI + API will live (e.g. https://mail.example.com).
  --domain                  Sending domain (repeat for multiple).

Apply flags (--apply):
  --allow-email <email>     Required at least once for the Access policy.
  --allow-platform-hostnames
                             Allow pages.dev/workers.dev admin URLs. Custom
                             domains are strongly preferred.
  --d1-id <id>              Use existing D1 instead of creating.
  --kv-id <id>              Use existing KV namespace instead of creating.
  --relay-key-id <id>       RELAY_HMAC_KEY_ID (default rel_01).
  --regenerate-secrets      Force regenerate even if worker/wrangler.toml exists.
  --push-cf-api-token       Push your setup CLOUDFLARE_API_TOKEN as the worker's
                             runtime CF_API_TOKEN secret. NOT recommended — your
                             setup token has broad scopes; the runtime token
                             should only have Email Sending Edit. Default off.
  --force                   Overwrite existing worker/wrangler.toml.
  --skip-migrations         Skip 'wrangler d1 migrations apply'.
  --skip-build-deploy       Skip UI build + worker deploy.
  --skip-bootstrap          Skip the /bootstrap/admin call.

Common:
  --token-env <name>        Env var holding the CF API token (default CLOUDFLARE_API_TOKEN).
  --dry-run                 Print plan only; no API calls (no token required).
`;
}
