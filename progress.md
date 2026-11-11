# feat-161 — Schema Bounds Lows (V15)

Plan: `docs/plan/code-review-2026-11-10-plan.md` (V15), tasks:
`docs/plan/code-review-2026-11-10-tasks.md` (V15.S–V15.X). Low findings of
`docs/plan/code-review-2026-11-10-report.md`. Depends on feat-156.

## State

Done, waiting for review and merge.

## What changed

| Finding                                             | Before                                                                                                                                                                                                                        | Now                                                                                                                  |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| prompt update (`prompt-update.ts`)                  | `maxTokens` and `temperature` were any number, `model` any string: a fraction or a long model was a 500; a negative `maxTokens` was stored and made the daily budget reservation negative, refusing every user until midnight | `maxTokens` an integer 1–100000, `temperature` 0–2, `model` ≤ 100, `content` ≤ 50000 → 422 outside                   |
| prompt test (`prompt-test.ts`)                      | no upper bound on the message                                                                                                                                                                                                 | ≤ 4000, as a support message                                                                                         |
| knowledge base (`support-knowledge-base.ts`)        | `title` and `category` unbounded against varchar(255) / varchar(100): 500                                                                                                                                                     | `title` ≤ 255, `category` ≤ 100, `content` ≤ 30000 → 422                                                             |
| OAuth sign-up (`oauth-service.ts`)                  | a provider display name over 100 characters failed the INSERT: that person could not sign up through the provider                                                                                                             | the name is cut to the column's length; `oauth_accounts.provider_name` keeps it whole                                |
| avatar of an OAuth account (`avatar-service.ts`)    | replacing or deleting it issued a DeleteObject for a key like `<prefix>/https://…`                                                                                                                                            | a provider picture URL is not a storage key: no request                                                              |
| numeric ids (`controllers/shared/parse-id.ts`, new) | a 30-digit id reached the query: 500 "out of range for type bigint"; the admin KB id took `0x10` and `-5`                                                                                                                     | one strict parser in every controller that reads an id (9 places): not an id → the same 400 / 404 as a malformed one |

Docs (both locales): `backend/ai.md`, `backend/oauth.md`, `backend/controllers.md`.

## Evidence of Completion

### RED (new tests against the old code)

```
push-subscription-ownership.pg.test.ts
 × GET /:id answers like a missing id for a 30-digit id          expected 500 to be 404
 × GET /:id/statistics …   × GET /:id/logs …   × DELETE /:id …
oauth-service.spec.ts
 × cuts a display name longer than the column to its length
avatar-service.spec.ts
 × deleteAvatar clears a provider picture (https://…) without a storage request   (2 cases)
```

The schema bounds are new assertions in `packages/shared/test/contracts.test.js`; the old schemas
had no bounds to assert (they were not run against the old schemas).

### After the fix

- `parse-id.spec.ts` 15 passed; the specs above pass.
- `make check`: backend 196 files / 2655 tests, frontend 467, shared 30, playground 81.
- `pnpm --filter backend test:pg` with `REDIS_TEST_URL`: 31 files / 295 passed.
- `pnpm docs:build && pnpm docs:verify`: passed.

### Not verified

- The admin UI forms for prompts and articles were not opened: a value over a bound now answers
  422 and the form shows the server's message, as for any validation error.
- The bounds 100000 (maxTokens), 50000 (prompt) and 30000 (article) are my choice of "large
  enough"; the provider's own limits are lower for some models.
- `GET /push-subscriptions/:id/logs` answers 404 for an id that is not a number (as it did for a
  non-numeric one), while a well-formed foreign id still answers 200 with an empty list.
