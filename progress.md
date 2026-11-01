# Session Progress Log

## Current State

**Last Updated:** 2026-11-01
**Active Feature:** feat-079 - Dead Code Frontend (in progress, K3)
**Branch:** `chore/dead-code-frontend`
**Plan:** `docs/plan/code-review-fixes-tasks.md`, phase K3

## Status

### Done

- [x] `main.ts`: the branch `event.data === 'NEW_VERSION'` (the string form) is gone. The service worker only ever posts the object `{ type: 'NEW_VERSION', buildTimestamp }` (`service-worker.ts`), which the next branch handles; nothing posts the bare string
- [x] `stores/state.ts`: the `getClientIP` stub (always `null`; the server takes the address from the request) and the `ipAddress: undefined` it fed into the push subscription payload
- [x] `composables/useSentry.ts` (a function returning `sentryService`): `main.ts` and `stores/user.ts` import `sentryService` directly; the file, its README row and the mention in `frontend/index.md` are gone
- [x] Checked, not removed: the user-agent parsing in `stores/state.ts` (`getDeviceType`, `getBrowserInfo`, `getOSInfo`). The plan removes it only if the backend does not use `browserName`, `osName` and `deviceType`; **it does**: they are columns of `push_subscriptions` (`database/schema.ts`), part of the create/update schemas in `shared`, and of the subscription response. That is a contract, so removing the sniffing would be a contract change (moving the parsing to the server, `parseUserAgent`, which K1 found unreferenced); not done here, and the owner decides whether it is wanted

## Evidence of Completion

| Check                                      | Result                                                            |
| ------------------------------------------ | ----------------------------------------------------------------- |
| `pnpm typecheck` / `lint` / `format:check` | exit 0                                                            |
| `pnpm build`                               | exit 0                                                            |
| `pnpm test`                                | frontend 257, backend 1731, api-playground 29, shared 17, docs 26 |
| `docs:build && docs:verify`                | passed                                                            |

## Notes for Next Session

1. Merge this PR; then a PR flipping feat-079 to `done`: the three K items are then complete and phase I (feat-075) is unblocked
2. Owner decision pending: the push-subscription device fields: keep the client-side parsing as is, or move it to the server (a contract change)
