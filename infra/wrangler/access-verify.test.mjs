import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { parseArgs, parseWranglerVars, run } from "./access-verify.mjs";

describe("access-verify helper", () => {
  it("parses overrides", () => {
    assert.deepEqual(parseArgs(["--config", "tmp.toml", "--team-domain", "https://team.cloudflareaccess.com/", "--access-jwt-env", "JWT", "--require-authenticated-session"]), {
      accessJwtEnv: "JWT",
      audience: "",
      config: "tmp.toml",
      help: false,
      pagesUrl: "https://cf-mail-relay-ui.pages.dev",
      requireAuthenticatedSession: true,
      teamDomain: "team.cloudflareaccess.com",
      workerUrl: "https://cf-mail-relay-worker.milfred.workers.dev",
    });
  });

  it("reads vars from wrangler toml", () => {
    assert.deepEqual(
      parseWranglerVars(`
name = "worker"
[vars]
ACCESS_TEAM_DOMAIN = "team.cloudflareaccess.com"
ACCESS_AUDIENCE = "aud_123"
ADMIN_CORS_ORIGIN = "https://cf-mail-relay-ui.pages.dev"
[[kv_namespaces]]
id = "kv"
`),
      {
        ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
        ACCESS_AUDIENCE: "aud_123",
        ADMIN_CORS_ORIGIN: "https://cf-mail-relay-ui.pages.dev",
      },
    );
  });

  it("fails before live checks when Access config still has placeholders", async () => {
    const config = await writeTempConfig(`
[vars]
ACCESS_TEAM_DOMAIN = "your-team.cloudflareaccess.com"
ACCESS_AUDIENCE = "REPLACE_WITH_ACCESS_APPLICATION_AUD"
ADMIN_CORS_ORIGIN = "https://cf-mail-relay-ui.pages.dev"
`);
    const calls = [];
    const result = await run(["--config", config], {}, async (url) => {
      calls.push(url);
      return json({ ok: true });
    });

    assert.equal(result.ok, false);
    assert.equal(result.checks.find((check) => check.name === "access_team_domain").status, "fail");
    assert.equal(result.checks.find((check) => check.name === "access_jwks").status, "skip");
    assert.equal(calls.some((url) => String(url).includes("/cdn-cgi/access/certs")), false);
  });

  it("passes configured checks when Access intercepts unauthenticated admin requests", async () => {
    const config = await writeTempConfig(`
[vars]
ACCESS_TEAM_DOMAIN = "team.cloudflareaccess.com"
ACCESS_AUDIENCE = "aud_123"
ADMIN_CORS_ORIGIN = "https://cf-mail-relay-ui.pages.dev"
`);
    const result = await run(["--config", config], {}, async (url, init) => {
      if (url === "https://team.cloudflareaccess.com/cdn-cgi/access/certs") {
        return json({ keys: [{ kid: "key_1" }] });
      }
      if (url === "https://cf-mail-relay-worker.milfred.workers.dev/healthz") {
        return json({ ok: true, version: "0.1.0-ms3", git_sha: "ms3" });
      }
      if (url === "https://cf-mail-relay-ui.pages.dev") {
        return text("<html>https://cf-mail-relay-worker.milfred.workers.dev</html>");
      }
      if (url === "https://cf-mail-relay-worker.milfred.workers.dev/admin/api/session" && init.redirect === "manual") {
        return new Response("", { status: 302, headers: { location: "https://team.cloudflareaccess.com/cdn-cgi/access/login" } });
      }
      throw new Error(`unexpected request ${init.method} ${url}`);
    });

    assert.equal(result.ok, true);
    assert.equal(result.checks.find((check) => check.name === "unauthenticated_admin_gate").status, "pass");
    assert.equal(result.checks.find((check) => check.name === "authenticated_session").status, "warn");
  });

  it("passes the Pages check when Access protects the Pages artifact", async () => {
    const config = await writeTempConfig(`
[vars]
ACCESS_TEAM_DOMAIN = "team.cloudflareaccess.com"
ACCESS_AUDIENCE = "aud_123"
ADMIN_CORS_ORIGIN = "https://cf-mail-relay-ui.pages.dev"
`);
    const result = await run(["--config", config], {}, async (url, init) => {
      if (url === "https://team.cloudflareaccess.com/cdn-cgi/access/certs") {
        return json({ keys: [{ kid: "key_1" }] });
      }
      if (url === "https://cf-mail-relay-worker.milfred.workers.dev/healthz") {
        return json({ ok: true, version: "0.1.0-ms3", git_sha: "ms3" });
      }
      if (url === "https://cf-mail-relay-ui.pages.dev" && init.redirect === "manual") {
        return new Response("", { status: 302, headers: { location: "https://team.cloudflareaccess.com/cdn-cgi/access/login" } });
      }
      if (url === "https://cf-mail-relay-worker.milfred.workers.dev/admin/api/session" && init.redirect === "manual") {
        return new Response("", { status: 302, headers: { location: "https://team.cloudflareaccess.com/cdn-cgi/access/login" } });
      }
      throw new Error(`unexpected request ${init.method} ${url}`);
    });

    assert.equal(result.ok, true);
    assert.equal(result.checks.find((check) => check.name === "pages_artifact").status, "pass");
    assert.equal(result.checks.find((check) => check.name === "authenticated_session").status, "warn");
  });

  it("uses the provided Access JWT when checking the protected Pages artifact", async () => {
    const config = await writeTempConfig(`
[vars]
ACCESS_TEAM_DOMAIN = "team.cloudflareaccess.com"
ACCESS_AUDIENCE = "aud_123"
ADMIN_CORS_ORIGIN = "https://cf-mail-relay-ui.pages.dev"
`);
    const result = await run(["--config", config, "--access-jwt-env", "ACCESS_JWT"], { ACCESS_JWT: "jwt" }, async (url, init) => {
      if (url === "https://team.cloudflareaccess.com/cdn-cgi/access/certs") {
        return json({ keys: [{ kid: "key_1" }] });
      }
      if (url === "https://cf-mail-relay-worker.milfred.workers.dev/healthz") {
        return json({ ok: true, version: "0.1.0-ms3", git_sha: "ms3" });
      }
      if (
        url === "https://cf-mail-relay-ui.pages.dev" &&
        init.headers["cf-access-jwt-assertion"] === "jwt" &&
        init.headers.cookie === "CF_Authorization=jwt"
      ) {
        return text("<html>https://cf-mail-relay-worker.milfred.workers.dev</html>");
      }
      if (url === "https://cf-mail-relay-worker.milfred.workers.dev/admin/api/session" && init.redirect === "manual") {
        return new Response("", { status: 302, headers: { location: "https://team.cloudflareaccess.com/cdn-cgi/access/login" } });
      }
      if (
        url === "https://cf-mail-relay-worker.milfred.workers.dev/admin/api/session" &&
        init.headers["cf-access-jwt-assertion"] === "jwt" &&
        init.headers.cookie === "CF_Authorization=jwt"
      ) {
        return json({ ok: true, user: { id: "usr_1", email: "admin@example.com" } });
      }
      throw new Error(`unexpected request ${init.method} ${url}`);
    });

    assert.equal(result.ok, true);
    assert.equal(result.checks.find((check) => check.name === "pages_artifact").status, "pass");
    assert.equal(result.checks.find((check) => check.name === "authenticated_session").status, "pass");
  });

  it("fails strict verification when no Access JWT is provided", async () => {
    const config = await writeTempConfig(`
[vars]
ACCESS_TEAM_DOMAIN = "team.cloudflareaccess.com"
ACCESS_AUDIENCE = "aud_123"
ADMIN_CORS_ORIGIN = "https://cf-mail-relay-ui.pages.dev"
`);
    const result = await run(["--config", config, "--require-authenticated-session"], {}, async (url, init) => {
      if (url === "https://team.cloudflareaccess.com/cdn-cgi/access/certs") {
        return json({ keys: [{ kid: "key_1" }] });
      }
      if (url === "https://cf-mail-relay-worker.milfred.workers.dev/healthz") {
        return json({ ok: true, version: "0.1.0-ms3", git_sha: "ms3" });
      }
      if (url === "https://cf-mail-relay-ui.pages.dev") {
        return text("<html>https://cf-mail-relay-worker.milfred.workers.dev</html>");
      }
      if (url === "https://cf-mail-relay-worker.milfred.workers.dev/admin/api/session" && init.redirect === "manual") {
        return new Response("", { status: 302, headers: { location: "https://team.cloudflareaccess.com/cdn-cgi/access/login" } });
      }
      throw new Error(`unexpected request ${init.method} ${url}`);
    });

    assert.equal(result.ok, false);
    assert.equal(result.checks.find((check) => check.name === "authenticated_session").status, "fail");
  });

  it("passes strict verification when an Access JWT returns an admin session", async () => {
    const config = await writeTempConfig(`
[vars]
ACCESS_TEAM_DOMAIN = "team.cloudflareaccess.com"
ACCESS_AUDIENCE = "aud_123"
ADMIN_CORS_ORIGIN = "https://cf-mail-relay-ui.pages.dev"
`);
    const result = await run(["--config", config, "--access-jwt-env", "ACCESS_JWT", "--require-authenticated-session"], { ACCESS_JWT: "jwt" }, async (url, init) => {
      if (url === "https://team.cloudflareaccess.com/cdn-cgi/access/certs") {
        return json({ keys: [{ kid: "key_1" }] });
      }
      if (url === "https://cf-mail-relay-worker.milfred.workers.dev/healthz") {
        return json({ ok: true, version: "0.1.0-ms3", git_sha: "ms3" });
      }
      if (url === "https://cf-mail-relay-ui.pages.dev") {
        return text("<html>https://cf-mail-relay-worker.milfred.workers.dev</html>");
      }
      if (url === "https://cf-mail-relay-worker.milfred.workers.dev/admin/api/session" && init.redirect === "manual") {
        return new Response("", { status: 302, headers: { location: "https://team.cloudflareaccess.com/cdn-cgi/access/login" } });
      }
      if (
        url === "https://cf-mail-relay-worker.milfred.workers.dev/admin/api/session" &&
        init.headers["cf-access-jwt-assertion"] === "jwt" &&
        init.headers.cookie === "CF_Authorization=jwt"
      ) {
        return json({ ok: true, user: { id: "usr_1", email: "admin@example.com" } });
      }
      throw new Error(`unexpected request ${init.method} ${url}`);
    });

    assert.equal(result.ok, true);
    assert.equal(result.checks.find((check) => check.name === "authenticated_session").status, "pass");
  });

  it("fails when the Worker directly returns missing_access_jwt", async () => {
    const config = await writeTempConfig(`
[vars]
ACCESS_TEAM_DOMAIN = "team.cloudflareaccess.com"
ACCESS_AUDIENCE = "aud_123"
ADMIN_CORS_ORIGIN = "https://cf-mail-relay-ui.pages.dev"
`);
    const result = await run(["--config", config], {}, async (url) => {
      if (url === "https://team.cloudflareaccess.com/cdn-cgi/access/certs") {
        return json({ keys: [{ kid: "key_1" }] });
      }
      if (url.endsWith("/healthz")) {
        return json({ ok: true });
      }
      if (url === "https://cf-mail-relay-ui.pages.dev") {
        return text("<html>https://cf-mail-relay-worker.milfred.workers.dev</html>");
      }
      if (url.endsWith("/admin/api/session")) {
        return json({ ok: false, error: "missing_access_jwt" }, { status: 401 });
      }
      throw new Error(`unexpected request ${url}`);
    });

    assert.equal(result.ok, false);
    assert.equal(result.checks.find((check) => check.name === "unauthenticated_admin_gate").status, "fail");
  });
});

async function writeTempConfig(text) {
  const dir = await mkdtemp(path.join(tmpdir(), "cf-mail-relay-access-verify-"));
  const file = path.join(dir, "wrangler.toml");
  await writeFile(file, text);
  return file;
}

function json(payload, options = {}) {
  return new Response(JSON.stringify(payload), {
    status: options.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

function text(body, options = {}) {
  return new Response(body, {
    status: options.status ?? 200,
    headers: { "content-type": "text/html" },
  });
}
