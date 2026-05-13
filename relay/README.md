# relay/

Go SMTP submission daemon. Runs as a multi-arch Docker image.

The relay listens on `587`, requires STARTTLS, supports `AUTH PLAIN` and
`AUTH LOGIN`, and forwards raw RFC 5322 MIME to the Worker over HMAC-signed
HTTPS.

## Configuration

| Variable | Purpose | Default |
|---|---|---|
| `RELAY_LISTEN_ADDR` | SMTP listen address | `:587` |
| `RELAY_DOMAIN` | SMTP banner/EHLO identity | `localhost` |
| `RELAY_WORKER_URL` | Worker base URL | required |
| `RELAY_KEY_ID` | HMAC key id | required |
| `RELAY_HMAC_SECRET` | HMAC shared secret | required |
| `RELAY_TLS_CERT_FILE` | PEM cert path | required |
| `RELAY_TLS_KEY_FILE` | PEM key path | required |
| `RELAY_MAX_BYTES` | Max MIME bytes at DATA | `4718592` |
| `RELAY_MAX_RECIPIENTS` | Max recipients | `50` |
| `RELAY_CONN_PER_MIN` | Connections per remote IP per minute | `60` |
| `RELAY_AUTH_PER_MIN` | AUTH attempts per username+remote pair per minute; remote IPs also get a 5x aggregate bucket | `20` |
| `RELAY_AUTH_LOCKOUT_BASE_SECONDS` | Auth lockout base after failures | `30` |

`RELAY_WORKER_URL` must use `https://`. For local-only development, set
`RELAY_ALLOW_INSECURE_WORKER_URL=1` to permit `http://`.

SMTP credential checks are cached for up to 5 seconds per relay process. This
keeps revocation lag short, but high-throughput clients should expect one Worker
auth round trip on most new SMTP sessions.

## Development

```sh
cd relay
go vet ./...
go test ./...
go build ./cmd/relay
```

See `infra/docker/` for deployment examples.
