# feat-164 — Modal Accessibility (V18)

Plan: `docs/plan/code-review-2026-11-10-plan.md` (V18), tasks:
`docs/plan/code-review-2026-11-10-tasks.md` (V18.S–V18.X). Low finding of
`docs/plan/code-review-2026-11-10-report.md`. No dependencies.

## State

Done, waiting for review and merge.

## What changed

- `composables/useModalDialog.ts` (new): focus moves into the panel when the dialog opens
  (`data-modal-initial-focus`, else the first control that is not `data-modal-close`, else the
  panel), Tab and Shift+Tab stay inside, Escape closes, focus returns to where it was. Open
  dialogs are a stack: only the top one answers the keyboard; one dialog replacing another
  (sign-in → registration) returns focus to the element of the page that opened the first.
- `AuthModalShell.vue`, `AdminUserDetailModal.vue`, `AvatarEditorModal.vue`: `role="dialog"`,
  `aria-modal="true"`, `aria-labelledby` (the title), `tabindex="-1"`, the composable.
- Icon-only buttons have a name: the avatar editor's close button
  (`account.avatar.closeEditor`), the chat send button (`support.send`) in `en`, `uk`, `pl`; the
  admin modal's `✕` has `aria-label="Close"` (the admin UI is not translated).

Docs (both locales): `frontend/index.md` lists the new composable.

## Evidence of Completion

### RED (new tests against the old components)

```
components/__tests__/modal-dialogs.spec.ts
 × AuthModalShell: a labelled dialog that closes on Escape only while shown
 × AdminUserDetailModal: a labelled dialog, a named close button, Escape closes
 × AvatarEditorModal: a labelled dialog, a named close button, Escape cancels
e2e/mock/modal-keyboard.spec.ts   3 failed
 × is a labelled dialog and takes focus when it opens
 × Tab and Shift+Tab never leave the dialog
 × Escape closes it and focus returns to the button that opened it
```

`useModalDialog.spec.ts` (11 tests) is new behaviour with no old counterpart.

### After the fix

- `make check`: frontend 45 files / 499 tests, backend 2655, shared 30, playground 81.
- `pnpm --filter frontend test:e2e`: 92 passed.
- `pnpm --filter frontend test:e2e:live`: 13 passed.
- `pnpm docs:build && pnpm docs:verify`: passed.

### Not verified

- No screen reader was run: the roles and names were checked through the accessibility tree
  Playwright uses (`getByRole('dialog', { name })`), not by listening.
- The e2e keyboard test covers the sign-in modal; the admin user modal and the avatar editor
  are covered by unit tests in jsdom only.
- The sign-in modal now focuses its first field on open; on a phone that brings the keyboard up
  at once.
- The knowledge base article form in `AdminKnowledgeBaseView.vue` is a fourth modal the report
  did not list; it is unchanged.
