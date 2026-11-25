# feat-262 progress: Shared Entity Id Validator

Plan: `docs/plan/branded-types-plan.md` (rev. 5), tasks T1–T9 in `docs/plan/branded-types-tasks.md` (v2.1).
Status PR: #837 (`in_progress`). Branch: `fix/single-entity-id-validator`.

## State

- T1 done: `./init.sh` exit 0 on `6b2c96c` (backend 3742, frontend 1017, shared 149 tests passed).

## Deviations from the task list

- T2/T8: the "now" and "after" columns of the contract table are pinned by controller unit tests (services mocked) and
  schema tests in `app/controllers/http/entity-id-inputs.spec.ts`, not by HTTP PG tests. The null branches live in the
  controllers, so these tests reach them directly and run locally; the HTTP PG suites still run in CI (`pg-tests.yml`).
- PG and Redis suites run in CI only: the local PostgreSQL and Redis on 5432/6379 belong to another project.

## Files modified

## Evidence of Completion

## Notes for Next Session
