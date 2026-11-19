#!/usr/bin/env bash
# Bounds how long apt waits on one mirror, for the CI steps that run `playwright install-deps`.
# Without it apt-get waited minutes on an unreachable security.ubuntu.com, longer than the attempt
# timeout of scripts/retry.sh (#695, 2026-11-19; feat-229): 30 s per connection, 3 retries.
#
#   scripts/apt-timeouts.sh
set -eu

sudo -n tee /etc/apt/apt.conf.d/99ci-timeouts >/dev/null <<'CONF'
Acquire::http::Timeout "30";
Acquire::https::Timeout "30";
Acquire::Retries "3";
CONF
echo "apt-timeouts: $(tr '\n' ' ' </etc/apt/apt.conf.d/99ci-timeouts)" >&2
