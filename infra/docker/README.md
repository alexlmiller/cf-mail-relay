# Supported relay deployment

The supported production path is one nonroot relay container with certificates
managed on the host. This keeps ACME credentials and provider-specific proxy
configuration out of the relay stack.

The directory contains:

- `relay.compose.yml` — hardened Compose service pinned to an immutable release.
- `.env.example` — every required and optional runtime setting.
- `sync-certificates.sh` — validates and atomically publishes host-managed
  certificate material as one PEM bundle for container UID/GID `65532`, then
  restarts a running relay.

## Install

On the relay host:

```sh
sudo install -d -m 0750 /opt/cf-mail-relay
sudo cp infra/docker/relay.compose.yml /opt/cf-mail-relay/compose.yml
sudo cp infra/docker/sync-certificates.sh /opt/cf-mail-relay/sync-certificates.sh
sudo cp infra/docker/.env.example /opt/cf-mail-relay/.env
sudo chmod 0755 /opt/cf-mail-relay/sync-certificates.sh
sudo chmod 0600 /opt/cf-mail-relay/.env
```

Edit `/opt/cf-mail-relay/.env` with the immutable release tag and values from
the setup runbook. The SMTP hostname must be a DNS-only `A` or `AAAA` record;
Cloudflare's HTTP proxy does not proxy SMTP.

Use the ACME client already managed by the host. For certbot, an initial
certificate could be issued with:

```sh
sudo certbot certonly --standalone -d smtp.example.com --agree-tos -m admin@example.com
```

Publish the dereferenced certificate and key as one bundle in the deployment
directory:

```sh
sudo /opt/cf-mail-relay/sync-certificates.sh \
  /etc/letsencrypt/live/smtp.example.com/fullchain.pem \
  /etc/letsencrypt/live/smtp.example.com/privkey.pem \
  /opt/cf-mail-relay
```

The helper refuses unreadable, invalid, or mismatched material. It combines the
certificate and private key in `tls/relay.pem`, mode `0600`, owned by UID/GID
`65532`, and publishes the pair with one atomic rename. Source symlinks are
dereferenced so the container never depends on an ACME client's private archive
paths.

Start and verify the relay:

```sh
cd /opt/cf-mail-relay
sudo docker compose pull
sudo docker compose up -d
sudo docker compose ps
openssl s_client -connect smtp.example.com:587 -starttls smtp -servername smtp.example.com -verify_return_error -brief
```

The container healthcheck connects to the local SMTP listener and requires a
valid `220` banner; it does not merely check that the process exists.

## Certificate renewal hook

Certbot exposes the renewed certificate directory in `RENEWED_LINEAGE`. Save
this wrapper as
`/etc/letsencrypt/renewal-hooks/deploy/cf-mail-relay`, mode `0755`:

```sh
#!/bin/sh
exec /opt/cf-mail-relay/sync-certificates.sh \
  "$RENEWED_LINEAGE/fullchain.pem" \
  "$RENEWED_LINEAGE/privkey.pem" \
  /opt/cf-mail-relay
```

The helper restarts the relay only when its Compose service is already running.
If the Compose file is elsewhere, set `RELAY_COMPOSE_FILE` to its path. When the
Compose file is absent or the relay service is stopped, the helper publishes the
renewed bundle successfully but warns that a restart is still required before
the relay will serve the new certificate.

`RELAY_ALLOW_INSECURE_AUTH` and `RELAY_ALLOW_INSECURE_WORKER_URL` are for
isolated local development only. Do not set either in a public deployment.
