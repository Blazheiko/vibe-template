#!/bin/sh
# Checks the local toolchain before the first run (`make doctor`, part of `make setup`).
# Node and pnpm are required: a mismatch fails the script. Docker and .env are needed
# only for some workflows, so their absence is a warning.
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

if [ "$failed" -ne 0 ]; then
    echo 'doctor: required tools are missing or too old'
    exit 1
fi
