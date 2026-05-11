# relay/

Go SMTP submission daemon. Multi-arch Docker image.

Listens on `587` with `STARTTLS` + `AUTH PLAIN/LOGIN`. Forwards raw RFC 5322 MIME to the Worker over HTTPS, HMAC-signed.

## Status

Scaffold only. Implementation lands in MS1 per `IMPLEMENTATION_PLAN.md`.

## Build target

- `linux/amd64` and `linux/arm64` Docker images.
- Single static binary inside.
- Published to GHCR as `ghcr.io/<owner>/cf-mail-relay/relay:<version>`.

## Configuration (planned)

All via environment variables. Reference `IMPLEMENTATION_PLAN.md` § Component breakdown for the full list.

| Variable | Purpose | Default |
|---|---|---|
| `RELAY_LISTEN_ADDR` | SMTP listen address | `:587` |
| `RELAY_DOMAIN` | Used for `EHLO` and STARTTLS cert SNI | required |
| `RELAY_WORKER_URL` | Worker base URL | required |
| `RELAY_KEY_ID` | HMAC key id | required |
| `RELAY_HMAC_SECRET` | HMAC shared secret | required |
| `RELAY_TLS_CERT_FILE` | Path to mounted PEM cert | required |
| `RELAY_TLS_KEY_FILE` | Path to mounted PEM key | required |
| `RELAY_MAX_BYTES` | Max MIME bytes at DATA | `4500000` |
| `RELAY_MAX_RECIPIENTS` | Max `RCPT TO` count | `50` |
| `RELAY_RATE_LIMIT_PER_USER_PER_MIN` | AUTH attempts | `30` |
| `RELAY_AUTH_FAIL_BAN_THRESHOLD` | Fail2ban-style threshold | `5/5m -> 15m ban` |

## Local development

```sh
cd relay
go test ./...
go build ./cmd/relay
```

See `docker-compose.example.yml` for a sample standalone setup.
