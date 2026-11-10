#!/bin/bash
# Build the local Docker image of the application from the production Dockerfile:
# the backend with the built SPA in packages/backend/public (SERVE_STATIC=true).
# docker-compose.yml runs it as the `app` service (`pnpm app:up`).
#
# Usage: scripts/docker-build.sh [extra docker build args...]
#   APP_IMAGE=vibe-template:local   tag of the image (the same variable docker-compose.yml reads)
#
# The frontend is built for a same-origin API (no VITE_BASE_URL) and without Sentry, so the
# image talks to nothing outside the compose stack. Extra arguments go to `docker build`,
# for example --no-cache or --build-arg VITE_SENTRY_ENABLED=true.
#
# The API prefix is compiled into the SPA, and the container reads API_PATH_PREFIX from
# packages/backend/.env at run time (docker-compose.yml: env_file). The two must be the same,
# so the build takes it from the same file (or from API_PATH_PREFIX in the environment).
set -euo pipefail

cd "$(dirname "$0")/.."

if ! docker info >/dev/null 2>&1; then
    echo "Docker is not running: start Docker Desktop (or the docker daemon) and retry." >&2
    exit 1
fi

APP_IMAGE="${APP_IMAGE:-vibe-template:local}"
REVISION="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
    REVISION="${REVISION}-dirty"
fi

# The last API_PATH_PREFIX line of the file, without quotes; empty when there is none.
env_file_prefix() {
    [ -f packages/backend/.env ] || return 0
    sed -n 's/^[[:space:]]*API_PATH_PREFIX[[:space:]]*=[[:space:]]*//p' packages/backend/.env |
        tail -n 1 | sed -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}
API_PREFIX="${API_PATH_PREFIX:-$(env_file_prefix)}"

echo "Building ${APP_IMAGE} (revision ${REVISION}, API prefix ${API_PREFIX:-api})"
docker build \
    --tag "$APP_IMAGE" \
    --build-arg "VITE_API_PATH_PREFIX=${API_PREFIX}" \
    --label "org.opencontainers.image.revision=${REVISION}" \
    --build-arg VITE_SENTRY_ENABLED=false \
    --build-arg VITE_SENTRY_DSN= \
    "$@" \
    .

echo
echo "Built ${APP_IMAGE}. Start it with the services: pnpm app:up (http://localhost:\${APP_PORT:-3000})"
