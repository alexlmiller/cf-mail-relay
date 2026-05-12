#!/usr/bin/env bash
set -euo pipefail

worker_url="${CF_MAIL_RELAY_WORKER_URL:?set CF_MAIL_RELAY_WORKER_URL to your relay admin host, for example https://mail.example.com}"
api_key="${CF_MAIL_RELAY_API_KEY:?set CF_MAIL_RELAY_API_KEY}"
from="${CF_MAIL_RELAY_FROM:?set CF_MAIL_RELAY_FROM}"
to="${CF_MAIL_RELAY_TO:?set CF_MAIL_RELAY_TO}"
subject="${CF_MAIL_RELAY_SUBJECT:-Test from cf-mail-relay HTTP API}"
body="${CF_MAIL_RELAY_BODY:-hello from cf-mail-relay}"
idempotency_key="${CF_MAIL_RELAY_IDEMPOTENCY_KEY:-$(uuidgen 2>/dev/null || date +%s)}"

mime="$(printf 'From: %s\r\nTo: %s\r\nSubject: %s\r\n\r\n%s\r\n' "$from" "$to" "$subject" "$body")"
raw="$(printf '%s' "$mime" | base64 | tr -d '\n')"

curl -fsSL "$worker_url/send" \
  -H "Authorization: Bearer $api_key" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $idempotency_key" \
  -d "{\"from\":\"$from\",\"recipients\":[\"$to\"],\"raw\":\"$raw\"}"
