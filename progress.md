# feat-127 — Log and Sentry Scrubbing Regressions (fifth review H1)

## State

Done on branch `fix/feat-127-scrub-regressions`; start PR #414.

## Changes

- `vendor/utils/errors/scrub-error.ts`: plain data is walked with a strict error check
  (`instanceof Error`, or string `name` + `message` + `stack`), so `{ code, message }` and
  `payload: { message }` keep their fields (N1). One copy-on-write walk: a record with nothing to
  replace is returned as it is; a shared reference is walked once; a cycle becomes `[Circular]` and a
  subtree deeper than 32 levels `[Truncated]` (no raw error below either). `toSafeValue(value,
mapError)` lets the logger serialize errors in the same pass. Cause / `errors` of an error are still
  scrubbed when merely error-like.
- `vendor/utils/logger.ts`: `formatters.log` is one pass (`toSafeValue` + `stdSerializers.err`), no
  second deep copy; `hooks.logMethod` replaces an error given first or under `err` / `error` by its
  safe copy before pino takes `msg` from it.
- `services/observability/sentry-service.ts`: `sanitizeDeep` sanitizes a class instance as the plain
  object of its own fields (what Sentry sends after normalizing); dates, maps, sets, buffers kept (N2).
- Docs: `documentation/backend/observability.md`.

## Evidence of Completion

- typecheck, lint, prettier clean
- pnpm test: backend 2406, frontend 400, api-playground 62; test:pg (with Redis) 28 files / 255;
  test:redis 11 / 116; docs:build + docs:verify pass
- Manual: the reviewer's repro `toSafeValue({ message: 'user-facing', userId: 5, payload: { message:
'hi', where: 'x' } })` returns the object unchanged (same reference); on main it gave
  `{"userId":5,"payload":{}}`.
- Mutation (main version of each file, new tests): scrub-error 5 fail, logger 2 fail, sentry 1 fail.
