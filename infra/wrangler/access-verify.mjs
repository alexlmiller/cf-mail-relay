#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const defaults = {
  adminUrl: "",
  config: "worker/wrangler.toml",
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
  if (options.adminUrl.length === 0) {
    throw new Error("--admin-url is required, for example https://mail.example.com");
  }

  const configText = await readFile(options.config, "utf8");
  const vars = parseWranglerVars(configText);
  const teamDomain = options.teamDomain || vars.ACCESS_TEAM_DOMAIN || "";
  const audience = options.audience || vars.ACCESS_AUDIENCE || "";
  const corsOrigin = vars.ADMIN_CORS_ORIGIN || "";
  const accessJwt = options.accessJwtEnv !== "" ? env[options.accessJwtEnv] : undefined;
  const checks = [];

  checks.push(checkConfiguredValue("access_team_domain", teamDomain, ["your-team.cloudflareaccess.com", "REPLACE_WITH_ACCESS_TEAM_DOMAIN"]));
  checks.push(checkConfiguredValue("access_audience", audience, ["REPLACE_WITH_ACCESS_APPLICATION_AUD"]));
  checks.push(checkAdminCorsOrigin(corsOrigin, options.adminUrl));

  if (checks.every((check) => check.status !== "fail")) {
    checks.push(await checkJwks(fetchImpl, teamDomain));
  } else {
    checks.push(skipCheck("access_jwks", "Access team domain or audience is not configured."));
  }

  checks.push(await checkWorkerHealth(fetchImpl, options.adminUrl));
  checks.push(await checkUnauthenticatedAccessGate(fetchImpl, options.adminUrl, "/", "ui_gate"));
  checks.push(await checkUnauthenticatedAccessGate(fetchImpl, options.adminUrl, "/admin/api/session", "admin_api_gate"));
  checks.push(await checkUnauthenticatedAccessGate(fetchImpl, options.adminUrl, "/self/api/session", "self_api_gate"));
  checks.push(await checkUnauthenticatedWorkerRoute(fetchImpl, options.adminUrl, "/send", "send_public_path", { method: "POST", expectedError: "missing_api_key" }));
  checks.push(await checkUnauthenticatedWorkerRoute(fetchImpl, options.adminUrl, "/relay/auth", "relay_auth_public_path", { method: "POST" }));
  checks.push(await checkUnauthenticatedWorkerRoute(fetchImpl, options.adminUrl, "/bootstrap/admin", "bootstrap_public_path", { method: "POST", expectedError: "invalid_json" }));

  if (accessJwt !== undefined) {
    checks.push(await checkAuthenticatedUi(fetchImpl, options.adminUrl, accessJwt));
    checks.push(await checkAuthenticatedSession(fetchImpl, options.adminUrl, accessJwt));
  } else if (options.requireAuthenticatedSession) {
    checks.push(failCheck("authenticated_session", "Set --access-jwt-env to an environment variable containing a live Access JWT."));
  } else {
    checks.push(warnCheck("authenticated_session", "Set --access-jwt-env to verify the protected UI and /admin/api/session."));
  }

  return {
    ok: checks.every((check) => check.status !== "fail"),
    checked_at: new Date().toISOString(),
    admin_url: options.adminUrl,
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
      case "--admin-url":
      case "--pages-url":
      case "--worker-url":
        parsed.adminUrl = trimTrailingSlash(takeValue(args, ++index, arg, fail));
        break;
      case "--audience":
        parsed.audience = takeValue(args, ++index, arg, fail);
        break;
      case "--config":
        parsed.config = takeValue(args, ++index, arg, fail);
        break;
      case "--team-domain":
        parsed.teamDomain = stripScheme(trimTrailingSlash(takeValue(args, ++index, arg, fail)));
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

function checkAdminCorsOrigin(corsOrigin, adminUrl) {
  if (corsOrigin.length === 0) {
    return passCheck("admin_cors_origin", "ADMIN_CORS_ORIGIN is unset; Worker will trust its own same-origin URL.");
  }
  if (corsOrigin === "*") {
    return failCheck("admin_cors_origin", "ADMIN_CORS_ORIGIN must not be '*'.");
  }
  if (trimTrailingSlash(corsOrigin) !== trimTrailingSlash(adminUrl)) {
    return failCheck("admin_cors_origin", "ADMIN_CORS_ORIGIN does not match the admin URL.", { configured: corsOrigin, expected: adminUrl });
  }
  return passCheck("admin_cors_origin", "ADMIN_CORS_ORIGIN matches the admin URL.", { origin: corsOrigin });
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

async function checkWorkerHealth(fetchImpl, adminUrl) {
  const response = await fetchText(fetchImpl, `${adminUrl}/healthz`, { method: "GET", redirect: "manual", headers: { accept: "application/json" } });
  if (isRedirect(response)) {
    return failCheck("worker_healthz", "Worker /healthz was intercepted by Access; /healthz must remain outside the Access app.", redirectDetails(response));
  }
  if (!response.ok || response.body?.ok !== true) {
    return failCheck("worker_healthz", `Worker /healthz failed with HTTP ${response.status}.`, response.body ?? response.text);
  }
  return passCheck("worker_healthz", "Worker /healthz is healthy and not Access-gated.", { version: response.body.version, git_sha: response.body.git_sha });
}

async function checkUnauthenticatedAccessGate(fetchImpl, adminUrl, path, name) {
  const response = await fetchText(fetchImpl, `${adminUrl}${path}`, {
    method: "GET",
    redirect: "manual",
    headers: { accept: "application/json,text/html", origin: adminUrl },
  });
  if (isRedirect(response)) {
    return passCheck(name, `${path} is protected by Cloudflare Access.`, redirectDetails(response));
  }
  if (response.body?.error === "missing_access_jwt") {
    return failCheck(name, `${path} reached the Worker without an Access JWT; Cloudflare Access is not enforcing this path.`, { status: response.status });
  }
  if (response.status === 401 || response.status === 403) {
    return passCheck(name, `${path} was blocked before a Worker session response.`, { status: response.status });
  }
  return failCheck(name, `${path} was reachable without Cloudflare Access.`, { status: response.status, body: response.body ?? response.text.slice(0, 200) });
}

async function checkUnauthenticatedWorkerRoute(fetchImpl, adminUrl, path, name, options) {
  const response = await fetchText(fetchImpl, `${adminUrl}${path}`, {
    method: options.method,
    redirect: "manual",
    headers: { accept: "application/json" },
  });
  if (isRedirect(response)) {
    return failCheck(name, `${path} was intercepted by Access; this route must remain outside the Access app.`, redirectDetails(response));
  }
  if (options.expectedError !== undefined && response.body?.error !== options.expectedError) {
    return failCheck(name, `${path} did not return the expected Worker auth error.`, { expected_error: options.expectedError, status: response.status, body: response.body ?? response.text });
  }
  if (response.status >= 400 && response.status < 500) {
    return passCheck(name, `${path} reached the Worker and returned its own auth/validation response.`, { status: response.status, error: response.body?.error ?? null });
  }
  return failCheck(name, `${path} returned unexpected HTTP ${response.status}.`, response.body ?? response.text);
}

async function checkAuthenticatedUi(fetchImpl, adminUrl, jwt) {
  const response = await fetchText(fetchImpl, adminUrl, {
    method: "GET",
    redirect: "manual",
    headers: accessHeaders(jwt, "text/html", adminUrl),
  });
  if (isRedirect(response)) {
    return failCheck("authenticated_ui", "Admin UI still redirected with the provided Access JWT.", redirectDetails(response));
  }
  if (!response.ok) {
    return failCheck("authenticated_ui", `Admin UI fetch failed with HTTP ${response.status}.`, response.text);
  }
  if (!response.text.includes('id="app"')) {
    return failCheck("authenticated_ui", "Admin UI response did not look like the built app shell.", response.text.slice(0, 200));
  }
  return passCheck("authenticated_ui", "Admin UI served the app shell with the provided Access JWT.");
}

async function checkAuthenticatedSession(fetchImpl, adminUrl, jwt) {
  const response = await fetchText(fetchImpl, `${adminUrl}/admin/api/session`, {
    method: "GET",
    redirect: "manual",
    headers: accessHeaders(jwt, "application/json", adminUrl),
  });
  if (!response.ok || response.body?.ok !== true) {
    return failCheck("authenticated_session", `Authenticated /admin/api/session failed with HTTP ${response.status}.`, response.body ?? response.text);
  }
  return passCheck("authenticated_session", "Authenticated /admin/api/session returned an admin user.", {
    user_id: response.body.user?.id,
    email: response.body.user?.email,
  });
}

function accessHeaders(jwt, accept, origin) {
  return {
    accept,
    "cf-access-jwt-assertion": jwt,
    cookie: `CF_Authorization=${jwt}`,
    origin,
  };
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

function isRedirect(response) {
  return response.status >= 300 && response.status < 400 && (response.headers.get("location") ?? "").length > 0;
}

function redirectDetails(response) {
  return { status: response.status, location: response.headers.get("location") ?? "" };
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
  return `Usage: node infra/wrangler/access-verify.mjs --admin-url https://mail.example.com [options]

Verifies the same-origin Cloudflare Access gate from local config and live endpoints.

Options:
  --config <path>            wrangler.toml path (default: worker/wrangler.toml)
  --admin-url <url>          Admin UI + API origin, e.g. https://mail.example.com
  --pages-url <url>          Legacy alias for --admin-url
  --worker-url <url>         Legacy alias for --admin-url
  --team-domain <domain>     Override ACCESS_TEAM_DOMAIN from wrangler.toml
  --audience <aud>           Override ACCESS_AUDIENCE from wrangler.toml
  --access-jwt-env <name>    Optional env var containing an Access JWT or CF_Authorization cookie value
  --require-authenticated-session
                             Fail unless --access-jwt-env is set and /admin/api/session passes
`;
}

function throwUsageError(message) {
  throw new Error(message);
}
