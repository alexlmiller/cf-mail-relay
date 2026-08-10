#!/bin/sh
set -eu

usage() {
  echo "usage: $0 CERT_FILE KEY_FILE DEPLOYMENT_DIR" >&2
  exit 2
}

[ "$#" -eq 3 ] || usage

cert_source=$1
key_source=$2
deployment_dir=$3
tls_dir=$deployment_dir/tls
compose_file=${COMPOSE_FILE:-$deployment_dir/compose.yml}

[ -r "$cert_source" ] || { echo "certificate is not readable: $cert_source" >&2; exit 1; }
[ -r "$key_source" ] || { echo "private key is not readable: $key_source" >&2; exit 1; }

install -d -m 0750 -o 65532 -g 65532 "$tls_dir"
cert_tmp=$(mktemp "$tls_dir/.fullchain.pem.XXXXXX")
key_tmp=$(mktemp "$tls_dir/.privkey.pem.XXXXXX")

cleanup() {
  rm -f "$cert_tmp" "$key_tmp"
}
trap cleanup EXIT HUP INT TERM

# `-L` is essential for ACME clients such as certbot, whose live paths are
# symlinks that are not usable inside the container bind mount.
cp -L "$cert_source" "$cert_tmp"
cp -L "$key_source" "$key_tmp"
chmod 0644 "$cert_tmp"
chmod 0600 "$key_tmp"
chown 65532:65532 "$cert_tmp" "$key_tmp"

openssl x509 -in "$cert_tmp" -noout
openssl pkey -in "$key_tmp" -noout
cert_public_key=$(openssl x509 -in "$cert_tmp" -pubkey -noout | openssl sha256)
key_public_key=$(openssl pkey -in "$key_tmp" -pubout | openssl sha256)
[ "$cert_public_key" = "$key_public_key" ] || { echo "certificate and private key do not match" >&2; exit 1; }

# Each rename is atomic on the destination filesystem. The relay is restarted
# only after both validated files are in place, so it never opens a partial copy.
mv -f "$cert_tmp" "$tls_dir/fullchain.pem"
mv -f "$key_tmp" "$tls_dir/privkey.pem"
trap - EXIT HUP INT TERM

if [ -f "$compose_file" ]; then
  running_services=$(docker compose --project-directory "$deployment_dir" -f "$compose_file" ps --status running --services)
  if printf '%s\n' "$running_services" | grep -qx relay; then
    docker compose --project-directory "$deployment_dir" -f "$compose_file" restart relay
  fi
fi
