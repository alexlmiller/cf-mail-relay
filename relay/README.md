# relay/

Go SMTP submission daemon. Multi-arch Docker image.

Listens on `587` with `STARTTLS` + `AUTH PLAIN/LOGIN`. Forwards raw RFC 5322 MIME to the Worker over HTTPS, HMAC-signed.

## Status

MS1 relay implementation is in place:

- `587` SMTP submission with STARTTLS.
- `AUTH PLAIN` and `AUTH LOGIN`, delegated to Worker `/relay/auth`.
- Sender allowlist, recipient cap, size cap, and conservative 8-bit rejection.
- HMAC-signed `POST /relay/send` with raw MIME bytes.

## Build target

- `linux/amd64` and `linux/arm64` Docker images.
- Single static binary inside.
- Published to GHCR as `ghcr.io/<owner>/cf-mail-relay/relay:<version>`.

## Configuration

All via environment variables.

| Variable | Purpose | Default |
|---|---|---|
| `RELAY_LISTEN_ADDR` | SMTP listen address | `:587` |
| `RELAY_DOMAIN` | Used for the SMTP server banner/EHLO identity | `localhost` |
| `RELAY_WORKER_URL` | Worker base URL | required |
| `RELAY_KEY_ID` | HMAC key id | required |
| `RELAY_HMAC_SECRET` | HMAC shared secret | required |
| `RELAY_TLS_CERT_FILE` | Path to mounted PEM cert | required |
| `RELAY_TLS_KEY_FILE` | Path to mounted PEM key | required |
| `RELAY_ALLOWED_SENDERS` | Comma-separated sender allowlist; supports `*@domain` | required |
| `RELAY_MAX_BYTES` | Max MIME bytes at DATA | `4718592` |
| `RELAY_MAX_RECIPIENTS` | Max `RCPT TO` count | `50` |
| `RELAY_ALLOW_INSECURE_AUTH` | Local-dev only; allow AUTH before STARTTLS | unset/false |
| `RELAY_RATE_LIMIT_PER_USER_PER_MIN` | AUTH attempts | `30` |
| `RELAY_AUTH_FAIL_BAN_THRESHOLD` | Fail2ban-style threshold | `5/5m -> 15m ban` |

## Local development

```sh
cd relay
go test ./...
go build ./cmd/relay
```

See `docker-compose.example.yml` for a sample standalone setup.
