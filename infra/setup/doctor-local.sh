#!/usr/bin/env bash
# doctor-local — fully automated install validation.
#
# MS5: implement the real checks.
# Planned checks:
#   - DNS: smtp.<RELAY_DOMAIN> resolves to the configured host
#   - TLS: STARTTLS handshake on 587 returns a valid cert covering smtp.<RELAY_DOMAIN>
#   - SMTP AUTH: bootstrap credential authenticates
#   - Worker: GET /healthz returns 200 with matching git_sha
#   - D1: a synthetic send_events row appears within 10s of an AUTH + DATA cycle
#
# Exit non-zero on first failure with a clear message.

set -euo pipefail

echo "doctor:local — not implemented yet. See IMPLEMENTATION_PLAN.md § MS5."
exit 1
