# feat-170 — Route Contracts Lock (C5b)

Plan: `docs/plan/code-review-2026-11-10-plan.md` (C7, C4, C8, C5b, C6), tasks:
`docs/plan/code-review-2026-11-10-tasks.md` (C5b.S–C5b.X). Depends on feat-177.

## State

Done, waiting for review and merge. With it, the target state of ADR 0005 is reached.

## What changed

- **C5b.1:**
    - `defineContractRoute` is renamed to `defineRoute({ contract, handler, … })`
      (`app/routes/contract-schemas/index.ts`). It is the one way to declare a route of the
      application.
    - The old schema-only helper is now `defineRawRoute` (`app/routing/define-raw-route.ts`). It
      stays for the tests of the HTTP machinery: 11 vendor specs build routes of their own.
    - It stays in `app/routing`, not in `vendor`: it depends on `#app/validate`.
    - A root ESLint rule (`no-restricted-imports`) forbids importing it in `packages/backend/src`
      outside tests.
- **C5b.2:**
    - `api-direct-calls.spec.ts` (the counter, at 0) is deleted, and so is the ESLint exception for
      `utils/api.ts`;
    - the frontend rule now covers `baseApi.upload` too, so only `utils/api-client.ts` calls the
      transport.
- **C5b.3:** `route-contracts.spec.ts` walks the route table. It fails when a route has no
  contract, no registry entry, no response schema, or no body schema on `post`/`put`/`patch`, and
  when the registry holds an entry without a route.
- **What the new test found:** `POST /auth/oauth/email/resend` took any body unchecked. It now has
  the empty-form schema, like the other POST routes that read nothing (the contract,
  the registry entry and the frontend call changed with it).
- **Docs:**
    - 15 pages in both locales: routing, adding a feature, architecture, security, validation, web
      and API routes, middlewares, testing, backend index, http-request, first endpoint, how the
      backend works, CSRF, glossary, shared;
    - the routing page has one section on `defineRoute`, plus multipart and navigation, and a
      section on `defineRawRoute` for tests;
    - ADR 0005: the target state is reached;
    - the global `backend-feature` skill (`~/.claude/skills`, outside the repository): its routes
      step is rewritten for contract, registry entry, `defineRoute` and `callApi`.
- **Both tutorials were run on a clean worktree.** "Your first endpoint" and "Adding a feature"
  went through every step: files, barrels, migration, `db:migrate`, `db:seed --demo`, server,
  every `curl` of the page.
- That run found three old errors on the pages, now fixed in both locales:
    - the login body was `{"email", "password", "token"}` (a 422 since feat-093 and feat-163); it is
      now `{"identifier", "password"}`, in the tutorial and in the CSRF guide;
    - the tutorial's service test expected a repository failure to become an `Internal` result.
      Services let unexpected failures through to the HTTP layer (500), so the test now expects the
      rejection;
    - the response examples showed `created_at` with `+02:00`, but the transformer's
      `toISOString()` is always UTC (`Z`); the examples now match.

## Evidence of Completion

- `make check`: backend 2662, frontend 501 (−3: the deleted counter), shared 30, playground 111;
  bundle graph: no schema.
- `pnpm --filter backend test:pg` (with `REDIS_TEST_URL`): 295 passed.
- `pnpm --filter frontend test:e2e` 92, `test:e2e:live` 13, `test:e2e:security` 7.
- ESLint rules, checked on throwaway files:
    - `import { defineRawRoute }` in `src/app` → `no-restricted-imports` error;
    - `baseApi.upload(…)` in `src` → `no-restricted-syntax` error.
- Tutorials on a clean worktree:
    - first endpoint: typecheck, lint and tests; `/hello`, `?name=Olena`, and the 4 broken
      requests give the statuses and bodies of the page;
    - adding a feature: `pnpm typecheck`, the backend tests (2665), the page's eslint command, the
      generated migration identical to the page, and all 10 requests of the manual check (login,
      two creates, list, 401, two 422, 415, two 403) as on the page.
- `pnpm docs:build && pnpm docs:verify`: passed.
