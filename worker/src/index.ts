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
  bumpPolicyVersionAction,
  deleteSender,
  flushKvCaches,
  revokeApiKey,
  revokeSmtpCredential,
  rollApiKey,
  rollSmtpCredential,
  updateApiKey,
  updateDomain,
  updateSender,
  updateSmtpCredential,
  updateUser,
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
  collectSignedHeaders,
  normalizeBodySha256,
  parseRelayHmacHeaders,
  parseSignedHeaderNames,
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
  extractHeaders,
  policyVersionFromD1,
  recordBootstrapFailure,
  recordSendEvent,
  reserveSendQuota,
  senderAllowedForApiKey,
  senderAllowedForCredential,
  schemaVersionFromD1,
} from "./state";

export interface Env {
  D1_MAIN: D1Database;
  KV_HOT: KVNamespace;
  ASSETS: Fetcher;
  CF_API_TOKEN: string;
  CF_ACCOUNT_ID: string;
  CREDENTIAL_PEPPER: string;
  METADATA_PEPPER: string;
  RELAY_HMAC_SECRET_CURRENT: string;
  RELAY_HMAC_SECRET_PREVIOUS?: string;
  RELAY_HMAC_KEY_ID?: string;
  BOOTSTRAP_SETUP_TOKEN?: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUDIENCE: string;
  ACCESS_JWKS_JSON?: string;
  ADMIN_CORS_ORIGIN?: string;
  REQUIRED_D1_SCHEMA_VERSION: string;
}

const app = new Hono<{ Bindings: Env }>();
const workerVersion = "0.1.0-ms7";
const gitSha = "ms7";
const requiredSchemaVersionDefault = "3";
const maxRelayBodyBytes = 6 * 1024 * 1024;

app.get("/healthz", async (c) => {
  const requiredSchemaVersion = c.env.REQUIRED_D1_SCHEMA_VERSION || requiredSchemaVersionDefault;
  const actualSchemaVersion = await schemaVersionFromD1(c.env);
  if (actualSchemaVersion !== requiredSchemaVersion) {
    return c.json(
      {
        ok: false,
        version: workerVersion,
        git_sha: gitSha,
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
    git_sha: gitSha,
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
    if (result.status === 401) {
      await recordBootstrapFailure(c.env, c.req.header("cf-connecting-ip") ?? undefined, result.error);
    }
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

  const from = normalizeEmail(c.req.header("x-relay-envelope-from") ?? "");
  const recipients = uniqueAddresses(parseRecipients(c.req.header("x-relay-recipients")).map(normalizeEmail).filter((recipient) => recipient.length > 0));
  if (from.length === 0) {
    return c.json({ ok: false, error: "missing_envelope_from" }, 400);
  }
  if (!isValidMailbox(from)) {
    return c.json({ ok: false, error: "invalid_envelope_from" }, 400);
  }
  if (recipients.length === 0) {
    return c.json({ ok: false, error: "missing_recipients" }, 400);
  }
  if (!recipients.every(isValidMailbox)) {
    return c.json({ ok: false, error: "invalid_recipients" }, 400);
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
  const headerValidation = validateSingletonHeaders(decoded);
  if (!headerValidation.ok) {
    return c.json({ ok: false, error: headerValidation.error }, 400);
  }
  const mimeFrom = extractSingleEmailAddress(headerValidation.from);
  if (!mimeFrom.ok) {
    return c.json({ ok: false, error: mimeFrom.error }, 400);
  }
  if (normalizeEmail(from) !== mimeFrom.address) {
    return c.json({ ok: false, error: "from_header_mismatch" }, 403);
  }
  const senderHeader = extractHeader(decoded, "sender");
  if (senderHeader.length > 0 && !allAddressesAllowed(senderHeader, senderPolicy.allowedSenders)) {
    return c.json({ ok: false, error: "sender_header_not_allowed" }, 403);
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
  const requestHash = idempotencyKey;
  const idempotency = await beginIdempotentRequest(c.env, idempotencyKey, requestHash, "smtp");
  if (idempotency.status === "pending") {
    return c.json({ ok: false, error: "idempotency_pending" }, 409);
  }
  if (idempotency.status === "conflict") {
    return c.json({ ok: false, error: "idempotency_key_conflict" }, 409);
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
      completeIdempotentRequest(c.env, idempotencyKey, requestHash, "smtp", false, {
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
    completeIdempotentRequest(c.env, idempotencyKey, requestHash, "smtp", deliveryOk, {
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

app.get("/admin/api/login", async (c) => {
  const admin = await requireAdmin(c.req.raw, c.env);
  if (!admin.ok) {
    return c.json({ ok: false, error: admin.error }, admin.status);
  }
  return c.redirect(safeReturnPath(c.req.query("return_to")));
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

// PATCH / DELETE — sparse updates and hard deletes for senders. All bump policy_version.
app.patch("/admin/api/users/:id", async (c) =>
  adminJson(c, async () => updateUser(c.env, c.req.param("id"), await readJsonObject(c.req.raw))),
);
app.patch("/admin/api/domains/:id", async (c) =>
  adminJson(c, async () => updateDomain(c.env, c.req.param("id"), await readJsonObject(c.req.raw))),
);
app.patch("/admin/api/senders/:id", async (c) =>
  adminJson(c, async () => updateSender(c.env, c.req.param("id"), await readJsonObject(c.req.raw))),
);
app.delete("/admin/api/senders/:id", async (c) =>
  adminJson(c, async () => deleteSender(c.env, c.req.param("id"))),
);
app.patch("/admin/api/smtp-credentials/:id", async (c) =>
  adminJson(c, async () => updateSmtpCredential(c.env, c.req.param("id"), await readJsonObject(c.req.raw))),
);
app.patch("/admin/api/api-keys/:id", async (c) =>
  adminJson(c, async () => updateApiKey(c.env, c.req.param("id"), await readJsonObject(c.req.raw))),
);

// Ops actions: manual policy_version bump + bulk KV cache flush.
app.post("/admin/api/ops/bump-policy-version", async (c) =>
  adminJson(c, () => bumpPolicyVersionAction(c.env)),
);
app.post("/admin/api/ops/flush-caches", async (c) =>
  adminJson(c, () => flushKvCaches(c.env)),
);

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

app.get("/self/api/login", async (c) => {
  const session = await requireAuthenticated(c.req.raw, c.env);
  if (!session.ok) return c.json({ ok: false, error: session.error }, session.status);
  return c.redirect(safeReturnPath(c.req.query("return_to")));
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

  let body: { from?: unknown; recipients?: unknown; raw?: unknown };
  try {
    body = (await c.req.json()) as { from?: unknown; recipients?: unknown; raw?: unknown };
  } catch {
    return c.json({ ok: false, error: "invalid_json" }, 400);
  }
  if (typeof body.from !== "string" || body.from.trim().length === 0) {
    return c.json({ ok: false, error: "missing_from" }, 400);
  }
  if (!Array.isArray(body.recipients) || !body.recipients.every((recipient) => typeof recipient === "string")) {
    return c.json({ ok: false, error: "invalid_recipients" }, 400);
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

  const decodedMimeMessage = decodeUtf8(rawMimeBytes);
  if (decodedMimeMessage === null) {
    return c.json({ ok: false, error: "mime_not_utf8_json_safe" }, 422);
  }

  const from = normalizeEmail(body.from);
  const recipients = uniqueAddresses(body.recipients.map((recipient) => normalizeEmail(recipient)).filter((recipient) => recipient.length > 0));
  if (!isValidMailbox(from)) {
    return c.json({ ok: false, error: "invalid_from" }, 400);
  }
  if (!recipients.every(isValidMailbox)) {
    return c.json({ ok: false, error: "invalid_recipients" }, 400);
  }
  const headerValidation = validateSingletonHeaders(decodedMimeMessage);
  if (!headerValidation.ok) {
    return c.json({ ok: false, error: headerValidation.error }, 400);
  }
  const mimeFrom = extractSingleEmailAddress(headerValidation.from);
  if (!mimeFrom.ok) {
    return c.json({ ok: false, error: mimeFrom.error }, 400);
  }
  if (recipients.length === 0) {
    return c.json({ ok: false, error: "missing_recipients" }, 400);
  }
  if (recipients.length > 50) {
    return c.json({ ok: false, error: "too_many_recipients" }, 400);
  }
  if (mimeFrom.address !== from) {
    return c.json({ ok: false, error: "from_header_mismatch" }, 403);
  }
  const senderHeader = extractHeader(decodedMimeMessage, "sender");
  if (senderHeader.length > 0 && !allAddressesAllowed(senderHeader, apiKey.allowed_senders)) {
    return c.json({ ok: false, error: "sender_header_not_allowed" }, 403);
  }
  const mimeMessage = stripCaptureHopHeaders(decodedMimeMessage);
  const mimeMessageBytes = new TextEncoder().encode(mimeMessage);
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
  const strippedMimeSha256 = await sha256Hex(mimeMessageBytes);
  const requestHash = await computeHttpIdempotencyKey({
    envelopeFrom: from,
    recipients,
    messageIdHeader,
    mimeSha256: strippedMimeSha256,
  });
  const suppliedIdempotencyKey = c.req.header("idempotency-key")?.trim();
  const idempotencyKey = suppliedIdempotencyKey && suppliedIdempotencyKey.length > 0 ? `http:${apiKey.api_key_id}:${suppliedIdempotencyKey}` : requestHash;
  const idempotency = await beginIdempotentRequest(c.env, idempotencyKey, requestHash, "http");
  if (idempotency.status === "pending") {
    return c.json({ ok: false, error: "idempotency_pending" }, 409);
  }
  if (idempotency.status === "conflict") {
    return c.json({ ok: false, error: "idempotency_key_conflict" }, 409);
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
      completeIdempotentRequest(c.env, idempotencyKey, requestHash, "http", false, {
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
    stripped_mime_size_bytes: mimeMessageBytes.byteLength,
    raw_mime_sha256: rawMimeSha256,
    stripped_mime_sha256: strippedMimeSha256,
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
    completeIdempotentRequest(c.env, idempotencyKey, requestHash, "http", deliveryOk, {
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
  return stripMimeHeaders(mimeMessage, ["received", "x-received", "x-gm-message-state", "bcc"]);
}

function stripMimeHeaders(mimeMessage: string, names: string[]): string {
  const normalized = mimeMessage.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const headerEnd = normalized.indexOf("\n\n");
  if (headerEnd === -1) {
    return mimeMessage;
  }
  const blocked = new Set(names.map((name) => name.toLowerCase()));

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
    return !blocked.has(name);
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
  const signedHeaderNames = parseSignedHeaderNames(headers.signedHeaders);
  if (signedHeaderNames.length === 0) {
    return { ok: false, status: 401, error: "missing_signed_headers" };
  }
  const requiredSignedHeaders = requiredRelaySignedHeaders(new URL(request.url).pathname);
  if (!requiredSignedHeaders.every((name) => signedHeaderNames.includes(name))) {
    return { ok: false, status: 401, error: "missing_required_signed_header" };
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
    signedHeaders: collectSignedHeaders(request.headers, signedHeaderNames),
  };
  const current = await signRelayRequest(input, env.RELAY_HMAC_SECRET_CURRENT);
  const previous =
    env.RELAY_HMAC_SECRET_PREVIOUS !== undefined && env.RELAY_HMAC_SECRET_PREVIOUS.length > 0
      ? await signRelayRequest(input, env.RELAY_HMAC_SECRET_PREVIOUS)
      : null;
  if (!timingSafeEqualString(headers.signature, current) && (previous === null || !timingSafeEqualString(headers.signature, previous))) {
    return { ok: false, status: 401, error: "invalid_signature" };
  }

  const nonceInserted = await reserveRelayNonce(env, headers.keyId, headers.nonce);
  if (!nonceInserted) {
    return { ok: false, status: 401, error: "replay_nonce" };
  }

  return { ok: true };
}

async function reserveRelayNonce(env: Env, keyId: string, nonce: string): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const result = await env.D1_MAIN.prepare("INSERT OR IGNORE INTO relay_nonces (key_id, nonce, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(keyId, nonce, now, now + 120)
    .run();
  return result.meta.changes > 0;
}

async function cleanupExpiredRows(env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.D1_MAIN.batch([
    env.D1_MAIN.prepare("DELETE FROM relay_nonces WHERE expires_at < ?").bind(now),
    env.D1_MAIN.prepare("DELETE FROM idempotency_keys WHERE expires_at < ?").bind(now),
  ]);
}

function requiredRelaySignedHeaders(path: string): string[] {
  if (path === "/relay/send") {
    return ["x-relay-credential-id", "x-relay-envelope-from", "x-relay-recipients", "x-relay-version"];
  }
  return ["x-relay-version"];
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
  return /^0\.1\.0-ms(?:[7-9]|\d{2,})$/.test(version);
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
  const csrf = rejectUnsafeCrossOrigin(c);
  if (csrf !== null) return csrf;
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
  const csrf = rejectUnsafeCrossOrigin(c);
  if (csrf !== null) return csrf;
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
  if (origin !== undefined && allowedOrigin !== "*" && origin === trustedAdminOrigin(c)) {
    c.header("access-control-allow-origin", origin);
    c.header("access-control-allow-credentials", "true");
    c.header("vary", "Origin");
  }
  c.header("access-control-allow-methods", "GET,POST,PATCH,DELETE,OPTIONS");
  c.header("access-control-allow-headers", "content-type");
  c.header("access-control-max-age", "600");
}

function rejectUnsafeCrossOrigin(c: Context<{ Bindings: Env }>): Response | null {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method.toUpperCase())) {
    return null;
  }
  if (c.env.ADMIN_CORS_ORIGIN === "*") {
    return c.json({ ok: false, error: "invalid_admin_cors_origin" }, 403);
  }
  const origin = c.req.header("origin");
  if (origin === undefined && c.req.header("sec-fetch-site") === undefined && c.req.header("sec-fetch-mode") === undefined) {
    return null;
  }
  if (origin !== trustedAdminOrigin(c)) {
    return c.json({ ok: false, error: "csrf_origin_denied" }, 403);
  }
  return null;
}

function trustedAdminOrigin(c: Context<{ Bindings: Env }>): string {
  const configured = c.env.ADMIN_CORS_ORIGIN;
  if (configured !== undefined && configured.length > 0 && configured !== "*") {
    return configured.replace(/\/$/, "");
  }
  return new URL(c.req.url).origin;
}

function safeReturnPath(raw: string | undefined): string {
  if (raw === undefined || raw.length === 0) return "/";
  try {
    const decoded = decodeURIComponent(raw);
    if (!decoded.startsWith("/") || decoded.startsWith("//")) return "/";
    return decoded;
  } catch {
    return "/";
  }
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

function validateSingletonHeaders(mimeMessage: string): { ok: true; from: string } | { ok: false; error: string } {
  const fromHeaders = extractHeaders(mimeMessage, "from");
  if (fromHeaders.length === 0) {
    return { ok: false, error: "missing_from_header" };
  }
  if (fromHeaders.length > 1) {
    return { ok: false, error: "duplicate_from_header" };
  }
  if (extractHeaders(mimeMessage, "sender").length > 1) {
    return { ok: false, error: "duplicate_sender_header" };
  }
  if (extractHeaders(mimeMessage, "message-id").length > 1) {
    return { ok: false, error: "duplicate_message_id_header" };
  }
  return { ok: true, from: fromHeaders[0]! };
}

function extractSingleEmailAddress(raw: string): { ok: true; address: string } | { ok: false; error: "missing_from_header" | "multiple_from_addresses" } {
  const addresses = extractEmailAddresses(raw);
  if (addresses.length === 0) {
    return { ok: false, error: "missing_from_header" };
  }
  if (addresses.length > 1) {
    return { ok: false, error: "multiple_from_addresses" };
  }
  return { ok: true, address: addresses[0]! };
}

function extractEmailAddresses(raw: string): string[] {
  const withoutQuotedStrings = raw.replace(/"([^"\\]|\\.)*"/g, "");
  return [...withoutQuotedStrings.matchAll(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)].map((match) => match[0].toLowerCase());
}

function allAddressesAllowed(raw: string, allowedSenders: string[]): boolean {
  const addresses = extractEmailAddresses(raw);
  return addresses.length > 0 && addresses.every((address) => senderAllowedForApiKey(address, allowedSenders));
}

function isValidMailbox(value: string): boolean {
  if (value.length > 254) {
    return false;
  }
  const at = value.lastIndexOf("@");
  if (at <= 0 || at === value.length - 1 || at > 64) {
    return false;
  }
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) || local.includes("..")) {
    return false;
  }
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(domain)) {
    return false;
  }
  return true;
}

function uniqueAddresses(addresses: string[]): string[] {
  return [...new Set(addresses)];
}

export async function scheduled(_controller: unknown, env: Env): Promise<void> {
  await cleanupExpiredRows(env);
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase().replace(/^<|>$/g, "").trim();
}

// Catch-all: anything the API routes above didn't match (asset paths, SPA
// deep links, `/` itself) goes to the Workers Static Assets binding which
// serves the matched file or falls back to /index.html per the
// `not_found_handling = "single-page-application"` setting in wrangler.toml.
app.all("*", async (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

(app as typeof app & { scheduled: typeof scheduled }).scheduled = scheduled;

export default app;
