#!/usr/bin/env bash
# Waits until no apt-get, apt or dpkg process runs, at most LIMIT seconds (default 300), then lets
# dpkg finish a run that was cut short. For scripts/retry.sh before it retries `playwright
# install-deps`: a `timeout` that ends an attempt kills pnpm, not the `sudo apt-get` it started,
# and that apt-get keeps the dpkg lock; every retry then failed at once with "Could not get lock
# /var/lib/dpkg/lock-frontend" (feat-225). Usually the orphan finishes the install, and the retry
# is quick.
#
#   scripts/wait-apt-idle.sh [LIMIT_SECONDS]
#
# Exits 1 if apt is still running at the limit (the retry is then made anyway and fails as before).
set -u

limit=${1:-300}
step=5
waited=0

while pgrep -x 'apt-get|apt|dpkg' >/dev/null; do
    if [ "$waited" -ge "$limit" ]; then
        echo "wait-apt-idle: apt is still running after ${limit}s" >&2
        exit 1
    fi
    sleep "$step"
    waited=$((waited + step))
done
echo "wait-apt-idle: apt idle after ${waited}s" >&2

# A killed dpkg leaves "dpkg was interrupted, you must manually run 'dpkg --configure -a'".
if command -v dpkg >/dev/null; then
    sudo -n dpkg --configure -a || echo "wait-apt-idle: dpkg --configure -a failed" >&2
fi
exit 0
