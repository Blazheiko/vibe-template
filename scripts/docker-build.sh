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

echo "Building ${APP_IMAGE} (revision ${REVISION})"
docker build \
    --tag "$APP_IMAGE" \
    --label "org.opencontainers.image.revision=${REVISION}" \
    --build-arg VITE_SENTRY_ENABLED=false \
    --build-arg VITE_SENTRY_DSN= \
    "$@" \
    .

echo
echo "Built ${APP_IMAGE}. Start it with the services: pnpm app:up (http://localhost:\${APP_PORT:-3000})"
