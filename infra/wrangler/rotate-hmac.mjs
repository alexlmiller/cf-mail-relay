#!/usr/bin/env node

// Generate a fresh RELAY_HMAC_SECRET and print the rotation runbook.
//
// Cloudflare Worker secrets are write-only via the API, so this script can't
// read the existing CURRENT value. The operator preserves it manually by
// copying it into RELAY_HMAC_SECRET_PREVIOUS during the rotation window.
//
// Usage:
//   pnpm rotate:hmac                   # print the new secret + runbook
//   pnpm rotate:hmac --json            # machine-readable output
//
// The worker accepts RELAY_HMAC_SECRET_CURRENT and RELAY_HMAC_SECRET_PREVIOUS
// for as long as both secrets are set — there's no time-based expiry. Delete
// PREVIOUS once the relay is on the new value to remove the dual-acceptance
// window. The runbook recommends ~1 hour as a sensible operator-side ceiling.

import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

const overlapWindowSeconds = 60 * 60;

export function generateSecret() {
  return randomBytes(32).toString("base64url");
}

export function buildRunbook(newSecret, now = new Date()) {
  const generatedAt = now.toISOString();
  const lines = [
    `# RELAY HMAC ROTATION — ${generatedAt}`,
    ``,
    `New secret value:`,
    ``,
    `    ${newSecret}`,
    ``,
    `Steps (run from the worker/ directory unless noted):`,
    ``,
    `1. Move the existing CURRENT value to PREVIOUS so the relay keeps`,
    `   accepting it during the ~${Math.round(overlapWindowSeconds / 60)}-minute grace window.`,
    `   You'll need a copy of the current value from your records or .env file.`,
    ``,
    `     pnpm exec wrangler secret put RELAY_HMAC_SECRET_PREVIOUS`,
    `     # paste the EXISTING value when prompted`,
    ``,
    `2. Push the new value as CURRENT.`,
    ``,
    `     echo -n "${newSecret}" | pnpm exec wrangler secret put RELAY_HMAC_SECRET_CURRENT`,
    ``,
    `3. Update the relay container's env (RELAY_HMAC_SECRET) with the new value`,
    `   and restart. Inside the relay docker-compose context:`,
    ``,
    `     # Edit your relay .env so RELAY_HMAC_SECRET=${newSecret}`,
    `     docker compose up -d relay`,
    ``,
    `4. After the relay has been restarted and is healthy (verify by tailing`,
    `   logs for a successful authed SMTP submission), clear PREVIOUS:`,
    ``,
    `     pnpm exec wrangler secret delete RELAY_HMAC_SECRET_PREVIOUS --force`,
    ``,
    `The worker accepts PREVIOUS for as long as it's set — there's no built-in`,
    `expiry. Aim to clear it within ~${Math.round(overlapWindowSeconds / 60)} minutes so a leaked old secret can't be`,
    `used indefinitely. Leaving it set is dual-acceptance, not "harmless".`,
    ``,
  ];
  return lines.join("\n");
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const secret = generateSecret();
  if (asJson) {
    console.log(JSON.stringify({ secret, generated_at: new Date().toISOString() }, null, 2));
  } else {
    console.log(buildRunbook(secret));
  }
}
