// cf-mail-relay Worker entry point.

import { Hono } from "hono";
import type { Context } from "hono";
import {
  createApiKey,
  createDomain,
  createSender,
  createSmtpCredential,
  createUser,
  dashboard,
  listApiKeys,
  listAuthFailures,
  listDomains,
  listSendEvents,
  listSenders,
  listSmtpCredentials,
  listUsers,
  revokeApiKey,
  revokeSmtpCredential,
  rollApiKey,
  rollSmtpCredential,
} from "./admin";
import { requireAdmin, requireAuthenticated } from "./access";
import {
  selfApiKeys,
  selfCreateApiKey,
  selfCreateSmtpCredential,
  selfProfile,
  selfRevokeApiKey,
  selfRevokeSmtpCredential,
  selfRollApiKey,
  selfRollSmtpCredential,
  selfSendEvents,
  selfSenders,
  selfSmtpCredentials,
} from "./self";
import {
  canonicalRelayString,
  normalizeBodySha256,
  parseRelayHmacHeaders,
  sha256Hex,
  signRelayRequest,
  timingSafeEqualString,
} from "./hmac";
import {
  authenticateApiKey,
  authenticateSmtpCredential,
  beginIdempotentRequest,
  bootstrapAdmin,
  completeIdempotentRequest,
  computeHttpIdempotencyKey,
  computeSmtpIdempotencyKey,
  extractHeader,
  policyVersionFromD1,
  recordSendEvent,
  reserveSendQuota,
  senderAllowedForApiKey,
  senderAllowedForCredential,
  schemaVersionFromD1,
} from "./state";

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
  BOOTSTRAP_SETUP_TOKEN?: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUDIENCE: string;
  ACCESS_JWKS_JSON?: string;
  ADMIN_CORS_ORIGIN?: string;
  REQUIRED_D1_SCHEMA_VERSION: string;
}

const app = new Hono<{ Bindings: Env }>();
const workerVersion = "0.1.0-ms5";
const maxRelayBodyBytes = 6 * 1024 * 1024;

app.get("/healthz", async (c) => {
  const requiredSchemaVersion = c.env.REQUIRED_D1_SCHEMA_VERSION || "1";
  const actualSchemaVersion = await schemaVersionFromD1(c.env);
  if (actualSchemaVersion !== requiredSchemaVersion) {
    return c.json(
      {
        ok: false,
        version: workerVersion,
        git_sha: "ms5",
        error: "schema_version_mismatch",
        required_schema_version: requiredSchemaVersion,
        actual_schema_version: actualSchemaVersion,
      },
      500,
    );
  }
  return c.json({
    ok: true,
    version: workerVersion,
    git_sha: "ms5",
    schema_version: actualSchemaVersion,
  });
});

app.post("/bootstrap/admin", async (c) => {
  let body: { email?: unknown; display_name?: unknown };
  try {
    body = (await c.req.json()) as { email?: unknown; display_name?: unknown };
  } catch {
    return c.json({ ok: false, error: "invalid_json" }, 400);
  }

  const token = c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const result = await bootstrapAdmin(c.env, token, body);
  if (!result.ok) {
    return c.json({ ok: false, error: result.error }, result.status);
  }
  return c.json(result);
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

  const result = await authenticateSmtpCredential(c.env, credentials.username, credentials.password, c.req.header("cf-connecting-ip") ?? undefined);
  if (!result.ok) {
    return c.json({ ok: false, error: "invalid_credentials" }, 401);
  }

  c.header("x-relay-policy-version", result.policy_version);
  return c.json(result);
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
  const credentialId = c.req.header("x-relay-credential-id")?.trim() ?? "";
  if (credentialId.length === 0) {
    return c.json({ ok: false, error: "missing_credential_id" }, 400);
  }
  const policyVersion = await policyVersionFromD1(c.env);
  c.header("x-relay-policy-version", policyVersion);
  const senderPolicy = await senderAllowedForCredential(c.env, credentialId, from);
  if (!senderPolicy.ok) {
    await recordSendEvent(c.env, {
      traceId: c.req.header("x-relay-trace-id") ?? crypto.randomUUID(),
      source: "smtp",
      credentialId,
      envelopeFrom: from,
      recipients,
      mimeSizeBytes: rawMimeBytes.byteLength,
      messageIdHeader: "",
      status: "policy_rejected",
      smtpCode: "553",
      errorCode: senderPolicy.reason,
    });
    return c.json({ ok: false, error: "sender_not_allowed" }, 403);
  }

  const decoded = decodeUtf8(rawMimeBytes);
  if (decoded === null) {
    return c.json({ ok: false, error: "mime_not_utf8_json_safe" }, 422);
  }
  const mimeMessage = stripCaptureHopHeaders(decoded);
  const mimeMessageBytes = new TextEncoder().encode(mimeMessage);
  const strippedMimeSha256 = await sha256Hex(mimeMessageBytes);
  const messageIdHeader = extractHeader(mimeMessage, "message-id");
  const idempotencyKey = await computeSmtpIdempotencyKey({
    envelopeFrom: from,
    recipients,
    messageIdHeader,
    mimeSha256: strippedMimeSha256,
  });
  const idempotency = await beginIdempotentRequest(c.env, idempotencyKey, idempotencyKey);
  if (idempotency.status === "pending") {
    return c.json({ ok: false, error: "idempotency_pending" }, 409);
  }
  if (idempotency.status === "replay") {
    for (const [name, value] of Object.entries(idempotency.response.headers ?? {})) {
      c.header(name, value);
    }
    c.header("x-relay-idempotency-replay", "1");
    return c.json(idempotency.response.body, idempotency.response.status as 200 | 400 | 401 | 403 | 409 | 413 | 422 | 429 | 502);
  }

  const quota = await reserveSendQuota(c.env, { source: "smtp", envelopeFrom: from, credentialId });
  if (!quota.ok) {
    const responseBody = { ok: false, error: "rate_limited", scope: quota.scope, limit: quota.limit };
    await Promise.all([
      recordSendEvent(c.env, {
        traceId: c.req.header("x-relay-trace-id") ?? crypto.randomUUID(),
        source: "smtp",
        userId: senderPolicy.userId,
        credentialId,
        envelopeFrom: from,
        recipients,
        mimeSizeBytes: rawMimeBytes.byteLength,
        messageIdHeader,
        status: "rate_limited",
        smtpCode: "451",
        errorCode: "rate_limited",
      }),
      completeIdempotentRequest(c.env, idempotencyKey, false, {
        ok: false,
        status: 429,
        body: responseBody,
        headers: { "x-relay-policy-version": policyVersion },
      }),
    ]);
    return c.json(responseBody, 429);
  }

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
  const cfResponseParsed = parseJsonOrText(cfResponseText);
  const cfResult = parseCloudflareResult(cfResponseParsed);
  const allBounced =
    cfResponse.ok &&
    arrayLength(cfResult.bounced) > 0 &&
    arrayLength(cfResult.delivered) === 0 &&
    arrayLength(cfResult.queued) === 0;
  const deliveryOk = cfResponse.ok && !allBounced;
  const responseStatus = deliveryOk ? 200 : 502;
  const rawMimeSha256 = await sha256Hex(rawMimeBytes);
  const cfRequestId = cfResponse.headers.get("cf-request-id");
  const cfRayId = cfResponse.headers.get("cf-ray");
  const responseBody = {
    ok: deliveryOk,
    from,
    recipients,
    raw_mime_size_bytes: rawMimeBytes.byteLength,
    stripped_mime_size_bytes: mimeMessageBytes.byteLength,
    raw_mime_sha256: rawMimeSha256,
    stripped_mime_sha256: strippedMimeSha256,
    idempotency_key: idempotencyKey,
    cf_status: cfResponse.status,
    cf_ray_id: cfRayId,
    cf_request_id: cfRequestId,
    cf_response: cfResponseParsed,
  };
  console.log(
    JSON.stringify({
      event: "relay_send_raw_result",
      ok: deliveryOk,
      recipient_count: recipients.length,
      raw_mime_size_bytes: rawMimeBytes.byteLength,
      stripped_mime_size_bytes: mimeMessageBytes.byteLength,
      cf_status: cfResponse.status,
    }),
  );

  await Promise.all([
    recordSendEvent(c.env, {
      traceId: c.req.header("x-relay-trace-id") ?? crypto.randomUUID(),
      source: "smtp",
      userId: senderPolicy.userId,
      credentialId,
      envelopeFrom: from,
      recipients,
      mimeSizeBytes: rawMimeBytes.byteLength,
      messageIdHeader,
      cfRequestId,
      cfRayId,
      cfDeliveredJson: cfResult.delivered === null ? null : JSON.stringify(cfResult.delivered),
      cfQueuedJson: cfResult.queued === null ? null : JSON.stringify(cfResult.queued),
      cfBouncedJson: cfResult.bounced === null ? null : JSON.stringify(cfResult.bounced),
      status: deliveryOk ? "accepted" : allBounced ? "all_bounced" : "cf_error",
      smtpCode: deliveryOk ? "250" : allBounced ? "550" : "451",
      errorCode: deliveryOk ? undefined : allBounced ? "all_recipients_bounced" : "cloudflare_send_raw_rejected",
      cfErrorCode: cfResult.errorCode,
    }),
    completeIdempotentRequest(c.env, idempotencyKey, deliveryOk, {
      ok: deliveryOk,
      status: responseStatus,
      body: responseBody,
      headers: { "x-relay-policy-version": policyVersion },
    },
    ),
  ]);

  return c.json(responseBody, responseStatus);
});

app.options("/admin/api/*", (c) => {
  setAdminCors(c);
  return new Response(null, { status: 204, headers: c.res.headers });
});

app.get("/admin/api/session", async (c) => {
  setAdminCors(c);
  const admin = await requireAdmin(c.req.raw, c.env);
  if (!admin.ok) {
    return c.json({ ok: false, error: admin.error }, admin.status);
  }
  return c.json({ ok: true, user: admin.user, access: { sub: admin.claims.sub, email: admin.claims.email ?? null } });
});

app.get("/admin/api/dashboard", async (c) => adminJson(c, () => dashboard(c.env)));
app.get("/admin/api/users", async (c) => adminJson(c, () => listUsers(c.env)));
app.post("/admin/api/users", async (c) => adminJson(c, async () => createUser(c.env, await readJsonObject(c.req.raw)), 201));
app.get("/admin/api/domains", async (c) => adminJson(c, () => listDomains(c.env)));
app.post("/admin/api/domains", async (c) => adminJson(c, async () => createDomain(c.env, await readJsonObject(c.req.raw)), 201));
app.get("/admin/api/senders", async (c) => adminJson(c, () => listSenders(c.env)));
app.post("/admin/api/senders", async (c) => adminJson(c, async () => createSender(c.env, await readJsonObject(c.req.raw)), 201));
app.get("/admin/api/smtp-credentials", async (c) => adminJson(c, () => listSmtpCredentials(c.env)));
app.post("/admin/api/smtp-credentials", async (c) => adminJson(c, async () => createSmtpCredential(c.env, await readJsonObject(c.req.raw)), 201));
app.post("/admin/api/smtp-credentials/:id/revoke", async (c) =>
  adminJson(c, async () => {
    await revokeSmtpCredential(c.env, c.req.param("id"));
    return { revoked: true };
  }),
);
app.post("/admin/api/smtp-credentials/:id/roll", async (c) =>
  adminJson(c, async () => rollSmtpCredential(c.env, c.req.param("id"))),
);
app.get("/admin/api/api-keys", async (c) => adminJson(c, () => listApiKeys(c.env)));
app.post("/admin/api/api-keys", async (c) => adminJson(c, async () => createApiKey(c.env, await readJsonObject(c.req.raw)), 201));
app.post("/admin/api/api-keys/:id/revoke", async (c) =>
  adminJson(c, async () => {
    await revokeApiKey(c.env, c.req.param("id"));
    return { revoked: true };
  }),
);
app.post("/admin/api/api-keys/:id/roll", async (c) =>
  adminJson(c, async () => rollApiKey(c.env, c.req.param("id"))),
);
app.get("/admin/api/send-events", async (c) => adminJson(c, () => listSendEvents(c.env)));
app.get("/admin/api/auth-failures", async (c) => adminJson(c, () => listAuthFailures(c.env)));

// ───────────────────────── Self-service ─────────────────────────
// Any authenticated, non-disabled user (admin or sender). All queries are
// scoped to the session user; client-supplied user_id is ignored.

app.options("/self/api/*", (c) => {
  setAdminCors(c);
  return new Response(null, { status: 204, headers: c.res.headers });
});

app.get("/self/api/session", async (c) => {
  setAdminCors(c);
  const session = await requireAuthenticated(c.req.raw, c.env);
  if (!session.ok) return c.json({ ok: false, error: session.error }, session.status);
  return c.json({
    ok: true,
    user: session.user,
    access: { sub: session.claims.sub, email: session.claims.email ?? null },
  });
});

app.get("/self/api/profile", async (c) => selfJson(c, (userId) => selfProfile(c.env, userId)));
app.get("/self/api/senders", async (c) => selfJson(c, (userId) => selfSenders(c.env, userId)));
app.get("/self/api/smtp-credentials", async (c) => selfJson(c, (userId) => selfSmtpCredentials(c.env, userId)));
app.post("/self/api/smtp-credentials", async (c) =>
  selfJson(c, async (userId) => selfCreateSmtpCredential(c.env, userId, await readJsonObject(c.req.raw)), 201),
);
app.post("/self/api/smtp-credentials/:id/revoke", async (c) =>
  selfJson(c, (userId) => selfRevokeSmtpCredential(c.env, userId, c.req.param("id"))),
);
app.post("/self/api/smtp-credentials/:id/roll", async (c) =>
  selfJson(c, (userId) => selfRollSmtpCredential(c.env, userId, c.req.param("id"))),
);
app.get("/self/api/api-keys", async (c) => selfJson(c, (userId) => selfApiKeys(c.env, userId)));
app.post("/self/api/api-keys", async (c) =>
  selfJson(c, async (userId) => selfCreateApiKey(c.env, userId, await readJsonObject(c.req.raw)), 201),
);
app.post("/self/api/api-keys/:id/revoke", async (c) =>
  selfJson(c, (userId) => selfRevokeApiKey(c.env, userId, c.req.param("id"))),
);
app.post("/self/api/api-keys/:id/roll", async (c) =>
  selfJson(c, (userId) => selfRollApiKey(c.env, userId, c.req.param("id"))),
);
app.get("/self/api/send-events", async (c) => selfJson(c, (userId) => selfSendEvents(c.env, userId)));

app.post("/send", async (c) => {
  const bearer = parseBearer(c.req.header("authorization"));
  if (bearer === null) {
    return c.json({ ok: false, error: "missing_api_key" }, 401);
  }

  const apiKey = await authenticateApiKey(c.env, bearer);
  if (!apiKey.ok) {
    return c.json({ ok: false, error: "invalid_api_key", reason: apiKey.reason }, 401);
  }

  let body: { raw?: unknown };
  try {
    body = (await c.req.json()) as { raw?: unknown };
  } catch {
    return c.json({ ok: false, error: "invalid_json" }, 400);
  }
  if (typeof body.raw !== "string" || body.raw.length === 0) {
    return c.json({ ok: false, error: "invalid_raw" }, 400);
  }

  const rawMimeBytes = decodeBase64(body.raw);
  if (rawMimeBytes === null) {
    return c.json({ ok: false, error: "invalid_raw_base64" }, 400);
  }
  if (rawMimeBytes.byteLength > maxRelayBodyBytes) {
    return c.json({ ok: false, error: "message_too_large" }, 413);
  }

  const mimeMessage = decodeUtf8(rawMimeBytes);
  if (mimeMessage === null) {
    return c.json({ ok: false, error: "mime_not_utf8_json_safe" }, 422);
  }

  const from = extractFirstEmailAddress(extractHeader(mimeMessage, "from"));
  const recipients = uniqueAddresses([
    ...extractEmailAddresses(extractHeader(mimeMessage, "to")),
    ...extractEmailAddresses(extractHeader(mimeMessage, "cc")),
    ...extractEmailAddresses(extractHeader(mimeMessage, "bcc")),
  ]);
  if (from === null) {
    return c.json({ ok: false, error: "missing_from_header" }, 400);
  }
  if (recipients.length === 0) {
    return c.json({ ok: false, error: "missing_recipients" }, 400);
  }
  if (recipients.length > 50) {
    return c.json({ ok: false, error: "too_many_recipients" }, 400);
  }
  const messageIdHeader = extractHeader(mimeMessage, "message-id");
  if (!senderAllowedForApiKey(from, apiKey.allowed_senders)) {
    await recordSendEvent(c.env, {
      traceId: crypto.randomUUID(),
      source: "http",
      userId: apiKey.user_id,
      apiKeyId: apiKey.api_key_id,
      envelopeFrom: from,
      recipients,
      mimeSizeBytes: rawMimeBytes.byteLength,
      messageIdHeader,
      status: "policy_rejected",
      errorCode: "sender_not_allowed",
    });
    return c.json({ ok: false, error: "sender_not_allowed" }, 403);
  }

  const rawMimeSha256 = await sha256Hex(rawMimeBytes);
  const requestHash = await computeHttpIdempotencyKey({
    envelopeFrom: from,
    recipients,
    messageIdHeader,
    mimeSha256: rawMimeSha256,
  });
  const suppliedIdempotencyKey = c.req.header("idempotency-key")?.trim();
  const idempotencyKey = suppliedIdempotencyKey && suppliedIdempotencyKey.length > 0 ? suppliedIdempotencyKey : requestHash;
  const idempotency = await beginIdempotentRequest(c.env, idempotencyKey, requestHash, "http");
  if (idempotency.status === "pending") {
    return c.json({ ok: false, error: "idempotency_pending" }, 409);
  }
  if (idempotency.status === "replay") {
    for (const [name, value] of Object.entries(idempotency.response.headers ?? {})) {
      c.header(name, value);
    }
    c.header("x-relay-idempotency-replay", "1");
    return c.json(idempotency.response.body, idempotency.response.status as 200 | 400 | 401 | 403 | 409 | 413 | 422 | 429 | 502);
  }

  const quota = await reserveSendQuota(c.env, { source: "http", envelopeFrom: from, apiKeyId: apiKey.api_key_id });
  if (!quota.ok) {
    const responseBody = { ok: false, error: "rate_limited", scope: quota.scope, limit: quota.limit };
    await Promise.all([
      recordSendEvent(c.env, {
        traceId: crypto.randomUUID(),
        source: "http",
        userId: apiKey.user_id,
        apiKeyId: apiKey.api_key_id,
        envelopeFrom: from,
        recipients,
        mimeSizeBytes: rawMimeBytes.byteLength,
        messageIdHeader,
        status: "rate_limited",
        errorCode: "rate_limited",
      }),
      completeIdempotentRequest(c.env, idempotencyKey, false, {
        ok: false,
        status: 429,
        body: responseBody,
      }),
    ]);
    return c.json(responseBody, 429);
  }

  const cfResponse = await fetch(sendRawUrl(c.env.CF_ACCOUNT_ID), {
    method: "POST",
    headers: {
      authorization: `Bearer ${c.env.CF_API_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from,
      recipients,
      mime_message: mimeMessage,
    }),
  });
  const cfResponseText = await cfResponse.text();
  const cfResponseParsed = parseJsonOrText(cfResponseText);
  const cfResult = parseCloudflareResult(cfResponseParsed);
  const allBounced =
    cfResponse.ok &&
    arrayLength(cfResult.bounced) > 0 &&
    arrayLength(cfResult.delivered) === 0 &&
    arrayLength(cfResult.queued) === 0;
  const deliveryOk = cfResponse.ok && !allBounced;
  const responseStatus = deliveryOk ? 200 : 502;
  const cfRequestId = cfResponse.headers.get("cf-request-id");
  const cfRayId = cfResponse.headers.get("cf-ray");
  const responseBody = {
    ok: deliveryOk,
    from,
    recipients,
    raw_mime_size_bytes: rawMimeBytes.byteLength,
    raw_mime_sha256: rawMimeSha256,
    idempotency_key: idempotencyKey,
    cf_status: cfResponse.status,
    cf_ray_id: cfRayId,
    cf_request_id: cfRequestId,
    cf_response: cfResponseParsed,
  };

  await Promise.all([
    recordSendEvent(c.env, {
      traceId: crypto.randomUUID(),
      source: "http",
      userId: apiKey.user_id,
      apiKeyId: apiKey.api_key_id,
      envelopeFrom: from,
      recipients,
      mimeSizeBytes: rawMimeBytes.byteLength,
      messageIdHeader,
      cfRequestId,
      cfRayId,
      cfDeliveredJson: cfResult.delivered === null ? null : JSON.stringify(cfResult.delivered),
      cfQueuedJson: cfResult.queued === null ? null : JSON.stringify(cfResult.queued),
      cfBouncedJson: cfResult.bounced === null ? null : JSON.stringify(cfResult.bounced),
      status: deliveryOk ? "accepted" : allBounced ? "all_bounced" : "cf_error",
      errorCode: deliveryOk ? undefined : allBounced ? "all_recipients_bounced" : "cloudflare_send_raw_rejected",
      cfErrorCode: cfResult.errorCode,
    }),
    completeIdempotentRequest(c.env, idempotencyKey, deliveryOk, {
      ok: deliveryOk,
      status: responseStatus,
      body: responseBody,
    }),
  ]);

  return c.json(responseBody, responseStatus);
});

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

async function adminJson(
  c: Context<{ Bindings: Env }>,
  load: () => Promise<unknown>,
  successStatus: 200 | 201 = 200,
) {
  setAdminCors(c);
  const admin = await requireAdmin(c.req.raw, c.env);
  if (!admin.ok) {
    return c.json({ ok: false, error: admin.error }, admin.status);
  }
  try {
    const result = await load();
    return c.json({ ok: true, result }, successStatus);
  } catch (error) {
    return c.json({ ok: false, error: error instanceof Error ? error.message : "admin_request_failed" }, 400);
  }
}

async function selfJson(
  c: Context<{ Bindings: Env }>,
  load: (userId: string) => Promise<unknown>,
  successStatus: 200 | 201 = 200,
) {
  setAdminCors(c);
  const session = await requireAuthenticated(c.req.raw, c.env);
  if (!session.ok) {
    return c.json({ ok: false, error: session.error }, session.status);
  }
  try {
    const result = await load(session.user.id);
    return c.json({ ok: true, result }, successStatus);
  } catch (error) {
    const message = error instanceof Error ? error.message : "self_request_failed";
    const status = message === "credential_not_found" || message === "api_key_not_found" ? 404 : 400;
    return c.json({ ok: false, error: message }, status);
  }
}

function setAdminCors(c: Context<{ Bindings: Env }>): void {
  const origin = c.req.header("origin");
  const allowedOrigin = c.env.ADMIN_CORS_ORIGIN;
  if (origin !== undefined && (allowedOrigin === "*" || origin === allowedOrigin)) {
    c.header("access-control-allow-origin", origin);
    c.header("access-control-allow-credentials", "true");
    c.header("vary", "Origin");
  }
  c.header("access-control-allow-methods", "GET,POST,OPTIONS");
  c.header("access-control-allow-headers", "content-type");
  c.header("access-control-max-age", "600");
}

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const parsed = (await request.json()) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("invalid_json");
  }
  return parsed as Record<string, unknown>;
}

function parseCloudflareResult(value: unknown): {
  delivered: unknown[] | null;
  queued: unknown[] | null;
  bounced: unknown[] | null;
  errorCode: string | null;
} {
  if (typeof value !== "object" || value === null) {
    return { delivered: null, queued: null, bounced: null, errorCode: null };
  }
  const object = value as { result?: unknown; errors?: unknown };
  const result = typeof object.result === "object" && object.result !== null ? (object.result as Record<string, unknown>) : {};
  const errors = Array.isArray(object.errors) ? object.errors : [];
  const firstError = errors.find((error): error is { code?: unknown } => typeof error === "object" && error !== null);
  return {
    delivered: Array.isArray(result.delivered) ? result.delivered : null,
    queued: Array.isArray(result.queued) ? result.queued : null,
    bounced: Array.isArray(result.permanent_bounces) ? result.permanent_bounces : null,
    errorCode: typeof firstError?.code === "string" || typeof firstError?.code === "number" ? String(firstError.code) : null,
  };
}

function arrayLength(value: unknown[] | null): number {
  return value?.length ?? 0;
}

function parseBearer(raw: string | undefined): string | null {
  const match = raw?.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  return token && token.length > 0 ? token : null;
}

function decodeBase64(raw: string): Uint8Array | null {
  const normalized = raw.replace(/\s+/g, "").replaceAll("-", "+").replaceAll("_", "/");
  if (normalized.length === 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    return null;
  }
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

function extractFirstEmailAddress(raw: string): string | null {
  return extractEmailAddresses(raw)[0] ?? null;
}

function extractEmailAddresses(raw: string): string[] {
  return [...raw.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)].map((match) => match[0].toLowerCase());
}

function uniqueAddresses(addresses: string[]): string[] {
  return [...new Set(addresses)];
}

export default app;
