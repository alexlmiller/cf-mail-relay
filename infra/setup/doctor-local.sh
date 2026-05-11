#!/usr/bin/env bash
# doctor-local — automated install validation for the relay host + Worker.

set -euo pipefail

domain="${CF_MAIL_RELAY_DOMAIN:-${RELAY_DOMAIN:-}}"
smtp_host="${CF_MAIL_RELAY_SMTP_HOST:-}"
smtp_port="${CF_MAIL_RELAY_SMTP_PORT:-587}"
worker_url="${CF_MAIL_RELAY_WORKER_URL:-${RELAY_WORKER_URL:-}}"
smtp_username="${CF_MAIL_RELAY_SMTP_USERNAME:-${RELAY_SMTP_USERNAME:-}}"
smtp_password="${CF_MAIL_RELAY_SMTP_PASSWORD:-${RELAY_SMTP_PASSWORD:-}}"
from_addr="${CF_MAIL_RELAY_FROM:-}"
to_addr="${CF_MAIL_RELAY_TO:-}"
d1_database="${CF_MAIL_RELAY_D1_DATABASE:-cf-mail-relay}"

usage() {
  cat <<'USAGE'
Usage: pnpm doctor:local -- --domain <domain> --worker-url <url> [options]

Options:
  --domain <domain>         Sending domain; defaults CF_MAIL_RELAY_DOMAIN/RELAY_DOMAIN.
  --smtp-host <host>        SMTP host; defaults smtp.<domain>.
  --smtp-port <port>        SMTP port; defaults 587.
  --worker-url <url>        Worker base URL; defaults CF_MAIL_RELAY_WORKER_URL/RELAY_WORKER_URL.
  --smtp-username <name>    SMTP credential username.
  --smtp-password <secret>  SMTP credential password.
  --from <addr>             Optional sender for a synthetic SMTP message.
  --to <addr>               Optional recipient for a synthetic SMTP message.
  --d1-database <name>      D1 database name for optional event visibility check.

The synthetic send and D1 visibility checks run only when --from, --to, and
SMTP credentials are provided. D1 visibility also requires wrangler auth.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --) shift ;;
    --domain) domain="$2"; shift 2 ;;
    --smtp-host) smtp_host="$2"; shift 2 ;;
    --smtp-port) smtp_port="$2"; shift 2 ;;
    --worker-url) worker_url="$2"; shift 2 ;;
    --smtp-username) smtp_username="$2"; shift 2 ;;
    --smtp-password) smtp_password="$2"; shift 2 ;;
    --from) from_addr="$2"; shift 2 ;;
    --to) to_addr="$2"; shift 2 ;;
    --d1-database) d1_database="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ -z "$domain" ]]; then
  echo "doctor:local: missing --domain" >&2
  exit 2
fi
if [[ -z "$worker_url" ]]; then
  echo "doctor:local: missing --worker-url" >&2
  exit 2
fi
if [[ -z "$smtp_host" ]]; then
  smtp_host="smtp.$domain"
fi

pass() { printf 'ok - %s\n' "$1"; }
fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }

command -v python3 >/dev/null || fail "python3 is required"
command -v curl >/dev/null || fail "curl is required"

if command -v dig >/dev/null; then
  dns_result="$(dig +short "$smtp_host" A "$smtp_host" AAAA | tr '\n' ' ')"
  [[ -n "$dns_result" ]] || fail "$smtp_host has no A/AAAA records"
  pass "$smtp_host resolves"
else
  python3 - "$smtp_host" <<'PY' || exit 1
import socket, sys
socket.getaddrinfo(sys.argv[1], None)
PY
  pass "$smtp_host resolves"
fi

health="$(curl -fsS "$worker_url/healthz")" || fail "Worker /healthz failed"
python3 - "$health" <<'PY' || fail "Worker /healthz did not return ok=true"
import json, sys
payload = json.loads(sys.argv[1])
if payload.get("ok") is not True:
    raise SystemExit(payload)
PY
pass "Worker /healthz is healthy"

python3 - "$smtp_host" "$smtp_port" "$smtp_username" "$smtp_password" "$from_addr" "$to_addr" <<'PY' || fail "SMTP STARTTLS/AUTH check failed"
import smtplib
import ssl
import sys
from email.message import EmailMessage

host = sys.argv[1]
port = int(sys.argv[2])
username = sys.argv[3]
password = sys.argv[4]
from_addr = sys.argv[5]
to_addr = sys.argv[6]
context = ssl.create_default_context()
with smtplib.SMTP(host, port, timeout=20) as smtp:
    smtp.ehlo()
    smtp.starttls(context=context)
    smtp.ehlo()
    if username and password:
        smtp.login(username, password)
    if username and password and from_addr and to_addr:
        message = EmailMessage()
        message["From"] = from_addr
        message["To"] = to_addr
        message["Subject"] = "cf-mail-relay doctor local"
        message.set_content("cf-mail-relay doctor local\n")
        smtp.send_message(message)
PY
if [[ -n "$smtp_username" && -n "$smtp_password" ]]; then
  pass "SMTP STARTTLS/AUTH path works"
else
  pass "SMTP STARTTLS path works"
fi

if [[ -n "$from_addr" && -n "$to_addr" && -n "$smtp_username" && -n "$smtp_password" ]] && command -v pnpm >/dev/null; then
  if pnpm --dir worker exec wrangler d1 execute "$d1_database" --remote --command \
    "SELECT id, status, envelope_from, ts FROM send_events WHERE envelope_from = '$from_addr' ORDER BY ts DESC LIMIT 1;" >/tmp/cf-mail-relay-doctor-d1.json 2>/tmp/cf-mail-relay-doctor-d1.err; then
    pass "D1 send_events is reachable through wrangler"
  else
    echo "warn - skipped D1 event visibility check; wrangler failed:" >&2
    sed 's/^/warn - /' /tmp/cf-mail-relay-doctor-d1.err >&2 || true
  fi
fi

pass "doctor:local complete"
