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
bundle_file=$tls_dir/relay.pem

[ -r "$cert_source" ] || { echo "certificate is not readable: $cert_source" >&2; exit 1; }
[ -r "$key_source" ] || { echo "private key is not readable: $key_source" >&2; exit 1; }

install -d -m 0750 -o 65532 -g 65532 "$tls_dir"
bundle_tmp=$(mktemp "$tls_dir/.relay.pem.XXXXXX")

cleanup() {
  rm -f "$bundle_tmp"
}
trap cleanup EXIT HUP INT TERM

# Reading the sources dereferences ACME-client symlinks so the container never
# depends on private archive paths that are outside its bind mount.
{
  cat "$cert_source"
  printf '\n'
  cat "$key_source"
} > "$bundle_tmp"
chmod 0600 "$bundle_tmp"
chown 65532:65532 "$bundle_tmp"

openssl x509 -in "$bundle_tmp" -noout
openssl pkey -in "$bundle_tmp" -noout
cert_public_key=$(openssl x509 -in "$bundle_tmp" -pubkey -noout | openssl sha256)
key_public_key=$(openssl pkey -in "$bundle_tmp" -pubout | openssl sha256)
[ "$cert_public_key" = "$key_public_key" ] || { echo "certificate and private key do not match" >&2; exit 1; }

# Certificate and key are one validated bundle, so this single same-filesystem
# rename publishes the pair atomically. A crash cannot leave a mismatched pair.
mv -f "$bundle_tmp" "$bundle_file"
trap - EXIT HUP INT TERM

if [ -f "$compose_file" ]; then
  running_services=$(docker compose --project-directory "$deployment_dir" -f "$compose_file" ps --status running --services)
  if printf '%s\n' "$running_services" | grep -qx relay; then
    docker compose --project-directory "$deployment_dir" -f "$compose_file" restart relay
  fi
fi
