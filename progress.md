# feat-166 — Docs Home Page Accuracy (V20)

Plan: `docs/plan/code-review-2026-11-10-plan.md` (V20), tasks:
`docs/plan/code-review-2026-11-10-tasks.md` (V20.S–V20.X). Section "Документація (PR #473)" of
`docs/plan/code-review-2026-11-10-report.md`. No dependencies.

## State

Done, waiting for review and merge.

## What changed (both locales, same content)

| Remark of the report / AC                      | Now                                                                                                                                                                               |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (1) "rejects extra fields" was wrong for `log` | the list item says only that a route with a `ResponseSchema` checks its responses and links argument 5, which states `strict` / `log` as `config/response-validation.ts` does     |
| (2) `validator` is optional                    | said in item 1: a route without one accepts any body (`server.ts` passes the parsed body unvalidated)                                                                             |
| (3) access control not covered                 | a paragraph: middleware, guards and limits live in `http-routes.ts` / `ws-routes.ts`, partly checked by `route-access.spec.ts`, and need review                                   |
| (4) "without your involvement"                 | replaced: review can focus on tests and contracts; human review stays required (`AGENTS.md`); a change to tests needs review too                                                  |
| (5) warning block                              | names the human review of the cases a test describes                                                                                                                              |
| (6) three descriptions of `ResponseSchema`     | the list item and the type-protection paragraph link argument 5 instead of restating it                                                                                           |
| V20.2 "off in production"                      | `guide/how-backend-works.md` and `backend/adding-a-feature.md`: `strict` outside production, `log` by default in production, no off mode, a route without a schema is not checked |

`grep` for "off in production" / "`off` у production" over `documentation/`: no match.

## Evidence of Completion

- `pnpm docs:build && pnpm docs:verify`: passed.
- `pnpm format:check`: clean.

Docs-only change: typecheck / lint / test are unaffected and run in CI.
