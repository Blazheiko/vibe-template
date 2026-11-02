# Session Progress Log

## Current State

**Last Updated:** 2026-11-02
**Active Feature:** feat-083 - Locale Stubs (review)
**Branch:** `chore/locale-stubs`
**Plan:** `docs/plan/code-review-fixes-tasks.md`, phase O

## Status

Owner decision: the interface ships `en`, `uk`, `pl`.

- [x] **`uk.ts` and `pl.ts` are real translations** of all 204 lines of `en.ts` (they were `export default en` copies). **Drafted by me, not by a native speaker: worth a read by someone who speaks them**, especially the legal-sounding `termsAgreeText` / `errorTerms`
- [x] **The 15 other stub files are deleted** (`ar cs de es fr hi it ja ko nl pt ru sv tr zh`)
- [x] **`SHIPPED_LOCALE_CODES = ['en','uk','pl']`** and `isShippedLocale` in `shared/enums`. `APP_LOCALE_CODES` (18) stays: language recognition and the Support AI use it
- [x] **`loadLocale` can no longer leave the interface without text**: it returns the locale actually usable, `en` when the file is missing or fails to load (with a warning); `useLocale` and `initLocaleStandalone` apply what it returns
- [x] **A regression avoided on the way**: `SupportView` sent `locale.value` (the UI locale) to the Support AI as the language to answer in. With only three interface languages that would have turned a Russian or German browser's answers into English, where before `locale.value` was `ru`/`de` (with English texts). It now sends `supportLanguage()`, the browser language among the 18
- [x] **Tests**: `locales.spec.ts` (files = shipped list; uk/pl have exactly the keys of `en` and the same placeholders; translated, not copies; `loadLocale` success, failure, unknown language, partial translation), `useLocale.spec.ts` (browser language -> interface language for 10 cases; `supportLanguage`), `languages.test.js` (shared), Playwright `mock` `locale.spec.ts` (uk, pl, en, ru, de, ja, unknown browser languages show the right login page without page errors; the sign-in modal and its field error in Ukrainian)
- [x] Docs: `frontend/index.md`, `backend/ai.md`, `guide/your-project.md`, `shared/index.md`

## Evidence of Completion

| Check                                      | Result                                                                  |
| ------------------------------------------ | ----------------------------------------------------------------------- |
| `pnpm typecheck` / `lint` / `format:check` | exit 0                                                                  |
| `pnpm build`                               | exit 0                                                                  |
| `pnpm test`                                | frontend 373 (+29), shared 25, backend 1844, api-playground 62, docs 26 |
| Playwright `mock` project                  | all passed (61 + 8 new)                                                 |
| `docs:build && docs:verify`                | passed                                                                  |
