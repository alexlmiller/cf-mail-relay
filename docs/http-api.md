# HTTP `/send` API

> Stub. Lands in MS4. MVP supports raw MIME only; structured JSON assembly is roadmap.

```http
POST https://<worker-host>/send
Authorization: Bearer <api_key>
Content-Type: application/json
Idempotency-Key: <optional; sha256 of normalized request input if absent>

{
  "raw": "<base64-encoded RFC 5322 MIME message>"
}
```

Success:

```json
{
  "accepted": true,
  "message_id": "<...>",
  "cf_request_id": "<...>"
}
```

Failure mappings follow the SMTP-code table; see `shared/src/smtp-error-map.ts`.

See `examples/curl-send/` and `examples/node-send/` for working clients (MS4).
