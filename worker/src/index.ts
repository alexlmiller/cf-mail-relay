// cf-mail-relay Worker entry point.
//
// Scaffold only. MS1 wires /relay/auth, /relay/send. MS2 wires D1, idempotency,
// audit log. MS3 wires /admin/api/*. MS4 wires /send. See IMPLEMENTATION_PLAN.md.

import { Hono } from "hono";

export interface Env {
  D1_MAIN: D1Database;
  KV_HOT: KVNamespace;
  CF_API_TOKEN: string;
  CF_ACCOUNT_ID: string;
  CREDENTIAL_PEPPER: string;
  METADATA_PEPPER: string;
  RELAY_HMAC_SECRET_CURRENT: string;
  RELAY_HMAC_SECRET_PREVIOUS?: string;
  BOOTSTRAP_SETUP_TOKEN?: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUDIENCE: string;
  REQUIRED_D1_SCHEMA_VERSION: string;
}

const app = new Hono<{ Bindings: Env }>();

app.get("/healthz", (c) => {
  return c.json({
    ok: true,
    version: "0.0.0",
    git_sha: "scaffold",
  });
});

// TODO MS1: /relay/auth, /relay/send  (HMAC-protected)
// TODO MS2: D1-backed credential verification, idempotency, send_events
// TODO MS3: /admin/api/*               (CF Access JWT-protected)
// TODO MS4: /send                      (API key-protected)

export default app;
