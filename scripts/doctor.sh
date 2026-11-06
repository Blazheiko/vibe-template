#!/bin/sh
# Checks the local toolchain before the first run (`make doctor`, part of `make setup`).
# Node and pnpm are required: a mismatch fails the script. Docker, .env and free ports are
# needed only for some workflows, so problems there are warnings.
#
# Usage: scripts/doctor.sh
cd "$(dirname "$0")/.." || exit 1

failed=0
ok() { printf '  ok    %s\n' "$1"; }
warn() { printf '  warn  %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; failed=1; }

# Same range as engines.node in package.json: ^<version from .nvmrc>.
required_node=$(cat .nvmrc)
if command -v node >/dev/null 2>&1; then
    node_version=$(node -p 'process.versions.node')
    if node -e '
        const [have, need] = process.argv.slice(1).map((v) => v.split(".").map(Number))
        const ok = have[0] === need[0] && (have[1] > need[1] || (have[1] === need[1] && have[2] >= need[2]))
        process.exit(ok ? 0 : 1)
    ' "$node_version" "$required_node"; then
        ok "Node $node_version"
    else
        fail "Node $node_version, need ^$required_node (.nvmrc; nvm use)"
    fi
else
    fail "Node not found, need ^$required_node (.nvmrc)"
fi

if command -v pnpm >/dev/null 2>&1; then
    pnpm_version=$(pnpm --version)
    if [ "${pnpm_version%%.*}" -ge 9 ] 2>/dev/null; then
        ok "pnpm $pnpm_version"
    else
        fail "pnpm $pnpm_version, need >=9 (corepack enable)"
    fi
else
    fail 'pnpm not found, need >=9 (corepack enable)'
fi

if command -v docker >/dev/null 2>&1; then
    if docker info >/dev/null 2>&1; then
        ok 'Docker is running'
    else
        warn 'Docker is installed but not running: make services-up and app-* will not work'
    fi
else
    warn 'Docker not found: make services-up and app-* will not work'
fi

if [ -f packages/backend/.env ]; then
    ok 'packages/backend/.env exists'
else
    warn 'packages/backend/.env is missing: run make env'
fi

# Host ports of docker-compose.yml and the dev servers, read from .env like compose does.
env_value() {
    value=''
    if [ -f packages/backend/.env ]; then
        value=$(sed -n "s/^$1=//p" packages/backend/.env | tail -n 1 | tr -d "\"' \r")
    fi
    printf '%s' "${value:-$2}"
}

check_port() {
    holder=$(lsof -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | awk 'NR == 2 { print $1 " (PID " $2 ")" }')
    case "$holder" in
        '') ok "port $1 is free ($2)" ;;
        com.docke* | docker*) ok "port $1 is used by Docker ($2): probably already running" ;;
        *) warn "port $1 is taken by $holder ($2): $3" ;;
    esac
}

if command -v lsof >/dev/null 2>&1; then
    check_port "$(env_value PGSQL_PORT 5432)" 'PostgreSQL' \
        'stop it, set PGSQL_PORT, or use it: make services-up ARGS="redis s3 mailpit"'
    check_port "$(env_value REDIS_PORT 6379)" 'Redis' 'stop it or set REDIS_PORT'
    check_port "$(env_value S3_HOST_PORT 8333)" 'S3' 'stop it or set S3_HOST_PORT'
    check_port "$(env_value SMTP_PORT 1025)" 'Mailpit SMTP' 'stop it or set SMTP_PORT'
    check_port "$(env_value MAILPIT_UI_PORT 8025)" 'Mailpit UI' 'stop it or set MAILPIT_UI_PORT'
    check_port "$(env_value PORT 3000)" 'backend, make dev / app-up' \
        'stop it (make app-down if it is the app container) or set PORT and APP_PORT'
    check_port 5173 'frontend, make dev' 'stop it, Vite would pick another port'
else
    warn 'lsof not found: ports not checked'
fi

if [ "$failed" -ne 0 ]; then
    echo 'doctor: required tools are missing or too old'
    exit 1
fi
