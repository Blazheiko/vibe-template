#!/bin/bash
# Build the local Docker images from the production Dockerfiles: the application (the backend
# with the built SPA in packages/backend/public, SERVE_STATIC=true) and the landing
# (packages/landing/Dockerfile, nginx). docker-compose.yml runs them as the `app` and `landing`
# services (`pnpm app:up`).
#
# Usage: scripts/docker-build.sh [extra docker build args...]
#   APP_IMAGE=vibe-template:local             tag of the app image (docker-compose.yml reads it too)
#   LANDING_IMAGE=vibe-template-landing:local tag of the landing image (likewise)
#
# The landing's addresses are compiled in: its buttons lead to http://localhost:APP_PORT and its
# own address is http://localhost:LANDING_PORT, the ports compose publishes (shell, else
# packages/backend/.env, else 3000 and 8080). Local http addresses, so LANDING_STRICT=false.
#
# The frontend is built for a same-origin API (no VITE_BASE_URL) and without Sentry, so the
# image talks to nothing outside the compose stack. Extra arguments go to `docker build`,
# for example --no-cache or --build-arg VITE_SENTRY_ENABLED=true.
#
# The API prefix is compiled into the SPA, and the container reads API_PATH_PREFIX at run time.
# The two must be the same, so the build resolves it like docker-compose.yml does: from
# API_PATH_PREFIX in the environment, else from packages/backend/.env, else `api`
# (scripts/verify-compose.mjs checks the compose side).
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

# The last NAME= line of packages/backend/.env, without quotes; empty when there is none.
env_file_value() {
    [ -f packages/backend/.env ] || return 0
    sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" packages/backend/.env |
        tail -n 1 | sed -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}
API_PREFIX="${API_PATH_PREFIX:-$(env_file_value API_PATH_PREFIX)}"
LANDING_IMAGE="${LANDING_IMAGE:-vibe-template-landing:local}"
HOST_APP_PORT="${APP_PORT:-$(env_file_value APP_PORT)}"
HOST_LANDING_PORT="${LANDING_PORT:-$(env_file_value LANDING_PORT)}"
HOST_APP_PORT="${HOST_APP_PORT:-3000}"
HOST_LANDING_PORT="${HOST_LANDING_PORT:-8080}"

echo "Building ${APP_IMAGE} (revision ${REVISION}, API prefix ${API_PREFIX:-api})"
docker build \
    --tag "$APP_IMAGE" \
    --build-arg "API_PATH_PREFIX=${API_PREFIX}" \
    --label "org.opencontainers.image.revision=${REVISION}" \
    --build-arg VITE_SENTRY_ENABLED=false \
    --build-arg VITE_SENTRY_DSN= \
    "$@" \
    .

echo "Building ${LANDING_IMAGE} (buttons to http://localhost:${HOST_APP_PORT}, site http://localhost:${HOST_LANDING_PORT})"
docker build \
    --file packages/landing/Dockerfile \
    --tag "$LANDING_IMAGE" \
    --label "org.opencontainers.image.revision=${REVISION}" \
    --build-arg "LANDING_APP_URL=http://localhost:${HOST_APP_PORT}" \
    --build-arg "LANDING_SITE_URL=http://localhost:${HOST_LANDING_PORT}" \
    --build-arg LANDING_STRICT=false \
    "$@" \
    .

echo
echo "Built ${APP_IMAGE} and ${LANDING_IMAGE}. Start them with the services: pnpm app:up"
echo "(app http://localhost:${HOST_APP_PORT}, landing http://localhost:${HOST_LANDING_PORT})"
