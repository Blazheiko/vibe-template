# feat-117 — Link-flow Enumeration Decision

Plan: `docs/plan/code-review-2026-11-03-plan.md`, item R12a (finding 27), decision Д4: accept and document (accepted 2026-11-04, recorded in #384). Branch: `fix/feat-117-link-flow-enumeration` (from `main` after #383).

## Current State

Implemented; PR open.

- The "already linked to another account" answers stay. They come from link-email, link-phone start/confirm and the OAuth first-address resend.
- Д4 accepts them under per-user and per-target limits. Checking the code showed the phone link had per-IP and per-number limits but none per account. So this feature adds:
    - `AUTH_PHONE_LINK_MAX_ATTEMPTS_PER_USER_PER_HOUR` (default 3, `0` refused at startup like every auth policy);
    - policy `linkPhoneUser` (`link_phone_user`, keyed by user, fixed window of 1 h);
    - in `startPhoneLink`, spent after `linkPhoneIp` and before `smsSendPhone` and the existence check.
- Docs:
    - `auth.md`: section «Прив'язка розкриває, що адреса зайнята (рішення Д4)», covering who sees it, the limits before the check, the bound of 3 emails and 3 numbers per account per hour, and how to switch to a generic answer;
    - `security.md`: `linkPhoneUser` row;
    - `configuration.md`: the variable;
    - `.env.example`.

## Files Modified

- `packages/backend/src/config/auth.ts`, `src/config/throttle-policies.ts` + spec
- `packages/backend/src/app/services/auth/auth-service.ts`, `auth-service.throttle-contract.spec.ts` (new case `startPhoneLink · user`; the phone case includes it in order)
- `packages/backend/.env.example`, `documentation/backend/auth.md`, `security.md`, `configuration.md`

## Evidence of Completion

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check` clean.
- `pnpm test`: backend 2344, frontend 400, api-playground 62 passed.
- `pnpm docs:build && pnpm docs:verify` passed.
- `test:pg` with Redis: 27 files / 236 passed. `test:redis`: 11 files / 107 passed.
- Throttle contract: `startPhoneLink` consumes `change_password_user`, `link_phone_ip`, `link_phone_user` and `sms_send_phone` in this order. A spent `link_phone_user` answers `Too many verification attempts` and does nothing further, and a Redis outage fails closed.
- Mutation check: without the new throttle, 5 contract cases fail.
- Manual (built backend):
    - `AUTH_PHONE_LINK_MAX_ATTEMPTS_PER_USER_PER_HOUR=0` → exit 1, `Invalid throttle policy configuration: linkPhoneUser: limit must be an integer >= 1`;
    - `=abc` → exit 1, `Invalid auth configuration: ...`;
    - `POST /api/auth/link-phone/start` with a valid body and no session → 401.

## Notes for Next Session

- Remaining: merge the PR after green checks, then the done PR.
- Next and last by the plan: R12b (LLM usage audit for aborted calls: status, tokens_estimated, migration, ADR 0003).
