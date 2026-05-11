# curl-send

Minimal curl client for the HTTP `/send` API.

```sh
export CF_MAIL_RELAY_WORKER_URL="https://<worker-host>"
export CF_MAIL_RELAY_API_KEY="<api key secret shown once in the admin UI>"
export CF_MAIL_RELAY_FROM="sender@example.com"
export CF_MAIL_RELAY_TO="dest@example.org"

./send.sh
```

Optional environment variables: `CF_MAIL_RELAY_SUBJECT`,
`CF_MAIL_RELAY_BODY`, and `CF_MAIL_RELAY_IDEMPOTENCY_KEY`.
