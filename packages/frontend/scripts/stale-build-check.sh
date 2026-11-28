#!/bin/bash
# feat-278 (T6): a real deploy under an open tab. Builds the production app twice, A and B,
# where B changes the About page (a marker the test looks for), then runs
# e2e-stale-build/: the backend serves A, a tab opens with an active service worker, the
# backend restarts on B (it indexes its static files at start, so swapping files under a
# running process is not a deploy), and the tab opens the lazy About page.
#
# Not part of CI (two production builds and a backend restart). Requires PostgreSQL and Redis
# from packages/backend/.env, like the other prod-local runs.
#
# Usage: packages/frontend/scripts/stale-build-check.sh   (from anywhere)
set -euo pipefail

cd "$(dirname "$0")/../../.."
ROOT=$(pwd)
WORK=$(mktemp -d)
VIEW="$ROOT/packages/frontend/src/views/ManifestoSocial.vue"
PUBLIC="$ROOT/packages/backend/public"
export PORT="${PORT:-3300}"

restore() {
    if [ -f "$WORK/view.bak" ]; then cp "$WORK/view.bak" "$VIEW"; fi
    # Leave build A in place: a later PROD_LOCAL_SKIP_BUILD run must not serve the marker.
    if [ -d "$WORK/A" ]; then rm -rf "$PUBLIC" && cp -r "$WORK/A" "$PUBLIC"; fi
    rm -rf "$WORK"
}
trap restore EXIT

echo "== build A"
scripts/prod-local.sh --build-only
cp -r "$PUBLIC" "$WORK/A"

echo "== build B (About page with a marker)"
cp "$VIEW" "$WORK/view.bak"
perl -0pi -e 's|<main class="static-view">|<main class="static-view" data-stale-build="B">|' "$VIEW"
grep -q 'data-stale-build="B"' "$VIEW"
# Only the frontend changed: the backend and shared builds of A are reused.
VITE_BASE_URL="http://localhost:${PORT}" VITE_SENTRY_ENABLED=false VITE_SENTRY_DSN= \
    pnpm --filter frontend build
cp -r "$ROOT/packages/frontend/dist" "$WORK/B"
cp "$WORK/view.bak" "$VIEW"

echo "== deploy A -> B under an open tab"
cd "$ROOT/packages/frontend"
STALE_ROOT="$ROOT" STALE_A_DIR="$WORK/A" STALE_B_DIR="$WORK/B" \
    pnpm exec playwright test -c playwright.stale-build.config.ts
