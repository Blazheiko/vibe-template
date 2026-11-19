#!/usr/bin/env bash
# Points apt's package archive at DIR and keeps what it downloads there, so a CI cache can carry
# the .deb files of `playwright install-deps` from run to run: on 2026-11-19 the runner's mirror
# gave 69–500 kB/s, and the ~126 MB did not fit in any attempt (feat-231). DIR belongs to the
# runner user, so actions/cache can restore into it and save from it; apt (root) writes the .deb
# files world-readable. Only `DIR/*.deb` is cached: apt's `partial/` and `lock` stay out.
#
#   scripts/apt-archives.sh DIR
set -eu

if [ "$#" -ne 1 ]; then
    echo "usage: $0 DIR" >&2
    exit 2
fi
dir=$1
mkdir -p "$dir"

sudo -n tee /etc/apt/apt.conf.d/99ci-archives >/dev/null <<CONF
Dir::Cache::Archives "$dir/";
APT::Keep-Downloaded-Packages "true";
Binary::apt::APT::Keep-Downloaded-Packages "true";
CONF
echo "apt-archives: $dir ($(find "$dir" -maxdepth 1 -name '*.deb' | wc -l | tr -d ' ') .deb restored)" >&2
