# feat-179 — CI Browser Deps Retry

Source: `docs/plan/code-review-2026-11-10-report.md`, «Знайдено під час виконання плану»; owner
decision 2026-11-11: retry `install-deps` (chosen over the Playwright container).

## State

Done, waiting for review and merge.

## What changed

- `scripts/retry.sh ATTEMPTS DELAY COMMAND…` runs a command until it succeeds:
    - the pause doubles after each failure;
    - it exits with the command's last status.
- `ci.yml`: the four browser install steps run as
  `scripts/retry.sh 3 30 timeout 300 pnpm --filter frontend exec playwright …`. These are
  `install --with-deps` and `install-deps`, in both `e2e` and `e2e-live`.
    - There are at most 3 attempts, each capped at 5 minutes, 30 s and 60 s apart.
    - During the 2026-11-11 outage, one attempt hung for up to 10 minutes: apt waits on every
      unreachable mirror. Without the cap, the job timeout would be reached first.
- Job timeouts: `e2e` 30 → 40 minutes and `e2e-live` 20 → 30, to leave room for the retries.
- Why not the Playwright container:
    - its image tag would have to follow `@playwright/test` by hand;
    - `e2e-live` runs PostgreSQL and Redis as services, so the job's networking would change.
- Docs (both locales): `backend/testing.md`, the CI row.

## Evidence of Completion

- `scripts/retry.sh`, run by hand:
    - a command that fails twice and then succeeds exits 0 after 3 runs, waiting 1 s and 2 s;
    - a command that always fails (exit 7) exits 7 after 2 attempts;
    - a command that succeeds at once runs once;
    - bad usage exits 2.
- `bash -n scripts/retry.sh`: ok. The file is committed with mode 100755.
- The CI run of this PR runs the new steps, but the mirrors are up now, so it shows the success
  path only.
- `pnpm format:check`: clean. `ci.yml` is not covered by it and was not Prettier-formatted before
  this change either.
- `pnpm docs:build && pnpm docs:verify`: passed.

### Not verified

- A real apt outage in CI: the retry path was only checked locally.
