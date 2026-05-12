import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { parseArgs, parseWranglerVars, run } from "./access-verify.mjs";

describe("access-verify helper", () => {
  it("parses same-origin admin URL and legacy aliases", () => {
    assert.deepEqual(parseArgs(["--config", "tmp.toml", "--admin-url", "https://mail.example.com/", "--team-domain", "https://team.cloudflareaccess.com/", "--access-jwt-env", "JWT", "--require-authenticated-session"]), {
      accessJwtEnv: "JWT",
      adminUrl: "https://mail.example.com",
      audience: "",
      config: "tmp.toml",
      help: false,
      requireAuthenticatedSession: true,
      teamDomain: "team.cloudflareaccess.com",
    });

    assert.equal(parseArgs(["--pages-url", "https://mail.example.com"]).adminUrl, "https://mail.example.com");
    assert.equal(parseArgs(["--worker-url", "https://mail.example.com"]).adminUrl, "https://mail.example.com");
  });

  it("reads vars from wrangler toml", () => {
    assert.deepEqual(
      parseWranglerVars(`
name = "worker"
[vars]
ACCESS_TEAM_DOMAIN = "team.cloudflareaccess.com"
ACCESS_AUDIENCE = "aud_123"
ADMIN_CORS_ORIGIN = "https://mail.example.com"
[[kv_namespaces]]
id = "kv"
`),
      {
        ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
        ACCESS_AUDIENCE: "aud_123",
        ADMIN_CORS_ORIGIN: "https://mail.example.com",
      },
    );
  });

  it("fails before live Access JWKS checks when Access config still has placeholders", async () => {
    const config = await writeTempConfig(`
[vars]
ACCESS_TEAM_DOMAIN = "your-team.cloudflareaccess.com"
ACCESS_AUDIENCE = "REPLACE_WITH_ACCESS_APPLICATION_AUD"
`);
    const calls = [];
    const result = await run(["--config", config, "--admin-url", "https://mail.example.com"], {}, async (url) => {
      calls.push(url);
      return json({ ok: true });
    });

    assert.equal(result.ok, false);
    assert.equal(result.checks.find((check) => check.name === "access_team_domain").status, "fail");
    assert.equal(result.checks.find((check) => check.name === "access_jwks").status, "skip");
    assert.equal(calls.some((url) => String(url).includes("/cdn-cgi/access/certs")), false);
  });

  it("passes same-origin path-scoped Access verification", async () => {
    const config = await writeTempConfig(`
[vars]
ACCESS_TEAM_DOMAIN = "team.cloudflareaccess.com"
ACCESS_AUDIENCE = "aud_123"
`);
    const result = await run(["--config", config, "--admin-url", "https://mail.example.com"], {}, async (url, init = {}) => {
      if (url === "https://team.cloudflareaccess.com/cdn-cgi/access/certs") {
        return json({ keys: [{ kid: "key_1" }] });
      }
      if (url === "https://mail.example.com/healthz") {
        return json({ ok: true, version: "0.1.0-ms7", git_sha: "ms7" });
      }
      if (url === "https://mail.example.com/" && init.redirect === "manual") {
        return redirect();
      }
      if (url === "https://mail.example.com/admin/api/session" && init.redirect === "manual") {
        return redirect();
      }
      if (url === "https://mail.example.com/self/api/session" && init.redirect === "manual") {
        return redirect();
      }
      if (url === "https://mail.example.com/send") {
        return json({ ok: false, error: "missing_api_key" }, 401);
      }
      if (url === "https://mail.example.com/relay/auth") {
        return json({ ok: false, error: "missing_hmac_headers" }, 401);
      }
      if (url === "https://mail.example.com/bootstrap/admin") {
        return json({ ok: false, error: "invalid_json" }, 400);
      }
      throw new Error(`unexpected request ${init.method ?? "GET"} ${url}`);
    });

    assert.equal(result.ok, true);
    assert.equal(result.checks.find((check) => check.name === "admin_cors_origin").status, "pass");
    assert.equal(result.checks.find((check) => check.name === "ui_gate").status, "pass");
    assert.equal(result.checks.find((check) => check.name === "send_public_path").status, "pass");
    assert.equal(result.checks.find((check) => check.name === "authenticated_session").status, "warn");
  });

  it("fails when Access is not enforcing the admin API", async () => {
    const config = await writeTempConfig(`
[vars]
ACCESS_TEAM_DOMAIN = "team.cloudflareaccess.com"
ACCESS_AUDIENCE = "aud_123"
`);
    const result = await run(["--config", config, "--admin-url", "https://mail.example.com"], {}, async (url) => {
      if (url === "https://team.cloudflareaccess.com/cdn-cgi/access/certs") {
        return json({ keys: [{ kid: "key_1" }] });
      }
      if (url.endsWith("/healthz")) return json({ ok: true });
      if (url.endsWith("/admin/api/session")) return json({ ok: false, error: "missing_access_jwt" }, 401);
      if (url.endsWith("/self/api/session")) return redirect();
      if (url === "https://mail.example.com/") return redirect();
      if (url.endsWith("/send")) return json({ ok: false, error: "missing_api_key" }, 401);
      if (url.endsWith("/relay/auth")) return json({ ok: false, error: "missing_hmac_headers" }, 401);
      if (url.endsWith("/bootstrap/admin")) return json({ ok: false, error: "invalid_json" }, 400);
      throw new Error(`unexpected ${url}`);
    });

    assert.equal(result.ok, false);
    assert.equal(result.checks.find((check) => check.name === "admin_api_gate").status, "fail");
  });

  it("fails when Access gates a public Worker route", async () => {
    const config = await writeTempConfig(`
[vars]
ACCESS_TEAM_DOMAIN = "team.cloudflareaccess.com"
ACCESS_AUDIENCE = "aud_123"
`);
    const result = await run(["--config", config, "--admin-url", "https://mail.example.com"], {}, async (url) => {
      if (url === "https://team.cloudflareaccess.com/cdn-cgi/access/certs") {
        return json({ keys: [{ kid: "key_1" }] });
      }
      if (url.endsWith("/healthz")) return json({ ok: true });
      if (url === "https://mail.example.com/") return redirect();
      if (url.endsWith("/admin/api/session")) return redirect();
      if (url.endsWith("/self/api/session")) return redirect();
      if (url.endsWith("/send")) return redirect();
      if (url.endsWith("/relay/auth")) return json({ ok: false, error: "missing_hmac_headers" }, 401);
      if (url.endsWith("/bootstrap/admin")) return json({ ok: false, error: "invalid_json" }, 400);
      throw new Error(`unexpected ${url}`);
    });

    assert.equal(result.ok, false);
    assert.equal(result.checks.find((check) => check.name === "send_public_path").status, "fail");
  });

  it("passes strict verification when an Access JWT returns the app shell and admin session", async () => {
    const config = await writeTempConfig(`
[vars]
ACCESS_TEAM_DOMAIN = "team.cloudflareaccess.com"
ACCESS_AUDIENCE = "aud_123"
`);
    const result = await run(["--config", config, "--admin-url", "https://mail.example.com", "--access-jwt-env", "ACCESS_JWT", "--require-authenticated-session"], { ACCESS_JWT: "jwt" }, async (url, init = {}) => {
      if (url === "https://team.cloudflareaccess.com/cdn-cgi/access/certs") {
        return json({ keys: [{ kid: "key_1" }] });
      }
      if (url === "https://mail.example.com/healthz") {
        return json({ ok: true, version: "0.1.0-ms7", git_sha: "ms7" });
      }
      if ((url === "https://mail.example.com/" || url === "https://mail.example.com") && init.headers?.["cf-access-jwt-assertion"] === "jwt") {
        return text('<html><body><div id="app"></div></body></html>');
      }
      if (url === "https://mail.example.com/") {
        return redirect();
      }
      if (url.endsWith("/admin/api/session") && init.headers?.["cf-access-jwt-assertion"] === "jwt") {
        return json({ ok: true, user: { id: "usr_1", email: "admin@example.com" } });
      }
      if (url.endsWith("/admin/api/session")) return redirect();
      if (url.endsWith("/self/api/session")) return redirect();
      if (url.endsWith("/send")) return json({ ok: false, error: "missing_api_key" }, 401);
      if (url.endsWith("/relay/auth")) return json({ ok: false, error: "missing_hmac_headers" }, 401);
      if (url.endsWith("/bootstrap/admin")) return json({ ok: false, error: "invalid_json" }, 400);
      throw new Error(`unexpected request ${init.method ?? "GET"} ${url}`);
    });

    assert.equal(result.ok, true);
    assert.equal(result.checks.find((check) => check.name === "authenticated_ui").status, "pass");
    assert.equal(result.checks.find((check) => check.name === "authenticated_session").status, "pass");
  });
});

async function writeTempConfig(text) {
  const dir = await mkdtemp(path.join(tmpdir(), "cf-mail-relay-access-verify-"));
  const file = path.join(dir, "wrangler.toml");
  await writeFile(file, text);
  return file;
}

function redirect() {
  return new Response("", { status: 302, headers: { location: "https://team.cloudflareaccess.com/cdn-cgi/access/login" } });
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function text(body, status = 200) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html" },
  });
}
