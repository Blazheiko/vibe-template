# feat-244 — Admin Channel Leave Coalescing

Review of feat-243 (2026-11-21): two unsubscribes of one socket (access_changed and the permission watcher) could finish out of order; a subscribe sent after the first to finish was undone on the server by the other, while the client held it confirmed.

## State

Fixed; ready for review. `useAdminChannel.leave()` joins the unsubscribe still running for the same socket (generation); a leave on a new socket still sends its own.

## Evidence of Completion

- New test "a second leave of the same socket joins the unsubscribe still running" fails on the code of `main` (two unsubscribes sent); "a leave on a new socket sends its own unsubscribe" guards the other path.
- `make check`: exit 0 — backend 3414, frontend 906.
- Only a frontend composable changed (no UI, DB, Redis or docs); `e2e` / `e2e-live` run in CI on the PR.
