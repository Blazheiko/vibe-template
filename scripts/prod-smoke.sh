#!/bin/bash
# Smoke run of docker-compose-prod.yml on this machine (feat-218), in production mode: the images
# are built as Dokploy builds them, the app starts with APP_IS_PRODUCTION=true and Secure __Host-
# cookies behind Caddy with an internal TLS certificate (docker-compose-prod.smoke.yml stands in
# for Traefik, the Database services, S3 and SMTP). Then, over https:
#   - scripts/verify-landing-deploy.sh on https://landing.localhost:<port> and the app;
#   - /<prefix>/ready answers ok;
#   - a registration, its confirmation from the mail (Mailpit) and a sign-in through the API, as a
#     browser does them (CSRF token, Origin).
#
# Usage: scripts/prod-smoke.sh            build, start, check, remove everything (volumes too)
#   SMOKE_HTTPS_PORT=8443                 host port of Caddy (127.0.0.1 only)
#   SMOKE_KEEP=true                       leave the stack running for a look in the browser
#                                         (accept the certificate warning); remove it later with
#                                         the `down` command the script prints
set -euo pipefail

cd "$(dirname "$0")/.."

if ! docker info >/dev/null 2>&1; then
    echo "Docker is not running: start Docker Desktop (or the docker daemon) and retry." >&2
    exit 1
fi

PORT="${SMOKE_HTTPS_PORT:-8443}"
APP="https://app.localhost:${PORT}"
LANDING="https://landing.localhost:${PORT}"
PREFIX=api
WORK="$(mktemp -d)"
ENV_FILE="${WORK}/smoke.env"
PROJECT=vibe-template-prod-smoke
COMPOSE=(docker compose -p "$PROJECT" -f docker-compose-prod.yml -f docker-compose-prod.smoke.yml
    --env-file "$ENV_FILE")

random() { openssl rand -base64 "$1" | tr -d '\n'; }

# What the Environment tab of Dokploy would hold, for the stand-ins of the smoke file.
cat > "$ENV_FILE" <<EOF
SMOKE_HTTPS_PORT=${PORT}
APP_DOMAIN=app.localhost:${PORT}
LANDING_DOMAIN=landing.localhost:${PORT}
API_PATH_PREFIX=${PREFIX}
LANDING_STRICT=false
APP_KEY=$(random 48)
MFA_ENCRYPTION_KEYS=smoke:$(random 32)
PGSQL_HOST=postgres
PGSQL_PORT=5432
PGSQL_USER=postgres
PGSQL_PASSWORD=$(random 18 | tr -dc 'A-Za-z0-9')
PGSQL_DB_NAME=vibe_template
REDIS_HOST=redis
REDIS_PORT=6379
REDIS_PASSWORD=$(random 18 | tr -dc 'A-Za-z0-9')
TRUSTED_PROXY_CIDRS=172.30.218.0/24
S3_ENDPOINT=http://s3:8333
S3_REGION=us-east-1
S3_BUCKET=vibe-template
S3_ACCESS_KEY_ID=smokeaccess
S3_SECRET_ACCESS_KEY=$(random 24 | tr -dc 'A-Za-z0-9')
CDN_URL=${APP}/cdn
SMTP_HOST=mailpit
SMTP_FROM_EMAIL=noreply@example.com
EOF

cleanup() {
    if [ "${SMOKE_KEEP:-false}" = true ]; then
        echo
        echo "Left running: ${APP} and ${LANDING}"
        echo "Remove with: ${COMPOSE[*]} down -v   (the env file is ${ENV_FILE})"
        return
    fi
    "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
    rm -rf "$WORK"
}
trap cleanup EXIT

echo "prod-smoke: building and starting (production mode, ${APP})"
if ! "${COMPOSE[@]}" up -d --build --wait --wait-timeout 300; then
    echo "prod-smoke: the stack did not become healthy" >&2
    "${COMPOSE[@]}" ps -a >&2 || true
    "${COMPOSE[@]}" logs --no-color --tail 80 migrate app >&2 || true
    exit 1
fi

failed=0
check() {
    if "$@"; then
        echo "  ok   $CHECK"
    else
        echo "  FAIL $CHECK" >&2
        failed=$((failed + 1))
    fi
}
CURL=(curl --silent --show-error --insecure --max-time 20)

CHECK="landing and its buttons (verify-landing-deploy.sh)"
check scripts/verify-landing-deploy.sh --insecure --allow-local "$LANDING" "$APP"

CHECK="${APP}/${PREFIX}/ready answers ok"
check bash -c "$(printf '%q ' "${CURL[@]}") '${APP}/${PREFIX}/ready' | grep -q '\"status\":\"ok\"'"

# A browser's cold start: GET /main/init gives the session cookie and the CSRF token, an unsafe
# request sends both with its Origin. The cookie must be __Host- and Secure (production mode).
JAR="${WORK}/cookies.txt"
csrf_token() {
    "${CURL[@]}" --cookie-jar "$JAR" --cookie "$JAR" "${APP}/${PREFIX}/main/init" |
        sed -n 's/.*"csrfToken":"\([^"]*\)".*/\1/p'
}
post() {
    local path="$1" body="$2" token
    token="$(csrf_token)"
    "${CURL[@]}" --cookie-jar "$JAR" --cookie "$JAR" -X POST "${APP}/${PREFIX}${path}" \
        -H 'Content-Type: application/json' -H "Origin: ${APP}" -H "X-CSRF-Token: ${token}" \
        --data "$body"
}

EMAIL="smoke-$(date +%s)@example.com"
PASSWORD="Smoke-$(random 12 | tr -dc 'A-Za-z0-9')-9"

CHECK="the session cookie is __Host- and Secure"
check bash -c "$(printf '%q ' "${CURL[@]}") -D - -o /dev/null '${APP}/${PREFIX}/main/init' |
    grep -i '^set-cookie: __Host-' | grep -qi 'secure'"

CHECK="registration by email"
REGISTER="$(post /auth/register/email "{\"name\":\"Smoke\",\"email\":\"${EMAIL}\",\"password\":\"${PASSWORD}\"}")"
check grep -q '"status":"success"' <<<"$REGISTER"

# Registration is strict (AUTH_STRICT_REGISTRATION): the account signs in once the link of the
# mail is confirmed with its password. Mailpit is inside the network; the app container reads it.
verification_token() {
    local attempt message
    for attempt in $(seq 1 20); do
        message="$("${COMPOSE[@]}" exec -T app curl -fsS http://mailpit:8025/api/v1/message/latest 2>/dev/null || true)"
        if grep -q "$EMAIL" <<<"$message"; then
            grep -o 'verify-email?token=[A-Za-z0-9_%-]*' <<<"$message" | head -n 1 | sed 's/.*token=//'
            return
        fi
        sleep 1
    done
}
CHECK="the verification mail reaches the mailbox"
TOKEN="$(verification_token)"
check test -n "$TOKEN"

CHECK="the email is confirmed by its link"
VERIFY="$(post /auth/verify-email "{\"token\":\"${TOKEN}\",\"password\":\"${PASSWORD}\"}")"
check grep -q '"status":"success"' <<<"$VERIFY"

# A new cookie jar: the sign-in of the account just registered, from a fresh browser.
rm -f "$JAR"
CHECK="sign-in with the new account"
LOGIN="$(post /auth/login "{\"identifier\":\"${EMAIL}\",\"password\":\"${PASSWORD}\"}")"
check grep -q '"status":"success"' <<<"$LOGIN"

CHECK="the signed-in session reads main/init"
check bash -c "$(printf '%q ' "${CURL[@]}") --cookie '$JAR' '${APP}/${PREFIX}/main/init' | grep -q '\"${EMAIL}\"'"

if [ "$failed" -gt 0 ]; then
    echo "prod-smoke: ${failed} check(s) failed" >&2
    echo "register: ${REGISTER}" >&2
    echo "verify: ${VERIFY:-}" >&2
    echo "login: ${LOGIN}" >&2
    "${COMPOSE[@]}" logs --no-color --tail 60 app >&2 || true
    exit 1
fi
echo "prod-smoke: every check passed"
