#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { updateWranglerVars } from "./access-apply.mjs";

export const defaults = {
  name: "cf-mail-relay-admin",
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
  tokenEnv: "CLOUDFLARE_API_TOKEN",
  pagesUrl: "https://cf-mail-relay-ui.pages.dev",
  workerUrl: "https://cf-mail-relay-worker.milfred.workers.dev",
  sessionDuration: "24h",
  email: [],
  dryRun: false,
  applyConfig: "",
};

export function buildBodies(config) {
  return {
    app: {
      name: config.name,
      type: "self_hosted",
      domain: withoutScheme(config.pagesUrl),
      destinations: [
        { type: "public", uri: withoutScheme(config.pagesUrl) },
        { type: "public", uri: `${withoutScheme(config.workerUrl)}/admin/api/*` },
      ],
      session_duration: config.sessionDuration,
      app_launcher_visible: true,
      cors_headers: {
        allow_credentials: true,
        allowed_methods: ["GET", "POST", "OPTIONS"],
        allowed_headers: ["content-type"],
        allowed_origins: [config.pagesUrl],
        max_age: 600,
      },
    },
    policy: {
      name: `${config.name} allow admins`,
      decision: "allow",
      include: config.email.map((email) => ({ email: { email } })),
      session_duration: config.sessionDuration,
    },
  };
}

export function parseArgs(args, fail = throwUsageError) {
  const parsed = { email: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--account-id":
        parsed.accountId = takeValue(args, ++index, arg, fail);
        break;
      case "--token-env":
        parsed.tokenEnv = takeValue(args, ++index, arg, fail);
        break;
      case "--name":
        parsed.name = takeValue(args, ++index, arg, fail);
        break;
      case "--pages-url":
        parsed.pagesUrl = trimTrailingSlash(takeValue(args, ++index, arg, fail));
        break;
      case "--worker-url":
        parsed.workerUrl = trimTrailingSlash(takeValue(args, ++index, arg, fail));
        break;
      case "--session-duration":
        parsed.sessionDuration = takeValue(args, ++index, arg, fail);
        break;
      case "--allow-email":
        parsed.email.push(...takeValue(args, ++index, arg, fail).split(",").map((email) => email.trim()).filter(Boolean));
        break;
      case "--dry-run":
        parsed.dryRun = true;
        break;
      case "--apply-config":
        parsed.applyConfig = takeValue(args, ++index, arg, fail);
        break;
      case "--help":
        usage(0);
        break;
      default:
        fail(`unknown argument: ${arg}`);
    }
  }
  return parsed;
}

export async function run(rawArgs = process.argv.slice(2), env = process.env, fetchImpl = fetch) {
  const options = parseArgs(rawArgs, fail);
  const config = { ...defaults, accountId: env.CLOUDFLARE_ACCOUNT_ID ?? defaults.accountId, ...options };
  const token = env[config.tokenEnv];

  if (!config.accountId) {
    fail("--account-id or CLOUDFLARE_ACCOUNT_ID is required");
  }
  if (!token && !config.dryRun) {
    fail(`${config.tokenEnv} is required unless --dry-run is set`);
  }
  if (config.email.length === 0) {
    fail("at least one --allow-email is required");
  }

  const { app: appBody, policy: policyBody } = buildBodies(config);
  if (config.dryRun) {
    return { app: appBody, policy: policyBody };
  }

  const client = makeClient(config.accountId, token, fetchImpl);
  const organization = await client.api("GET", `/accounts/${config.accountId}/access/organizations`);
  const authDomain = organization.result?.auth_domain;
  if (typeof authDomain !== "string" || authDomain.length === 0) {
    fail("Cloudflare Access organization has no auth_domain");
  }

  const existing = await client.api("GET", `/accounts/${config.accountId}/access/apps?name=${encodeURIComponent(config.name)}`);
  const existingApp = Array.isArray(existing.result) ? existing.result.find((app) => app.name === config.name) : undefined;
  const app = existingApp === undefined
    ? await client.api("POST", `/accounts/${config.accountId}/access/apps`, appBody)
    : await client.api("PUT", `/accounts/${config.accountId}/access/apps/${existingApp.id}`, { ...appBody, id: existingApp.id });
  const appId = app.result?.id;
  if (typeof appId !== "string") {
    fail("Access app response did not include an id");
  }

  const policies = await client.api("GET", `/accounts/${config.accountId}/access/apps/${appId}/policies`);
  const existingPolicy = Array.isArray(policies.result) ? policies.result.find((policy) => policy.name === policyBody.name) : undefined;
  if (existingPolicy === undefined) {
    await client.api("POST", `/accounts/${config.accountId}/access/apps/${appId}/policies`, policyBody);
  } else {
    await client.api("PUT", `/accounts/${config.accountId}/access/apps/${appId}/policies/${existingPolicy.id}`, { ...policyBody, id: existingPolicy.id });
  }

  const refreshed = await client.api("GET", `/accounts/${config.accountId}/access/apps/${appId}`);
  const aud = refreshed.result?.aud;
  if (typeof aud !== "string" || aud.length === 0) {
    fail("Access app response did not include an aud value");
  }

  const result = {
    app_id: appId,
    app_name: config.name,
    access_team_domain: authDomain,
    access_audience: aud,
    pages_url: config.pagesUrl,
    worker_admin_api: `${config.workerUrl}/admin/api/*`,
  };
  if (config.applyConfig.length > 0) {
    result.applied_config = await applyAccessConfig(config.applyConfig, {
      ACCESS_TEAM_DOMAIN: authDomain,
      ACCESS_AUDIENCE: aud,
      ADMIN_CORS_ORIGIN: config.pagesUrl,
    });
  }
  return result;
}

async function applyAccessConfig(path, vars) {
  const before = await readFile(path, "utf8");
  const after = updateWranglerVars(before, vars);
  if (after !== before) {
    await writeFile(path, after);
  }
  return {
    config: path,
    changed: after !== before,
    vars,
  };
}

function makeClient(_accountId, token, fetchImpl) {
  return {
    async api(method, path, body) {
      const response = await fetchImpl(`https://api.cloudflare.com/client/v4${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const payload = await response.json();
      if (!response.ok || payload.success === false) {
        const message = payload.errors?.map((error) => `${error.code}: ${error.message}`).join("; ") || response.statusText;
        fail(`${method} ${path} failed: ${message}`);
      }
      return payload;
    },
  };
}

function takeValue(args, index, flag, fail) {
  const value = args[index];
  if (value === undefined || value.startsWith("--")) {
    fail(`${flag} requires a value`);
  }
  return value;
}

function withoutScheme(url) {
  return trimTrailingSlash(url).replace(/^https?:\/\//, "");
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function usage(code) {
  console.log(`Usage: node infra/wrangler/access-app.mjs --account-id <id> --allow-email <email> [options]

Creates or updates the Cloudflare Access app required by MS3.

Options:
  --token-env <name>          Environment variable containing an Access-capable Cloudflare API token
  --name <name>               Access app name (default: cf-mail-relay-admin)
  --pages-url <url>           Pages UI URL (default: https://cf-mail-relay-ui.pages.dev)
  --worker-url <url>          Worker API URL (default: https://cf-mail-relay-worker.milfred.workers.dev)
  --session-duration <value>  Access session duration (default: 24h)
  --allow-email <email,csv>   Email address allowed by the app policy; repeatable
  --apply-config <path>       Apply returned Access values to a Worker wrangler.toml
  --dry-run                   Print request bodies without calling Cloudflare
`);
  process.exit(code);
}

function throwUsageError(message) {
  throw new Error(message);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await run();
  console.log(JSON.stringify(result, null, 2));
}
