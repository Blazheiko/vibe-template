# feat-225: CI Browser Deps Lock Wait

Owner: Blazheiko · Branch: `ci/playwright-deps-lock-wait` · Registry PR: #687

## Current state

Done; ready for `review`. Unblocks #685 (feat-223), whose `e2e` failed three times in a row at this
step.

## Cause (from the #685 logs, 2026-11-18)

1. `timeout 300 pnpm … playwright install-deps` hits the timeout (exit 124): apt on the runner was
   slow that day.
2. `timeout` ends its own process group; the `sudo apt-get` that Playwright started runs in a
   session of its own (sudo), outlives the attempt and keeps the dpkg lock.
3. Both retries of `scripts/retry.sh` fail at once: `E: Could not get lock
/var/lib/dpkg/lock-frontend. It is held by process 2908 (apt-get)` (exit 100).

## What was built

- `scripts/wait-apt-idle.sh [LIMIT]`: waits (5 s steps, default 300 s) until no `apt-get`, `apt` or
  `dpkg` runs, then `sudo -n dpkg --configure -a` for a dpkg run that was cut short; exit 1 at the
  limit (the retry still happens).
- `scripts/retry.sh`: optional `RETRY_BEFORE`, a command run before every retry; its failure is
  reported and the retry goes ahead. Without it the script behaves as before.
- `ci.yml`: the four browser install steps (e2e, e2e-live) set
  `RETRY_BEFORE: scripts/wait-apt-idle.sh 240`. Worst case 3 × 300 s + 90 s pauses + 2 × 240 s
  waits ≈ 25 min: `e2e-live` timeout 30 → 35 min (`e2e` has 40).
- Docs: `documentation/{,en/}backend/testing.md`.

## Evidence of Completion

- Simulation in `ubuntu:24.04` (Docker) with a fake install of 6 s, a 2 s timeout and an `apt-get`
  in its own session (`setsid`, like sudo) that finishes the install:
    - without the hook: exit 124 → 100 (lock) → 100 (lock), as on #685;
    - with `RETRY_BEFORE="scripts/wait-apt-idle.sh 30"`: exit 124, `apt idle after 5s`, then exit 0.
- `wait-apt-idle.sh` alone (same container): waits for a running `apt-get` (exit 0 after 10 s);
  gives up at the limit (exit 1).
- `retry.sh` by hand: the hook runs before each retry and the command's exit code is kept (7); a
  failing hook is reported and the retry goes ahead (3); no hook, first-time success (0).
- `make check` green (backend 3119 tests); `pnpm docs:build && pnpm docs:verify` green.
- CI of this PR: see the PR checks (the success path; the failure path cannot be forced on a
  runner).

## Notes for Next Session

- After merge: rerun the `e2e` of #685, merge it; "Mark feat-225 done" and "Mark feat-223 done".
