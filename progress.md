# feat-137 — Observability Lows (sixth review I4)

## State

Done on branch `fix/feat-137-observability`. Waiting for CI on the feature PR.

## Changes

- **L10** `sentry-service.ts`: a value with `toJSON` (`URL`, `Decimal`) is sanitized as what
  `toJSON()` returns, which is what Sentry sends; it used to become `{}` (regression of feat-127).
- **L11** edges of the scrubber:
    - Sentry: the safe copy of an `Error` in `extra` / `contexts` drops its sensitive own fields and
      sanitizes the rest;
    - logger (`scrub-error.ts` `walk`): a class instance is walked as its own enumerable fields, so
      a query error inside it is scrubbed (copy-on-write; dates, buffers, maps, `toJSON` values kept);
    - logger: the bindings of `child()` are scrubbed (pino resets `formatters.bindings` for
      children, so the root's `child` is wrapped; children inherit it);
    - logger: errors among the format arguments (`'%s', err`, `'%o', { err }`) are replaced by safe
      copies before pino interpolates them into `msg`.
- Docs: `observability.md`.

## Evidence of Completion

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check` clean
- `pnpm test`: backend 2525, frontend 400, api-playground 62; docs build + verify
- Mutation: main `logger.ts`, `scrub-error.ts`, `sentry-service.ts` → 4 new cases fail (toJSON +
  error own fields, class instance, child bindings, format argument).
