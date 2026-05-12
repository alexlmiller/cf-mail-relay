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
  teamDomain: "",
  allowPlatformHostnames: false,
};

const platformHostnameSuffixes = [".pages.dev", ".workers.dev"];

export function buildBodies(config) {
  // Same-origin model: the Worker serves both the UI and the API at one
  // hostname, so the Access app gates a single destination — the admin host.
  const adminHost = withoutScheme(config.pagesUrl);
  return {
    app: {
      name: config.name,
      type: "self_hosted",
      domain: adminHost,
      destinations: [
        { type: "public", uri: adminHost },
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
      case "--team-domain":
        parsed.teamDomain = withoutScheme(takeValue(args, ++index, arg, fail));
        break;
      case "--allow-platform-hostnames":
        parsed.allowPlatformHostnames = true;
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

export async function run(rawArgs = process.argv.slice(2), env = process.env, fetchImpl = fetch, failImpl = fail) {
  const options = parseArgs(rawArgs, failImpl);
  const config = { ...defaults, accountId: env.CLOUDFLARE_ACCOUNT_ID ?? defaults.accountId, ...options };
  const token = env[config.tokenEnv];

  if (!config.accountId) {
    failImpl("--account-id or CLOUDFLARE_ACCOUNT_ID is required");
  }
  if (!token && !config.dryRun) {
    failImpl(`${config.tokenEnv} is required unless --dry-run is set`);
  }
  if (config.email.length === 0) {
    failImpl("at least one --allow-email is required");
  }
  // Same-origin model: workerUrl defaults to the admin host. Warn if the
  // caller passed --worker-url with a different value (legacy two-origin
  // setup — supported by setting ADMIN_CORS_ORIGIN, but not the default).
  if (config.workerUrl && config.workerUrl !== config.pagesUrl) {
    process.stderr.write(`warning: --worker-url differs from --pages-url; same-origin Access app uses --pages-url only.\n`);
  }
  const platformHostnames = findPlatformHostnames([config.pagesUrl]);
  if (platformHostnames.length > 0 && !config.allowPlatformHostnames) {
    failImpl(`Platform hostnames require Workers & Pages Access controls, or pass --allow-platform-hostnames after confirming this account accepts them in a self-hosted Access app: ${platformHostnames.join(", ")}`);
  }

  const { app: appBody, policy: policyBody } = buildBodies(config);
  if (config.dryRun) {
    return { app: appBody, policy: policyBody };
  }

  const client = makeClient(config.accountId, token, fetchImpl);
  const authDomain = config.teamDomain || await readAccessTeamDomain(client, config.accountId);
  if (typeof authDomain !== "string" || authDomain.length === 0) {
    failImpl("Cloudflare Access organization has no auth_domain");
  }

  const existing = await client.api("GET", `/accounts/${config.accountId}/access/apps?name=${encodeURIComponent(config.name)}`);
  const existingApp = Array.isArray(existing.result) ? existing.result.find((app) => app.name === config.name) : undefined;
  const app = existingApp === undefined
    ? await client.api("POST", `/accounts/${config.accountId}/access/apps`, appBody)
    : await client.api("PUT", `/accounts/${config.accountId}/access/apps/${existingApp.id}`, { ...appBody, id: existingApp.id });
  const appId = app.result?.id;
  if (typeof appId !== "string") {
    failImpl("Access app response did not include an id");
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
    failImpl("Access app response did not include an aud value");
  }

  const result = {
    app_id: appId,
    app_name: config.name,
    access_team_domain: authDomain,
    access_audience: aud,
    admin_url: config.pagesUrl,
  };
  if (config.applyConfig.length > 0) {
    // Same-origin: the Worker defaults its trusted Origin to its own URL, so
    // ADMIN_CORS_ORIGIN is left unset. Only set if the operator has opted into
    // a two-origin (legacy Pages) setup, which they'd do manually.
    result.applied_config = await applyAccessConfig(config.applyConfig, {
      ACCESS_TEAM_DOMAIN: authDomain,
      ACCESS_AUDIENCE: aud,
    });
  }
  return result;
}

async function readAccessTeamDomain(client, accountId) {
  const organization = await client.api("GET", `/accounts/${accountId}/access/organizations`);
  return organization.result?.auth_domain;
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

function findPlatformHostnames(urls) {
  return urls
    .map((url) => withoutScheme(url).split("/", 1)[0]?.toLowerCase() ?? "")
    .filter((hostname) => platformHostnameSuffixes.some((suffix) => hostname.endsWith(suffix)));
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function usage(code) {
  console.log(`Usage: node infra/wrangler/access-app.mjs --account-id <id> --allow-email <email> [options]

Creates or updates the Cloudflare Access app for the admin UI.

Options:
  --token-env <name>          Environment variable containing an Access-capable Cloudflare API token
  --name <name>               Access app name (default: cf-mail-relay-admin)
  --pages-url <url>           Pages UI URL (default: https://cf-mail-relay-ui.pages.dev)
  --worker-url <url>          Worker API URL (default: https://cf-mail-relay-worker.milfred.workers.dev)
  --session-duration <value>  Access session duration (default: 24h)
  --allow-email <email,csv>   Email address allowed by the app policy; repeatable
  --apply-config <path>       Apply returned Access values to a Worker wrangler.toml
  --team-domain <domain>      Access team domain; skips Access organization read
  --allow-platform-hostnames  Allow pages.dev/workers.dev hostnames in the self-hosted app payload
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
