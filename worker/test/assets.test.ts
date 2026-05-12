import { describe, expect, it, vi } from "vitest";
import app from "../src/index";

// The Worker is bound to a Workers Static Assets binding at runtime. The
// Worker handles its own API routes; everything else falls through to
// `c.env.ASSETS.fetch(req)`, which Workers Static Assets resolves as either
// a matched file or, when `not_found_handling = "single-page-application"`,
// the bundled `/index.html` so client-side hash routing keeps working.

function makeAssetsFetcher(): { fetch: ReturnType<typeof vi.fn> } {
  return {
    fetch: vi.fn(async (req: Request) => {
      const url = new URL(req.url);
      // Simulate Workers Static Assets: serve a known asset, else 200 index.html.
      if (url.pathname === "/_astro/known.js") {
        return new Response("console.log('asset');", {
          status: 200,
          headers: { "content-type": "application/javascript" },
        });
      }
      return new Response("<!doctype html><html>SPA shell</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }),
  };
}

function makeMinimalEnv(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    D1_MAIN: {} as D1Database,
    KV_HOT: {} as KVNamespace,
    ASSETS: makeAssetsFetcher(),
    CF_ACCOUNT_ID: "account",
    CF_API_TOKEN: "token",
    CREDENTIAL_PEPPER: "p",
    METADATA_PEPPER: "m",
    RELAY_HMAC_SECRET_CURRENT: "secret",
    ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
    ACCESS_AUDIENCE: "aud",
    REQUIRED_D1_SCHEMA_VERSION: "2",
    ...overrides,
  };
}

describe("Workers Static Assets fallback", () => {
  it("delegates an unmatched GET to the ASSETS binding (SPA shell)", async () => {
    const env = makeMinimalEnv();
    const response = await app.request("/some/deep/hash-route", { method: "GET" }, env);
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain("SPA shell");
    const assets = env.ASSETS as { fetch: ReturnType<typeof vi.fn> };
    expect(assets.fetch).toHaveBeenCalledTimes(1);
  });

  it("delegates a static asset path to the ASSETS binding", async () => {
    const env = makeMinimalEnv();
    const response = await app.request("/_astro/known.js", { method: "GET" }, env);
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain("console.log");
    expect((env.ASSETS as { fetch: ReturnType<typeof vi.fn> }).fetch).toHaveBeenCalledOnce();
  });

  it("does NOT delegate API routes — /healthz hits the worker", async () => {
    // Bare-minimum D1 mock for the healthz schema check.
    const env = makeMinimalEnv({
      D1_MAIN: {
        prepare: () => ({
          bind: () => ({
            first: async () => ({ value_json: '"2"' }),
            all: async () => ({ results: [] }),
            run: async () => ({ meta: { changes: 0 } }),
          }),
        }),
      },
    });
    const response = await app.request("/healthz", { method: "GET" }, env);
    expect(response.status).toBe(200);
    expect((env.ASSETS as { fetch: ReturnType<typeof vi.fn> }).fetch).not.toHaveBeenCalled();
  });

  it("does NOT delegate /admin/api/* — missing JWT path returns 401, not the SPA shell", async () => {
    const env = makeMinimalEnv();
    const response = await app.request(
      "/admin/api/users",
      { method: "GET" },
      env,
    );
    expect(response.status).toBe(401);
    expect((env.ASSETS as { fetch: ReturnType<typeof vi.fn> }).fetch).not.toHaveBeenCalled();
  });
});
