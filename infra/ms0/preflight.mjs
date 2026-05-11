#!/usr/bin/env node

import process from "node:process";
import { pathToFileURL } from "node:url";

const defaultApiBase = "https://api.cloudflare.com/client/v4";

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
    return {
      ok: true,
      usage: usage(),
    };
  }

  const missing = requiredFields(options);
  if (missing.length > 0) {
    throw new Error(`Missing required option(s): ${missing.join(", ")}\n\n${usage()}`);
  }

  const token = env[options.tokenEnv];
  if (token === undefined || token.length === 0) {
    throw new Error(`Environment variable ${options.tokenEnv} must contain a Cloudflare API token.`);
  }

  const client = new CloudflareApiClient(options.apiBase, token, fetchImpl);
  const checks = [];

  checks.push(await checkToken(client));
  checks.push(await checkAccount(client, options.accountId));
  checks.push(await checkZone(client, options.zoneId, options.domain));
  const subdomainCheck = await checkSendingSubdomain(client, options.zoneId, options.domain);
  checks.push(subdomainCheck);
  if (subdomainCheck.subdomainId !== undefined) {
    checks.push(await checkSendingDns(client, options.zoneId, subdomainCheck.subdomainId));
  } else {
    checks.push(skipCheck("sending_dns_records", "No matching enabled sending subdomain was found."));
  }

  checks.push(warnCheck("sandbox_status", "Cloudflare's listed sending subdomain model exposes enabled/name/tag but not sandbox status. MS0 still requires live delivery evidence."));

  return {
    ok: checks.every((check) => check.status !== "fail"),
    checked_at: new Date().toISOString(),
    account_id: options.accountId,
    zone_id: options.zoneId,
    domain: options.domain,
    checks,
  };
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
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: "application/json",
      },
    });
    const text = await response.text();
    const body = parseJsonOrText(text);
    return {
      status: response.status,
      ok: response.ok,
      body,
    };
  }
}

export function parseArgs(argv) {
  const options = {
    accountId: "",
    apiBase: defaultApiBase,
    domain: "",
    help: false,
    tokenEnv: "CLOUDFLARE_API_TOKEN",
    zoneId: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--account-id":
        options.accountId = readValue(argv, index, arg);
        index += 1;
        break;
      case "--api-base":
        options.apiBase = readValue(argv, index, arg);
        index += 1;
        break;
      case "--domain":
        options.domain = normalizeDomain(readValue(argv, index, arg));
        index += 1;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--token-env":
        options.tokenEnv = readValue(argv, index, arg);
        index += 1;
        break;
      case "--zone-id":
        options.zoneId = readValue(argv, index, arg);
        index += 1;
        break;
      default:
        throw new Error(`Unknown option: ${arg}\n\n${usage()}`);
    }
  }

  return options;
}

async function checkToken(client) {
  const response = await client.get("/user/tokens/verify");
  if (!response.ok) {
    return failCheck("api_token", `Token verification failed with HTTP ${response.status}.`, response.body);
  }
  return passCheck("api_token", "Cloudflare API token verified.", { status: response.status });
}

async function checkAccount(client, accountId) {
  const response = await client.get(`/accounts/${encodeURIComponent(accountId)}`);
  if (!response.ok) {
    return failCheck("account_access", `Account lookup failed with HTTP ${response.status}.`, response.body);
  }
  return passCheck("account_access", "Cloudflare account is accessible to this token.", {
    name: response.body?.result?.name,
  });
}

async function checkZone(client, zoneId, domain) {
  const response = await client.get(`/zones/${encodeURIComponent(zoneId)}`);
  if (!response.ok) {
    return failCheck("zone_access", `Zone lookup failed with HTTP ${response.status}.`, response.body);
  }

  const zoneName = normalizeDomain(response.body?.result?.name ?? "");
  if (zoneName.length > 0 && !domain.endsWith(zoneName)) {
    return failCheck("zone_access", `Domain ${domain} is not under Cloudflare zone ${zoneName}.`, {
      zone_name: zoneName,
    });
  }

  return passCheck("zone_access", "Cloudflare zone is accessible and matches the requested domain.", {
    zone_name: zoneName,
  });
}

async function checkSendingSubdomain(client, zoneId, domain) {
  const response = await client.get(`/zones/${encodeURIComponent(zoneId)}/email/sending/subdomains`);
  if (!response.ok) {
    return failCheck("sending_subdomain", `Sending subdomain list failed with HTTP ${response.status}.`, response.body);
  }

  const subdomains = Array.isArray(response.body?.result) ? response.body.result : [];
  const exact = subdomains.find((subdomain) => normalizeDomain(subdomain.name ?? "") === domain);
  const parent = subdomains.find((subdomain) => domain.endsWith(`.${normalizeDomain(subdomain.name ?? "")}`));
  const match = exact ?? parent;
  if (match === undefined) {
    return failCheck("sending_subdomain", `No Email Sending subdomain matched ${domain}.`, {
      available: subdomains.map((subdomain) => ({ name: subdomain.name, enabled: subdomain.enabled, tag: subdomain.tag })),
    });
  }

  if (match.enabled !== true) {
    return failCheck("sending_subdomain", `Email Sending subdomain ${match.name} is present but not enabled.`, {
      name: match.name,
      enabled: match.enabled,
      tag: match.tag,
    });
  }

  return {
    ...passCheck("sending_subdomain", `Email Sending subdomain ${match.name} is enabled.`, {
      name: match.name,
      tag: match.tag,
      dkim_selector: match.dkim_selector,
      return_path_domain: match.return_path_domain,
    }),
    subdomainId: match.tag,
  };
}

async function checkSendingDns(client, zoneId, subdomainId) {
  const response = await client.get(`/zones/${encodeURIComponent(zoneId)}/email/sending/subdomains/${encodeURIComponent(subdomainId)}/dns`);
  if (!response.ok) {
    return failCheck("sending_dns_records", `Sending subdomain DNS lookup failed with HTTP ${response.status}.`, response.body);
  }

  return passCheck("sending_dns_records", "Cloudflare returned Email Sending DNS records for the matched subdomain.", {
    record_count: Array.isArray(response.body?.result) ? response.body.result.length : undefined,
  });
}

function requiredFields(options) {
  return [
    ["--account-id", options.accountId],
    ["--domain", options.domain],
    ["--zone-id", options.zoneId],
  ]
    .filter(([, value]) => value.length === 0)
    .map(([name]) => name);
}

function passCheck(name, message, details = {}) {
  return {
    name,
    status: "pass",
    message,
    details,
  };
}

function failCheck(name, message, details = {}) {
  return {
    name,
    status: "fail",
    message,
    details,
  };
}

function warnCheck(name, message, details = {}) {
  return {
    name,
    status: "warn",
    message,
    details,
  };
}

function skipCheck(name, message, details = {}) {
  return {
    name,
    status: "skip",
    message,
    details,
  };
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
  if (text.length === 0) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function usage() {
  return `Usage:
  pnpm ms0:preflight --account-id <account_id> --zone-id <zone_id> --domain <sending-domain>

Options:
  --account-id  Cloudflare account ID used by send_raw.
  --zone-id     Cloudflare zone ID that owns the sending domain.
  --domain      Sending domain or subdomain to test.
  --token-env   Environment variable containing the Cloudflare API token. Default: CLOUDFLARE_API_TOKEN.
  --api-base    Cloudflare API base URL. Default: ${defaultApiBase}.`;
}
