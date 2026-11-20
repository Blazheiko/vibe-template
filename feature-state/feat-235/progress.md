# feat-235 · Audit Log — progress

Plan: `docs/plan/audit-log-plan.md` (rev. 3), tasks: `docs/plan/audit-log-tasks.md` (rev. 2).
Branch: `feat/audit-log`. Status PR: #726.

## Current state

- T0: done. `./init.sh` green on `d911394` (2026-11-20): backend 3237 tests, frontend 732,
  landing 103, shared green, build green.
- T1: done (`shared/src/audit`, query and response schemas, `shared/test/audit.test.js`).

## Files modified

- `packages/shared/src/audit/*`, `packages/shared/src/schemas/query/admin-audit-events.ts`,
  `packages/shared/src/responses/admin-audit-events-controller.ts`, barrels, `package.json` export
  `./audit`; `packages/shared/test/audit.test.js`.

## Next step

T2: `audit_events` table, migration with the `audit_events_no_update` trigger.

## Notes for Next Session

- Actor proof/source are merged into `metadata` by `buildAuditPayload` (`actor.proof`,
  `actor.source`), not by the projections.

## Evidence of Completion

(pending)
