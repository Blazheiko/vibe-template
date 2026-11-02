# feat-092 — Controller Respond Helper

Plan: `docs/plan/error-handling-fix-plan.md`, stage 5.

## Current state

Implemented, awaiting review. Start PR #305 merged (feat-092 → `in_progress`).

## Changes

- `respond(context, result, toBody?)` and `respondWs` in `controllers/shared/controller-error.ts`: an error becomes the canonical error answer (mapControllerError / mapWsControllerError), a value the body as is or through `toBody`.
- 36 `if (Result.isError(result)) return map…Error(…); return …` blocks replaced in `auth`, `admin-knowledge-base`, `push-subscription`, `main`, `support`, `avatar` and the admin WS controller (controllers: −205 / +106 lines). `const result = await …` is kept for readability.
- `resetPassword`: the manual reason filter (`RESET_PASSWORD_REASONS`, `getResetPasswordReason`) is gone — the response schema already takes the canonical error with `reason`, and the service only returns the five known reasons.
- `startPhonePasswordReset`: `{ status: 'success', ...value }` instead of four `if`s.
- 11 explicit `Result.isError` remain where more logic follows (201 status, OAuth redirect, session renewal, WS chat admission).
- Process note: the work started on `main` before feat-092 was registered; it was stashed and moved to this branch after the start PR (nothing was committed to `main`).

## Evidence of Completion

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check` clean.
- `pnpm test`: backend 1928, frontend 373, api-playground 62, shared 25, documentation 26 passed (one run hit a timing failure in `upload-limits.transport.spec.ts` "20 parallel 50 MiB uploads" under the full parallel suite; 5/5 green alone and green on rerun — unrelated to controllers).
- `test:pg` 153, `test:redis` 89 (local).
- `pnpm docs:build && pnpm docs:verify` passed.
- New tests: `respond` / `respondWs` (value, toBody, error never calls toBody, WS status); `auth-controller.reset.spec.ts` (each of the five reasons passes through; the phone reset start answers only defined fields).
- Manual on a fresh `dist` build: reset-password with a bad token → 400 `reason: invalid_token`, mismatched passwords → `passwords_mismatch`; push-subscriptions list → 200 `[]`, unknown id → 404 `not_found`; init → 200. Test user deleted afterwards.

## Files modified

- `packages/backend/src/app/controllers/shared/controller-error.ts` (+ spec), the controllers listed above, `auth-controller.reset.spec.ts` (new)
- Docs: `documentation/backend/{controllers,adding-a-feature,architecture}.md`; plan stage 5 note

## Next step

Review + merge, then "Mark feat-092 done". Remaining: stage 7 (compat code), then 6 (session state class).
