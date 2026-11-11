# feat-157 — Strict Registration Session Oracle (V11)

Plan: `docs/plan/code-review-2026-11-10-plan.md` (V11, decision Д4: destroy the session in both
branches), tasks: `docs/plan/code-review-2026-11-10-tasks.md` (V11.S–V11.X). A low finding of
`docs/plan/code-review-2026-11-10-report.md`, raised to medium.

## Goal

Strict registration (`AUTH_STRICT_REGISTRATION=true`, the default) answers the same for a free and
a taken address, and hashes the password before the lookup so the two take the same time
(feat-099, feat-100). The caller's stored session, however, was destroyed only when the address
was free: a caller who was still signed in after the answer knew the email was registered.

## State

Done, waiting for review and merge.

## What changed

- `packages/backend/src/app/services/auth/auth-service.ts`, `registerEmailFlow` — in strict mode
  the caller's session is destroyed in every branch that returns the generic answer: the address
  is taken, the address is free, the race was lost. The non-strict mode is unchanged (it signs a
  free address in, so it has nothing to hide).
- Tests: `register-race.pg.test.ts` (+2, one existing assertion changed),
  `auth-service.regression.spec.ts` (one assertion changed), `e2e-live/registration.spec.ts` (+1).
- Docs (both locales): `backend/auth.md`.

### Behaviour change to review

A registration request sent from a signed-in session now signs that session out whatever the
address is (it already did for a free address). The register form is shown to anonymous visitors,
so this is reached through the API, not the UI.

Two tests pinned the old asymmetry on purpose ("only the winner leaves its anonymous session; the
loser keeps it, like a taken address") and were changed to the decision Д4.

## Evidence of Completion

### V11.T — RED (before the fix)

`register-race.pg.test.ts` (real PostgreSQL, a session double that records `destroySession`):

```
 × strict: both answer the generic message, one user is created
   AssertionError: expected "vi.fn()" to be called 1 times, but got 0 times   (the loser of the race)
 × strict: the caller’s session ends the same way for a free and a taken address
   AssertionError: expected "vi.fn()" to be called 1 times, but got 0 times   (the taken address)
```

With real sessions in Redis, `e2e-live/registration.spec.ts` on the old service: two signed-in
browsers post a registration, one for a taken address and one for a free one; both get the same
200 answer, and

```
 ✘ strict registration ends the caller’s session the same way for a taken and a free address
   Received: "live-d4344490@example.test"      (the caller of the taken address is still signed in)
```

### After the fix

- `register-race.pg.test.ts` 6 passed; auth unit specs 761 passed.
- `pnpm --filter backend test:pg`: 31 files / 288 tests; `test:redis`: 116 passed.
- `make check`: backend 2612, frontend 452, shared 27, api-playground 62.
- `pnpm --filter frontend test:e2e:live`: 13 passed (the new scenario with real Redis sessions).
- `pnpm docs:build && pnpm docs:verify`: passed.
- The timing tests of feat-099 are part of the unit suite and pass.

### Not verified

- The time of the answer was not measured: every strict branch now makes the same Redis call
  (`destroySession`), which should make the branches more alike, not less.

## Notes for Next Session

- The phone registration flow was not part of this finding and was not changed.
