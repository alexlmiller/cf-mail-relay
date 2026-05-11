# Relay with host-managed certbot

This pattern keeps certificate issuance outside Docker and bind-mounts the
result into the relay container.

## DNS

Create a DNS-only `A` or `AAAA` record for the relay hostname:

```text
smtp.example.com. A 198.51.100.7
```

Do not orange-cloud the record. Cloudflare's HTTP proxy does not proxy SMTP.

## Issue the certificate on the host

Use any certbot challenge that fits your environment. HTTP-01 requires port 80
to reach the host; DNS-01 works even when only SMTP is public.

```sh
sudo certbot certonly \
  --standalone \
  -d smtp.example.com \
  --agree-tos \
  -m admin@example.com
```

## Mount into the relay

Set these paths in the relay compose file:

```yaml
services:
  relay:
    volumes:
      - /etc/letsencrypt/live/smtp.example.com:/tls:ro
    environment:
      RELAY_TLS_CERT_FILE: /tls/fullchain.pem
      RELAY_TLS_KEY_FILE: /tls/privkey.pem
```

Then start the reference compose file:

```sh
docker compose -f infra/docker/relay.compose.yml up -d
```

## Renewals

Certbot renews certificates on the host. Reload the container after renewal so
the relay process reopens the mounted files:

```sh
sudo certbot renew
docker compose -f infra/docker/relay.compose.yml restart relay
```

For unattended hosts, add a certbot deploy hook:

```sh
sudo install -d /etc/letsencrypt/renewal-hooks/deploy
sudo tee /etc/letsencrypt/renewal-hooks/deploy/restart-cf-mail-relay >/dev/null <<'EOF'
#!/bin/sh
cd /opt/cf-mail-relay
docker compose restart relay
EOF
sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/restart-cf-mail-relay
```
