import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("schema migrations", () => {
  it("scrubs existing idempotency replay payloads in version 5", () => {
    const sql = readFileSync(join(process.cwd(), "migrations", "0005_privacy_retention_hardening.sql"), "utf8");

    expect(sql).toContain("DELETE FROM idempotency_keys");
    expect(sql).toContain("DELETE FROM auth_failures");
    expect(sql).toContain("DELETE FROM rate_reservations");
    expect(sql).toContain("SET value_json = '5'");
  });
});
