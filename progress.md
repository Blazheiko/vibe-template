# feat-121 — Fourth Review Mediums (G1 = M1–M4)

Plan: `docs/plan/code-review-2026-11-03-plan.md`, «Четверте рев'ю 2026-11-04», G1; start #396. Branch: `fix/feat-121-fourth-review-mediums`.

## Current State

Implemented; PR open. All four findings were confirmed in the code first.

- **M1:** `normalizeIp` maps every IPv4-mapped form (`::ffff:a.b.c.d`, `::ffff:7f00:1`, `0000:…:ffff:7f00:0001`) to the IPv4 address (`mappedIPv4`, via the 128-bit value). A probe on real uWS with `listen('::')` showed an IPv4 client as `0000:0000:0000:0000:0000:ffff:7f00:0001`.
- **M2:** `statusOfError(err, callerSignal)` answers `aborted` when the caller's signal aborted, whatever the error is called. A lost lock rejects fetch with `SupportLockLostError` itself, while a timeout lives on the adapter's own signal and stays `failed`. It is used by the text audit and the embedding audit.
- **M3:** `AUTH_SMS_MAX_INVALID_ATTEMPTS` takes `min: 1`.
- **M4:** `changePassword` and `logoutAll` call `invalidatePendingPhoneChallenges(phone, tx)` in their transactions. The helper moved to `phone-challenges.ts` (`account-claim-service` re-exports it), because importing `account-claim-service` from `auth-service` broke the throttle contract spec's module mocks.
- Docs: `security.md`, `auth.md`, `ai.md`, `configuration.md`. The plan records the fourth review and the groups G2–G5 for the next stages.

## Files Modified

- `vendor/utils/network/ip-address.ts` + spec
- `app/services/ai/usage/usage-audit.ts`, `adapters/openai-embedding-adapter.ts` + `usage-recording.spec.ts`, `usage-audit.pg.test.ts`
- `config/auth.ts`, `app/start/validate-runtime-config.spec.ts`
- `app/services/auth/auth-service.ts`, new `phone-challenges.ts`, `account-claim-service.ts`
- Tests: `reauth-and-reset-links.pg.test.ts`, `auth-service.spec.ts` / `.regression.spec.ts` (SMS repository mock), `logout-all.redis.test.ts` / `session-store.redis.test.ts` (user fake gets `phone: null`)
- Docs as above.

## Evidence of Completion

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `git diff --check` clean.
- `pnpm test`: backend 2365, frontend 400, api-playground 62 passed.
- `pnpm docs:build && pnpm docs:verify` passed.
- `test:pg` with Redis: 28 files / 248 passed. `test:redis`: 11 files / 114 passed.
    - `logout-all.redis.test.ts` first failed: its user fake returned `{ id }` without `phone`. It passes with `phone: null`, as a real row has.
- New tests:
    - **M1:** five mapped forms → `127.0.0.1`; two dual-stack IPv4 clients keep separate keys; neighbours of the range stay IPv6.
    - **M2:** a custom abort reason with the caller's signal aborted → `aborted` (PG text audit, embedding unit); a timeout with the caller waiting → `failed`.
    - **M3:** `0` is a config error, `1` is accepted.
    - **M4 (PG):** change-password and logout-all retire a pending phone-reset challenge; a revoked session retires none.
- Mutation check:
    - M1: `main`'s ip-address fails 5 cases;
    - M2: without the caller-signal rule, 2 cases fail;
    - M3: `main`'s config fails 1;
    - M4: `main`'s auth-service fails 2.

## Notes for Next Session

- Remaining: merge the PR after green checks, then the done PR.
- Next by the plan: G2 (lease timing, XFF chain, unix socket + CIDRs).
