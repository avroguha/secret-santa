#!/bin/sh
# Prepares the bind mounts, then drops privileges and starts the app.
#
#   /data owned by root (Docker created it) -> hand it to the "santa" user (uid 10001)
#   /data owned by a host user              -> run AS that user, so the operator can
#                                              back up and inspect the files without sudo
#   rootless Docker/Podman                  -> container root already is the host user
#
# Also, when asked: a self-signed TLS certificate for the first start, and a copy of
# the Azure client secret that the unprivileged user can read (the original may be a
# mode-600 file owned by whoever created it on the host).
set -e

make_self_signed() {
    dir="${SANTA_TLS_DIR:-/certs}"
    crt="$dir/${SANTA_TLS_CERT_NAME:-tls.crt}"
    key="$dir/${SANTA_TLS_KEY_NAME:-tls.key}"
    [ "${SANTA_TLS_SELF_SIGNED:-false}" = "true" ] || return 0
    [ -f "$crt" ] && [ -f "$key" ] && return 0
    first=""
    san="DNS:localhost,IP:127.0.0.1"
    for h in $(printf '%s' "${SANTA_TLS_HOSTNAME:-}" | tr ',' ' '); do
        [ -n "$first" ] || first="$h"
        case "$h" in
            *[!0-9.]*) san="$san,DNS:$h" ;;
            *) san="$san,IP:$h" ;;
        esac
    done
    openssl req -x509 -newkey rsa:2048 -nodes -days 825 -subj "/CN=${first:-localhost}" \
        -addext "subjectAltName=$san" -keyout "$key" -out "$crt" 2>/dev/null
    chmod 600 "$key"
    echo "entrypoint: made a self-signed certificate for ${first:-localhost} ($san) - replace $crt and $key with the real ones when you have them"
}

copy_secrets() {
    uid="$1"; gid="$2"
    src="${SANTA_AZURE_CLIENT_SECRET_FILE:-/secrets/azure_client_secret}"
    if [ -f "$src" ]; then
        mkdir -p /tmp/santa-secrets
        cp "$src" /tmp/santa-secrets/azure_client_secret
        chown -R "$uid:$gid" /tmp/santa-secrets
        chmod 500 /tmp/santa-secrets
        chmod 400 /tmp/santa-secrets/azure_client_secret
        export SANTA_AZURE_CLIENT_SECRET_FILE=/tmp/santa-secrets/azure_client_secret
    fi
}

if [ "$(id -u)" = "0" ]; then
    mkdir -p /data
    rootless=no
    if [ -r /proc/self/uid_map ]; then
        read -r _in _out _len < /proc/self/uid_map || true
        if [ "$_out" != "0" ] || [ "${_len:-0}" -le 100000 ] 2>/dev/null; then rootless=yes; fi
    fi
    owner=$(stat -c %u /data); group=$(stat -c %g /data)
    if [ "$rootless" = "yes" ] && [ "$owner" = "0" ]; then
        echo "entrypoint: rootless container runtime detected; staying root (that is the host user)"
        make_self_signed
        exec "$@"
    fi
    if [ "$owner" = "0" ]; then
        owner=$(id -u santa); group=$(id -g santa)
        chown -R "$owner:$group" /data
    fi
    make_self_signed
    for f in "${SANTA_TLS_DIR:-/certs}/${SANTA_TLS_CERT_NAME:-tls.crt}" "${SANTA_TLS_DIR:-/certs}/${SANTA_TLS_KEY_NAME:-tls.key}"; do
        [ -f "$f" ] && chown "$owner:$group" "$f" 2>/dev/null || true
    done
    copy_secrets "$owner" "$group"
    if ! setpriv --reuid="$owner" --regid="$group" --clear-groups sh -c 'test -w /data'; then
        echo "entrypoint: ERROR /data is not writable by uid $owner - check the bind mount (SANTA_DATA_DIR)" >&2
        exit 1
    fi
    echo "entrypoint: running as uid $owner gid $group (owner of /data)"
    exec setpriv --reuid="$owner" --regid="$group" --clear-groups "$@"
fi
make_self_signed
exec "$@"
