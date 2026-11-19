# feat-229: CI Hung Apt

Owner: Blazheiko · Branch: `ci/apt-hang-kill`

## Current state

Done; CI scripts and docs only. Ready for review.

## Cause (#695, 2026-11-19)

feat-225 waited for the orphaned `apt-get` before each retry, as designed: `wait-apt-idle: apt is
still running after 240s`, twice. That `apt-get` (pid 2931) ran for over 9 minutes: the mirror gave
about 100 kB/s and `security.ubuntu.com` did not answer (`Ign:8 … noble-security InRelease`), and
apt's default timeouts and retries on it take minutes. Waiting longer does not help a hung apt.

## Change

- `scripts/apt-timeouts.sh` writes `/etc/apt/apt.conf.d/99ci-timeouts`
  (`Acquire::http(s)::Timeout "30"`, `Acquire::Retries "3"`); a step before the browser install
  steps in `e2e` and `e2e-live`.
- `scripts/wait-apt-idle.sh`: at the limit an `apt-get`/`apt` still running is treated as hung:
  SIGTERM, up to 30 s, then SIGKILL; dpkg itself is never killed, `dpkg --configure -a` still runs.
  Exit 1 only if apt still runs after that.
- Docs: `documentation/{,en/}backend/testing.md`.
- Budget: per retry at most 240 s wait + 30 s + 1 s; `e2e-live` worst case about 26 min of its 35.

## Evidence of Completion

In `ubuntu:24.04` (Docker):

- `apt-timeouts.sh`: `apt-config dump` shows `Acquire::http::Timeout "30"`,
  `Acquire::https::Timeout "30"`, `Acquire::Retries "3"`.
- A hung `apt-get` in its own session: `wait-apt-idle.sh 5` ends it at the limit (exit 0 after
  6 s, none left).
- An `apt-get` that ignores SIGTERM: killed with SIGKILL after the 30 s grace (exit 0 after 36 s,
  none left).
- The #695 case (an attempt times out and leaves a hung `apt-get` with the lock):
  `RETRY_BEFORE="wait-apt-idle.sh 5" retry.sh 3 1 timeout 2 …`: exit 124, `ending it as hung`,
  then exit 0. Under feat-225 the same case failed on the lock.
- `prettier --check` clean; `pnpm docs:build && pnpm docs:verify` (see the PR).
