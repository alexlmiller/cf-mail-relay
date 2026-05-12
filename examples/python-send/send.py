#!/usr/bin/env python3
import base64
import json
import os
import sys
import urllib.error
import urllib.request
import uuid


def required_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"missing {name}")
    return value


worker_url = required_env("CF_MAIL_RELAY_WORKER_URL").rstrip("/")
api_key = required_env("CF_MAIL_RELAY_API_KEY")
from_addr = required_env("CF_MAIL_RELAY_FROM")
to_addr = required_env("CF_MAIL_RELAY_TO")
subject = os.environ.get("CF_MAIL_RELAY_SUBJECT", "Test from cf-mail-relay HTTP API")
body = os.environ.get("CF_MAIL_RELAY_BODY", "hello from cf-mail-relay")
idempotency_key = os.environ.get("CF_MAIL_RELAY_IDEMPOTENCY_KEY", str(uuid.uuid4()))

mime = f"From: {from_addr}\r\nTo: {to_addr}\r\nSubject: {subject}\r\n\r\n{body}\r\n"
payload = json.dumps({
    "from": from_addr,
    "recipients": [to_addr],
    "raw": base64.b64encode(mime.encode("utf-8")).decode("ascii"),
}).encode("utf-8")
request = urllib.request.Request(
    f"{worker_url}/send",
    data=payload,
    method="POST",
    headers={
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "Idempotency-Key": idempotency_key,
    },
)

try:
    with urllib.request.urlopen(request, timeout=30) as response:
        print(response.read().decode("utf-8"))
except urllib.error.HTTPError as exc:
    sys.stderr.write(exc.read().decode("utf-8") + "\n")
    sys.exit(1)
