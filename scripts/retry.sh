#!/usr/bin/env bash
# Runs a command until it succeeds, at most ATTEMPTS times, waiting DELAY seconds after the first
# failure and twice as long after each next one.
#
#   scripts/retry.sh 4 30 pnpm --filter frontend exec playwright install-deps chromium
#
# For steps that fail on someone else's outage, not on our code: `playwright install-deps` runs
# apt, and on 2026-11-11 the Ubuntu mirrors of the GitHub runners were unreachable for hours
# (feat-179). Exits with the command's last status.
#
# RETRY_BEFORE, if set, is run (split on spaces) before every retry, e.g.
# RETRY_BEFORE='scripts/wait-apt-idle.sh 300' waits for an apt left over by a timed-out attempt
# (feat-225). Its failure is reported and the retry goes ahead.
set -u

if [ "$#" -lt 3 ]; then
    echo "usage: $0 ATTEMPTS DELAY_SECONDS COMMAND [ARGS...]" >&2
    exit 2
fi

attempts=$1
delay=$2
shift 2

attempt=1
while true; do
    "$@"
    status=$?
    if [ "$status" -eq 0 ]; then
        exit 0
    fi
    if [ "$attempt" -ge "$attempts" ]; then
        echo "retry: '$*' failed $attempt times, giving up (exit $status)" >&2
        exit "$status"
    fi
    echo "retry: '$*' failed (exit $status), attempt $attempt of $attempts; again in ${delay}s" >&2
    sleep "$delay"
    if [ -n "${RETRY_BEFORE:-}" ]; then
        # shellcheck disable=SC2086 # a command with its arguments, split on purpose
        ${RETRY_BEFORE} || echo "retry: '${RETRY_BEFORE}' failed (exit $?), retrying anyway" >&2
    fi
    attempt=$((attempt + 1))
    delay=$((delay * 2))
done
