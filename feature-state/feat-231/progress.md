# feat-231: CI Apt Archives Cache

Owner: Blazheiko · Branch: `ci/apt-archives-cache` · Registry PR: #701

## Current state

Done; CI and docs only. Ready for review.

## Cause (#697, #700, 2026-11-19)

With feat-225/229 the retries work as designed (`ending it as hung`, `apt idle after 240s`), but
the mirror gave 69–500 kB/s: the ~126 MB of `playwright install-deps` fit in none of the three
5-minute attempts.

## Change

- `scripts/apt-archives.sh DIR`: `/etc/apt/apt.conf.d/99ci-archives` with
  `Dir::Cache::Archives "DIR/"` and `Keep-Downloaded-Packages "true"` (apt-get and apt). DIR is
  created by the runner user; apt writes the `.deb` files world-readable.
- `ci.yml`, jobs `e2e` and `e2e-live`: a step that outputs the runner image (`ImageOS`,
  `ImageVersion`); `actions/cache/restore` of `~/apt-cache/*.deb` (key
  `apt-e2e[-live]-<os>-<image>-pw-<playwright>`, restore-keys by the os prefix); the archives
  step; after the browser install, `actions/cache/save` under the primary key when it was not
  an exact hit. Only `*.deb` is cached: `partial/` and `lock` stay out.
- The old comment "System deps are not cached" is corrected.
- Docs: `documentation/{,en/}backend/testing.md`.

GitHub serves a PR only caches of its own branch or of `main`: the cache shared by all PRs is
filled by the first green run on `main` after the merge.

## Evidence of Completion

In `ubuntu:24.04` (Docker), with a `runner` user owning `~/apt-cache`:

- after `apt-archives.sh`, `apt-get install tree cowsay` leaves its 9 `.deb` files in the cache
  dir, readable by `runner`;
- after a purge, the same install with the network cut (a dead HTTP proxy) installs both from
  the cache;
- control: without the config and after `apt-get clean`, the same install fails to fetch.
- `pnpm format:check`, `pnpm docs:build && pnpm docs:verify` (see the PR).
- On a runner: the PR's own run (cold cache: saves) and a rerun (warm: restores) — see the PR.
