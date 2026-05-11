# HTTP `/send` API

MS4 exposes a small raw-MIME HTTP API for automation clients. It does not build
messages from structured JSON; callers supply a complete RFC 5322 MIME message.

```http
POST https://<worker-host>/send
Authorization: Bearer <api_key_secret>
Content-Type: application/json
Idempotency-Key: <optional stable key>

{
  "raw": "<base64-encoded RFC 5322 MIME message>"
}
```

The Worker derives `from` from the `From` header and recipients from `To`, `Cc`,
and `Bcc`. The sender must match the API key user's allowlisted senders. The
MIME bytes must be UTF-8 safe because Cloudflare Email Sending accepts
`mime_message` as a JSON string.

If `Idempotency-Key` is omitted, the Worker computes one from:

```text
source=http
envelope_from
sorted recipients
Message-ID header
raw MIME SHA-256
```

Success:

```json
{
  "ok": true,
  "from": "gmail@example.com",
  "recipients": ["dest@example.org"],
  "raw_mime_size_bytes": 92,
  "raw_mime_sha256": "...",
  "idempotency_key": "...",
  "cf_status": 200,
  "cf_ray_id": "...",
  "cf_request_id": "...",
  "cf_response": {}
}
```

Common failures:

| Status | Error |
|---|---|
| 400 | `invalid_json`, `invalid_raw`, `invalid_raw_base64`, `missing_from_header`, `missing_recipients`, `too_many_recipients` |
| 401 | `missing_api_key`, `invalid_api_key` |
| 403 | `sender_not_allowed` |
| 409 | `idempotency_pending` |
| 413 | `message_too_large` |
| 422 | `mime_not_utf8_json_safe` |
| 502 | Cloudflare Email Sending rejected the message or all recipients bounced |

See `examples/curl-send/`, `examples/node-send/`, and
`examples/python-send/` for minimal clients.
