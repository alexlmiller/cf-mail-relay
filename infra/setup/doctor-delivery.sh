#!/usr/bin/env bash
# doctor-delivery — guided DKIM/DMARC delivery check.
#
# Usage: doctor-delivery.sh --domain <name> [--to <test-recipient>]
#
# MS5: implement.
# Planned flow:
#   1. Accept --domain <name>; default to first verified domain.
#   2. Generate a unique subject token (e.g. "cf-mail-relay test 0e5f...").
#   3. Send a test message via the relay using a doctor-only credential.
#   4. Prompt the adopter to paste the received message's headers
#      (or forward the message to a sentinel address).
#   5. Parse headers; report DKIM=pass / DMARC=pass with the d= value seen.
#   6. Exit 0 on green; non-zero with explanation on red.

set -euo pipefail

echo "doctor:delivery — not implemented yet. See IMPLEMENTATION_PLAN.md § MS5."
exit 1
