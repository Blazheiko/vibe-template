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

# The landing runs next to the backend, and the two live and die together: the backend starts
# only once the preview answers, and whichever exits first stops the other. A busy port 4174 or
# a broken preview then stops the run instead of leaving the backend up without its landing.
# A loop, not `wait -n`: macOS ships bash 3.2.
# Bound to 127.0.0.1 explicitly: on `localhost` Vite may take [::1] while another process holds
# 127.0.0.1 on the same port, and --strictPort would not notice.
(cd ../landing && exec ./node_modules/.bin/vite preview --host 127.0.0.1 --port "$LANDING_PREVIEW_PORT" --strictPort) &
LANDING_PID=$!
BACKEND_PID=""
stop_all() {
    kill "$LANDING_PID" ${BACKEND_PID:+"$BACKEND_PID"} 2>/dev/null || true
    wait 2>/dev/null || true
}
trap stop_all EXIT
trap 'exit 130' INT TERM

LANDING_URL_LOCAL="http://localhost:${LANDING_PREVIEW_PORT}/"
LANDING_PROBE="http://127.0.0.1:${LANDING_PREVIEW_PORT}/"
ready=false
for _ in $(seq 1 60); do
    if ! kill -0 "$LANDING_PID" 2>/dev/null; then
        echo "The landing preview exited before it answered (is port ${LANDING_PREVIEW_PORT} busy? LANDING_PREVIEW_PORT changes it)" >&2
        exit 1
    fi
    # Ready means this landing answers: its page with a button to this backend, not just any
    # server on the port.
    if page="$(curl -fsS "$LANDING_PROBE" 2>/dev/null)"; then
        if printf '%s' "$page" | grep -qF "href=\"${ORIGIN}/register\""; then
            ready=true
            break
        fi
        echo "The landing on ${LANDING_URL_LOCAL} was built for another app address, not ${ORIGIN}: run without PROD_LOCAL_SKIP_BUILD to rebuild it" >&2
        exit 1
    fi
    sleep 0.5
done
if [ "$ready" != "true" ]; then
    echo "The landing preview did not answer on ${LANDING_URL_LOCAL} in 30 s" >&2
    exit 1
fi

echo "Landing: ${LANDING_URL_LOCAL}  App: ${ORIGIN}"
node dist/index.js &
BACKEND_PID=$!
while kill -0 "$LANDING_PID" 2>/dev/null && kill -0 "$BACKEND_PID" 2>/dev/null; do
    sleep 1
done
if kill -0 "$BACKEND_PID" 2>/dev/null; then
    echo "The landing preview exited: stopping the backend" >&2
    exit 1
fi
status=0
wait "$BACKEND_PID" || status=$?
echo "The backend exited (status ${status}): stopping the landing preview" >&2
exit "$status"
