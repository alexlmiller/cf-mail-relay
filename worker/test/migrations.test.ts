import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

describe("schema migrations", () => {
  it("scrubs existing idempotency replay payloads in version 5", () => {
    const sql = readFileSync(join(process.cwd(), "migrations", "0005_privacy_retention_hardening.sql"), "utf8");

    expect(sql).toContain("DELETE FROM idempotency_keys");
    expect(sql).toContain("DELETE FROM auth_failures");
    expect(sql).toContain("DELETE FROM rate_reservations");
    expect(sql).toContain("SET value_json = '5'");
  });

  it("extends surviving SMTP idempotency rows in version 6", () => {
    const sql = readFileSync(join(process.cwd(), "migrations", "0006_extend_smtp_idempotency.sql"), "utf8");
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL)");
      db.exec("CREATE TABLE idempotency_keys (idempotency_key TEXT PRIMARY KEY, source TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)");
      db.exec("INSERT INTO settings (key, value_json, updated_at) VALUES ('schema_version', '5', 0)");
      db.exec("INSERT INTO idempotency_keys VALUES ('smtp-row', 'smtp', 1000, 87400), ('http-row', 'http', 1000, 87400)");

      db.exec(sql);

      expect(db.prepare("SELECT expires_at FROM idempotency_keys WHERE idempotency_key = 'smtp-row'").get()).toEqual({ expires_at: 605800 });
      expect(db.prepare("SELECT expires_at FROM idempotency_keys WHERE idempotency_key = 'http-row'").get()).toEqual({ expires_at: 87400 });
      expect(db.prepare("SELECT value_json FROM settings WHERE key = 'schema_version'").get()).toEqual({ value_json: "6" });
    } finally {
      db.close();
    }
  });
});
