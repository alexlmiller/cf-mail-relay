#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const defaults = {
  config: "worker/wrangler.toml",
  // Same-origin setups should pass --pages-url and --worker-url pointing at
  // the admin host (e.g. https://mail.example.com). The legacy defaults below
  // remain as a starting point for the existing test fixtures.
  pagesUrl: "https://cf-mail-relay-ui.pages.dev",
  workerUrl: "https://cf-mail-relay-worker.milfred.workers.dev",
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await run(process.argv.slice(2), process.env);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

export async function run(rawArgs = process.argv.slice(2), env = process.env, fetchImpl = fetch) {
  const options = parseArgs(rawArgs);
  if (options.help) {
    return { ok: true, usage: usage() };
  }

  const configText = await readFile(options.config, "utf8");
  const vars = parseWranglerVars(configText);
  const teamDomain = options.teamDomain || vars.ACCESS_TEAM_DOMAIN || "";
  const audience = options.audience || vars.ACCESS_AUDIENCE || "";
  const corsOrigin = vars.ADMIN_CORS_ORIGIN || "";
  const accessJwt = options.accessJwtEnv !== "" ? env[options.accessJwtEnv] : undefined;
  const checks = [];

  checks.push(checkConfiguredValue("access_team_domain", teamDomain, ["your-team.cloudflareaccess.com", "REPLACE_WITH_ACCESS_TEAM_DOMAIN"]));
  checks.push(checkConfiguredValue("access_audience", audience, ["REPLACE_WITH_ACCESS_APPLICATION_AUD", "REPLACE_WITH_ACCESS_APPLICATION_AUD"]));
  checks.push(checkCorsOrigin(corsOrigin, options.pagesUrl));

  if (checks.every((check) => check.status !== "fail")) {
    checks.push(await checkJwks(fetchImpl, teamDomain));
  } else {
    checks.push(skipCheck("access_jwks", "Access team domain or audience is not configured."));
  }

  checks.push(await checkWorkerHealth(fetchImpl, options.workerUrl));
  checks.push(await checkPagesArtifact(fetchImpl, options.pagesUrl, options.workerUrl, accessJwt));
  checks.push(await checkUnauthenticatedAdminGate(fetchImpl, options.workerUrl, options.pagesUrl));

  if (accessJwt !== undefined) {
    checks.push(await checkAuthenticatedSession(fetchImpl, options.workerUrl, options.pagesUrl, accessJwt));
  } else if (options.requireAuthenticatedSession) {
    checks.push(failCheck("authenticated_session", `Set --access-jwt-env to an environment variable containing a live Access JWT.`));
  } else {
    checks.push(warnCheck("authenticated_session", `Set --access-jwt-env to verify a live Access-authenticated /admin/api/session response.`));
  }

  return {
    ok: checks.every((check) => check.status !== "fail"),
    checked_at: new Date().toISOString(),
    worker_url: options.workerUrl,
    pages_url: options.pagesUrl,
    config: options.config,
    checks,
  };
}

export function parseArgs(args, fail = throwUsageError) {
  const parsed = {
    ...defaults,
    accessJwtEnv: "",
    audience: "",
    help: false,
    requireAuthenticatedSession: false,
    teamDomain: "",
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--access-jwt-env":
        parsed.accessJwtEnv = takeValue(args, ++index, arg, fail);
        break;
      case "--require-authenticated-session":
        parsed.requireAuthenticatedSession = true;
        break;
      case "--audience":
        parsed.audience = takeValue(args, ++index, arg, fail);
        break;
      case "--config":
        parsed.config = takeValue(args, ++index, arg, fail);
        break;
      case "--pages-url":
        parsed.pagesUrl = trimTrailingSlash(takeValue(args, ++index, arg, fail));
        break;
      case "--team-domain":
        parsed.teamDomain = stripScheme(trimTrailingSlash(takeValue(args, ++index, arg, fail)));
        break;
      case "--worker-url":
        parsed.workerUrl = trimTrailingSlash(takeValue(args, ++index, arg, fail));
        break;
      case "--help":
      case "-h":
        parsed.help = true;
        break;
      default:
        fail(`unknown argument: ${arg}`);
    }
  }

  return parsed;
}

export function parseWranglerVars(text) {
  const vars = {};
  let inVars = false;
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const section = line.match(/^\[([^\]]+)\]$/u);
    if (section !== null) {
      inVars = section[1] === "vars";
      continue;
    }
    if (!inVars) {
      continue;
    }
    const assignment = line.match(/^([A-Z0-9_]+)\s*=\s*"([^"]*)"$/u);
    if (assignment !== null) {
      vars[assignment[1]] = assignment[2];
    }
  }
  return vars;
}

function checkConfiguredValue(name, value, placeholders) {
  if (value.length === 0) {
    return failCheck(name, `${name} is empty.`);
  }
  if (placeholders.includes(value) || value.startsWith("REPLACE_WITH_")) {
    return failCheck(name, `${name} still contains a placeholder value.`, { value });
  }
  return passCheck(name, `${name} is configured.`, { value });
}

function checkCorsOrigin(corsOrigin, pagesUrl) {
  if (corsOrigin.length === 0) {
    return failCheck("admin_cors_origin", "ADMIN_CORS_ORIGIN is empty.");
  }
  if (trimTrailingSlash(corsOrigin) !== trimTrailingSlash(pagesUrl)) {
    return failCheck("admin_cors_origin", "ADMIN_CORS_ORIGIN does not match the Pages URL.", { configured: corsOrigin, expected: pagesUrl });
  }
  return passCheck("admin_cors_origin", "ADMIN_CORS_ORIGIN matches the Pages URL.", { origin: corsOrigin });
}

async function checkJwks(fetchImpl, teamDomain) {
  const response = await fetchText(fetchImpl, `https://${teamDomain}/cdn-cgi/access/certs`, { method: "GET", headers: { accept: "application/json" } });
  if (!response.ok) {
    return failCheck("access_jwks", `Access JWKS fetch failed with HTTP ${response.status}.`, response.body);
  }
  const keys = Array.isArray(response.body?.keys) ? response.body.keys : [];
  if (keys.length === 0) {
    return failCheck("access_jwks", "Access JWKS response did not include any keys.", response.body);
  }
  return passCheck("access_jwks", "Access JWKS is reachable and contains signing keys.", { key_count: keys.length });
}

async function checkWorkerHealth(fetchImpl, workerUrl) {
  const response = await fetchText(fetchImpl, `${workerUrl}/healthz`, { method: "GET", headers: { accept: "application/json" } });
  if (!response.ok || response.body?.ok !== true) {
    return failCheck("worker_healthz", `Worker /healthz failed with HTTP ${response.status}.`, response.body);
  }
  return passCheck("worker_healthz", "Worker /healthz is healthy.", { version: response.body.version, git_sha: response.body.git_sha });
}

async function checkPagesArtifact(fetchImpl, pagesUrl, workerUrl, accessJwt) {
  const headers = { accept: "text/html" };
  if (accessJwt !== undefined) {
    headers["cf-access-jwt-assertion"] = accessJwt;
    headers.cookie = `CF_Authorization=${accessJwt}`;
  }
  const response = await fetchText(fetchImpl, pagesUrl, { method: "GET", redirect: "manual", headers });
  const location = response.headers.get("location") ?? "";
  if (response.status >= 300 && response.status < 400 && location.length > 0) {
    if (accessJwt !== undefined) {
      return failCheck("pages_artifact", "Pages URL still redirected with the provided Access JWT.", { status: response.status, location });
    }
    return passCheck("pages_artifact", "Pages URL is protected by Cloudflare Access before serving the artifact.", { status: response.status, location });
  }
  if (!response.ok) {
    return failCheck("pages_artifact", `Pages fetch failed with HTTP ${response.status}.`, response.text);
  }
  if (!response.text.includes(workerUrl)) {
    return failCheck("pages_artifact", "Pages artifact does not contain the configured Worker URL.", { worker_url: workerUrl });
  }
  return passCheck("pages_artifact", "Pages artifact points at the configured Worker URL.", { worker_url: workerUrl });
}

async function checkUnauthenticatedAdminGate(fetchImpl, workerUrl, pagesUrl) {
  const response = await fetchText(fetchImpl, `${workerUrl}/admin/api/session`, {
    method: "GET",
    redirect: "manual",
    headers: {
      accept: "application/json,text/html",
      origin: pagesUrl,
    },
  });
  const location = response.headers.get("location") ?? "";
  if (response.status >= 300 && response.status < 400 && location.length > 0) {
    return passCheck("unauthenticated_admin_gate", "Unauthenticated admin request was redirected before reaching the Worker.", {
      status: response.status,
      location,
    });
  }
  if (response.body?.error === "missing_access_jwt") {
    return failCheck("unauthenticated_admin_gate", "Worker returned missing_access_jwt directly; Cloudflare Access is not enforcing the admin API yet.", {
      status: response.status,
    });
  }
  if (response.status === 401 || response.status === 403) {
    return passCheck("unauthenticated_admin_gate", "Unauthenticated admin request was blocked before a Worker JSON session response.", {
      status: response.status,
    });
  }
  return failCheck("unauthenticated_admin_gate", `Unexpected unauthenticated admin response HTTP ${response.status}.`, response.body ?? response.text);
}

async function checkAuthenticatedSession(fetchImpl, workerUrl, pagesUrl, jwt) {
  const response = await fetchText(fetchImpl, `${workerUrl}/admin/api/session`, {
    method: "GET",
    headers: {
      accept: "application/json",
      "cf-access-jwt-assertion": jwt,
      cookie: `CF_Authorization=${jwt}`,
      origin: pagesUrl,
    },
  });
  if (!response.ok || response.body?.ok !== true) {
    return failCheck("authenticated_session", `Authenticated /admin/api/session failed with HTTP ${response.status}.`, response.body ?? response.text);
  }
  return passCheck("authenticated_session", "Authenticated /admin/api/session returned an admin user.", {
    user_id: response.body.user?.id,
    email: response.body.user?.email,
  });
}

async function fetchText(fetchImpl, url, init) {
  const response = await fetchImpl(url, init);
  const text = await response.text();
  return {
    body: parseJsonOrNull(text),
    headers: response.headers,
    ok: response.ok,
    status: response.status,
    text,
  };
}

function parseJsonOrNull(text) {
  if (text.length === 0) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
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

function skipCheck(name, message, details = {}) {
  return { name, status: "skip", message, details };
}

function takeValue(args, index, flag, fail) {
  const value = args[index];
  if (value === undefined || value.startsWith("--")) {
    fail(`${flag} requires a value`);
  }
  return value;
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/u, "");
}

function stripScheme(value) {
  return value.replace(/^https?:\/\//u, "");
}

function usage() {
  return `Usage: node infra/wrangler/access-verify.mjs [options]

Verifies the Cloudflare Access gate from local config and live endpoints.

Options:
  --config <path>            wrangler.toml path (default: worker/wrangler.toml)
  --pages-url <url>          Pages UI URL (default: https://cf-mail-relay-ui.pages.dev)
  --worker-url <url>         Worker URL (default: https://cf-mail-relay-worker.milfred.workers.dev)
  --team-domain <domain>     Override ACCESS_TEAM_DOMAIN from wrangler.toml
  --audience <aud>           Override ACCESS_AUDIENCE from wrangler.toml
  --access-jwt-env <name>    Optional env var containing an Access JWT or CF_Authorization cookie value for /admin/api/session
  --require-authenticated-session
                             Fail unless --access-jwt-env is set and /admin/api/session passes
`;
}

function throwUsageError(message) {
  throw new Error(message);
}
