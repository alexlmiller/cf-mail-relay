# Relay deployment

The supported production deployment is one nonroot container with certificates
managed on the host.

The directory contains:

- `relay.compose.yml` — hardened Compose service pinned to an immutable release.
- `.env.example` — every required and optional runtime setting.
- `sync-certificates.sh` — checks certificate parseability and key matching,
  publishes one atomic PEM bundle for container UID/GID `65532`, then restarts
  a running relay.

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

Edit `/opt/cf-mail-relay/.env`. Set a published immutable release tag and copy
the relay values from `RUNBOOK.md`. The SMTP hostname must be a DNS-only `A` or
`AAAA` record.

Use the host's existing ACME client. A Certbot standalone HTTP-01 request looks
like this:

```sh
sudo certbot certonly --standalone -d smtp.example.com --agree-tos -m admin@example.com
```

This requires working public DNS, inbound TCP `80`, and no conflicting listener.
Check [Certbot's standalone guidance](https://eff-certbot.readthedocs.io/en/stable/using.html#standalone)
and [Let's Encrypt's challenge requirements](https://letsencrypt.org/docs/challenge-types/)
before running it. Use another supported challenge when those conditions do not
fit the host.

Publish the dereferenced certificate and key as one bundle in the deployment
directory:

```sh
sudo /opt/cf-mail-relay/sync-certificates.sh \
  /etc/letsencrypt/live/smtp.example.com/fullchain.pem \
  /etc/letsencrypt/live/smtp.example.com/privkey.pem \
  /opt/cf-mail-relay
```

The helper requires readable, parseable certificate/key files with matching
public keys. It does not validate expiry, hostname, chain, or certificate
purpose; the ACME client remains responsible for those checks. It writes a
mode-`0600` bundle owned by UID/GID `65532` and publishes it with one atomic
rename. Source symlinks are dereferenced.

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

## Upgrade and rollback

Change only `CF_MAIL_RELAY_VERSION` in `.env`, then:

```sh
cd /opt/cf-mail-relay
sudo docker compose pull relay
sudo docker compose up -d relay
sudo docker compose ps relay
openssl s_client -connect smtp.example.com:587 -starttls smtp -servername smtp.example.com -verify_return_error -brief
```

Roll back by restoring the previous immutable tag and repeating the commands.
Do not use `latest` in production.

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

`RELAY_ALLOW_INSECURE_AUTH` and `RELAY_ALLOW_INSECURE_WORKER_URL` are for local
development only.
