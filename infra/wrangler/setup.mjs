#!/usr/bin/env node

import { pathToFileURL } from "node:url";

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

export async function main(argv, env, fetchImpl = fetch) {
  const options = parseArgs(argv);
  if (options.help) {
    return { ok: true, usage: usage() };
  }
  if (options.domains.length === 0) {
    throw new Error(`At least one --domain is required.\n\n${usage()}`);
  }
  if (!options.accountId) {
    throw new Error(`--account-id or CLOUDFLARE_ACCOUNT_ID is required.\n\n${usage()}`);
  }

  const plan = buildPlan(options);
  if (options.dryRun) {
    return { ok: true, checked_at: new Date().toISOString(), dry_run: true, plan };
  }

  const token = env[options.tokenEnv];
  if (!token) {
    throw new Error(`${options.tokenEnv} must contain a Cloudflare API token, or pass --dry-run for a command plan.`);
  }

  const client = new CloudflareApiClient(options.apiBase, token, fetchImpl);
  const checks = [];
  checks.push(await checkToken(client));
  checks.push(await checkAccount(client, options.accountId));
  checks.push(await checkWorkersPaid(client, options.accountId));
  checks.push(await checkD1(client, options.accountId, options.d1DatabaseId, options.d1DatabaseName));
  checks.push(await checkKv(client, options.accountId, options.kvNamespaceId, options.kvNamespaceTitle));
  checks.push(await checkAccess(client, options.accountId, options.accessAppName, options.pagesUrl, options.workerUrl));
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

export function parseArgs(argv, env = process.env) {
  const options = {
    accountId: env.CLOUDFLARE_ACCOUNT_ID ?? "",
    accessAppName: "cf-mail-relay-admin",
    apiBase: defaultApiBase,
    d1DatabaseId: "",
    d1DatabaseName: "cf-mail-relay",
    domains: [],
    dryRun: false,
    help: false,
    kvNamespaceId: "",
    kvNamespaceTitle: "cf-mail-relay-hot",
    pagesUrl: "https://cf-mail-relay-ui.pages.dev",
    tokenEnv: "CLOUDFLARE_API_TOKEN",
    workerScriptName: "cf-mail-relay-worker",
    workerUrl: "https://cf-mail-relay-worker.milfred.workers.dev",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--account-id":
        options.accountId = readValue(argv, index, arg);
        index += 1;
        break;
      case "--access-app-name":
        options.accessAppName = readValue(argv, index, arg);
        index += 1;
        break;
      case "--api-base":
        options.apiBase = readValue(argv, index, arg);
        index += 1;
        break;
      case "--d1-database-id":
        options.d1DatabaseId = readValue(argv, index, arg);
        index += 1;
        break;
      case "--d1-database-name":
        options.d1DatabaseName = readValue(argv, index, arg);
        index += 1;
        break;
      case "--domain":
        options.domains.push(normalizeDomain(readValue(argv, index, arg)));
        index += 1;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--kv-namespace-id":
        options.kvNamespaceId = readValue(argv, index, arg);
        index += 1;
        break;
      case "--kv-namespace-title":
        options.kvNamespaceTitle = readValue(argv, index, arg);
        index += 1;
        break;
      case "--pages-url":
        options.pagesUrl = trimTrailingSlash(readValue(argv, index, arg));
        index += 1;
        break;
      case "--token-env":
        options.tokenEnv = readValue(argv, index, arg);
        index += 1;
        break;
      case "--worker-script-name":
        options.workerScriptName = readValue(argv, index, arg);
        index += 1;
        break;
      case "--worker-url":
        options.workerUrl = trimTrailingSlash(readValue(argv, index, arg));
        index += 1;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
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
}

function buildPlan(options) {
  return {
    domains: options.domains.map((domain) => ({
      domain,
      relay_hostname: `smtp.${options.domains[0]}`,
      dns_records: dnsRecordPlan(domain),
      verification: `pnpm doctor:delivery -- --domain ${domain}`,
    })),
    commands: [
      `pnpm --dir worker exec wrangler d1 create ${options.d1DatabaseName}`,
      `pnpm --dir worker exec wrangler kv namespace create ${options.kvNamespaceTitle}`,
      "pnpm --dir worker exec wrangler d1 migrations apply <D1_DATABASE_NAME> --remote",
      ...requiredSecrets.map((secret) => `pnpm --dir worker exec wrangler secret put ${secret}`),
      "pnpm access:setup --allow-email <admin@example.com> --apply-config worker/wrangler.toml",
      "pnpm --dir worker exec wrangler deploy",
      "PUBLIC_CF_MAIL_RELAY_API_BASE=<worker-url> pnpm --filter @cf-mail-relay/ui build",
      "pnpm --dir worker exec wrangler pages deploy ../ui/dist --project-name cf-mail-relay-ui --branch main",
      "pnpm doctor:local -- --domain <domain> --worker-url <worker-url>",
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
    return warnCheck("d1_database", "No --d1-database-id provided. Create D1 and apply migrations before deploy.", { database_name: databaseName });
  }
  const response = await client.get(`/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}`);
  return response.ok ? passCheck("d1_database", "D1 database is accessible; production D1 includes Time Travel.", { name: response.body?.result?.name }) : failCheck("d1_database", `D1 lookup failed with HTTP ${response.status}.`, response.body);
}

async function checkKv(client, accountId, namespaceId, namespaceTitle) {
  const response = await client.get(`/accounts/${encodeURIComponent(accountId)}/storage/kv/namespaces`);
  if (!response.ok) {
    return failCheck("kv_namespace", `KV namespace lookup failed with HTTP ${response.status}.`, response.body);
  }
  const namespaces = Array.isArray(response.body?.result) ? response.body.result : [];
  const match = namespaces.find((namespace) => namespace.id === namespaceId || namespace.title === namespaceTitle);
  return match ? passCheck("kv_namespace", "KV namespace is accessible.", { id: match.id, title: match.title }) : warnCheck("kv_namespace", "KV namespace was not found; create it before deploy.", { expected_id: namespaceId || undefined, expected_title: namespaceTitle });
}

async function checkAccess(client, accountId, appName, pagesUrl, workerUrl) {
  const response = await client.get(`/accounts/${encodeURIComponent(accountId)}/access/apps?name=${encodeURIComponent(appName)}`);
  if (!response.ok) {
    return warnCheck("access_app", "Could not read Access apps; create or verify the Access app separately.", response.body);
  }
  const apps = Array.isArray(response.body?.result) ? response.body.result : [];
  const app = apps.find((candidate) => candidate.name === appName);
  if (app === undefined) {
    return warnCheck("access_app", "Access app was not found. Run pnpm access:setup before exposing the UI.", { app_name: appName });
  }
  const expected = [withoutScheme(pagesUrl), `${withoutScheme(workerUrl)}/admin/api/*`];
  return passCheck("access_app", "Access app exists; verify destinations include Pages and Worker admin API.", { app_id: app.id, expected_destinations: expected });
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
    const dnsResponse = await client.get(`/zones/${encodeURIComponent(zoneId)}/email/sending/subdomains/${encodeURIComponent(match.tag)}/dns`);
    checks.push(dnsResponse.ok ? passCheck(`domain:${domain}:email_sending_dns`, "Cloudflare returned Email Sending DNS records.", { record_count: Array.isArray(dnsResponse.body?.result) ? dnsResponse.body.result.length : undefined }) : warnCheck(`domain:${domain}:email_sending_dns`, "Could not read Email Sending DNS records.", dnsResponse.body));
  } else {
    checks.push(failCheck(`domain:${domain}:email_sending`, "Email Sending is not enabled for this domain.", { available: subdomains.map((subdomain) => ({ name: subdomain.name, enabled: subdomain.enabled })) }));
  }
  checks.push(warnCheck(`domain:${domain}:sandbox`, "Cloudflare's API may not expose sandbox state; verify live delivery before promising arbitrary recipients."));
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

function passCheck(name, message, details = {}) {
  return { name, status: "pass", message, details };
}

function failCheck(name, message, details = {}) {
  return { name, status: "fail", message, details };
}

function warnCheck(name, message, details = {}) {
  return { name, status: "warn", message, details };
}

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

function usage() {
  return `Usage:
  pnpm run setup --account-id <account_id> --domain <domain> [--domain <other-domain>]

Required:
  --account-id              Cloudflare account ID, or CLOUDFLARE_ACCOUNT_ID.
  --domain                  Sending domain. Repeat for multiple domains.

Common options:
  --d1-database-id <id>     Existing D1 database ID to verify.
  --kv-namespace-id <id>    Existing KV namespace ID to verify.
  --pages-url <url>         Pages admin UI URL.
  --worker-url <url>        Worker URL.
  --dry-run                 Print the setup plan without Cloudflare API calls.
`;
}
