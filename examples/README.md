# HTTP API examples

All examples use the same environment:

```sh
export CF_MAIL_RELAY_WORKER_URL="https://mail.example.com"
export CF_MAIL_RELAY_API_KEY="<secret shown once in the UI>"
export CF_MAIL_RELAY_FROM="sender@example.com"
export CF_MAIL_RELAY_TO="dest@example.org"
```

Run one client:

```sh
./examples/curl-send/send.sh
node examples/node-send/index.mjs
python3 examples/python-send/send.py
```

All three clients also accept `CF_MAIL_RELAY_SUBJECT`, `CF_MAIL_RELAY_BODY`,
and `CF_MAIL_RELAY_IDEMPOTENCY_KEY`.
