import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { parseArgs, run, updateWranglerVars } from "./access-apply.mjs";

describe("access-apply helper", () => {
  it("parses explicit values", () => {
    assert.deepEqual(parseArgs(["--config", "worker.toml", "--team-domain", "https://team.cloudflareaccess.com/", "--audience", "aud_123", "--dry-run"]), {
      adminCorsOrigin: "",
      audience: "aud_123",
      config: "worker.toml",
      dryRun: true,
      help: false,
      json: "",
      pagesUrl: "",
      teamDomain: "team.cloudflareaccess.com",
    });
  });

  it("updates existing vars while preserving unrelated config", () => {
    const updated = updateWranglerVars(
      `name = "cf-mail-relay-worker"

[vars]
REQUIRED_D1_SCHEMA_VERSION = "1"
ACCESS_TEAM_DOMAIN = "your-team.cloudflareaccess.com"
ACCESS_AUDIENCE = "REPLACE_WITH_ACCESS_APPLICATION_AUD"
ADMIN_CORS_ORIGIN = "https://old.example.com" # keep comment
CF_ACCOUNT_ID = "account"

[[kv_namespaces]]
id = "kv"
`,
      {
        ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
        ACCESS_AUDIENCE: "aud_123",
        ADMIN_CORS_ORIGIN: "https://admin.example.com",
      },
    );

    assert.match(updated, /ACCESS_TEAM_DOMAIN = "team\.cloudflareaccess\.com"/);
    assert.match(updated, /ACCESS_AUDIENCE = "aud_123"/);
    assert.match(updated, /ADMIN_CORS_ORIGIN = "https:\/\/admin\.example\.com" # keep comment/);
    assert.match(updated, /\[\[kv_namespaces\]\]\nid = "kv"/);
  });

  it("inserts missing vars before the next section", () => {
    const updated = updateWranglerVars(
      `[vars]
REQUIRED_D1_SCHEMA_VERSION = "1"

[[d1_databases]]
binding = "D1_MAIN"
`,
      {
        ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
        ACCESS_AUDIENCE: "aud_123",
        ADMIN_CORS_ORIGIN: "https://admin.example.com",
      },
    );

    assert.match(
      updated,
      /REQUIRED_D1_SCHEMA_VERSION = "1"\nACCESS_TEAM_DOMAIN = "team\.cloudflareaccess\.com"\nACCESS_AUDIENCE = "aud_123"\nADMIN_CORS_ORIGIN = "https:\/\/admin\.example\.com"\n\n\[\[d1_databases\]\]/,
    );
  });

  it("can read access:setup JSON output and write the config", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cf-mail-relay-access-apply-"));
    const config = path.join(dir, "wrangler.toml");
    const json = path.join(dir, "access.json");
    await writeFile(config, `[vars]\nACCESS_TEAM_DOMAIN = "old.cloudflareaccess.com"\nACCESS_AUDIENCE = "old_aud"\n`);
    await writeFile(json, JSON.stringify({ access_team_domain: "team.cloudflareaccess.com", access_audience: "aud_123" }));

    const result = await run(["--config", config, "--json", json, "--pages-url", "https://admin.example.com/"]);
    const written = await readFile(config, "utf8");

    assert.equal(result.changed, true);
    assert.match(written, /ACCESS_TEAM_DOMAIN = "team\.cloudflareaccess\.com"/);
    assert.match(written, /ACCESS_AUDIENCE = "aud_123"/);
    assert.match(written, /ADMIN_CORS_ORIGIN = "https:\/\/admin\.example\.com"/);
  });

  it("does not write in dry-run mode", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cf-mail-relay-access-apply-"));
    const config = path.join(dir, "wrangler.toml");
    await writeFile(config, `[vars]\nACCESS_TEAM_DOMAIN = "old.cloudflareaccess.com"\nACCESS_AUDIENCE = "old_aud"\n`);

    const result = await run(["--config", config, "--team-domain", "team.cloudflareaccess.com", "--audience", "aud_123", "--dry-run"]);
    const written = await readFile(config, "utf8");

    assert.equal(result.changed, true);
    assert.equal(written, `[vars]\nACCESS_TEAM_DOMAIN = "old.cloudflareaccess.com"\nACCESS_AUDIENCE = "old_aud"\n`);
  });
});
