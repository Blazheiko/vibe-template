#!/usr/bin/env bash
# Waits until no apt-get, apt or dpkg process runs, at most LIMIT seconds (default 300), then lets
# dpkg finish a run that was cut short. For scripts/retry.sh before it retries `playwright
# install-deps`: a `timeout` that ends an attempt kills pnpm, not the `sudo apt-get` it started,
# and that apt-get keeps the dpkg lock; every retry then failed at once with "Could not get lock
# /var/lib/dpkg/lock-frontend" (feat-225). Usually the orphan finishes the install, and the retry
# is quick.
#
# An apt-get still running at the limit is hung, not slow (#695, 2026-11-19: over 9 minutes on an
# unreachable security.ubuntu.com): it is ended with SIGTERM, then SIGKILL, so the retry gets the
# lock (feat-229). dpkg itself is never killed; `dpkg --configure -a` finishes what it left.
#
#   scripts/wait-apt-idle.sh [LIMIT_SECONDS]
#
# Exits 1 only if apt still runs after it was ended (the retry is then made anyway).
set -u

limit=${1:-300}
step=5
waited=0

running() { pgrep -x 'apt-get|apt|dpkg' >/dev/null; }

while running; do
    if [ "$waited" -ge "$limit" ]; then
        echo "wait-apt-idle: apt is still running after ${limit}s, ending it as hung" >&2
        sudo -n pkill -TERM -x 'apt-get|apt' || true
        for _ in 1 2 3 4 5 6; do
            pgrep -x 'apt-get|apt' >/dev/null || break
            sleep "$step"
        done
        sudo -n pkill -KILL -x 'apt-get|apt' || true
        sleep 1
        break
    fi
    sleep "$step"
    waited=$((waited + step))
done

if running; then
    echo "wait-apt-idle: apt is still running" >&2
    status=1
else
    echo "wait-apt-idle: apt idle after ${waited}s" >&2
    status=0
fi

# A killed apt or dpkg leaves "dpkg was interrupted, you must manually run 'dpkg --configure -a'".
if command -v dpkg >/dev/null; then
    sudo -n dpkg --configure -a || echo "wait-apt-idle: dpkg --configure -a failed" >&2
fi
exit "$status"
