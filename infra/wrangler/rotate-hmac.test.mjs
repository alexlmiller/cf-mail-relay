import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildRunbook, generateSecret } from "./rotate-hmac.mjs";

describe("rotate-hmac helper", () => {
  it("generates a 32-byte base64url secret", () => {
    const secret = generateSecret();
    // 32 bytes base64url-encoded → 43 chars, no padding.
    assert.equal(secret.length, 43);
    assert.match(secret, /^[A-Za-z0-9_-]+$/);
  });

  it("emits a runbook that names both PREVIOUS and CURRENT slots", () => {
    const runbook = buildRunbook("EXAMPLESECRET", new Date("2026-01-01T00:00:00Z"));
    assert.match(runbook, /EXAMPLESECRET/);
    assert.match(runbook, /RELAY_HMAC_SECRET_PREVIOUS/);
    assert.match(runbook, /RELAY_HMAC_SECRET_CURRENT/);
    assert.match(runbook, /docker compose up -d relay/);
    assert.match(runbook, /grace window/);
  });
});
