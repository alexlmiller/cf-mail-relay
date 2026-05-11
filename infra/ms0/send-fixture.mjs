#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const defaultOutDir = ".ai-runs/ms0-evidence";

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main(process.argv.slice(2), process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

export async function main(argv, env, fetchImpl = fetch, writeOutput = console.log) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return;
  }

  const missing = requiredFields(options);
  if (missing.length > 0) {
    throw new Error(`Missing required option(s): ${missing.join(", ")}\n\n${usage()}`);
  }

  const token = env[options.tokenEnv];
  if (token === undefined || token.length === 0) {
    throw new Error(`Environment variable ${options.tokenEnv} must contain the MS0 spike token.`);
  }

  const fixtureBytes = await readFile(options.fixture);
  const localMimeSha256 = sha256Hex(fixtureBytes);
  const startedAt = new Date();
  const url = spikeUrl(options);
  const response = await fetchWithRetry(
    fetchImpl,
    url,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "message/rfc822",
      },
      body: fixtureBytes,
    },
    options.retries,
  );
  const responseText = await response.text();
  const parsedResponse = parseJsonOrText(responseText);
  const finishedAt = new Date();

  const evidence = {
    kind: "cf-mail-relay.ms0.spike-evidence",
    version: 1,
    label: options.label,
    dry_run: !options.live,
    requested_at: startedAt.toISOString(),
    completed_at: finishedAt.toISOString(),
    request: {
      worker_url: options.workerUrl,
      endpoint: url.toString(),
      from: options.from,
      recipients: parseRecipients(options.recipients),
      fixture: path.resolve(options.fixture),
      fixture_size_bytes: fixtureBytes.byteLength,
      local_mime_sha256: localMimeSha256,
    },
    response: {
      http_status: response.status,
      ok: response.ok,
      body: parsedResponse,
    },
    checks: evaluateChecks(parsedResponse, localMimeSha256, !options.live),
  };

  await mkdir(options.outDir, { recursive: true });
  const evidencePath = path.join(options.outDir, evidenceFilename(startedAt, options.label));
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  writeOutput(evidencePath);

  if (!response.ok) {
    throw new Error(`Spike request failed with HTTP ${response.status}; evidence written to ${evidencePath}`);
  }
}

export function parseArgs(argv) {
  const options = {
    fixture: "",
    from: "",
    help: false,
    label: "fixture",
    live: false,
    outDir: defaultOutDir,
    recipients: "",
    retries: 3,
    tokenEnv: "MS0_SPIKE_TOKEN",
    workerUrl: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--dry-run":
        options.live = false;
        break;
      case "--fixture":
        options.fixture = readValue(argv, index, arg);
        index += 1;
        break;
      case "--from":
        options.from = readValue(argv, index, arg);
        index += 1;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--label":
        options.label = sanitizeLabel(readValue(argv, index, arg));
        index += 1;
        break;
      case "--live":
        options.live = true;
        break;
      case "--out-dir":
        options.outDir = readValue(argv, index, arg);
        index += 1;
        break;
      case "--retries":
        options.retries = parseNonNegativeInteger(readValue(argv, index, arg), arg);
        index += 1;
        break;
      case "--recipients":
        options.recipients = readValue(argv, index, arg);
        index += 1;
        break;
      case "--token-env":
        options.tokenEnv = readValue(argv, index, arg);
        index += 1;
        break;
      case "--worker-url":
        options.workerUrl = readValue(argv, index, arg);
        index += 1;
        break;
      default:
        throw new Error(`Unknown option: ${arg}\n\n${usage()}`);
    }
  }

  return options;
}

export function spikeUrl(options) {
  const url = new URL("/spike", ensureTrailingSlash(options.workerUrl));
  url.searchParams.set("from", options.from);
  url.searchParams.set("recipients", parseRecipients(options.recipients).join(","));
  if (!options.live) {
    url.searchParams.set("dry_run", "1");
  }
  return url;
}

export function evaluateChecks(body, localMimeSha256, dryRun) {
  const bodyObject = typeof body === "object" && body !== null ? body : {};
  return {
    worker_ok: bodyObject.ok === true,
    mime_sha256_matches_local: bodyObject.mime_sha256 === localMimeSha256,
    mime_round_trip_verified: bodyObject.mime_round_trip_verified === true,
    dry_run_matches_request: bodyObject.dry_run === dryRun,
  };
}

export function parseRecipients(raw) {
  return raw
    .split(",")
    .map((recipient) => recipient.trim())
    .filter((recipient) => recipient.length > 0);
}

async function fetchWithRetry(fetchImpl, url, init, retries) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fetchImpl(url, init);
    } catch (error) {
      lastError = error;
      if (attempt === retries) {
        break;
      }
      await sleep(250 * 2 ** attempt);
    }
  }

  throw lastError;
}

function requiredFields(options) {
  return [
    ["--fixture", options.fixture],
    ["--from", options.from],
    ["--recipients", options.recipients],
    ["--worker-url", options.workerUrl],
  ]
    .filter(([, value]) => value.length === 0)
    .map(([name]) => name);
}

function readValue(argv, index, optionName) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${optionName} requires a value.`);
  }
  return value;
}

function parseNonNegativeInteger(raw, optionName) {
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 0 || String(value) !== raw) {
    throw new Error(`${optionName} must be a non-negative integer.`);
  }
  return value;
}

function sleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function ensureTrailingSlash(rawUrl) {
  return rawUrl.endsWith("/") ? rawUrl : `${rawUrl}/`;
}

function sanitizeLabel(raw) {
  const sanitized = raw.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized.length === 0 ? "fixture" : sanitized;
}

function evidenceFilename(date, label) {
  return `${date.toISOString().replace(/[:.]/g, "-")}-${sanitizeLabel(label)}.json`;
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

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function usage() {
  return `Usage:
  pnpm ms0:spike:send --fixture <path.eml> --from <sender> --recipients <a,b,c> --worker-url <url> [--dry-run|--live]

Options:
  --fixture      Raw RFC 5322 MIME fixture to POST.
  --from         Verified Cloudflare Email Sending sender address.
  --recipients   Comma-separated recipient list.
  --worker-url   Base URL for the deployed or local MS0 spike Worker.
  --dry-run      Call /spike with dry_run=1. Default.
  --live         Call Cloudflare Email Sending through /spike.
  --label        Label used in the evidence filename. Default: fixture.
  --out-dir      Evidence directory. Default: ${defaultOutDir}.
  --retries      Retry transient fetch failures. Default: 3.
  --token-env    Environment variable containing the spike token. Default: MS0_SPIKE_TOKEN.`;
}
