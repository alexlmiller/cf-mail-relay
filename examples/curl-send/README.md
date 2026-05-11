# curl-send

Stub. MS4 ships a working `send.sh` against the HTTP `/send` API.

Skeleton:

```sh
#!/usr/bin/env bash
set -euo pipefail

WORKER_URL="https://mail-api.example.com"
API_KEY="${CF_MAIL_RELAY_API_KEY:?set CF_MAIL_RELAY_API_KEY}"

# Build a tiny MIME message and base64-encode it.
RAW=$(printf 'From: alex@example.com\r\nTo: dest@example.org\r\nSubject: hi\r\n\r\nhello\r\n' | base64)

curl -fsSL "$WORKER_URL/send" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d "{\"raw\": \"$RAW\"}"
```
