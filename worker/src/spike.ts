import { Hono } from "hono";

export interface SpikeEnv {
  CF_ACCOUNT_ID: string;
  CF_API_TOKEN: string;
  MS0_SPIKE_TOKEN: string;
}

interface SendRawBody {
  from: string;
  recipients: string[];
  mime_message: string;
}

interface SpikeMetadata {
  from: string;
  recipients: string[];
  mime_size_bytes: number;
  mime_sha256: string;
  mime_round_trip_verified: boolean;
  cf_request_body_sha256: string;
  dry_run: boolean;
}

const app = new Hono<{ Bindings: SpikeEnv }>();

app.get("/spike/health", (c) => {
  return c.json({
    ok: true,
    purpose: "MS0 send_raw spike",
  });
});

app.post("/spike", async (c) => {
  const authError = authorizeSpike(c.req.header("authorization"), c.req.header("x-spike-token"), c.env.MS0_SPIKE_TOKEN);
  if (authError !== null) {
    return c.json({ ok: false, error: authError }, authError === "ms0_spike_token_not_configured" ? 500 : 401);
  }

  const from = parseSingleValue(c.req.header("x-spike-from") ?? c.req.query("from"));
  const recipients = parseRecipients(c.req.header("x-spike-recipients") ?? c.req.query("recipients"));
  if (from === null) {
    return c.json({ ok: false, error: "missing_from" }, 400);
  }
  if (recipients.length === 0) {
    return c.json({ ok: false, error: "missing_recipients" }, 400);
  }

  const mimeBytes = new Uint8Array(await c.req.arrayBuffer());
  if (mimeBytes.byteLength === 0) {
    return c.json({ ok: false, error: "empty_mime" }, 400);
  }

  const decoded = decodeMimeMessage(mimeBytes);
  if (!decoded.ok) {
    return c.json(
      {
        ok: false,
        error: "mime_not_utf8_json_safe",
        detail: "send_raw accepts mime_message as a JSON string. MS0 rejects MIME bytes that cannot round-trip through UTF-8.",
      },
      422,
    );
  }

  const body = buildSendRawBody(from, recipients, decoded.mimeMessage);
  const bodyText = JSON.stringify(body);
  const [mimeSha256, requestSha256] = await Promise.all([
    sha256Hex(mimeBytes),
    sha256Hex(new TextEncoder().encode(bodyText)),
  ]);

  const metadata: SpikeMetadata = {
    from,
    recipients,
    mime_size_bytes: mimeBytes.byteLength,
    mime_sha256: mimeSha256,
    mime_round_trip_verified: true,
    cf_request_body_sha256: requestSha256,
    dry_run: isDryRun(c.req.header("x-spike-dry-run"), c.req.query("dry_run")),
  };

  if (metadata.dry_run) {
    return c.json({
      ok: true,
      ...metadata,
      cf_status: null,
      cf_response: null,
    });
  }

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
      ...metadata,
      cf_status: cfResponse.status,
      cf_ray_id: cfResponse.headers.get("cf-ray"),
      cf_request_id: cfResponse.headers.get("cf-request-id"),
      cf_response: parseJsonOrText(cfResponseText),
    },
    responseStatus,
  );
});

export function authorizeSpike(authorization: string | undefined, tokenHeader: string | undefined, configuredToken: string | undefined): string | null {
  if (configuredToken === undefined || configuredToken.length === 0) {
    return "ms0_spike_token_not_configured";
  }

  const bearerPrefix = "Bearer ";
  const bearerToken = authorization?.startsWith(bearerPrefix) === true ? authorization.slice(bearerPrefix.length) : undefined;
  if (tokenHeader === configuredToken || bearerToken === configuredToken) {
    return null;
  }

  return "unauthorized";
}

export function buildSendRawBody(from: string, recipients: string[], mimeMessage: string): SendRawBody {
  return {
    from,
    recipients,
    mime_message: mimeMessage,
  };
}

export function decodeMimeMessage(mimeBytes: Uint8Array): { ok: true; mimeMessage: string } | { ok: false } {
  try {
    const mimeMessage = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(mimeBytes);
    const roundTrip = new TextEncoder().encode(mimeMessage);
    if (!byteArraysEqual(mimeBytes, roundTrip)) {
      return { ok: false };
    }
    return { ok: true, mimeMessage };
  } catch {
    return { ok: false };
  }
}

export function parseRecipients(raw: string | undefined): string[] {
  if (raw === undefined) {
    return [];
  }

  return raw
    .split(",")
    .map((recipient) => recipient.trim())
    .filter((recipient) => recipient.length > 0)
    .slice(0, 50);
}

function parseSingleValue(raw: string | undefined): string | null {
  const value = raw?.trim();
  return value === undefined || value.length === 0 ? null : value;
}

function isDryRun(headerValue: string | undefined, queryValue: string | undefined): boolean {
  return headerValue === "1" || headerValue === "true" || queryValue === "1" || queryValue === "true";
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
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

function byteArraysEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

export default app;
