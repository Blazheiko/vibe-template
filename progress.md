# feat-152 — Support Chat Stream Recovery (V06)

Plan: `docs/plan/code-review-2026-11-10-plan.md` (V06), tasks:
`docs/plan/code-review-2026-11-10-tasks.md` (V06.S–V06.X). Finding M11 of
`docs/plan/code-review-2026-11-10-report.md`. Depends on feat-151.

## Goal

The "answer in progress" state of the support chat ended only with the answer's own events
(`support_chat_complete` / `support_chat_error`). When the socket drops, the server aborts the
stream and sends none: the input and the send button stayed disabled with a typing indicator
until the page was left. Leaving the page mid-stream removed the listeners but left the partial
text in the store, and the next answer was appended to it.

## State

Done, waiting for review and merge.

## What changed

- `packages/frontend/src/stores/support.ts` — `abandonStreaming()`: drops the partial text, ends
  the streaming state and marks the cached history stale.
- `packages/frontend/src/views/SupportView.vue`
    - watches `isConnected`: a drop while an answer is awaited enables the input, abandons the
      stream and shows "connection lost"; when the connection is back the history is reloaded.
    - `onUnmounted`: an answer in flight is abandoned, so the next visit reads the history again.
- `packages/frontend/src/locales/{en,uk,pl}.ts` — `support.connectionLost`.
- `packages/frontend/src/views/__tests__/SupportView.spec.ts` (6, new).
- Docs (both locales): `backend/ai.md`.

## Evidence of Completion

### V06.T — RED (before the fix)

`pnpm exec vitest run src/views/__tests__/SupportView.spec.ts`:

```
 × lets the user type again and drops the partial answer
   AssertionError: expected '' to be undefined            (the textarea still has `disabled`)
 × reloads the conversation when the connection is back: the message is there once
   AssertionError: expected 1 to be 2                     (history loads)
 × leaves no partial answer behind, and the next visit reads the conversation again
   AssertionError: expected true to be false              (store.isStreaming after unmount)
 Tests  3 failed | 3 passed (6)
```

### After the fix

- `SupportView.spec.ts` 6 passed, `stores/__tests__/support.spec.ts` and the locale parity spec
  passed.
- `pnpm format:check`, `pnpm typecheck`, `pnpm lint`: clean.
- `pnpm test`: frontend 37 files / 432 tests, backend 2597, api-playground 62.
- `pnpm --filter frontend test:e2e`: 87 passed.
- `pnpm docs:build && pnpm docs:verify`: passed.

### Not verified

- No browser scenario: the live e2e runs without an AI provider, so there is no real stream to
  cut. The behaviour is covered by the component test on the real store with the connection state
  and the answer's events under the test's control.
- "The message is there once" rests on the server storing a message once per client message id
  (the existing contract) and on the history replacing what is shown; the component test checks
  the replacement, not the server side.

## Notes for Next Session

- feat-162 (V16) changes the same area of the frontend (401 handling).
