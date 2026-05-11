#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const defaults = {
  config: "worker/wrangler.toml",
  json: "",
  pagesUrl: "https://cf-mail-relay-ui.pages.dev",
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await run(process.argv.slice(2));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

export async function run(rawArgs = process.argv.slice(2)) {
  const options = parseArgs(rawArgs);
  if (options.help) {
    return { ok: true, usage: usage() };
  }

  const values = options.json.length > 0 ? await valuesFromJson(options.json) : {};
  const teamDomain = stripScheme(trimTrailingSlash(options.teamDomain || values.access_team_domain || ""));
  const audience = options.audience || values.access_audience || "";
  const corsOrigin = trimTrailingSlash(options.adminCorsOrigin || options.pagesUrl);
  if (teamDomain.length === 0) {
    throw new Error("--team-domain or --json with access_team_domain is required");
  }
  if (audience.length === 0) {
    throw new Error("--audience or --json with access_audience is required");
  }

  const before = await readFile(options.config, "utf8");
  const after = updateWranglerVars(before, {
    ACCESS_TEAM_DOMAIN: teamDomain,
    ACCESS_AUDIENCE: audience,
    ADMIN_CORS_ORIGIN: corsOrigin,
  });

  if (!options.dryRun && after !== before) {
    await writeFile(options.config, after);
  }

  return {
    ok: true,
    dry_run: options.dryRun,
    changed: after !== before,
    config: options.config,
    vars: {
      ACCESS_TEAM_DOMAIN: teamDomain,
      ACCESS_AUDIENCE: audience,
      ADMIN_CORS_ORIGIN: corsOrigin,
    },
  };
}

export function parseArgs(args, fail = throwUsageError) {
  const parsed = {
    ...defaults,
    adminCorsOrigin: "",
    audience: "",
    dryRun: false,
    help: false,
    teamDomain: "",
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--admin-cors-origin":
        parsed.adminCorsOrigin = trimTrailingSlash(takeValue(args, ++index, arg, fail));
        break;
      case "--audience":
        parsed.audience = takeValue(args, ++index, arg, fail);
        break;
      case "--config":
        parsed.config = takeValue(args, ++index, arg, fail);
        break;
      case "--dry-run":
        parsed.dryRun = true;
        break;
      case "--json":
        parsed.json = takeValue(args, ++index, arg, fail);
        break;
      case "--pages-url":
        parsed.pagesUrl = trimTrailingSlash(takeValue(args, ++index, arg, fail));
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

export function updateWranglerVars(text, replacements) {
  const lines = text.split(/\r?\n/u);
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  let inVars = false;
  let varsStart = -1;
  let varsEnd = lines.length;
  const seen = new Set();
  const updated = lines.map((line, index) => {
    const trimmed = line.trim();
    const section = tomlSectionName(trimmed);
    if (section !== null) {
      if (inVars && varsEnd === lines.length) {
        varsEnd = index;
      }
      inVars = section === "vars";
      if (inVars) {
        varsStart = index;
      }
      return line;
    }

    if (!inVars) {
      return line;
    }

    const assignment = line.match(/^(\s*)([A-Z0-9_]+)(\s*=\s*)"([^"]*)"(\s*(?:#.*)?)$/u);
    if (assignment === null || replacements[assignment[2]] === undefined) {
      return line;
    }
    seen.add(assignment[2]);
    return `${assignment[1]}${assignment[2]}${assignment[3]}"${escapeTomlString(replacements[assignment[2]])}"${assignment[5]}`;
  });

  if (varsStart === -1) {
    throw new Error("worker wrangler config does not contain a [vars] section");
  }

  const missing = Object.keys(replacements).filter((name) => !seen.has(name));
  if (missing.length > 0) {
    const insertAt = varsEnd > varsStart + 1 && updated[varsEnd - 1]?.trim() === "" ? varsEnd - 1 : varsEnd;
    updated.splice(insertAt, 0, ...missing.map((name) => `${name} = "${escapeTomlString(replacements[name])}"`));
  }

  const suffix = text.endsWith("\n") ? newline : "";
  return `${updated.join(newline)}${suffix}`;
}

function tomlSectionName(line) {
  const table = line.match(/^\[([^\]]+)\]$/u);
  if (table !== null) {
    return table[1];
  }
  const tableArray = line.match(/^\[\[([^\]]+)\]\]$/u);
  return tableArray?.[1] ?? null;
}

async function valuesFromJson(path) {
  const parsed = JSON.parse(await readFile(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("--json must point to an object output from access:setup");
  }
  return parsed;
}

function escapeTomlString(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
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
  return `Usage: node infra/wrangler/access-apply.mjs [options]

Applies Cloudflare Access setup output to the local Worker wrangler.toml.

Options:
  --config <path>             wrangler.toml path (default: worker/wrangler.toml)
  --json <path>               JSON output file from pnpm access:setup
  --team-domain <domain>      Access team domain, overrides --json
  --audience <aud>            Access application audience, overrides --json
  --pages-url <url>           Pages UI URL used as ADMIN_CORS_ORIGIN
  --admin-cors-origin <url>   Explicit ADMIN_CORS_ORIGIN, overrides --pages-url
  --dry-run                   Report intended values without writing
`;
}

function throwUsageError(message) {
  throw new Error(message);
}
