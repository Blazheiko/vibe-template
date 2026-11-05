# feat-126 — Log Scrubbing and Test Gaps (G5b)

Plan: `docs/plan/code-review-2026-11-03-plan.md`, «Четверте рев'ю 2026-11-04», G5b, the last group; start #411. Branch: `fix/feat-126-logs-and-tests`.

## Current State

Implemented; PR open.

- **Scrubber (R01 bypasses):**
    - `scrub-error.ts`:
        - `rebuildStack` takes the frames only after the original `Name: message` header, so message lines that look like frames are dropped;
        - an error's own fields go through `scrubNested`, so errors inside plain objects and arrays are scrubbed too;
        - new `toSafeValue` does the same for any value and never changes the caller's objects.
    - `logger.ts`: `formatters.log` runs `toSafeValue` over the record and serializes the nested errors, which pino printed as `{}`.
    - `sentry-service.ts`: `sanitizeDeep` returns a copy (errors replaced by `toSafeError`), assigned back to `extra`, `contexts` and breadcrumb data.
    - `index.ts`: the four `console.error` calls print `toSafeError(...)`.
    - `knowledge-base-init-service.ts`: the failed status message is `toSafeError(err).message`.
- **Weak tests:**
    - `server-lifecycle.spec.ts` holds `closeAllWs` open and checks a new TCP connection is refused while the sockets close;
    - new `usage-audit.spec.ts` checks `auditCall` settles once;
    - in `oauth-pre-hijack.pg.test.ts` the provider error body carries a full profile with an id, so only the `!ok` check stops it;
    - `phone-reset-transaction.pg.test.ts`: the two-completions case is renamed and commented as the older conditional-confirmation invariant; the R06a rollback cases are the ones that test the transaction.
- Docs: `observability.md`.

## Files Modified

- `vendor/utils/errors/scrub-error.ts` + spec, `vendor/utils/logger.ts` + spec, `app/services/observability/sentry-service.ts` + spec, `src/index.ts`, `app/services/support/knowledge-base-init-service.ts` + spec
- Tests: `vendor/start/server-lifecycle.spec.ts`, new `app/services/ai/usage/usage-audit.spec.ts`, `oauth-pre-hijack.pg.test.ts`, `phone-reset-transaction.pg.test.ts`
- `documentation/backend/observability.md`

## Evidence of Completion

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `git diff --check` clean (typecheck run after lint).
- `pnpm test`: backend 2398, frontend 400, api-playground 62 passed.
- `pnpm docs:build && pnpm docs:verify` passed.
- `test:pg` with Redis: 28 files / 255 passed. `test:redis`: 11 files / 116 passed.
- Mutation check:
    - `main`'s scrub-error (with an identity `toSafeValue`) fails 7 cases (stack frame line, nested field, the logger record cases);
    - `main`'s sentry-service fails the non-mutation case;
    - the raw KB status message fails 1;
    - with the close order swapped in `server.ts`, the strengthened test sees `connected` instead of `ECONNREFUSED`;
    - without the settled guard, 2 fail;
    - without `!response.ok`, the OAuth PG case fails.
    - A first try of that close-order mutation ran under `timeout`, which macOS lacks, so the test never ran. It was rerun without it.

## Notes for Next Session

- Remaining: merge the PR after green checks, then the done PR. This closes the fourth review.
