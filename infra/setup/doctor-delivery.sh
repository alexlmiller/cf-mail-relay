#!/usr/bin/env bash
# doctor-delivery — guided DKIM/DMARC delivery check.

set -euo pipefail

domain="${CF_MAIL_RELAY_DOMAIN:-${RELAY_DOMAIN:-}}"
to_addr="${CF_MAIL_RELAY_TO:-}"

usage() {
  cat <<'USAGE'
Usage: pnpm doctor:delivery -- --domain <domain> [--to <recipient>]

The script prints a unique subject token. Send a message through Gmail "Send
mail as" or the relay using that subject, then paste the received message
headers into stdin and press Ctrl-D. It exits 0 only when DKIM and DMARC pass.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) domain="$2"; shift 2 ;;
    --to) to_addr="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ -z "$domain" ]]; then
  echo "doctor:delivery: missing --domain" >&2
  exit 2
fi

token="cf-mail-relay delivery $(date -u +%Y%m%dT%H%M%SZ)-$RANDOM"
echo "Send a test message with this exact subject:"
echo
echo "  $token"
echo
if [[ -n "$to_addr" ]]; then
  echo "Suggested recipient: $to_addr"
  echo
fi
echo "After it arrives, paste the full received headers below, then press Ctrl-D:"

headers="$(cat)"
python3 - "$domain" "$headers" <<'PY'
import re
import sys

domain = sys.argv[1].lower()
headers = sys.argv[2]
auth_results = "\n".join(line for line in headers.splitlines() if "authentication-results:" in line.lower() or line[:1].isspace())
dkim_pass = bool(re.search(r"\bdkim=pass\b", auth_results, re.I))
dmarc_pass = bool(re.search(r"\bdmarc=pass\b", auth_results, re.I))
aligned_from = bool(re.search(r"header\.from=" + re.escape(domain), auth_results, re.I))
dkim_domain = re.search(r"header\.i=@([^;\s]+)", auth_results, re.I)

print(f"DKIM pass: {'yes' if dkim_pass else 'no'}")
if dkim_domain:
    print(f"DKIM identity: @{dkim_domain.group(1)}")
print(f"DMARC pass: {'yes' if dmarc_pass else 'no'}")
print(f"Header From aligned to {domain}: {'yes' if aligned_from else 'no'}")

if not (dkim_pass and dmarc_pass and aligned_from):
    raise SystemExit(1)
PY

echo "ok - doctor:delivery complete"
