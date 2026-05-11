// cf-mail-relay Worker entry point.
//
// Scaffold only. MS1 wires /relay/auth, /relay/send. MS2 wires D1, idempotency,
// audit log. MS3 wires /admin/api/*. MS4 wires /send. See IMPLEMENTATION_PLAN.md.

import { Hono } from "hono";
import {
  canonicalRelayString,
  normalizeBodySha256,
  parseRelayHmacHeaders,
  sha256Hex,
  signRelayRequest,
  timingSafeEqualString,
} from "./hmac";

export interface Env {
  D1_MAIN: D1Database;
  KV_HOT: KVNamespace;
  CF_API_TOKEN: string;
  CF_ACCOUNT_ID: string;
  CREDENTIAL_PEPPER: string;
  METADATA_PEPPER: string;
  RELAY_HMAC_SECRET_CURRENT: string;
  RELAY_HMAC_SECRET_PREVIOUS?: string;
  RELAY_HMAC_KEY_ID?: string;
  RELAY_AUTH_USERNAME?: string;
  RELAY_AUTH_PASSWORD?: string;
  RELAY_ALLOWED_SENDERS?: string;
  BOOTSTRAP_SETUP_TOKEN?: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUDIENCE: string;
  REQUIRED_D1_SCHEMA_VERSION: string;
}

const app = new Hono<{ Bindings: Env }>();
const workerVersion = "0.1.0-ms1";
const maxRelayBodyBytes = 6 * 1024 * 1024;

app.get("/healthz", (c) => {
  return c.json({
    ok: true,
    version: workerVersion,
    git_sha: "ms1",
  });
});

app.post("/relay/auth", async (c) => {
  const bodyBytes = new Uint8Array(await c.req.arrayBuffer());
  const verification = await verifyRelayHmac(c.req.raw, c.env, bodyBytes);
  if (!verification.ok) {
    return c.json({ ok: false, error: verification.error }, verification.status);
  }

  let credentials: { username?: unknown; password?: unknown };
  try {
    credentials = JSON.parse(new TextDecoder().decode(bodyBytes)) as { username?: unknown; password?: unknown };
  } catch {
    return c.json({ ok: false, error: "invalid_json" }, 400);
  }

  if (typeof credentials.username !== "string" || typeof credentials.password !== "string") {
    return c.json({ ok: false, error: "invalid_credentials_shape" }, 400);
  }

  const configuredUsername = c.env.RELAY_AUTH_USERNAME;
  const configuredPassword = c.env.RELAY_AUTH_PASSWORD;
  if (configuredUsername === undefined || configuredPassword === undefined) {
    return c.json({ ok: false, error: "relay_auth_not_configured" }, 500);
  }

  const usernameMatches = timingSafeEqualString(credentials.username, configuredUsername);
  const passwordMatches = timingSafeEqualString(credentials.password, configuredPassword);
  if (!usernameMatches || !passwordMatches) {
    return c.json({ ok: false, error: "invalid_credentials" }, 401);
  }

  return c.json({
    ok: true,
    ttl_seconds: 60,
    policy_version: "env-ms1",
    allowed_senders: parseAllowedSenders(c.env.RELAY_ALLOWED_SENDERS),
  });
});

app.post("/relay/send", async (c) => {
  const rawMimeBytes = new Uint8Array(await c.req.arrayBuffer());
  const verification = await verifyRelayHmac(c.req.raw, c.env, rawMimeBytes);
  if (!verification.ok) {
    return c.json({ ok: false, error: verification.error }, verification.status);
  }
  if (rawMimeBytes.byteLength > maxRelayBodyBytes) {
    return c.json({ ok: false, error: "message_too_large" }, 413);
  }

  const from = c.req.header("x-relay-envelope-from")?.trim() ?? "";
  const recipients = parseRecipients(c.req.header("x-relay-recipients"));
  if (from.length === 0) {
    return c.json({ ok: false, error: "missing_envelope_from" }, 400);
  }
  if (recipients.length === 0) {
    return c.json({ ok: false, error: "missing_recipients" }, 400);
  }
  if (recipients.length > 50) {
    return c.json({ ok: false, error: "too_many_recipients" }, 400);
  }

  const decoded = decodeUtf8(rawMimeBytes);
  if (decoded === null) {
    return c.json({ ok: false, error: "mime_not_utf8_json_safe" }, 422);
  }
  const mimeMessage = stripCaptureHopHeaders(decoded);
  const bodyText = JSON.stringify({
    from,
    recipients,
    mime_message: mimeMessage,
  });

  const cfResponse = await fetch(sendRawUrl(c.env.CF_ACCOUNT_ID), {
    method: "POST",
    headers: {
      authorization: `Bearer ${c.env.CF_API_TOKEN}`,
      "content-type": "application/json",
    },
    body: bodyText,
  });
  const cfResponseText = await cfResponse.text();
  const responseStatus = cfResponse.ok ? 200 : 502;

  return c.json(
    {
      ok: cfResponse.ok,
      from,
      recipients,
      raw_mime_size_bytes: rawMimeBytes.byteLength,
      stripped_mime_size_bytes: new TextEncoder().encode(mimeMessage).byteLength,
      raw_mime_sha256: await sha256Hex(rawMimeBytes),
      stripped_mime_sha256: await sha256Hex(new TextEncoder().encode(mimeMessage)),
      cf_status: cfResponse.status,
      cf_ray_id: cfResponse.headers.get("cf-ray"),
      cf_request_id: cfResponse.headers.get("cf-request-id"),
      cf_response: parseJsonOrText(cfResponseText),
    },
    responseStatus,
  );
});

// TODO MS2: D1-backed credential verification, idempotency, send_events
// TODO MS3: /admin/api/*               (CF Access JWT-protected)
// TODO MS4: /send                      (API key-protected)

export function parseRecipients(raw: string | undefined): string[] {
  if (raw === undefined) {
    return [];
  }
  return raw
    .split(",")
    .map((recipient) => recipient.trim())
    .filter((recipient) => recipient.length > 0);
}

export function stripCaptureHopHeaders(mimeMessage: string): string {
  const normalized = mimeMessage.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const headerEnd = normalized.indexOf("\n\n");
  if (headerEnd === -1) {
    return mimeMessage;
  }

  const headerBlock = normalized.slice(0, headerEnd);
  const body = normalized.slice(headerEnd + 2);
  const unfolded: string[] = [];
  for (const line of headerBlock.split("\n")) {
    if (/^[ \t]/.test(line) && unfolded.length > 0) {
      unfolded[unfolded.length - 1] += `\n${line}`;
    } else {
      unfolded.push(line);
    }
  }

  const kept = unfolded.filter((header) => {
    const name = header.split(":", 1)[0]?.toLowerCase() ?? "";
    return !["received", "x-received", "x-gm-message-state"].includes(name);
  });

  return `${kept.join("\r\n")}\r\n\r\n${body.replaceAll("\n", "\r\n")}`;
}

async function verifyRelayHmac(
  request: Request,
  env: Env,
  bodyBytes: Uint8Array,
): Promise<{ ok: true } | { ok: false; status: 400 | 401 | 413 | 426; error: string }> {
  if (bodyBytes.byteLength > maxRelayBodyBytes) {
    return { ok: false, status: 413, error: "message_too_large" };
  }

  const headers = parseRelayHmacHeaders(request.headers);
  if ("error" in headers) {
    return { ok: false, status: 401, error: headers.error };
  }
  if (env.RELAY_HMAC_KEY_ID !== undefined && headers.keyId !== env.RELAY_HMAC_KEY_ID) {
    return { ok: false, status: 401, error: "unknown_key_id" };
  }
  if (!isSupportedRelayVersion(headers.version)) {
    return { ok: false, status: 426, error: "unsupported_relay_version" };
  }

  const bodySha256 = await sha256Hex(bodyBytes);
  if (normalizeBodySha256(headers.bodySha256) !== bodySha256) {
    return { ok: false, status: 400, error: "invalid_body_hash" };
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const timestamp = Number.parseInt(headers.timestamp, 10);
  if (Math.abs(nowSeconds - timestamp) > 60) {
    return { ok: false, status: 401, error: "timestamp_out_of_window" };
  }

  const input = {
    method: request.method,
    path: new URL(request.url).pathname,
    timestamp: headers.timestamp,
    nonce: headers.nonce,
    bodySha256,
    keyId: headers.keyId,
  };
  const current = await signRelayRequest(input, env.RELAY_HMAC_SECRET_CURRENT);
  const previous =
    env.RELAY_HMAC_SECRET_PREVIOUS !== undefined && env.RELAY_HMAC_SECRET_PREVIOUS.length > 0
      ? await signRelayRequest(input, env.RELAY_HMAC_SECRET_PREVIOUS)
      : null;
  if (!timingSafeEqualString(headers.signature, current) && (previous === null || !timingSafeEqualString(headers.signature, previous))) {
    return { ok: false, status: 401, error: "invalid_signature" };
  }

  const nonceKey = `nonce:${headers.keyId}:${headers.nonce}`;
  if ((await env.KV_HOT.get(nonceKey)) !== null) {
    return { ok: false, status: 401, error: "replay_nonce" };
  }
  await env.KV_HOT.put(nonceKey, "1", { expirationTtl: 120 });

  return { ok: true };
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const encoded = new TextEncoder().encode(decoded);
    if (encoded.byteLength !== bytes.byteLength || encoded.some((byte, index) => byte !== bytes[index])) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

function parseAllowedSenders(raw: string | undefined): string[] {
  return raw
    ?.split(",")
    .map((sender) => sender.trim())
    .filter((sender) => sender.length > 0) ?? [];
}

function isSupportedRelayVersion(version: string): boolean {
  return version === "0.1.0-ms1" || version.startsWith("0.1.0-");
}

function sendRawUrl(accountId: string): string {
  return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/email/sending/send_raw`;
}

function parseJsonOrText(text: string): unknown {
  if (text.length === 0) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export default app;
