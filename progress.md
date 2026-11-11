# feat-160 — Support and Auth Lows (V14)

Plan: `docs/plan/code-review-2026-11-10-plan.md` (V14; decisions Д3 and Д5), tasks:
`docs/plan/code-review-2026-11-10-tasks.md` (V14.S–V14.X). Six low findings of
`docs/plan/code-review-2026-11-10-report.md`.

## State

Done, waiting for review and merge. Each finding was reproduced by a failing test.

## What changed

| #   | Finding                                                                                                                                                  | Now                                                                                                                                                                  |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `reindexAll` threw out of its loop when one batch failed: every later article stayed unindexed                                                           | a failed batch is logged (ids only) and reported in `failed`; the later batches are indexed. `POST /admin/knowledge-base/reindex-all` answers `{ indexed, failed? }` |
| 2   | the message being answered was left out of the model's history by its text, so an earlier identical message went too                                     | left out by its id (`addUserMessageOnce` returns the id)                                                                                                             |
| 3   | the admin KB list paged with LIMIT/OFFSET and no ORDER BY                                                                                                | ordered by id                                                                                                                                                        |
| 4   | the budget marked the translation and the embedding as started even when no provider would be called                                                     | `budget.begin` only when the service is configured (ADR 0003, point 5)                                                                                               |
| 5   | `GET /support/screenshot/:articleId` served the screenshot of a deactivated article                                                                      | 404 for a deactivated article (Д3); the admin path still sees the key                                                                                                |
| 6   | a repeated `reset-phone/start` spent the hourly SMS budget on a cooldown refusal, and after the cooldown handed the old challenge back without a new SMS | the cooldown is checked before the SMS budget; after it the session that started the reset gets a new code (Д5)                                                      |

Docs (both locales): `backend/ai.md`, `backend/storage.md`, `backend/auth.md`.

### Decision Д5 was narrowed — to review

Д5 said "after the cooldown issue a new code, as the registration and link flows do". The old
code had a second, deliberate property with its own test ("attacker-session"): a start from
**another session** neither learns nor replaces a live challenge. Issuing a new code to any
session would let anyone who knows the number cancel the owner's reset once a minute. So the new
code goes only to the session that started the reset; another session still gets the generic
answer and changes nothing — and no longer spends the SMS budget. If the wider reading of Д5 was
meant, the session check in `startPhonePasswordReset` is the one place to change.

## Evidence of Completion

### RED (new tests against the old code)

```
support unit specs
 × goes on with the later batches and names the articles of the failed one
 × returns no url for the screenshot of a deactivated article
 × does not mark the translation or the search as started when no provider will be called
 × keeps an earlier message with the same text in the history the model is shown
support-knowledge.pg.test.ts
 × orders the unfiltered list the same way
   expected [ 1n, 3n, 2n, 5n, 6n, 4n ] to deeply equal [ 1n, 2n, 3n, 4n, 5n, 6n ]
password-reset-service.contract.spec.ts
 × 3 rows: a cooldown refusal spent the SMS budget; after the cooldown no new code was sent
```

The KB test "an article edited between two pages is neither repeated nor skipped" passed on the
old code in this run: without ORDER BY the result depends on the physical order, which the
unfiltered test caught.

### After the fix

- `make check`: backend 195 files / 2638 tests, frontend 467, shared 29, playground 81.
- `pnpm --filter backend test:pg` with `REDIS_TEST_URL`: 31 files / 291 passed; `test:redis`: 116.
- `pnpm docs:build && pnpm docs:verify`: passed.

### Tests that pinned the old behaviour and were changed

- `password-reset-service.spec.ts` "reuses an active phone reset challenge…" → "sends a new code
  to the session that started the reset once the cooldown has passed".
- `support-chat-admission.pg.test.ts`: its stand-ins for the translation and the search are now
  marked as configured providers; with the real (unconfigured) `isConfigured` their reported usage
  was no longer charged, which is the fix itself.
- `support-repository.pg.test.ts`, `kb-embedding-consistency.pg.test.ts`,
  `support-embedding-service.spec.ts`: the new result shapes (`id`, `{ indexed, failed }`).

### Not verified

- No run against a real provider: an over-long article was simulated by a rejected batch.
- The registration and link flows also consume the SMS budget before their cooldown check; they
  were not part of this finding and are unchanged.
