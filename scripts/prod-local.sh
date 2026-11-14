#!/bin/bash
# Production-like local run: the built SPA is served by the backend (SERVE_STATIC=true),
# exactly as in the Docker image, so the response headers (CSP etc.) are the real ones.
# Requires PostgreSQL and Redis from packages/backend/.env. Env below overrides .env
# (dotenv never overwrites variables that are already set).
#
# Usage: scripts/prod-local.sh [--build-only]
#   PROD_LOCAL_SKIP_BUILD=true  start from the existing build (several instances in parallel)
#   PROD_LOCAL_LANDING=true     also build the landing for this origin and serve it with
#                               `vite preview` on LANDING_PREVIEW_PORT (4174); `pnpm prod:local`
#                               and `make prod-local` set it, the frontend e2e runs do not
set -e

cd "$(dirname "$0")/.."

PORT="${PORT:-3000}"
ORIGIN="http://localhost:${PORT}"
LANDING="${PROD_LOCAL_LANDING:-false}"
LANDING_PREVIEW_PORT="${LANDING_PREVIEW_PORT:-4174}"
# The landing's buttons lead to this backend; its own address is the preview server
# (packages/landing/build/urls.ts). Exported for the build and for `vite preview`, which loads
# the same config.
export LANDING_APP_URL="$ORIGIN"
export LANDING_SITE_URL="http://localhost:${LANDING_PREVIEW_PORT}"
export LANDING_STRICT=false

if [ "${PROD_LOCAL_SKIP_BUILD:-false}" != "true" ]; then
    pnpm --filter shared build
    # Same-origin API, no Sentry: the build must not talk to external services in tests.
    VITE_BASE_URL="$ORIGIN" VITE_SENTRY_ENABLED=false VITE_SENTRY_DSN= \
        pnpm --filter frontend build
    pnpm --filter backend build
    # Same step as the Dockerfile: the backend serves packages/backend/public.
    rm -rf packages/backend/public
    cp -r packages/frontend/dist packages/backend/public
    if [ "$LANDING" = "true" ]; then
        pnpm --filter landing build
    fi
fi

[ "${1:-}" = "--build-only" ] && exit 0

cd packages/backend
# Plain http on localhost: APP_ENV=production would make getWsUrl() hand out wss://,
# production-like mode would add upgrade-insecure-requests (breaking every request)
# and refuse dev-only settings such as the fake SMS provider. The built bundle and the
# backend-served headers are still the production ones.
export APP_ENV="${APP_ENV:-local}"
export APP_IS_PRODUCTION="${APP_IS_PRODUCTION:-false}"
export APP_URL="${APP_URL:-$ORIGIN}"
export FRONTEND_URL="${FRONTEND_URL:-$ORIGIN}"
export DOMAIN="${DOMAIN:-localhost:${PORT}}"
export PORT
export SERVE_STATIC=true
export DOC_PAGE=false
export CSP_ENABLED="${CSP_ENABLED:-true}"
export CSP_REPORT_ONLY="${CSP_REPORT_ONLY:-false}"

if [ "$LANDING" != "true" ]; then
    exec node dist/index.js
fi

# The landing runs next to the backend and stops with it (Ctrl+C reaches both, the trap covers
# the backend exiting on its own).
(cd ../landing && exec pnpm exec vite preview --port "$LANDING_PREVIEW_PORT" --strictPort) &
LANDING_PID=$!
trap 'kill "$LANDING_PID" 2>/dev/null || true' EXIT
echo "Landing: http://localhost:${LANDING_PREVIEW_PORT}  App: ${ORIGIN}"
node dist/index.js
