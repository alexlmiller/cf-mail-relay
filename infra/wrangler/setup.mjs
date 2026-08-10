#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const defaultApiBase = "https://api.cloudflare.com/client/v4";
const managedSecretNames = [
  "CREDENTIAL_PEPPER",
  "METADATA_PEPPER",
  "RELAY_HMAC_SECRET_CURRENT",
];
const requiredSecrets = [
  "CF_API_TOKEN",
  ...managedSecretNames,
];
const recoveryJournalVersion = 1;
// BOOTSTRAP_SETUP_TOKEN is intentionally not in `requiredSecrets`: the setup
// wizard bootstraps the first admin directly through D1 so it does not depend
// on reaching the freshly deployed admin URL from the installer machine. The
// /bootstrap/admin endpoint remains available for manual setup and recovery.

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
  if (!options.adminUrl) {
    throw new Error(`--admin-url is required (e.g. https://mail.example.com).\n\n${usage()}`);
  }
  if (!options.allowEmails.length) {
    throw new Error(`--allow-email is required (at least one); the Access policy is scoped to these addresses.\n\n${usage()}`);
  }

  const plan = buildPlan(options);
  const token = env[options.tokenEnv];

  // Plan-only fallback: with no token we can still print the plan + manual
  // commands. Useful for first-pass review before creating a token.
  if (!token) {
    if (options.apply) {
      throw new Error(`${options.tokenEnv} must contain a Cloudflare API token before running --apply.`);
    }
    return {
      ok: true,
      checked_at: new Date().toISOString(),
      plan_only: true,
      note: `${options.tokenEnv} is not set; live preflight skipped. Plan-only output.`,
      plan,
    };
  }

  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const execImpl = deps.execImpl ?? runCommand;
  const readFileImpl = deps.readFileImpl ?? ((path) => readFileSync(path, "utf8"));
  const writeFileImpl = deps.writeFileImpl ?? writeFileWithMode;
  const existsImpl = deps.existsImpl ?? existsSync;
  const writeRecoveryJournalImpl = deps.writeRecoveryJournalImpl ?? writeRecoveryJournalAtomic;
  const removeRecoveryJournalImpl = deps.removeRecoveryJournalImpl ?? ((path) => unlinkSync(path));
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
      writeRecoveryJournalImpl,
      removeRecoveryJournalImpl,
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
  const {
    options,
    env,
    client,
    execImpl,
    readFileImpl,
    writeFileImpl,
    existsImpl,
    writeRecoveryJournalImpl = writeRecoveryJournalAtomic,
    removeRecoveryJournalImpl = (path) => unlinkSync(path),
    accessAppImpl,
    fetchImpl,
  } = ctx;
  const progress = ctx.progressImpl ?? defaultProgress;
  const steps = [];

  // 1. Validate sending domains before mutating Cloudflare or deploying. The
  //    results are reused later for D1 registration so setup does not fail on a
  //    late provider lookup after the Worker is already deployed.
  const domainLookups = [];
  for (const domain of options.domains) {
    progress(`Validating Cloudflare Email Sending for ${domain}`);
    const lookup = await lookupCloudflareDomain(client, domain);
    domainLookups.push({ domain, zone_id: lookup.zoneId, status: lookup.status });
  }
  steps.push({ step: "domains_validated", domains: domainLookups });

  // Secret state is remote state. A gitignored local wrangler.toml says
  // nothing about whether this Worker is new, fully configured, or a live
  // deployment opened from a fresh clone. Inspect names only; secret values
  // remain unreadable by design.
  progress(`Inspecting remote Worker secret names for ${options.workerScriptName}`);
  const initialRemoteSecrets = await listWorkerSecretNames(client, options.accountId, options.workerScriptName);
  const existingJournal = loadRecoveryJournal(options, readFileImpl, existsImpl);
  const secretPlan = planManagedSecrets(options, initialRemoteSecrets, existingJournal);
  let recoveryJournal = secretPlan.journal;

  // Persist generated values before the first remote mutation. The journal is
  // deliberately a narrow crash-recovery aid: it is gitignored, mode 0600,
  // bound to one account/script/key id, and deleted after RUNBOOK.md is safely
  // written. It is never returned or logged.
  if (secretPlan.newJournal) {
    progress(`Writing setup recovery journal ${options.recoveryJournalPath}`);
    writeRecoveryJournalImpl(options.recoveryJournalPath, recoveryJournal);
    steps.push({
      step: "secret_recovery_journal",
      path: options.recoveryJournalPath,
      source: recoveryJournal.operation,
      resumed: false,
    });
  } else if (recoveryJournal !== null) {
    progress(`Resuming setup from ${options.recoveryJournalPath}`);
    steps.push({
      step: "secret_recovery_journal",
      path: options.recoveryJournalPath,
      source: recoveryJournal.operation,
      resumed: true,
    });
  } else {
    steps.push({ step: "managed_secrets", source: "remote", rotated: false });
  }

  // 2. Resource creation (skip-if-exists). Honors --d1-id / --kv-id flags from caller.
  progress(`Ensuring D1 database ${options.d1DatabaseName}`);
  const d1 = options.d1DatabaseId
    ? { id: options.d1DatabaseId, name: options.d1DatabaseName, source: "provided" }
    : await createOrFindD1(client, options.accountId, options.d1DatabaseName);
  steps.push({ step: "d1", source: d1.source, id: d1.id, name: d1.name });

  progress(`Ensuring KV namespace ${options.kvNamespaceTitle}`);
  const kv = options.kvNamespaceId
    ? { id: options.kvNamespaceId, title: options.kvNamespaceTitle, source: "provided" }
    : await createOrFindKv(client, options.accountId, options.kvNamespaceTitle);
  steps.push({ step: "kv", source: kv.source, id: kv.id, title: kv.title });

  // 3. Access app via access-app.mjs (programmatic call, so the destinations
  //    contract stays in one place).
  progress(`Ensuring Cloudflare Access app on ${options.adminUrl}`);
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

  // 4. Write worker/wrangler.toml from the example template. Its local
  //    existence controls only whether this file is overwritten, never secret
  //    generation or rotation.
  progress(`Writing ${options.wranglerPath}`);
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
    workerScriptName: options.workerScriptName,
  });
  if (!existsImpl(options.wranglerPath) || options.force) {
    writeFileImpl(options.wranglerPath, wranglerToml);
    steps.push({ step: "wrangler_toml", path: options.wranglerPath, written: true });
  } else {
    steps.push({ step: "wrangler_toml", path: options.wranglerPath, written: false, reason: "exists; pass --force to overwrite" });
  }

  // 5. Apply D1 migrations.
  if (!options.skipMigrations) {
    progress(`Applying D1 migrations to ${d1.name}`);
    await runWrangler(execImpl, options.workerDir, ["d1", "migrations", "apply", d1.name, "--remote"]);
    progress(`Setting smtp_host=${options.relayHost} in D1 settings`);
    await runWrangler(execImpl, options.workerDir, [
      "d1",
      "execute",
      d1.name,
      "--remote",
      "--command",
      `INSERT OR REPLACE INTO settings (key, value_json, updated_at) VALUES ('smtp_host', ${sqlStringLiteral(JSON.stringify(options.relayHost))}, unixepoch())`,
    ]);
    steps.push({ step: "migrations_applied" });
    steps.push({ step: "smtp_host_configured", smtp_host: options.relayHost });
  }

  // 6. Resume or perform the managed-secret write. Wrangler secret writes can
  //    create and deploy an intermediate Worker version, so submit all three
  //    managed values in one bulk request instead of exposing three successive
  //    partial versions. If completion is ambiguous, the unchanged journal is
  //    safe to retry because it supplies the exact same values.
  let managedSecretsPushed = 0;
  if (recoveryJournal !== null) {
    const remotelyPresent = initialRemoteSecrets.names;
    const bulkAlreadyComplete = managedSecretNames.every(
      (name) => recoveryJournal.pushed_secret_names.includes(name) && remotelyPresent.has(name),
    );
    if (!bulkAlreadyComplete) {
      progress(`Pushing ${managedSecretNames.length} managed Worker secrets in one bulk request`);
      await runWrangler(
        execImpl,
        options.workerDir,
        ["secret", "bulk", "--name", options.workerScriptName],
        `${JSON.stringify(recoveryJournal.secrets)}\n`,
      );
      managedSecretsPushed = managedSecretNames.length;
      recoveryJournal = {
        ...recoveryJournal,
        pushed_secret_names: [...managedSecretNames],
      };
      writeRecoveryJournalImpl(options.recoveryJournalPath, recoveryJournal);
    }
  }

  // CF_API_TOKEN is independent of generated secret state. By default the
  // broad setup token is not reused; operators set a least-privilege runtime
  // token between apply attempts. This explicit escape hatch works on first
  // runs and retries alike.
  let cfTokenPushed = false;
  if (options.pushCfApiToken && env[options.tokenEnv]) {
    process.stderr.write(
      "warning: --push-cf-api-token reuses your setup token as the worker's runtime CF_API_TOKEN.\n" +
      "         Create a least-privilege Email-Sending-Edit-only token and rotate this after first send.\n",
    );
    await runWrangler(
      execImpl,
      options.workerDir,
      ["secret", "put", "CF_API_TOKEN", "--name", options.workerScriptName],
      env[options.tokenEnv] ?? "",
    );
    cfTokenPushed = true;
  }
  if (managedSecretsPushed > 0 || cfTokenPushed) {
    steps.push({
      step: "secrets_pushed",
      count: managedSecretsPushed + (cfTokenPushed ? 1 : 0),
      managed_count: managedSecretsPushed,
      cf_api_token_pushed: cfTokenPushed,
    });
  }

  // Re-read remote names immediately before deploy. A first run normally stops
  // here until the operator sets a least-privilege CF_API_TOKEN, while
  // --push-cf-api-token can intentionally make setup one-shot.
  progress("Verifying required Worker secret names before deploy");
  const verifiedRemoteSecrets = await listWorkerSecretNames(client, options.accountId, options.workerScriptName);
  const missingRequiredSecrets = requiredSecrets.filter((name) => !verifiedRemoteSecrets.names.has(name));
  steps.push({
    step: "worker_secrets_verified",
    complete: missingRequiredSecrets.length === 0,
    missing: missingRequiredSecrets,
  });
  if (!options.skipBuildDeploy && missingRequiredSecrets.length > 0) {
    throw new Error(
      `Refusing to deploy ${options.workerScriptName}: required Worker secrets are missing: ${missingRequiredSecrets.join(", ")}. ` +
      `Set a least-privilege CF_API_TOKEN with \`pnpm --dir worker exec wrangler secret put CF_API_TOKEN\`, then rerun the same setup command. ` +
      `Recovery values remain in ${options.recoveryJournalPath}.`,
    );
  }

  // 7. Build UI (outputs into worker/public/) and deploy worker.
  if (!options.skipBuildDeploy) {
    progress("Building admin UI bundle");
    await execImpl("pnpm", ["--filter", "@cf-mail-relay/ui", "build"], { cwd: options.repoRoot });
    progress(`Deploying worker to ${options.adminUrl}`);
    await runWrangler(execImpl, options.workerDir, ["deploy"]);
    steps.push({ step: "deployed", admin_url: options.adminUrl });
  }

  // 8. Bootstrap the first admin if no admin row exists yet. This is gated
  //    on the actual D1 state, not on whether secrets were just regenerated.
  //    A retried --apply that previously failed at deploy must still bootstrap
  //    on the next attempt — earlier versions of this script keyed bootstrap
  //    off "secrets were just generated", which silently skipped bootstrap on
  //    every retry and left the relay deployed with no admin user.
  if (!options.skipBootstrap) {
    progress("Checking whether users table is empty");
    const usersEmpty = await isUsersTableEmpty(execImpl, options.workerDir, d1.name);
    if (!usersEmpty) {
      progress("Bootstrap skipped: users table is not empty");
      steps.push({ step: "bootstrap_admin", skipped: true, reason: "users_table_not_empty" });
    } else {
      const adminEmail = options.allowEmails[0];
      progress(`Bootstrapping admin ${adminEmail} directly in D1`);
      const userId = await bootstrapAdminInD1(execImpl, options.workerDir, d1.name, adminEmail);
      steps.push({ step: "bootstrap_admin", email: adminEmail, user_id: userId, method: "d1" });
    }
  }

  // 9. Register each --domain in D1 so the admin UI shows it on first login.
  //     `enabled` is left alone on conflict so admin-driven disables stick
  //     across reruns.
  const registeredDomains = [];
  for (const lookup of domainLookups) {
    progress(`Registering ${lookup.domain} in D1 (zone=${lookup.zone_id}, status=${lookup.status})`);
    const domainId = `dom_${randomBytes(16).toString("hex")}`;
    await runWrangler(execImpl, options.workerDir, [
      "d1",
      "execute",
      d1.name,
      "--remote",
      "--command",
      `INSERT INTO domains (id, domain, cloudflare_zone_id, status, enabled, created_at, updated_at) ` +
        `VALUES (${sqlStringLiteral(domainId)}, ${sqlStringLiteral(lookup.domain)}, ${sqlStringLiteral(lookup.zone_id)}, ${sqlStringLiteral(lookup.status)}, 1, unixepoch(), unixepoch()) ` +
        `ON CONFLICT(domain) DO UPDATE SET cloudflare_zone_id = excluded.cloudflare_zone_id, status = excluded.status, updated_at = unixepoch();`,
    ]);
    registeredDomains.push(lookup);
  }
  if (registeredDomains.length > 0) {
    // Atomically bump policy_version so any cached credentials miss on next
    // read. Setup can be rerun within the same second, so the next generation
    // must consider both wall time and the currently stored value.
    await runWrangler(execImpl, options.workerDir, [
      "d1",
      "execute",
      d1.name,
      "--remote",
      "--command",
      policyVersionBumpSql(),
    ]);
    steps.push({ step: "domains_registered", domains: registeredDomains });
  }

  // 10. Emit the adopter runbook only when an actual HMAC value is available:
  //     either from the active recovery journal or from a valid existing
  //     runbook. Remote secret values cannot be read back, so a fresh clone of
  //     an existing deployment preserves/skips instead of writing a dangerous
  //     placeholder over the operator's record.
  const existingRunbookSecret = readExistingRunbookSecret(options.runbookPath, readFileImpl, existsImpl);
  const relayHmacSecret = recoveryJournal?.secrets.RELAY_HMAC_SECRET_CURRENT ?? existingRunbookSecret;
  if (relayHmacSecret !== null) {
    progress(`${existingRunbookSecret !== null && recoveryJournal === null ? "Refreshing" : "Writing"} ${options.runbookPath}`);
    const runbook = renderRunbook({
      adminUrl: options.adminUrl,
      accountId: options.accountId,
      d1Id: d1.id,
      kvId: kv.id,
      domains: options.domains,
      relayHmacSecret,
      relayKeyId: options.relayKeyId,
      relayHost: options.relayHost,
    });
    writeFileImpl(options.runbookPath, runbook, { encoding: "utf8", mode: 0o600 });
    steps.push({
      step: "runbook_written",
      path: options.runbookPath,
      secret_source: recoveryJournal !== null ? "recovery_journal" : "existing_runbook",
    });
  } else {
    progress(`Skipping ${options.runbookPath}: remote secret values are unreadable and no valid local runbook exists`);
    steps.push({
      step: "runbook_preserved",
      path: options.runbookPath,
      written: false,
      reason: "remote_secret_value_unavailable",
    });
  }

  if (recoveryJournal !== null) {
    removeRecoveryJournalImpl(options.recoveryJournalPath);
    steps.push({ step: "secret_recovery_journal_removed", path: options.recoveryJournalPath });
  }

  return {
    ok: true,
    apply: true,
    admin_url: options.adminUrl,
    steps,
  };
}

function runWrangler(execImpl, cwd, args, stdin) {
  return execImpl("pnpm", ["exec", "wrangler", ...args], stdin === undefined ? { cwd } : { cwd, stdin });
}

/**
 * Builds the single-statement policy generation update used by setup. Historic
 * databases may store either a raw number (`7`) or a JSON string (`"7"`). The
 * UPSERT handles both and advances to max(previous + 1, wall-clock seconds),
 * matching the Worker mutation path without a read/write race.
 */
export function policyVersionBumpSql(now = Math.floor(Date.now() / 1000)) {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error("policy_version wall-clock value must be a non-negative safe integer");
  }
  return `INSERT INTO settings (key, value_json, updated_at)
VALUES ('policy_version', json_quote(CAST(${now} AS TEXT)), ${now})
ON CONFLICT(key) DO UPDATE SET
  value_json = json_quote(CAST(MAX(
    CAST(CASE
      WHEN json_valid(settings.value_json) THEN json_extract(settings.value_json, '$')
      ELSE settings.value_json
    END AS INTEGER) + 1,
    ${now}
  ) AS TEXT)),
  updated_at = excluded.updated_at`;
}

function defaultProgress(message) {
  process.stderr.write(`==> ${message}\n`);
}

async function isUsersTableEmpty(execImpl, cwd, databaseName) {
  const output = await execImpl(
    "pnpm",
    ["exec", "wrangler", "d1", "execute", databaseName, "--remote", "--json", "--command", "SELECT count(*) AS n FROM users"],
    { cwd, captureStdout: true },
  );
  return parseUsersCount(String(output ?? "")) === 0;
}

export function parseUsersCount(output) {
  const parsed = parseJsonOrText(output);
  if (!Array.isArray(parsed)) {
    throw new Error("Could not read users count from D1: `wrangler d1 execute --json` did not return a JSON array.");
  }
  for (const entry of parsed) {
    const rows = entry?.results;
    if (Array.isArray(rows)) {
      for (const row of rows) {
        const value = row?.n;
        if (typeof value === "number" && Number.isFinite(value)) {
          return value;
        }
      }
    }
  }
  throw new Error("Could not read users count from D1: no `n` column in any result row.");
}

async function bootstrapAdminInD1(execImpl, cwd, databaseName, email) {
  const now = Math.floor(Date.now() / 1000);
  const userId = `usr_${randomBytes(16).toString("hex")}`;
  await runWrangler(execImpl, cwd, [
    "d1",
    "execute",
    databaseName,
    "--remote",
    "--command",
    `INSERT INTO users (id, email, display_name, access_subject, role, disabled_at, created_at, updated_at) ` +
      `VALUES (${sqlStringLiteral(userId)}, ${sqlStringLiteral(email.toLowerCase())}, NULL, NULL, 'admin', NULL, ${now}, ${now})`,
  ]);
  await runWrangler(execImpl, cwd, [
    "d1",
    "execute",
    databaseName,
    "--remote",
    "--command",
    `INSERT OR REPLACE INTO settings (key, value_json, updated_at) ` +
      `VALUES ('bootstrap_completed_at', ${sqlStringLiteral(JSON.stringify(now))}, ${now})`,
  ]);
  return userId;
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

export async function lookupCloudflareDomain(client, domain) {
  const zone = await lookupCloudflareZone(client, domain);
  if (!zone) {
    throw new Error(`Cloudflare zone not found for ${domain}. Verify the domain is on Cloudflare DNS and the token has Zone:Read.`);
  }
  const sendingResponse = await client.get(`/zones/${encodeURIComponent(zone.id)}/email/sending/subdomains`);
  if (!sendingResponse.ok) {
    throw new Error(`Cloudflare Email Sending lookup failed for ${domain}: HTTP ${sendingResponse.status}. Onboard the domain and verify the runtime token has Email Sending access.`);
  }
  const subdomains = Array.isArray(sendingResponse.body?.result) ? sendingResponse.body.result : [];
  const match = subdomains.find((subdomain) => normalizeDomain(subdomain?.name ?? "") === domain);
  if (match?.enabled !== true) {
    throw new Error(`Cloudflare Email Sending is not enabled for ${domain}. Onboard the sending domain before running --apply.`);
  }
  return { zoneId: zone.id, status: "verified" };
}

async function lookupCloudflareZone(client, domain) {
  for (const candidate of zoneCandidates(domain)) {
    const zoneResponse = await client.get(`/zones?name=${encodeURIComponent(candidate)}&per_page=1`);
    if (!zoneResponse.ok) {
      throw new Error(`Cloudflare zone lookup failed for ${domain}: HTTP ${zoneResponse.status}. Verify the token has Zone:Read.`);
    }
    const zones = Array.isArray(zoneResponse.body?.result) ? zoneResponse.body.result : [];
    const zone = zones.find((entry) => typeof entry?.id === "string");
    if (zone !== undefined) {
      return zone;
    }
  }
  return null;
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
  };
}

export async function listWorkerSecretNames(client, accountId, scriptName) {
  const response = await client.get(`/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(scriptName)}/secrets`);
  if (response.status === 404) {
    return { script_exists: false, names: new Set() };
  }
  if (!response.ok) {
    throw new Error(
      `Could not inspect remote Worker secrets for ${scriptName}: HTTP ${response.status}. ` +
      `Refusing to guess from local files; verify the setup token can read Workers Scripts.`,
    );
  }
  const names = new Set(
    (Array.isArray(response.body?.result) ? response.body.result : [])
      .map((secret) => secret?.name)
      .filter((name) => typeof name === "string"),
  );
  return { script_exists: true, names };
}

function loadRecoveryJournal(options, readFileImpl, existsImpl) {
  if (!existsImpl(options.recoveryJournalPath)) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileImpl(options.recoveryJournalPath));
  } catch {
    throw new Error(
      `Setup recovery journal ${options.recoveryJournalPath} is unreadable or invalid JSON. ` +
      `Refusing to rotate or overwrite remote secrets.`,
    );
  }
  const bindingMatches = parsed?.version === recoveryJournalVersion
    && parsed?.account_id === options.accountId
    && parsed?.worker_script_name === options.workerScriptName
    && parsed?.relay_key_id === options.relayKeyId;
  const secretsValid = managedSecretNames.every((name) => isGeneratedSecret(parsed?.secrets?.[name]));
  const pushedNamesValid = Array.isArray(parsed?.pushed_secret_names)
    && parsed.pushed_secret_names.every((name) => managedSecretNames.includes(name));
  const operationValid = parsed?.operation === "initialize" || parsed?.operation === "replace_all";
  if (!bindingMatches || !secretsValid || !pushedNamesValid || !operationValid) {
    throw new Error(
      `Setup recovery journal ${options.recoveryJournalPath} does not match account ${options.accountId}, ` +
      `Worker ${options.workerScriptName}, and relay key ${options.relayKeyId}, or its contents are invalid. ` +
      `Refusing to use or overwrite it.`,
    );
  }
  return {
    version: recoveryJournalVersion,
    account_id: parsed.account_id,
    worker_script_name: parsed.worker_script_name,
    relay_key_id: parsed.relay_key_id,
    operation: parsed.operation,
    created_at: parsed.created_at,
    secrets: Object.fromEntries(managedSecretNames.map((name) => [name, parsed.secrets[name]])),
    pushed_secret_names: [...new Set(parsed.pushed_secret_names)],
  };
}

function planManagedSecrets(options, remoteState, existingJournal) {
  if (existingJournal !== null) {
    return { journal: existingJournal, newJournal: false };
  }

  const missingManaged = managedSecretNames.filter((name) => !remoteState.names.has(name));
  const shouldInitialize = !remoteState.script_exists;
  if (!options.rotateAllWorkerSecrets && !shouldInitialize && missingManaged.length === 0) {
    return { journal: null, newJournal: false };
  }
  if (!options.rotateAllWorkerSecrets && !shouldInitialize) {
    throw new Error(
      `Remote Worker ${options.workerScriptName} has incomplete managed secrets: missing ${missingManaged.join(", ")}. ` +
      `No matching recovery journal exists at ${options.recoveryJournalPath}, so setup will not guess or rotate live values. ` +
      `Restore the journal or, for deliberate disaster recovery only, rerun with --rotate-all-worker-secrets.`,
    );
  }

  const operation = options.rotateAllWorkerSecrets ? "replace_all" : "initialize";
  return {
    newJournal: true,
    journal: {
      version: recoveryJournalVersion,
      account_id: options.accountId,
      worker_script_name: options.workerScriptName,
      relay_key_id: options.relayKeyId,
      operation,
      created_at: new Date().toISOString(),
      secrets: generateSecrets(),
      pushed_secret_names: [],
    },
  };
}

export function writeRecoveryJournalAtomic(path, journal) {
  const temporaryPath = `${path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  let temporaryWritten = false;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(journal, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    temporaryWritten = true;
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, path);
    chmodSync(path, 0o600);
  } catch (error) {
    if (temporaryWritten && existsSync(temporaryPath)) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // Preserve the original persistence error; the temp path contains no
        // more information than the target journal would have contained.
      }
    }
    throw error;
  }
}

export function writeFileWithMode(path, body, options) {
  writeFileSync(path, body, options);
  if (typeof options === "object" && options !== null && options.mode !== undefined) {
    // Node only applies writeFile's mode when creating a file. RUNBOOK.md may
    // already exist from an older setup run, so enforce the requested mode
    // after every sensitive rewrite as well.
    chmodSync(path, options.mode);
  }
}

function readExistingRunbookSecret(path, readFileImpl, existsImpl) {
  if (!existsImpl(path)) {
    return null;
  }
  const match = /^RELAY_HMAC_SECRET=([^\r\n]+)$/mu.exec(readFileImpl(path));
  const value = match?.[1]?.trim() ?? "";
  return isGeneratedSecret(value) ? value : null;
}

function isGeneratedSecret(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/u.test(value);
}

export function renderWranglerToml(input) {
  let body = input.template;
  body = body.replace(/name = "cf-mail-relay-worker"/u, `name = "${input.workerScriptName ?? "cf-mail-relay-worker"}"`);
  body = body.replaceAll("REPLACE_WITH_CLOUDFLARE_ACCOUNT_ID", input.accountId);
  body = body.replaceAll("REPLACE_WITH_D1_DATABASE_ID", input.d1Id);
  body = body.replace(/database_name = "cf-mail-relay"/u, `database_name = "${input.d1Name ?? "cf-mail-relay"}"`);
  body = body.replaceAll("REPLACE_WITH_KV_NAMESPACE_ID", input.kvId);
  body = body.replaceAll("REPLACE_WITH_ACCESS_APPLICATION_AUD", input.accessAudience);
  body = body.replaceAll("your-team.cloudflareaccess.com", input.accessTeamDomain);
  body = body.replaceAll("rel_REPLACE_ME", input.relayKeyId);
  body = body.replace(/pattern = "mail\.example\.com"/g, `pattern = "${withoutScheme(input.adminUrl)}"`);
  return body;
}

export function renderRunbook(input) {
  const relayHost = input.relayHost ?? `smtp.${input.domains[0]}`;
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
    `RELAY_DOMAIN=${relayHost}`,
    `RELAY_TLS_CERT_FILE=/tls/relay.pem`,
    `RELAY_TLS_KEY_FILE=/tls/relay.pem`,
    `\`\`\``,
    ``,
    `## DNS records to publish per sending domain`,
    ``,
    ...input.domains.flatMap((domain) => [
      `### ${domain}`,
      ``,
      ...dnsRecordPlan(domain).map((record) => `- \`${record.type}  ${record.name}\` — ${record.value}`),
      ``,
      `Plus a DNS-only A record for the relay: \`${relayHost}\` -> your relay host IP.`,
      ``,
    ]),
    `## Verify the runtime CF_API_TOKEN`,
    ``,
    `Setup verifies that this Worker secret exists before deployment. Its value`,
    `should be a least-privilege Cloudflare API token with **Account · Email`,
    `Sending · Edit** plus **Zone · Zone · Read** for the sending zones. To`,
    `set or rotate it, keep an administrative setup token exported for Wrangler`,
    `authentication and paste the runtime token at the secret-value prompt:`,
    ``,
    `    pnpm --dir worker exec wrangler secret put CF_API_TOKEN`,
    ``,
    `If setup was run with \`--push-cf-api-token\`, the broad setup token was`,
    `reused and must be replaced with the least-privilege runtime token.`,
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
    force: false,
    help: false,
    kvNamespaceId: "",
    kvNamespaceTitle: "cf-mail-relay-hot",
    pushCfApiToken: false,
    recoveryJournalPath: join(repoRoot, ".cf-mail-relay-setup-recovery.json"),
    relayHost: "",
    relayKeyId: "rel_01",
    repoRoot,
    rotateAllWorkerSecrets: false,
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
      case "--force": options.force = true; break;
      case "--kv-namespace-id":
      case "--kv-id":
        options.kvNamespaceId = readValue(argv, index, arg); index += 1; break;
      case "--kv-namespace-title": options.kvNamespaceTitle = readValue(argv, index, arg); index += 1; break;
      case "--push-cf-api-token": options.pushCfApiToken = true; break;
      case "--rotate-all-worker-secrets": options.rotateAllWorkerSecrets = true; break;
      case "--regenerate-secrets":
        throw new Error(
          "--regenerate-secrets was removed because it understated a destructive operation. " +
          "Use --rotate-all-worker-secrets only for deliberate disaster recovery.",
        );
      case "--relay-host":
      case "--smtp-host":
        options.relayHost = normalizeHostname(readValue(argv, index, arg)); index += 1; break;
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
  if (!options.relayHost && options.domains.length > 0) {
    options.relayHost = `smtp.${options.domains[0]}`;
  }
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

function buildPlan(options) {
  return {
    admin_url: options.adminUrl,
    domains: options.domains.map((domain) => ({
      domain,
      relay_hostname: options.relayHost,
      dns_records: dnsRecordPlan(domain),
      verification: `pnpm doctor:delivery -- --domain ${domain}`,
    })),
    // High-level steps performed by --apply.
    apply_steps: [
      `Validate Cloudflare Email Sending for each domain`,
      `Inspect remote Worker secret names and refuse ambiguous partial state`,
      `Persist newly generated values in a mode-0600 recovery journal before mutation`,
      `Create or reuse D1 database (${options.d1DatabaseName})`,
      `Create or reuse KV namespace (${options.kvNamespaceTitle})`,
      `Create or reuse Cloudflare Access app on ${options.adminUrl}`,
      `Write worker/wrangler.toml`,
      `Apply D1 migrations`,
      `Resume or push managed secrets via one Wrangler bulk write (may create an intermediate Worker version)`,
      `Verify every required Worker secret before deploy`,
      `Build UI into worker/public/`,
      `Deploy worker`,
      `Create first admin directly in D1 when users table is empty`,
      `Register sending domains in D1`,
      `Write RUNBOOK.md`,
    ],
    // Representative commands for a manual setup. Most users should run
    // `pnpm run setup --apply` instead; the wizard fills config, pushes
    // generated secrets, bootstraps D1, and writes RUNBOOK.md.
    commands: [
      `pnpm --dir worker exec wrangler d1 create ${options.d1DatabaseName}`,
      `pnpm --dir worker exec wrangler kv namespace create ${options.kvNamespaceTitle}`,
      `pnpm --dir worker exec wrangler d1 migrations apply ${options.d1DatabaseName} --remote`,
      ...requiredSecrets.map((secret) => `pnpm --dir worker exec wrangler secret put ${secret}`),
      `pnpm access:setup --account-id ${options.accountId} --pages-url ${options.adminUrl} --allow-email ${options.allowEmails[0]} --apply-config worker/wrangler.toml`,
      "pnpm --filter @cf-mail-relay/ui build",
      "pnpm --dir worker exec wrangler deploy",
      `pnpm doctor:local -- --domain ${options.domains[0]} --worker-url ${options.adminUrl}`,
    ],
  };
}

async function checkToken(client) {
  const response = await client.get("/user/tokens/verify");
  return response.ok ? passCheck("api_token", "Cloudflare API token verified.") : warnCheck("api_token", `Token self-verification failed with HTTP ${response.status}; continuing because scoped account endpoints may still accept this token type.`, response.body);
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
  const checks = [];
  let zone;
  try {
    zone = await lookupCloudflareZone(client, domain);
  } catch (error) {
    checks.push(failCheck(`domain:${domain}:zone`, error instanceof Error ? error.message : "Cloudflare zone lookup failed."));
    return checks;
  }
  if (zone === null) {
    checks.push(failCheck(`domain:${domain}:zone`, "Cloudflare zone was not found or is inaccessible."));
    return checks;
  }
  const zoneId = zone.id;
  checks.push(passCheck(`domain:${domain}:zone`, "Cloudflare zone is accessible.", { zone_id: zoneId, zone_name: zone.name }));
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

function zoneCandidates(domain) {
  const labels = domain.split(".");
  const candidates = [];
  for (let index = 0; index <= labels.length - 2; index += 1) {
    candidates.push(labels.slice(index).join("."));
  }
  return candidates;
}

function normalizeHostname(raw) {
  const host = String(raw)
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//iu, "")
    .replace(/\/.*$/u, "")
    .replace(/\.$/u, "")
    .toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u.test(host)) {
    throw new Error(`Invalid SMTP host: ${raw}`);
  }
  return host;
}

function sqlStringLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
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
    const captureStdout = options.captureStdout === true;
    const stdout = [];
    const child = spawn(command, args, {
      cwd: options.cwd ?? process.cwd(),
      env: process.env,
      stdio: [
        options.stdin === undefined ? "ignore" : "pipe",
        captureStdout ? "pipe" : "inherit",
        "inherit",
      ],
    });
    if (options.stdin !== undefined && child.stdin !== null) {
      child.stdin.write(options.stdin);
      child.stdin.end();
    }
    if (captureStdout && child.stdout !== null) {
      child.stdout.on("data", (chunk) => stdout.push(chunk));
    }
    child.on("close", (code) => {
      if (code === 0) resolvePromise(captureStdout ? Buffer.concat(stdout).toString("utf8") : undefined);
      else rejectPromise(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
    child.on("error", rejectPromise);
  });
}

function usage() {
  return `Usage:
  pnpm run setup --account-id <id> --admin-url https://mail.example.com \\
                 --allow-email you@example.com --domain example.com
  pnpm run setup --apply --account-id <id> --admin-url ... --allow-email ... --domain ...

Modes:
  (no flag)                 Live preflight: validates the token, account, zone,
                            and resources; prints the plan and check results.
                            If no token is set (CLOUDFLARE_API_TOKEN unset),
                            falls back to a plan-only output.
  --apply                   Create resources, deploy the worker, bootstrap
                            the admin, write RUNBOOK.md. Requires a token.
                            Managed secrets use one bulk write, which may create
                            an intermediate Worker version; final deployment is
                            blocked until every required secret name is present.
Required (both modes):
  --account-id              Cloudflare account ID (or CLOUDFLARE_ACCOUNT_ID).
  --admin-url               URL where the admin UI + API will live
                            (e.g. https://mail.example.com).
  --allow-email <email>     Email(s) allowed by the Access policy. Repeat for
                            more than one. The first becomes the bootstrapped
                            admin during --apply.
  --domain                  Sending domain (repeat for multiple).

Apply flags:
  --allow-platform-hostnames
                             Allow pages.dev/workers.dev admin URLs. Custom
                             domains are strongly preferred.
  --d1-id <id>              Use existing D1 instead of creating.
  --kv-id <id>              Use existing KV namespace instead of creating.
  --smtp-host <host>        SMTP relay hostname shown in client setup details
                             and RUNBOOK.md (default smtp.<first-domain>).
  --relay-key-id <id>       RELAY_HMAC_KEY_ID (default rel_01).
  --rotate-all-worker-secrets
                             Destructive disaster recovery: replace the
                             credential pepper, metadata pepper, and relay HMAC
                             secret. This invalidates existing credentials/API
                             keys and requires relay reconfiguration. Normal
                             retries automatically resume the mode-0600 recovery
                             journal and do not need this flag.
  --push-cf-api-token       Push your setup CLOUDFLARE_API_TOKEN as the worker's
                             runtime CF_API_TOKEN secret. NOT recommended — your
                             setup token has broad scopes; the runtime token
                             should only have Email Sending Edit plus Zone Read.
                             Default off.
  --force                   Overwrite existing worker/wrangler.toml.
  --skip-migrations         Skip 'wrangler d1 migrations apply'. Advanced:
                             D1 bootstrap/domain registration still expect the
                             current schema to already exist.
  --skip-build-deploy       Skip UI build + worker deploy.
  --skip-bootstrap          Skip first-admin D1 bootstrap.

Common:
  --token-env <name>        Env var holding the CF API token (default CLOUDFLARE_API_TOKEN).
`;
}
