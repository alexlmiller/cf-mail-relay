# python-send

Minimal Python client for the HTTP `/send` API.

```sh
export CF_MAIL_RELAY_WORKER_URL="https://<worker-host>"
export CF_MAIL_RELAY_API_KEY="<api key secret shown once in the admin UI>"
export CF_MAIL_RELAY_FROM="gmail@example.com"
export CF_MAIL_RELAY_TO="dest@example.org"

python3 send.py
```
