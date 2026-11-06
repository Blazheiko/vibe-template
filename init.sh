#!/bin/bash
# Session start for agents and humans (AGENTS.md, step 4). Thin wrapper over the Makefile:
# `make init` installs dependencies, builds shared, runs `make check` (the same steps as the
# CI quality job: format, typecheck, lint, tests) and builds every package. Stops at the
# first failure.
set -e

cd "$(dirname "$0")"

echo "=== Harness Initialization: make init ==="
make init

echo "=== Verification Complete ==="
echo ""
echo "Next steps:"
echo "1. Read feature_list.json to see current feature state"
echo "2. Pick ONE unfinished feature to work on"
echo "3. Implement only that feature"
echo "4. Re-run verification before claiming done (make check)"
echo ""
echo "All developer commands: make help"
