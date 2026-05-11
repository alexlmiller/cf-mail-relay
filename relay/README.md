# relay/

Go SMTP submission daemon. Multi-arch Docker image.

Listens on `587` with `STARTTLS` + `AUTH PLAIN/LOGIN`. Forwards raw RFC 5322 MIME to the Worker over HTTPS, HMAC-signed.

## Status

MS5 relay implementation is in place:

- `587` SMTP submission with STARTTLS.
- `AUTH PLAIN` and `AUTH LOGIN`, delegated to Worker `/relay/auth`.
- Sender policy from Worker `/relay/auth`, recipient cap, size cap, and conservative 8-bit rejection.
- HMAC-signed `POST /relay/send` with raw MIME bytes.
- 60 second auth decision cache, invalidated when the Worker returns a new policy version.
- Per-IP connection throttling, per-username AUTH throttling, and exponential AUTH-failure lockout.
- Per-message trace IDs propagated to Worker `send_events`.

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
| `RELAY_ALLOWED_SENDERS` | Optional local fallback allowlist before Worker auth policy is available | unset |
| `RELAY_MAX_BYTES` | Max MIME bytes at DATA | `4718592` |
| `RELAY_MAX_RECIPIENTS` | Max `RCPT TO` count | `50` |
| `RELAY_ALLOW_INSECURE_AUTH` | Local-dev only; allow AUTH before STARTTLS | unset/false |
| `RELAY_CONN_PER_MIN` | Connections per remote IP per minute | `60` |
| `RELAY_AUTH_PER_MIN` | AUTH attempts per username per minute | `20` |
| `RELAY_AUTH_LOCKOUT_BASE_SECONDS` | Exponential lockout base after failed AUTH | `30` |

## Local development

```sh
cd relay
go test ./...
go build ./cmd/relay
```

See `docker-compose.example.yml` for a sample standalone setup.
