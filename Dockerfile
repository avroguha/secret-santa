# Secret Santa image.
#
# No site's locations are baked in: the image registry prefix, the Ubuntu apt
# mirror, the npm registry and the proxy all come from the site's env file
# (work.env or home.env) through docker-compose.yml. NPM_REGISTRY is required;
# the others may be empty (empty = Docker Hub / Ubuntu's own mirrors / no proxy).
#
# Classic builder only - no BuildKit-only syntax - because the work build host
# has no buildx.
#
# Images are pinned by digest; a digest is the same behind a registry mirror,
# only the prefix in front of it changes. image-pins.json records when each
# pinned manifest was pushed; test/deployment.test.js refuses a pin younger
# than 72 hours.
ARG IMAGE_REGISTRY=
ARG IMAGE_NODE=node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c
ARG IMAGE_UBUNTU=ubuntu:noble-20260905@sha256:a053cbffda9d424679c103c5b4f452297efc3774a1e491c110289f726fbb5d34

# ---- stage 1: the npm dependency, from the lockfile, through the 72-hour gate
FROM ${IMAGE_REGISTRY}${IMAGE_NODE} AS deps
ARG NPM_REGISTRY=
ARG NPM_TOKEN=
ARG HTTP_PROXY=
ARG HTTPS_PROXY=
ARG NO_PROXY=localhost,127.0.0.1
WORKDIR /build
# Site CA certificates (certs/*.crt, gitignored) for a registry or proxy that
# presents an internal certificate.
COPY certs/ /tmp/site-certs/
COPY package.json package-lock.json deps-publish-times.json ./
COPY scripts/check-release-age.js scripts/
# Proxy and token are exported inside this one step only and never persisted.
# The token is scoped to the registry and removed again in the same step.
# Then the 72-hour supply-chain gate: --offline judges from the committed
# cache only and never asks a public registry from inside the build.
RUN set -eux; \
    : "${NPM_REGISTRY:?NPM_REGISTRY is not set - build with: docker compose --env-file work.env up --build (or home.env)}"; \
    if [ -n "${HTTP_PROXY}" ]; then export http_proxy="${HTTP_PROXY}" https_proxy="${HTTPS_PROXY}" no_proxy="${NO_PROXY}" HTTP_PROXY HTTPS_PROXY NO_PROXY; fi; \
    if ls /tmp/site-certs/*.crt >/dev/null 2>&1; then cat /tmp/site-certs/*.crt > /tmp/site-ca.pem; export NODE_EXTRA_CA_CERTS=/tmp/site-ca.pem; fi; \
    npm config set registry "${NPM_REGISTRY}"; \
    AUTH_KEY="$(printf '%s' "${NPM_REGISTRY}" | sed -E 's#^https?:##; s#/*$#/#'):_authToken"; \
    if [ -n "${NPM_TOKEN}" ]; then npm config set "${AUTH_KEY}" "${NPM_TOKEN}"; fi; \
    npm ci --omit=dev --no-audit --no-fund; \
    rm -f /root/.npmrc; \
    node scripts/check-release-age.js --hours 72 --offline

# ---- stage 2: Ubuntu with the Node runtime copied in
FROM ${IMAGE_REGISTRY}${IMAGE_UBUNTU}
ARG APT_MIRROR=
ARG HTTP_PROXY=
ARG HTTPS_PROXY=
ARG NO_PROXY=localhost,127.0.0.1
ENV DEBIAN_FRONTEND=noninteractive
RUN set -eux; \
    if [ -n "${HTTP_PROXY}" ]; then export http_proxy="${HTTP_PROXY}" https_proxy="${HTTPS_PROXY}" no_proxy="${NO_PROXY}"; fi; \
    if [ -n "${APT_MIRROR}" ]; then \
      sed -i "s#http://archive.ubuntu.com/ubuntu/#${APT_MIRROR}/#; s#http://security.ubuntu.com/ubuntu/#${APT_MIRROR}/#" \
        /etc/apt/sources.list.d/ubuntu.sources; \
    fi; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl openssl; \
    rm -rf /var/lib/apt/lists/*

# Site CA certificates join the system store, which Node is pointed at below,
# so Microsoft sign-in works through a TLS-inspecting proxy.
COPY certs/ /usr/local/share/ca-certificates/site/
RUN set -eux; update-ca-certificates

# The official Node binary needs only glibc and libstdc++, both in Ubuntu 24.04.
COPY --from=deps /usr/local/bin/node /usr/local/bin/node

WORKDIR /app
COPY --from=deps /build/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY public ./public
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# Ubuntu 24.04 already has a user "ubuntu" (uid 1000); the app gets its own
# system user instead. The entrypoint starts as root only to sort out the
# bind-mount ownership, then drops to that user.
RUN set -eux; \
    sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh; \
    chmod 755 /usr/local/bin/docker-entrypoint.sh; \
    userdel -r ubuntu 2>/dev/null || true; \
    useradd -r -u 10001 -d /app -s /usr/sbin/nologin santa; \
    mkdir -p /data /certs /secrets; \
    chown santa:santa /data; \
    node --version

# Nothing from the build environment reaches the runtime layer: no registry,
# no token, no proxy. A runtime proxy (for Microsoft sign-in only) comes from
# the compose file; NODE_USE_ENV_PROXY makes Node's fetch honour it.
ENV NODE_ENV=production \
    SANTA_DATA_DIR=/data \
    SANTA_TLS_DIR=/certs \
    SANTA_PORT=8080 \
    NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt \
    NODE_USE_ENV_PROXY=1

VOLUME ["/data"]
EXPOSE 8080

# curl, not a Node one-liner: a language runtime every 30 s costs about a
# second of CPU. HTTPS first (when a certificate is installed), then HTTP.
# --noproxy: a runtime proxy must never see a loopback probe.
HEALTHCHECK --interval=30s --timeout=6s --start-period=20s --retries=3 \
    CMD curl -fsSk --noproxy '*' -o /dev/null --max-time 4 "https://127.0.0.1:${SANTA_PORT}/healthz" \
     || curl -fsS --noproxy '*' -o /dev/null --max-time 4 "http://127.0.0.1:${SANTA_PORT}/healthz" || exit 1

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server/index.js"]
