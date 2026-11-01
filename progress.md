# Session Progress Log

## Current State

**Last Updated:** 2026-11-01
**Active Feature:** feat-075 - Frontend And Shared Dedup (in progress, phase I)
**Branch:** `refactor/frontend-shared-dedup-3` (part 3; parts 1 and 2 are merged as #255 and #256)
**Plan:** `docs/plan/code-review-fixes-tasks.md`, phase I

## Status

### Done in this PR (items 1 and 2 of phase I, the part that is the same code)

- [x] **`shared/ws-client`** (new dependency-free subpath): `classifyWsMessage` / `WsMessageKind` and `normalizeApiPrefix`. Both were byte-identical copies in the app and the playground; the playground's `ws-message-kind.ts` and its spec are gone, the app's `ws-api-response.ts` no longer defines the classifier, both `api-path.ts` import the prefix function from shared. `ws-client.test.js` (4) holds the table of the prefix, the classifier's cases (under any prefix, pending or not) and that the module has no import
- [x] **One event bus.** The playground had a hand-written copy of what `mitt` does; it now uses `mitt` (added to its dependencies, the version the app uses) with its own two events. The two apps keep separate event maps on purpose: the maps are different
- [x] Docs: `shared/index.md`

### Not done, on purpose: the connection core itself

The plan wants the WebSocket transport (`useWebSocketConnection.ts`, 448 lines in the app, 437 in the playground) in `shared/ws-client` with the apps as thin wrappers. I looked at the two: they are **not** copies of one thing. The app's has a heartbeat, a token refresh over HTTP, a back-off for refused upgrades (`resolveWebSocketCloseAction`), the delivery-unknown error, and Sentry reporting; the playground's reconnects after a fixed 5 s and has none of that. A shared core would have to take all of these as hooks, or the playground would silently gain the app's behaviour. That is a redesign of the app's close and reconnect handling (the part that carries session revocation and the 4001 logic), not a dedup, with no safety net as strong as the other phases have; the part that really is the same code is what moved above. This is the owner's call

### Left for the next PR of phase I

- [ ] Admin views: `useAdminUserDetailModal`, `AdminFilterBar.vue`, `buildAdminQuery()` + `encodeURIComponent`, shared `admin.css` (screenshots before and after)

## Evidence of Completion

| Check                                      | Result                                                            |
| ------------------------------------------ | ----------------------------------------------------------------- |
| `pnpm typecheck` / `lint` / `format:check` | exit 0                                                            |
| `pnpm build`                               | exit 0                                                            |
| `pnpm test`                                | shared 24, frontend 262, backend 1731, api-playground 26, docs 26 |
| `docs:build && docs:verify`                | passed                                                            |
